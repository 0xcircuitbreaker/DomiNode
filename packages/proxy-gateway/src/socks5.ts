import * as net from "node:net";
import { createLogger, hashApiKey, userRepo, planRepo } from "@dominusnode/shared";
import type { ProviderSelector } from "@dominusnode/pool-manager";
import { checkBalance, checkTeamBalance } from "./balance-check.js";
import { attachByteCounters } from "./counting-stream.js";
import { startSession, endSession, registerSessionDestroy, unregisterSessionDestroy } from "./session-manager.js";
import type { ProxyOptions } from "./auth.js";
import { checkSanctionedCountry } from "./geo-check.js";
import { validateTarget, isValidHostname, isValidPort } from "./target-validator.js";
import { incrementUserConns, decrementUserConns } from "./connection-tracker.js";
import { checkAuthRateLimit, recordAuthFailure } from "./auth-rate-limit.js";
import { recordRequest, recordError, recordLatency } from "./stats.js";

const log = createLogger("proxy:socks5");

// Parse and validate tunnel idle timeout once at module level
const TUNNEL_IDLE_TIMEOUT_MS = parseInt(process.env["TUNNEL_IDLE_TIMEOUT_MS"] ?? "300000", 10);
if (isNaN(TUNNEL_IDLE_TIMEOUT_MS) || TUNNEL_IDLE_TIMEOUT_MS < 10_000 || TUNNEL_IDLE_TIMEOUT_MS > 3_600_000) {
  throw new Error("TUNNEL_IDLE_TIMEOUT_MS must be between 10000 and 3600000");
}

// Parse and validate connect timeout at module level (not per-connection)
const SOCKS5_CONNECT_TIMEOUT_MS = parseInt(process.env["PROXY_CONNECT_TIMEOUT_MS"] ?? "30000", 10);
if (isNaN(SOCKS5_CONNECT_TIMEOUT_MS) || SOCKS5_CONNECT_TIMEOUT_MS < 1_000 || SOCKS5_CONNECT_TIMEOUT_MS > 120_000) {
  throw new Error("PROXY_CONNECT_TIMEOUT_MS must be between 1000 and 120000");
}

/** Strip potential credentials from upstream status lines or error messages */
function sanitizeUpstreamMsg(msg: string): string {
  return msg
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/Proxy-Authorization:\s*[^\r\n]*/gi, "Proxy-Authorization: [REDACTED]")
    .replace(/:\/\/[^@\s]+@/g, "://[REDACTED]@")
    .replace(/\b\w+-country-[A-Z]{2}-\w+:[^\s@]*/g, "[REDACTED_CREDS]");
}

// SOCKS5 constants
const SOCKS_VER = 0x05;
const AUTH_USERPASS = 0x02;
const AUTH_NONE_ACCEPTABLE = 0xff;
const USERPASS_VER = 0x01;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;
const REP_SUCCESS = 0x00;
const REP_GENERAL_FAILURE = 0x01;
const REP_NOT_ALLOWED = 0x02;
const REP_COMMAND_NOT_SUPPORTED = 0x07;

function parseProxyOptions(username: string): ProxyOptions {
  const options: ProxyOptions = {};
  // Match proxyType prefix: dc-, residential-, auto-
  const typeMatch = username.match(/^(dc|residential|auto)(?:-|$)/);
  if (typeMatch) options.proxyType = typeMatch[1] as "dc" | "residential" | "auto";
  const countryMatch = username.match(/(?:^|-)country-([A-Za-z]{2})(?:-|$)/);
  if (countryMatch) options.country = countryMatch[1].toUpperCase();
  const stateMatch = username.match(/(?:^|-)state-([a-zA-Z]{2,30})(?:-|$)/);
  if (stateMatch) options.state = stateMatch[1].toLowerCase();
  const cityMatch = username.match(/(?:^|-)city-([a-zA-Z]{2,50})(?:-|$)/);
  if (cityMatch) options.city = cityMatch[1].toLowerCase();
  const asnMatch = username.match(/(?:^|-)asn-(\d{1,10})(?:-|$)/);
  if (asnMatch) {
    const asnNum = parseInt(asnMatch[1], 10);
    if (asnNum >= 1 && asnNum <= 4_294_967_295) options.asn = asnNum;
  }
  const sessionMatch = username.match(/(?:^|-)session-([a-zA-Z0-9]+)(?:-|$)/);
  if (sessionMatch) options.sessionId = sessionMatch[1].slice(0, 255); // cap length to match HTTP parser
  return options;
}

function sendReply(socket: net.Socket, rep: number): void {
  // Guard against writing to destroyed socket
  if (socket.destroyed) return;
  // Minimal SOCKS5 reply: VER REP RSV ATYP(IPv4) BND.ADDR(0.0.0.0) BND.PORT(0)
  const reply = Buffer.alloc(10);
  reply[0] = SOCKS_VER;
  reply[1] = rep;
  reply[2] = 0x00; // RSV
  reply[3] = ATYP_IPV4;
  // BND.ADDR and BND.PORT left as 0
  socket.write(reply);
}

// Total SOCKS5 handshake timeout (covers client negotiation + upstream CONNECT)
const SOCKS5_TOTAL_HANDSHAKE_TIMEOUT_MS = parseInt(process.env["SOCKS5_TOTAL_HANDSHAKE_TIMEOUT_MS"] ?? "15000", 10);
if (isNaN(SOCKS5_TOTAL_HANDSHAKE_TIMEOUT_MS) || SOCKS5_TOTAL_HANDSHAKE_TIMEOUT_MS < 5_000 || SOCKS5_TOTAL_HANDSHAKE_TIMEOUT_MS > 60_000) {
  throw new Error("SOCKS5_TOTAL_HANDSHAKE_TIMEOUT_MS must be between 5000 and 60000");
}

async function handleSocks5Connection(clientSocket: net.Socket, providerSelector: ProviderSelector): Promise<void> {
  const clientIp = (clientSocket.remoteAddress ?? "").replace(/^::ffff:/, "");

  // Total handshake timeout — destroys socket if entire SOCKS5 handshake
  // (greeting + auth + request + upstream CONNECT) isn't completed within 15 seconds.
  // This prevents slowloris-style attacks that hold connections open indefinitely
  // by trickling SOCKS5 protocol bytes one at a time.
  let totalHandshakeCompleted = false;
  const totalHandshakeTimer = setTimeout(() => {
    if (!totalHandshakeCompleted) {
      log.warn("SOCKS5 total handshake timeout exceeded", { clientIp });
      if (!clientSocket.destroyed) {
        clientSocket.destroy();
      }
    }
  }, SOCKS5_TOTAL_HANDSHAKE_TIMEOUT_MS);

  // Ensure timer is cleared on early socket close
  clientSocket.once("close", () => clearTimeout(totalHandshakeTimer));

  // Geo-check
  const blocked = checkSanctionedCountry(clientIp);
  if (blocked) {
    clearTimeout(totalHandshakeTimer);
    clientSocket.end();
    return;
  }

  // SOCKS5 auth rate limiting (Fix #7)
  if (checkAuthRateLimit(clientIp)) {
    clearTimeout(totalHandshakeTimer);
    clientSocket.end();
    return;
  }

  // Step 1: Read greeting (VER, NMETHODS, METHODS...)
  const greeting = await readBytes(clientSocket, 2, 5000);
  if (!greeting || greeting[0] !== SOCKS_VER) {
    clearTimeout(totalHandshakeTimer);
    clientSocket.end();
    return;
  }

  const nmethods = greeting[1];
  const methods = await readBytes(clientSocket, nmethods, 5000);
  if (!methods) {
    clearTimeout(totalHandshakeTimer);
    clientSocket.end();
    return;
  }

  // We require username/password auth (0x02)
  if (!Array.from(methods).includes(AUTH_USERPASS)) {
    clearTimeout(totalHandshakeTimer);
    clientSocket.write(Buffer.from([SOCKS_VER, AUTH_NONE_ACCEPTABLE]));
    clientSocket.end();
    return;
  }

  // Accept username/password auth
  clientSocket.write(Buffer.from([SOCKS_VER, AUTH_USERPASS]));

  // Step 2: Read username/password (RFC 1929)
  const authVer = await readBytes(clientSocket, 1, 5000);
  if (!authVer || authVer[0] !== USERPASS_VER) {
    clearTimeout(totalHandshakeTimer);
    clientSocket.end();
    return;
  }

  const ulenBuf = await readBytes(clientSocket, 1, 5000);
  if (!ulenBuf) { clearTimeout(totalHandshakeTimer); clientSocket.end(); return; }
  const ulen = ulenBuf[0];

  const unameBuf = await readBytes(clientSocket, ulen, 5000);
  if (!unameBuf) { clearTimeout(totalHandshakeTimer); clientSocket.end(); return; }
  const username = unameBuf.toString("utf-8");

  const plenBuf = await readBytes(clientSocket, 1, 5000);
  if (!plenBuf) { clearTimeout(totalHandshakeTimer); clientSocket.end(); return; }
  const plen = plenBuf[0];

  const passwdBuf = await readBytes(clientSocket, plen, 5000);
  if (!passwdBuf) { clearTimeout(totalHandshakeTimer); clientSocket.end(); return; }
  const apiKey = passwdBuf.toString("utf-8");

  // Authenticate
  if (!apiKey.startsWith("dn_live_")) {
    clearTimeout(totalHandshakeTimer);
    recordAuthFailure(clientIp);
    clientSocket.write(Buffer.from([USERPASS_VER, 0x01])); // auth failure
    clientSocket.end();
    return;
  }

  const keyHash = hashApiKey(apiKey);
  let userId: string;
  let logTargetHosts = false;
  let proxyOptions: ProxyOptions;
  let teamId: string | null = null;

  try {
    const result = await userRepo.findUserByApiKeyHash(keyHash);
    if (!result) {
      clearTimeout(totalHandshakeTimer);
      recordAuthFailure(clientIp);
      clientSocket.write(Buffer.from([USERPASS_VER, 0x01]));
      clientSocket.end();
      return;
    }
    // Reject suspended/deleted users at SOCKS5 auth layer
    if (result.user.status !== "active") {
      clearTimeout(totalHandshakeTimer);
      recordAuthFailure(clientIp);
      clientSocket.write(Buffer.from([USERPASS_VER, 0x01]));
      clientSocket.end();
      return;
    }
    // Reject unverified email (parity with HTTP proxy auth.ts)
    if (!result.user.email_verified) {
      clearTimeout(totalHandshakeTimer);
      recordAuthFailure(clientIp);
      clientSocket.write(Buffer.from([USERPASS_VER, 0x01]));
      clientSocket.end();
      return;
    }
    userId = result.user.id;
    teamId = result.apiKey.team_id ?? null;
    logTargetHosts = result.user.log_target_hosts ?? false;
    proxyOptions = parseProxyOptions(username);
  } catch (err) {
    clearTimeout(totalHandshakeTimer);
    log.error("SOCKS5 auth DB error", { error: err instanceof Error ? err.message : String(err) });
    clientSocket.write(Buffer.from([USERPASS_VER, 0x01]));
    clientSocket.end();
    return;
  }

  // Auth success
  clientSocket.write(Buffer.from([USERPASS_VER, 0x00]));

  // Fetch plan for per-plan connection limits and free plan balance bypass
  // Team API keys use the team's plan (e.g. payg/unrestricted) not the creator's personal plan
  const socksUserPlan = teamId
    ? await planRepo.getTeamPlan(teamId)
    : await planRepo.getUserPlan(userId);

  // Per-user connection limit (plan-aware)
  if (!incrementUserConns(userId, socksUserPlan.maxConnections)) {
    clearTimeout(totalHandshakeTimer);
    sendReply(clientSocket, REP_NOT_ALLOWED);
    clientSocket.end();
    return;
  }

  // Free plan: skip wallet balance check (bandwidth checked in startSession)
  if (socksUserPlan.pricePerGbCents > 0) {
    const hasBalance = teamId
      ? await checkTeamBalance(teamId)
      : await checkBalance(userId);
    if (!hasBalance) {
      clearTimeout(totalHandshakeTimer);
      decrementUserConns(userId);
      sendReply(clientSocket, REP_NOT_ALLOWED);
      clientSocket.end();
      return;
    }
  }

  // Step 3: Read request (VER, CMD, RSV, ATYP, DST.ADDR, DST.PORT)
  const reqHeader = await readBytes(clientSocket, 4, 10000);
  if (!reqHeader || reqHeader[0] !== SOCKS_VER) {
    clearTimeout(totalHandshakeTimer);
    decrementUserConns(userId);
    clientSocket.end();
    return;
  }

  const cmd = reqHeader[1];
  const atyp = reqHeader[3];

  if (cmd !== CMD_CONNECT) {
    clearTimeout(totalHandshakeTimer);
    sendReply(clientSocket, REP_COMMAND_NOT_SUPPORTED);
    decrementUserConns(userId);
    clientSocket.end();
    return;
  }

  // Parse destination address
  let targetHost: string;
  if (atyp === ATYP_IPV4) {
    const addrBuf = await readBytes(clientSocket, 4, 5000);
    if (!addrBuf) { clearTimeout(totalHandshakeTimer); decrementUserConns(userId); clientSocket.end(); return; }
    targetHost = `${addrBuf[0]}.${addrBuf[1]}.${addrBuf[2]}.${addrBuf[3]}`;
  } else if (atyp === ATYP_DOMAIN) {
    const domLenBuf = await readBytes(clientSocket, 1, 5000);
    if (!domLenBuf || domLenBuf[0] === 0) { clearTimeout(totalHandshakeTimer); decrementUserConns(userId); clientSocket.end(); return; }
    const domainBuf = await readBytes(clientSocket, domLenBuf[0], 5000);
    if (!domainBuf) { clearTimeout(totalHandshakeTimer); decrementUserConns(userId); clientSocket.end(); return; }
    targetHost = domainBuf.toString("utf-8");
  } else if (atyp === ATYP_IPV6) {
    const addrBuf = await readBytes(clientSocket, 16, 5000);
    if (!addrBuf) { clearTimeout(totalHandshakeTimer); decrementUserConns(userId); clientSocket.end(); return; }
    const parts: string[] = [];
    for (let i = 0; i < 16; i += 2) {
      parts.push(addrBuf.readUInt16BE(i).toString(16));
    }
    targetHost = parts.join(":");
  } else {
    clearTimeout(totalHandshakeTimer);
    sendReply(clientSocket, REP_GENERAL_FAILURE);
    decrementUserConns(userId);
    clientSocket.end();
    return;
  }

  // Parse destination port
  const portBuf = await readBytes(clientSocket, 2, 5000);
  if (!portBuf) { clearTimeout(totalHandshakeTimer); decrementUserConns(userId); clientSocket.end(); return; }
  const targetPort = portBuf.readUInt16BE(0);

  // CRLF injection prevention + SSRF validation
  if (!isValidHostname(targetHost) || !isValidPort(targetPort)) {
    clearTimeout(totalHandshakeTimer);
    sendReply(clientSocket, REP_NOT_ALLOWED);
    decrementUserConns(userId);
    clientSocket.end();
    return;
  }

  // Defense-in-depth: reject hostnames with control characters before upstream CONNECT
  if (/[\x00-\x1f\x7f]/.test(targetHost)) {
    clearTimeout(totalHandshakeTimer);
    sendReply(clientSocket, REP_NOT_ALLOWED);
    decrementUserConns(userId);
    clientSocket.end();
    return;
  }

  const socksTargetCheck = await validateTarget(targetHost, targetPort);
  if (!socksTargetCheck.allowed) {
    clearTimeout(totalHandshakeTimer);
    sendReply(clientSocket, REP_NOT_ALLOWED);
    decrementUserConns(userId);
    clientSocket.end();
    return;
  }

  // Enforce allowedProxyTypes BEFORE provider selection (parity with HTTP handler)
  // 'all' means unrestricted — skip the guard (truthy but should not restrict)
  if (socksUserPlan.allowedProxyTypes && socksUserPlan.allowedProxyTypes !== 'all') {
    const reqType = proxyOptions.proxyType;
    if (reqType === "residential" && socksUserPlan.allowedProxyTypes === "dc") {
      clearTimeout(totalHandshakeTimer);
      sendReply(clientSocket, REP_NOT_ALLOWED);
      decrementUserConns(userId);
      clientSocket.end();
      return;
    }
    if (reqType === "dc" && socksUserPlan.allowedProxyTypes === "residential") {
      clearTimeout(totalHandshakeTimer);
      sendReply(clientSocket, REP_NOT_ALLOWED);
      decrementUserConns(userId);
      clientSocket.end();
      return;
    }
    if (!reqType || reqType === "auto") {
      proxyOptions.proxyType = socksUserPlan.allowedProxyTypes as "dc" | "residential";
    }
  }

  recordRequest();

  // Provider selection (replaces global circuit breaker check)
  let selected;
  try {
    selected = providerSelector.select(proxyOptions);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("sanctioned")) {
      clearTimeout(totalHandshakeTimer);
      sendReply(clientSocket, REP_NOT_ALLOWED);
      decrementUserConns(userId);
      clientSocket.end();
      return;
    }
    if (msg.includes("unavailable")) {
      clearTimeout(totalHandshakeTimer);
      sendReply(clientSocket, REP_GENERAL_FAILURE);
      decrementUserConns(userId);
      clientSocket.end();
      return;
    }
    clearTimeout(totalHandshakeTimer);
    decrementUserConns(userId);
    throw err;
  }
  const { provider, proxy: upstream } = selected;
  const providerName = provider.name;

  const redactedHost = targetHost.split(".").slice(-2).join(".");
  log.info("SOCKS5 CONNECT", { target: `${redactedHost}:${targetPort}`, userId, country: proxyOptions.country, provider: providerName });

  const connectStart = Date.now();

  // Wrap IPv6 addresses in brackets for upstream CONNECT per RFC 7230
  const connectHost = targetHost.includes(":") ? `[${targetHost}]` : targetHost;

  const psSocket = net.connect(upstream.port, upstream.host, () => {
    psSocket.write(
      `CONNECT ${connectHost}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${connectHost}:${targetPort}\r\n` +
        `Proxy-Authorization: Basic ${upstream.proxyAuth}\r\n` +
        `\r\n`,
    );
  });

  let tunnelEstablished = false;
  let headersParsed = false; // Re-entry guard for header parsing (separate from tunnelEstablished)
  const headerChunks: Buffer[] = [];
  let headerBytesSoFar = 0;

  // Fix #6: Once-guard to prevent double-decrement
  let decremented = false;
  function safeDecrement(): void {
    if (!decremented) {
      decremented = true;
      decrementUserConns(userId);
    }
  }

  async function handleUpstreamData(chunk: Buffer): Promise<void> {
    if (headersParsed) return;

    headerChunks.push(chunk);
    headerBytesSoFar += chunk.length;

    if (headerBytesSoFar > 32 * 1024) {
      log.error("upstream response headers too large", { size: headerBytesSoFar });
      // Guard against writing to destroyed socket
      if (!clientSocket.destroyed) {
        sendReply(clientSocket, REP_GENERAL_FAILURE);
        clientSocket.end();
      }
      psSocket.destroy();
      safeDecrement();
      return;
    }

    const fullBuffer = Buffer.concat(headerChunks);
    const headerStr = fullBuffer.toString("utf-8");

    if (!headerStr.includes("\r\n\r\n")) {
      psSocket.once("data", (nextChunk: Buffer) => {
        handleUpstreamData(nextChunk).catch((err) => {
          log.error("unhandled error in SOCKS5 upstream data handler", {
            error: err instanceof Error ? err.message : String(err),
            provider: providerName,
          });
          if (!clientSocket.destroyed) {
            sendReply(clientSocket, REP_GENERAL_FAILURE);
            clientSocket.end();
          }
          psSocket.destroy();
          safeDecrement();
        });
      });
      return;
    }

    const statusLine = headerStr.split("\r\n")[0];

    // Strict status line check — prevent matching "200" in non-status contexts
    const statusMatch = statusLine.match(/^HTTP\/1\.[01] (\d{3})/);
    if (!statusMatch || statusMatch[1] !== "200") {
      log.error("SOCKS5 upstream CONNECT failed", { status: sanitizeUpstreamMsg(statusLine), provider: providerName });
      providerSelector.recordFailure(providerName);
      recordError();
      // Guard against writing to destroyed socket
      if (!clientSocket.destroyed) {
        sendReply(clientSocket, REP_GENERAL_FAILURE);
        clientSocket.end();
      }
      psSocket.destroy();
      safeDecrement();
      return;
    }

    headersParsed = true; // Prevent re-entry into header parsing
    const connectLatencyMs = Date.now() - connectStart;
    recordLatency(connectLatencyMs);
    providerSelector.recordSuccess(providerName, connectLatencyMs);

    // Forward any remaining data after HTTP headers
    const headerEndIdx = fullBuffer.indexOf("\r\n\r\n") + 4;
    const remaining = fullBuffer.slice(headerEndIdx);

    // Set up byte counting BEFORE piping
    const counter = attachByteCounters(clientSocket, psSocket);

    // Fix #3: Start session BEFORE sending success reply (billing race condition fix)
    let sessionId: string;
    try {
      // Pass connectLatencyMs and proxyType derived from provider name
      // Pass pre-fetched plan to prevent TOCTOU double-fetch
      const poolType = providerName.includes("dc") ? "dc" : "residential";
      const socksIsAgent = !!proxyOptions.walletId;
      sessionId = await startSession(userId, targetHost, counter, connectLatencyMs, poolType, socksUserPlan, logTargetHosts, teamId, socksIsAgent);
    } catch (err) {
      log.error("SOCKS5 failed to start session", { error: err instanceof Error ? err.message : String(err) });
      // Guard against writing to destroyed socket
      if (!clientSocket.destroyed) {
        sendReply(clientSocket, REP_GENERAL_FAILURE);
        clientSocket.end();
      }
      safeDecrement();
      psSocket.destroy();
      return;
    }

    // Register socket destroy callback so admin suspend can forcibly close this tunnel
    registerSessionDestroy(sessionId, () => {
      clientSocket.destroy();
      psSocket.destroy();
    });

    // Mark tunnel as fully established AFTER session is started — this ensures
    // the psSocket error handler properly cleans up if an error occurs during startSession
    tunnelEstablished = true;
    totalHandshakeCompleted = true; // Clear total handshake timeout
    clearTimeout(totalHandshakeTimer);
    clearTimeout(handshakeTimeout); // Free timer immediately instead of waiting for socket close

    // Session started successfully - NOW send success reply and start piping
    sendReply(clientSocket, REP_SUCCESS);

    if (remaining.length > 0) {
      counter.bytesOut += remaining.length; // Count buffered upstream data
      clientSocket.write(remaining);
    }

    psSocket.pipe(clientSocket);
    clientSocket.pipe(psSocket);

    // Idle timeout: close tunnels inactive for 5 minutes to prevent resource leaks
    clientSocket.setTimeout(TUNNEL_IDLE_TIMEOUT_MS);
    psSocket.setTimeout(TUNNEL_IDLE_TIMEOUT_MS);
    clientSocket.on("timeout", () => { clientSocket.destroy(); });
    psSocket.on("timeout", () => { psSocket.destroy(); });

    // Once-guard cleanup for session end
    let tunnelCleanedUp = false;
    const cleanup = () => {
      if (tunnelCleanedUp) return;
      tunnelCleanedUp = true;
      unregisterSessionDestroy(sessionId);
      safeDecrement();
      endSession(sessionId).catch((cleanupErr) => {
        log.error("SOCKS5 session end failed", { sessionId, error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) });
      });
    };

    clientSocket.on("end", cleanup);
    clientSocket.on("error", cleanup);
    clientSocket.on("close", cleanup);
    psSocket.on("end", cleanup);
    psSocket.on("error", cleanup);
    psSocket.on("close", cleanup);
  }

  psSocket.once("data", (chunk: Buffer) => {
    handleUpstreamData(chunk).catch((err) => {
      log.error("unhandled error in SOCKS5 upstream data handler", {
        error: err instanceof Error ? err.message : String(err),
        provider: providerName,
      });
      if (!clientSocket.destroyed) {
        sendReply(clientSocket, REP_GENERAL_FAILURE);
        clientSocket.end();
      }
      psSocket.destroy();
      safeDecrement();
    });
  });

  psSocket.on("error", (err) => {
    log.error("SOCKS5 upstream error", { error: err.message, provider: providerName });
    if (!tunnelEstablished) {
      providerSelector.recordFailure(providerName);
      recordError();
      if (!clientSocket.destroyed) sendReply(clientSocket, REP_GENERAL_FAILURE);
      safeDecrement();
    }
    if (!clientSocket.destroyed) clientSocket.end();
    psSocket.destroy(); // Ensure close event fires for session cleanup (parity with server.ts)
  });

  clientSocket.on("error", (err) => {
    log.error("SOCKS5 client error", { error: err.message });
    if (!psSocket.destroyed) psSocket.destroy();
  });

  const connectTimeoutMs = SOCKS5_CONNECT_TIMEOUT_MS;

  // Handshake timeout — cleared when tunnel is established or sockets close
  const handshakeTimeout: ReturnType<typeof setTimeout> = setTimeout(() => {
    if (!tunnelEstablished) {
      log.error("SOCKS5 upstream handshake timeout", { provider: providerName });
      providerSelector.recordFailure(providerName);
      recordError();
      // Guard against writing to destroyed socket (client may have disconnected)
      if (!clientSocket.destroyed) {
        sendReply(clientSocket, REP_GENERAL_FAILURE);
        clientSocket.end();
      }
      psSocket.destroy();
      safeDecrement();
    }
  }, connectTimeoutMs);

  psSocket.once("close", () => clearTimeout(handshakeTimeout));
  clientSocket.once("close", () => clearTimeout(handshakeTimeout));
}

/**
 * Read exactly `n` bytes from a socket with a timeout.
 */
function readBytes(socket: net.Socket, n: number, timeoutMs: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    if (n === 0) {
      resolve(Buffer.alloc(0));
      return;
    }

    let collected = Buffer.alloc(0);
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        // Free intermediate buffer memory before resolving
        collected = Buffer.alloc(0);
        socket.removeListener("data", onData);
        socket.removeListener("error", onError);
        socket.removeListener("close", onClose);
        resolve(null);
      }
    }, timeoutMs);

    function finish(result: Buffer | null): void {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      resolve(result);
    }

    function onData(chunk: Buffer): void {
      collected = Buffer.concat([collected, chunk]);
      if (collected.length >= n) {
        const result = collected.slice(0, n);
        const excess = collected.length > n ? collected.slice(n) : null;
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        // Pause socket to stop flowing mode, then remove listeners.
        // Without pause, removing the "data" listener while socket is flowing
        // causes any unshifted data to be silently discarded (Node.js streams spec).
        socket.pause();
        socket.removeListener("data", onData);
        socket.removeListener("error", onError);
        socket.removeListener("close", onClose);
        if (excess) {
          socket.unshift(excess);
        }
        resolve(result);
      }
    }

    function onError(): void {
      finish(null);
    }

    function onClose(): void {
      finish(null);
    }

    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
    // Ensure socket is flowing — needed after a previous readBytes call
    // paused the socket to safely unshift excess data.
    socket.resume();
  });
}

export async function startSocks5Server(port: number = 1080, providerSelector?: ProviderSelector): Promise<net.Server> {
  // Explicitly init geo-check — do not rely on HTTP server calling it first
  const { initGeoCheck } = await import("./geo-check.js");
  await initGeoCheck();

  // Cache the resolved selector to avoid Promise.resolve().then() microtask delay
  // which can cause readBytes to miss initial socket data in the connection handler
  let resolvedSelector: ProviderSelector | null = providerSelector ?? null;

  if (!resolvedSelector) {
    const { createProviderSelector } = await import("@dominusnode/pool-manager");
    resolvedSelector = createProviderSelector();
  }

  const server = net.createServer((socket) => {
    if (resolvedSelector) {
      // Synchronous path — handler runs in same tick as connection callback
      handleSocks5Connection(socket, resolvedSelector).catch((err) => {
        log.error("unhandled SOCKS5 error", { error: err instanceof Error ? err.message : String(err) });
        socket.destroy();
      });
    } else {
      log.warn("SOCKS5 connection rejected: provider selector not yet initialized");
      socket.destroy();
    }
  });

  const maxConns = parseInt(process.env["PROXY_MAX_CONNECTIONS"] ?? "5000", 10);
  if (isNaN(maxConns) || maxConns <= 0) {
    throw new Error("PROXY_MAX_CONNECTIONS must be a positive integer");
  }
  server.maxConnections = maxConns;

  server.listen(port, () => {
    log.info(`SOCKS5 proxy listening on port ${port}`);
  });

  return server;
}
