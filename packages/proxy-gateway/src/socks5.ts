import * as net from "node:net";
import * as tls from "node:tls";
import type { PlaintextAuthGuard } from "./proxy-tls.js";
import { createLogger, hashApiKey, userRepo, planRepo } from "@dominusnode/shared";
import { checkBalance, checkTeamBalance } from "./balance-check.js";
import { bindTunnelLifecycle, isTunnelClient } from "./tunnel-lifecycle.js";
import { attachByteCounters } from "./counting-stream.js";
import { checkAgenticWalletPolicy } from "./wallet-policy.js";
import { startSession, endSession, registerSessionDestroy, unregisterSessionDestroy } from "./session-manager.js";
import { parseProxyOptions, type ProxyOptions } from "./auth.js";
import { checkSanctionedCountry } from "./geo-check.js";
import { validateTarget, isValidHostname, isValidPort } from "./target-validator.js";
import { incrementUserConns, decrementUserConns } from "./connection-tracker.js";
import { checkAuthRateLimit, recordAuthFailure } from "./auth-rate-limit.js";
import { recordRequest, recordError, recordLatency } from "./stats.js";
import { enforcePolicy, isPlaintextPort, isFreeRelayBlocked } from "./policy-enforcer.js";
import { openRelayStream, RelayOpenError, type RelayRuntime, type RelayUpstream } from "./relay.js";

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

async function handleSocks5Connection(clientSocket: net.Socket, relay: RelayRuntime): Promise<void> {
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
  let walletAddress: string | null = null;

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
    walletAddress = result.user.wallet_address ?? null;
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

  if (isFreeRelayBlocked(relay.getPolicy(), socksUserPlan)) {
    clearTimeout(totalHandshakeTimer);
    log.info("SOCKS5 free plan rejected: PAID_PLAN_REQUIRED");
    sendReply(clientSocket, REP_NOT_ALLOWED);
    clientSocket.end();
    return;
  }

  // Per-user connection limit (plan-aware)
  if (!incrementUserConns(userId, socksUserPlan.maxConnections)) {
    clearTimeout(totalHandshakeTimer);
    sendReply(clientSocket, REP_NOT_ALLOWED);
    clientSocket.end();
    return;
  }

  // Free plan: skip wallet balance check (bandwidth checked in startSession)
  if (socksUserPlan.pricePerGbCents > 0) {
    let hasBalance: boolean;
    try {
      hasBalance = teamId
        ? await checkTeamBalance(teamId)
        : await checkBalance(userId);
    } catch (err) {
      // Fail closed and release the slot taken by incrementUserConns
      log.error("SOCKS5 balance check failed", { error: err instanceof Error ? err.message : String(err) });
      hasBalance = false;
    }
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

  // Policy: ports, denylist, OFAC destination, plaintext opt-in (port 80), requester caps
  const enforced = enforcePolicy(relay.getPolicy(), {
    userId, host: targetHost, port: targetPort, plaintext: isPlaintextPort(targetPort), allowHttp: proxyOptions.allowHttp === true, resolvedIps: socksTargetCheck.addresses,
  });
  if (!enforced.allowed) {
    clearTimeout(totalHandshakeTimer);
    sendReply(clientSocket, REP_NOT_ALLOWED);
    decrementUserConns(userId);
    clientSocket.end();
    return;
  }

  recordRequest();

  // Agentic wallet policy: only a verified, active, user-owned wallet grants agent limits
  const walletPolicy = await checkAgenticWalletPolicy(proxyOptions.walletId, userId, targetHost);
  if (!walletPolicy.allowed) {
    clearTimeout(totalHandshakeTimer);
    sendReply(clientSocket, REP_NOT_ALLOWED);
    decrementUserConns(userId);
    clientSocket.end();
    return;
  }

  const redactedHost = targetHost.split(".").slice(-2).join(".");
  log.info("SOCKS5 CONNECT", { target: `${redactedHost}:${targetPort}`, userId, country: proxyOptions.country });

  // Once-guard to prevent double-decrement
  let decremented = false;
  function safeDecrement(): void {
    if (!decremented) {
      decremented = true;
      decrementUserConns(userId);
    }
  }

  // Select a node and open a stream (DIAL_FAIL/DNS_FAIL retry once on another node)
  let upstream: RelayUpstream;
  try {
    upstream = await openRelayStream(relay, {
      country: proxyOptions.country,
      ipClass: proxyOptions.ipClass,
      requesterUserId: userId,
      requesterWallet: walletAddress ?? undefined,
      requesterTeamId: teamId ?? undefined,
      clientIp,
      targetHost,
      port: targetPort,
      sticky: proxyOptions.sessionId,
    });
  } catch (err) {
    clearTimeout(totalHandshakeTimer);
    recordError();
    const status = err instanceof RelayOpenError ? err.status : 502;
    log.warn("SOCKS5 relay open failed", { code: err instanceof RelayOpenError ? err.code : "UNKNOWN" });
    sendReply(clientSocket, status === 403 ? REP_NOT_ALLOWED : REP_GENERAL_FAILURE);
    safeDecrement();
    clientSocket.end();
    return;
  }
  recordLatency(upstream.latencyMs);
  const psStream = upstream.stream;
  psStream.on("error", (err) => log.warn("SOCKS5 relay stream error", { error: sanitizeUpstreamMsg(err.message) }));
  if (clientSocket.destroyed) {
    clearTimeout(totalHandshakeTimer);
    psStream.destroy();
    safeDecrement();
    return;
  }

  const counter = attachByteCounters(clientSocket, psStream);

  // Start session BEFORE sending success reply (billing race condition fix)
  let sessionId: string;
  try {
    sessionId = await startSession(userId, targetHost, counter, upstream.latencyMs, {
      nodeId: upstream.node.nodeId,
      ipClass: upstream.node.ipClass,
      nodeOwnerUserId: upstream.node.ownerUserId,
      destPort: targetPort,
      requesterWallet: walletAddress,
      nodeBytes: () => {
        const rep = (psStream as { nodeReport?: { bytesIn: number; bytesOut: number } | null }).nodeReport;
        return rep ? BigInt(rep.bytesIn) + BigInt(rep.bytesOut) : null;
      },
    }, socksUserPlan, logTargetHosts, teamId, walletPolicy.isAgent);
  } catch (err) {
    clearTimeout(totalHandshakeTimer);
    log.error("SOCKS5 failed to start session", { error: err instanceof Error ? err.message : String(err) });
    if (!clientSocket.destroyed) {
      sendReply(clientSocket, REP_GENERAL_FAILURE);
      clientSocket.end();
    }
    safeDecrement();
    psStream.destroy();
    return;
  }

  registerSessionDestroy(sessionId, () => {
    clientSocket.destroy();
    psStream.destroy();
  });

  totalHandshakeCompleted = true;
  clearTimeout(totalHandshakeTimer);

  let tunnelCleanedUp = false;
  const cleanup = () => {
    if (tunnelCleanedUp) return;
    tunnelCleanedUp = true;
    unregisterSessionDestroy(sessionId);
    safeDecrement();
    if (!clientSocket.destroyed) clientSocket.destroy();
    if (!psStream.destroyed) psStream.destroy();
    endSession(sessionId).catch((cleanupErr) => {
      log.error("SOCKS5 session end failed", { sessionId, error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) });
    });
  };

  if (clientSocket.destroyed) {
    cleanup();
    return;
  }

  sendReply(clientSocket, REP_SUCCESS);

  psStream.pipe(clientSocket);
  clientSocket.pipe(psStream);

  clientSocket.setTimeout(TUNNEL_IDLE_TIMEOUT_MS);
  clientSocket.on("timeout", () => { clientSocket.destroy(); });

  // Half-close aware: a client FIN ends only the upstream write side.
  bindTunnelLifecycle(clientSocket, psStream, cleanup);
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

export interface Socks5ServerOptions {
  /** SOCKS5 inside TLS: credentials travel encrypted. */
  tls?: { cert: Buffer; key: Buffer };
  /** Plaintext listener only. SOCKS5 always authenticates, so a refusal closes every connection. */
  plaintextAuth?: PlaintextAuthGuard;
}

export async function startSocks5Server(port: number, relay: RelayRuntime, opts: Socks5ServerOptions = {}): Promise<net.Server> {
  const plaintextAuth = opts.tls ? undefined : opts.plaintextAuth;
  // Explicitly init geo-check — do not rely on HTTP server calling it first
  const { initGeoCheck } = await import("./geo-check.js");
  await initGeoCheck();

  // allowHalfOpen: a client FIN after the request must not stop the response
  // from flowing back (see bindTunnelLifecycle). Before the tunnel exists, a
  // FIN still closes our side as before.
  const onConnection = (socket: net.Socket): void => {
    if (plaintextAuth && !plaintextAuth("socks5")) {
      socket.destroy();
      return;
    }
    socket.on("end", () => {
      if (!isTunnelClient(socket) && !socket.destroyed) socket.end();
    });
    // Synchronous path — handler runs in same tick as connection callback
    handleSocks5Connection(socket, relay).catch((err) => {
      log.error("unhandled SOCKS5 error", { error: err instanceof Error ? err.message : String(err) });
      socket.destroy();
    });
  };
  const server: net.Server = opts.tls
    ? tls.createServer({ cert: opts.tls.cert, key: opts.tls.key, minVersion: "TLSv1.2", allowHalfOpen: true }, onConnection)
    : net.createServer({ allowHalfOpen: true }, onConnection);

  const maxConns = parseInt(process.env["PROXY_MAX_CONNECTIONS"] ?? "5000", 10);
  if (isNaN(maxConns) || maxConns <= 0) {
    throw new Error("PROXY_MAX_CONNECTIONS must be a positive integer");
  }
  server.maxConnections = maxConns;

  server.listen(port, () => {
    log.info(`SOCKS5 proxy listening on port ${port}`, { tls: !!opts.tls });
  });

  return server;
}
