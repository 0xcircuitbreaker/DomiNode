import * as crypto from "node:crypto";
import * as http from "node:http";
import * as net from "node:net";
import { createLogger, planRepo } from "@dominusnode/shared";
import type { ProviderSelector } from "@dominusnode/pool-manager";
import { authenticateRequest } from "./auth.js";
import { checkBalance } from "./balance-check.js";
import { attachByteCounters } from "./counting-stream.js";
import { startSession, endSession, getActiveSessionCount, registerSessionDestroy, unregisterSessionDestroy } from "./session-manager.js";
import { checkSanctionedCountry, initGeoCheck } from "./geo-check.js";
import { executeWithRetry, promisifyRequest, DEFAULT_RETRY_OPTIONS } from "./retry.js";
import { validateTarget, isValidHostname, isValidPort } from "./target-validator.js";
import { incrementUserConns, decrementUserConns } from "./connection-tracker.js";
import { checkAuthRateLimit, recordAuthFailure } from "./auth-rate-limit.js";
import { recordRequest, recordError, recordLatency, recordBytes, recordSessionStart } from "./stats.js";

const log = createLogger("proxy:server");

/** Strip potential credentials from upstream status lines or error messages */
function sanitizeUpstreamMsg(msg: string): string {
  // Remove Basic auth tokens, Bearer tokens, and common credential patterns
  return msg
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/Proxy-Authorization:\s*[^\r\n]*/gi, "Proxy-Authorization: [REDACTED]")
    .replace(/:\/\/[^@\s]+@/g, "://[REDACTED]@")
    .replace(/\b\w+-country-[A-Z]{2}-\w+:[^\s@]*/g, "[REDACTED_CREDS]");
}

/** R30 C-2+H-4: Write to socket only if not destroyed, then end */
function safeSocketWrite(socket: net.Socket, data: string): void {
  if (!socket.destroyed) {
    socket.write(data);
    socket.end();
  }
}

const MAX_CONNECTIONS = parseInt(process.env["PROXY_MAX_CONNECTIONS"] ?? "5000", 10);

// Validate config at module load
if (isNaN(MAX_CONNECTIONS) || MAX_CONNECTIONS <= 0) {
  throw new Error("PROXY_MAX_CONNECTIONS must be a positive integer");
}

const MAX_BODY_SIZE = 50 * 1024 * 1024; // 50MB
const CONNECT_TIMEOUT_MS = parseInt(process.env["PROXY_CONNECT_TIMEOUT_MS"] ?? "30000", 10);

// R22 H-3: Parse and validate tunnel idle timeout once at module level
const TUNNEL_IDLE_TIMEOUT_MS = parseInt(process.env["TUNNEL_IDLE_TIMEOUT_MS"] ?? "300000", 10);
if (isNaN(TUNNEL_IDLE_TIMEOUT_MS) || TUNNEL_IDLE_TIMEOUT_MS < 10_000 || TUNNEL_IDLE_TIMEOUT_MS > 3_600_000) {
  throw new Error("TUNNEL_IDLE_TIMEOUT_MS must be between 10000 and 3600000");
}

// ─── Error response helper ──────────────────────────────────────────

function sendError(
  res: http.ServerResponse,
  status: number,
  errorCode: string,
  message: string,
  extraHeaders?: Record<string, string>,
): void {
  res.writeHead(status, {
    "Content-Type": "text/plain",
    "X-DominusNode-Error": errorCode,
    ...extraHeaders,
  });
  res.end(message);
}

// ─── HTTP forwarding (plain HTTP PROXY requests) ─────────────────────

async function handleRequest(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  providerSelector: ProviderSelector,
): Promise<void> {
  recordRequest();

  // Geo-check: block sanctioned countries
  const clientIp = (clientReq.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  const blockedCountry = checkSanctionedCountry(clientIp);
  if (blockedCountry) {
    sendError(clientRes, 403, "SANCTIONED_COUNTRY", "Access denied: service unavailable in your region.");
    return;
  }

  // Auth rate limiting
  if (checkAuthRateLimit(clientIp)) {
    sendError(clientRes, 429, "AUTH_RATE_LIMITED", "Too many authentication attempts.", { "Retry-After": "60" });
    return;
  }

  const auth = await authenticateRequest(clientReq);
  if (!auth) {
    recordAuthFailure(clientIp);
    clientRes.writeHead(407, {
      "Proxy-Authenticate": 'Basic realm="Dominus Node Proxy"',
      "Content-Type": "text/plain",
    });
    clientRes.end("Proxy authentication required");
    return;
  }

  // Fetch plan BEFORE provider selection to enforce pool restrictions (R22 H-4)
  const userPlan = await planRepo.getUserPlan(auth.userId);

  // R22 H-4: Enforce allowedProxyTypes BEFORE provider selection — not after
  // This ensures the provider selector receives the correct pool type, preventing
  // DC-only users from consuming residential bandwidth (or vice versa).
  if (userPlan.allowedProxyTypes) {
    const reqType = auth.proxyOptions.proxyType;
    if (reqType === "residential" && userPlan.allowedProxyTypes === "dc") {
      sendError(clientRes, 403, "POOL_RESTRICTED", "Your plan only allows datacenter proxies");
      return;
    }
    if (reqType === "dc" && userPlan.allowedProxyTypes === "residential") {
      sendError(clientRes, 403, "POOL_RESTRICTED", "Your plan only allows residential proxies");
      return;
    }
    // For "auto" or unrecognized, force to the allowed pool
    if (!reqType || reqType === "auto") {
      auth.proxyOptions.proxyType = userPlan.allowedProxyTypes as "dc" | "residential";
    }
  }

  // Provider selection (replaces global circuit breaker check)
  let selected;
  try {
    selected = providerSelector.select(auth.proxyOptions);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("sanctioned")) {
      sendError(clientRes, 403, "SANCTIONED_COUNTRY", msg);
      return;
    }
    if (msg.includes("unavailable")) {
      sendError(clientRes, 503, "ALL_PROVIDERS_DOWN", "Service temporarily unavailable. All upstream proxies are recovering.", { "Retry-After": "30" });
      return;
    }
    throw err;
  }
  const { provider, proxy: upstream } = selected;

  // Per-user connection limit (plan-aware)
  if (!incrementUserConns(auth.userId, userPlan.maxConnections)) {
    sendError(clientRes, 429, "TOO_MANY_CONNECTIONS", "Too many concurrent connections.", { "Retry-After": "5" });
    return;
  }

  // Free plan: skip wallet balance check (bandwidth checked in startSession)
  if (userPlan.pricePerGbCents > 0) {
    const hasBalance = await checkBalance(auth.userId);
    if (!hasBalance) {
      decrementUserConns(auth.userId);
      sendError(clientRes, 402, "INSUFFICIENT_BALANCE", "Insufficient balance. Top up your wallet at the Dominus Node dashboard.");
      return;
    }
  }

  const targetUrl = clientReq.url ?? "/";

  // Strip our Proxy-Authorization before forwarding
  const headers = { ...clientReq.headers };
  delete headers["proxy-authorization"];

  // Byte counting — bytesIn is set after buffering the request body (below)
  const counter: import("./counting-stream.js").ByteCounter = { bytesIn: 0, bytesOut: 0, maxBytes: 0, onLimitExceeded: null };

  const parsedTarget = new URL(targetUrl, "http://localhost");
  const targetHost = parsedTarget.hostname || "unknown";
  const targetPort = parseInt(parsedTarget.port || "80", 10);

  // SSRF protection: validate target is not a private/internal address
  const targetCheck = await validateTarget(targetHost, targetPort);
  if (!targetCheck.allowed) {
    decrementUserConns(auth.userId);
    sendError(clientRes, 403, "TARGET_BLOCKED", targetCheck.reason || "Blocked: target is a private/internal address");
    return;
  }

  // C1+C6 fix: Reserve balance and start session — fails with 402 if insufficient balance
  let sessionId: string;
  try {
    // R20 H-5: Pass proxyType derived from provider name
    // R29 C-2: Pass pre-fetched plan to prevent TOCTOU double-fetch
    const fwdPoolType = provider.name.includes("dc") ? "dc" : "residential";
    sessionId = await startSession(auth.userId, targetHost, counter, 0, fwdPoolType, userPlan, auth.user.log_target_hosts ?? false);
  } catch (err) {
    decrementUserConns(auth.userId);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Insufficient balance")) {
      sendError(clientRes, 402, "INSUFFICIENT_BALANCE", "Insufficient balance. Top up your wallet at the Dominus Node dashboard.");
    } else if (msg.includes("bandwidth limit")) {
      sendError(clientRes, 403, "BANDWIDTH_LIMIT_EXCEEDED", "Monthly bandwidth limit exceeded. Upgrade your plan at the Dominus Node dashboard.");
    } else if (msg.includes("rate limit")) {
      sendError(clientRes, 429, "TOO_MANY_CONNECTIONS", "Session rate limit exceeded. Please slow down.");
    } else {
      log.error("failed to start session", { error: msg });
      clientRes.writeHead(500, { "Content-Type": "text/plain" });
      clientRes.end("Internal proxy error");
    }
    return;
  }

  // C3 fix: Once-guard to prevent double-decrement of user connections
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    unregisterSessionDestroy(sessionId);
    decrementUserConns(auth.userId);
    endSession(sessionId).catch((err) => {
      log.error("failed to end session", { error: err instanceof Error ? err.message : String(err) });
    });
  };

  // R29 C-1: Register session destroy callback for HTTP forwarding sessions.
  // Without this, byte limit enforcement (counter.onLimitExceeded) cannot terminate
  // the response stream, allowing unbounded bandwidth theft.
  registerSessionDestroy(sessionId, () => {
    if (!clientRes.headersSent) {
      clientRes.writeHead(413, { "Content-Type": "text/plain" });
    }
    clientRes.end();
    // Trigger cleanup which ends the session and settles billing
    cleanup();
  });

  // Buffer the client request body so we can replay it on retries
  const bodyChunks: Buffer[] = [];
  let bodySize = 0;
  for await (const chunk of clientReq) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bodySize += buf.length;
    if (bodySize > MAX_BODY_SIZE) {
      clientRes.writeHead(413, { "Content-Type": "text/plain" });
      clientRes.end("Request body too large");
      cleanup();
      return;
    }
    bodyChunks.push(buf);
  }
  const requestBody = Buffer.concat(bodyChunks);
  counter.bytesIn = requestBody.length;

  const reqOptions: http.RequestOptions = {
    hostname: upstream.host,
    port: upstream.port,
    path: targetUrl,
    method: clientReq.method,
    headers: {
      ...headers,
      "Proxy-Authorization": `Basic ${upstream.proxyAuth}`,
    },
    timeout: CONNECT_TIMEOUT_MS,
  };

  const connectStart = Date.now();

  try {
    const { response: proxyRes, retries, totalDelayMs } = await executeWithRetry(
      () => promisifyRequest(reqOptions, requestBody),
      DEFAULT_RETRY_OPTIONS,
    );

    const connectLatencyMs = Date.now() - connectStart;
    recordLatency(connectLatencyMs);
    providerSelector.recordSuccess(provider.name, connectLatencyMs);

    // Count response bytes BEFORE piping to ensure no chunks are missed
    proxyRes.on("data", (chunk: Buffer) => {
      counter.bytesOut += chunk.length;
      // R31 C-2: Check byte limit (parity with CONNECT's attachByteCounters)
      if (counter.maxBytes > 0 && counter.onLimitExceeded &&
          counter.bytesIn + counter.bytesOut > counter.maxBytes) {
        counter.onLimitExceeded();
        counter.onLimitExceeded = null; // fire once
      }
    });

    // R31 H-3: Strip all hop-by-hop headers from upstream response
    const HOP_BY_HOP = new Set([
      "proxy-authenticate", "proxy-authorization", "proxy-connection",
      "connection", "keep-alive", "te", "trailer", "upgrade",
    ]);
    // Also strip headers named in the Connection header value
    const connHeaderVal = (proxyRes.headers["connection"] ?? "").toString();
    const connHeaders = connHeaderVal.split(",").map(h => h.trim().toLowerCase()).filter(Boolean);

    const responseHeaders = { ...proxyRes.headers };
    for (const h of HOP_BY_HOP) delete responseHeaders[h];
    for (const h of connHeaders) delete responseHeaders[h];
    if (retries > 0) {
      responseHeaders["x-dominusnode-retries"] = String(retries);
      responseHeaders["x-dominusnode-retry-after"] = `${totalDelayMs}ms`;
    }

    clientRes.writeHead(proxyRes.statusCode ?? 502, responseHeaders);
    proxyRes.pipe(clientRes, { end: true });

    // R30 C-1: Destroy upstream response if client disconnects mid-stream
    clientRes.on("close", () => {
      if (proxyRes && !proxyRes.destroyed) proxyRes.destroy();
    });

    proxyRes.on("end", cleanup);
    proxyRes.on("error", cleanup);
    proxyRes.on("close", cleanup); // Handle abrupt disconnects (R13 H-3)
  } catch (err) {
    providerSelector.recordFailure(provider.name);
    recordError();
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error("upstream error", { error: sanitizeUpstreamMsg(errMsg), provider: provider.name });
    if (!clientRes.headersSent) {
      if (errMsg.includes("ETIMEDOUT") || errMsg.includes("timeout")) {
        sendError(clientRes, 504, "UPSTREAM_TIMEOUT", "Gateway timeout");
      } else {
        sendError(clientRes, 502, "UPSTREAM_UNAVAILABLE", "Bad gateway");
      }
    }
    cleanup();
  }
}

// ─── HTTPS tunneling (CONNECT method) ────────────────────────────────

async function handleConnect(
  req: http.IncomingMessage,
  clientSocket: net.Socket,
  head: Buffer,
  providerSelector: ProviderSelector,
): Promise<void> {
  recordRequest();

  // Geo-check: block sanctioned countries
  const connectClientIp = (clientSocket.remoteAddress ?? "").replace(/^::ffff:/, "");
  const connectBlockedCountry = checkSanctionedCountry(connectClientIp);
  if (connectBlockedCountry) {
    safeSocketWrite(clientSocket, "HTTP/1.1 403 Forbidden\r\nX-DominusNode-Error: SANCTIONED_COUNTRY\r\n\r\n");
    return;
  }

  // Auth rate limiting
  if (checkAuthRateLimit(connectClientIp)) {
    safeSocketWrite(clientSocket, "HTTP/1.1 429 Too Many Requests\r\nX-DominusNode-Error: AUTH_RATE_LIMITED\r\nRetry-After: 60\r\n\r\n");
    return;
  }

  const auth = await authenticateRequest(req);
  if (!auth) {
    recordAuthFailure(connectClientIp);
    safeSocketWrite(clientSocket,
      "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"Dominus Node Proxy\"\r\n\r\n",
    );
    return;
  }

  // Capture userId and preferences before nested closures (TS can't narrow nullable across closures)
  const userId = auth.userId;
  const connectLogTargetHosts = auth.user.log_target_hosts ?? false;

  // Fetch plan BEFORE provider selection to enforce pool restrictions (R22 H-4)
  const connectPlan = await planRepo.getUserPlan(userId);

  // R22 H-4: Enforce allowedProxyTypes BEFORE provider selection
  if (connectPlan.allowedProxyTypes) {
    const reqType = auth.proxyOptions.proxyType;
    if (reqType === "residential" && connectPlan.allowedProxyTypes === "dc") {
      safeSocketWrite(clientSocket, "HTTP/1.1 403 Forbidden\r\nX-DominusNode-Error: POOL_RESTRICTED\r\n\r\n");
      return;
    }
    if (reqType === "dc" && connectPlan.allowedProxyTypes === "residential") {
      safeSocketWrite(clientSocket, "HTTP/1.1 403 Forbidden\r\nX-DominusNode-Error: POOL_RESTRICTED\r\n\r\n");
      return;
    }
    if (!reqType || reqType === "auto") {
      auth.proxyOptions.proxyType = connectPlan.allowedProxyTypes as "dc" | "residential";
    }
  }

  // Provider selection (replaces global circuit breaker check)
  let selected;
  try {
    selected = providerSelector.select(auth.proxyOptions);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("sanctioned")) {
      safeSocketWrite(clientSocket, "HTTP/1.1 403 Forbidden\r\nX-DominusNode-Error: SANCTIONED_COUNTRY\r\n\r\n");
      return;
    }
    if (msg.includes("unavailable")) {
      safeSocketWrite(clientSocket, "HTTP/1.1 503 Service Unavailable\r\nX-DominusNode-Error: ALL_PROVIDERS_DOWN\r\nRetry-After: 30\r\n\r\n");
      return;
    }
    throw err;
  }
  const { provider, proxy: upstream } = selected;

  // Per-user connection limit (plan-aware)
  if (!incrementUserConns(userId, connectPlan.maxConnections)) {
    safeSocketWrite(clientSocket, "HTTP/1.1 429 Too Many Requests\r\nX-DominusNode-Error: TOO_MANY_CONNECTIONS\r\nRetry-After: 5\r\n\r\n");
    return;
  }

  // Free plan: skip wallet balance check (bandwidth checked in startSession)
  if (connectPlan.pricePerGbCents > 0) {
    const hasBalance = await checkBalance(userId);
    if (!hasBalance) {
      decrementUserConns(userId);
      safeSocketWrite(clientSocket, "HTTP/1.1 402 Payment Required\r\nX-DominusNode-Error: INSUFFICIENT_BALANCE\r\n\r\n");
      return;
    }
  }

  // Parse host:port correctly for both IPv4 (host:port) and IPv6 ([::1]:port)
  const connectUrl = req.url ?? "";
  let targetHost: string;
  let targetPort: number;
  if (connectUrl.startsWith("[")) {
    // IPv6: [::1]:443
    const closeBracket = connectUrl.indexOf("]");
    if (closeBracket === -1) {
      decrementUserConns(userId);
      safeSocketWrite(clientSocket, "HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    targetHost = connectUrl.slice(1, closeBracket); // strip brackets
    // R31 C-1: Strip IPv6 zone ID before validation
    const zoneIdx = targetHost.indexOf("%");
    if (zoneIdx !== -1) {
      targetHost = targetHost.substring(0, zoneIdx);
    }
    const afterBracket = connectUrl.slice(closeBracket + 1);
    targetPort = afterBracket.startsWith(":") ? parseInt(afterBracket.slice(1), 10) : 443;
  } else {
    // IPv4 or hostname: host:port
    const lastColon = connectUrl.lastIndexOf(":");
    if (lastColon === -1) {
      targetHost = connectUrl;
      targetPort = 443;
    } else {
      targetHost = connectUrl.slice(0, lastColon);
      targetPort = parseInt(connectUrl.slice(lastColon + 1), 10);
    }
  }

  // CRLF injection prevention: validate hostname characters
  if (!isValidHostname(targetHost) || !isValidPort(targetPort)) {
    decrementUserConns(userId);
    safeSocketWrite(clientSocket, "HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }

  // SSRF protection: validate target is not a private/internal address
  const connectTargetCheck = await validateTarget(targetHost, targetPort);
  if (!connectTargetCheck.allowed) {
    decrementUserConns(userId);
    safeSocketWrite(clientSocket, "HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }

  // R30 C-2: Defense-in-depth: reject hostnames with control characters before upstream CONNECT
  if (/[\x00-\x1f\x7f]/.test(targetHost)) {
    decrementUserConns(userId);
    safeSocketWrite(clientSocket, "HTTP/1.1 400 Bad Request\r\nX-DominusNode-Error: INVALID_TARGET\r\n\r\n");
    return;
  }

  // Redact full hostname from logs to protect user privacy (show TLD+1 only)
  const redactedHost = (targetHost ?? "").split(".").slice(-2).join(".");
  log.info("CONNECT", { target: `${redactedHost}:${targetPort}`, userId, country: auth.proxyOptions.country, sticky: !!auth.proxyOptions.sessionId, provider: provider.name });

  const connectStart = Date.now();
  const providerName = provider.name;

  // Connect to upstream proxy gateway
  const psSocket = net.connect(upstream.port, upstream.host, () => {
    psSocket.write(
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${targetHost}:${targetPort}\r\n` +
        `Proxy-Authorization: Basic ${upstream.proxyAuth}\r\n` +
        `\r\n`,
    );
  });

  let tunnelEstablished = false;
  let headersParsed = false; // Re-entry guard for header parsing (separate from tunnelEstablished)
  const headerChunks: Buffer[] = [];
  let headerBytesSoFar = 0;

  // Fix #6: Once-guard to prevent double-decrement of user connections
  let decremented = false;
  function safeDecrement(): void {
    if (!decremented) {
      decremented = true;
      decrementUserConns(userId);
    }
  }

  // Named function to handle partial headers
  async function handleUpstreamData(chunk: Buffer): Promise<void> {
    if (headersParsed) return;

    headerChunks.push(chunk);
    headerBytesSoFar += chunk.length;

    if (headerBytesSoFar > 32 * 1024) {
      log.error("upstream response headers too large", { size: headerBytesSoFar, provider: providerName });
      safeSocketWrite(clientSocket, "HTTP/1.1 502 Bad Gateway\r\nX-DominusNode-Error: UPSTREAM_UNAVAILABLE\r\n\r\n");
      psSocket.destroy();
      safeDecrement();
      return;
    }

    // Concatenate all chunks to check for header end
    const fullBuffer = Buffer.concat(headerChunks);
    const headerStr = fullBuffer.toString("utf-8");

    if (!headerStr.includes("\r\n\r\n")) {
      // Haven't received full headers yet — wait for more data
      psSocket.once("data", (nextChunk: Buffer) => {
        handleUpstreamData(nextChunk).catch((err) => {
          log.error("unhandled error in upstream data handler", { error: err instanceof Error ? err.message : String(err), provider: providerName });
          safeSocketWrite(clientSocket, "HTTP/1.1 502 Bad Gateway\r\nX-DominusNode-Error: UPSTREAM_UNAVAILABLE\r\n\r\n");
          psSocket.destroy();
          safeDecrement();
        });
      });
      return;
    }

    const statusLine = headerStr.split("\r\n")[0];

    // R29 C-3: Strict status line check — prevent matching "200" in non-status contexts
    const statusMatch = statusLine.match(/^HTTP\/1\.[01] (\d{3})/);
    if (!statusMatch || statusMatch[1] !== "200") {
      log.error("upstream CONNECT failed", { status: sanitizeUpstreamMsg(statusLine), provider: providerName });
      providerSelector.recordFailure(providerName);
      recordError();
      safeSocketWrite(clientSocket, "HTTP/1.1 502 Bad Gateway\r\nX-DominusNode-Error: UPSTREAM_UNAVAILABLE\r\n\r\n");
      psSocket.destroy();
      safeDecrement();
      return;
    }

    headersParsed = true; // Prevent re-entry into header parsing
    const connectLatencyMs = Date.now() - connectStart;
    recordLatency(connectLatencyMs);
    providerSelector.recordSuccess(providerName, connectLatencyMs);

    // Calculate remaining data correctly from the full concatenated buffer
    const headerEndIdx = fullBuffer.indexOf("\r\n\r\n") + 4;
    const remaining = fullBuffer.slice(headerEndIdx);

    // Set up byte counting BEFORE piping
    const counter = attachByteCounters(clientSocket, psSocket);

    // Start session BEFORE sending 200 to client (billing race condition fix)
    let sessionId: string;
    try {
      // R20 H-5: Pass connectLatencyMs and proxyType derived from provider name
      // R29 C-2: Pass pre-fetched plan to prevent TOCTOU double-fetch
      const poolType = providerName.includes("dc") ? "dc" : "residential";
      sessionId = await startSession(userId, targetHost ?? "unknown", counter, connectLatencyMs, poolType, connectPlan, connectLogTargetHosts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Insufficient balance")) {
        safeSocketWrite(clientSocket, "HTTP/1.1 402 Payment Required\r\nX-DominusNode-Error: INSUFFICIENT_BALANCE\r\n\r\n");
      } else if (msg.includes("bandwidth limit")) {
        safeSocketWrite(clientSocket, "HTTP/1.1 403 Forbidden\r\nX-DominusNode-Error: BANDWIDTH_LIMIT_EXCEEDED\r\n\r\n");
      } else if (msg.includes("rate limit")) {
        safeSocketWrite(clientSocket, "HTTP/1.1 429 Too Many Requests\r\nX-DominusNode-Error: TOO_MANY_CONNECTIONS\r\nRetry-After: 60\r\n\r\n");
      } else {
        log.error("failed to start session", { error: msg });
        safeSocketWrite(clientSocket, "HTTP/1.1 500 Internal Server Error\r\n\r\n");
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
    clearTimeout(handshakeTimeout); // Free timer immediately instead of waiting for socket close

    // Session started successfully - NOW tell the client and start piping
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    if (remaining.length > 0) {
      counter.bytesOut += remaining.length; // Count buffered upstream data
      clientSocket.write(remaining);
    }

    if (head.length > 0) {
      counter.bytesIn += head.length; // Count head buffer from CONNECT handshake
      psSocket.write(head);
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
        log.error("session end failed", { sessionId, error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) });
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
      log.error("unhandled error in upstream data handler", { error: err instanceof Error ? err.message : String(err), provider: providerName });
      safeSocketWrite(clientSocket, "HTTP/1.1 502 Bad Gateway\r\nX-DominusNode-Error: UPSTREAM_UNAVAILABLE\r\n\r\n");
      psSocket.destroy();
      safeDecrement();
    });
  });

  psSocket.on("error", (err) => {
    log.error("upstream socket error", { error: err.message, provider: providerName });
    if (!tunnelEstablished) {
      providerSelector.recordFailure(providerName);
      recordError();
      safeSocketWrite(clientSocket, "HTTP/1.1 502 Bad Gateway\r\nX-DominusNode-Error: UPSTREAM_UNAVAILABLE\r\n\r\n");
      safeDecrement();
    } else {
      if (!clientSocket.destroyed) clientSocket.end();
    }
    psSocket.destroy(); // R24 H-2: Ensure close event fires promptly for session cleanup
  });

  clientSocket.on("error", (err) => {
    log.error("client socket error", { error: err.message });
    if (!psSocket.destroyed) psSocket.destroy();
  });

  // Timeout for upstream handshake
  const handshakeTimeout = setTimeout(() => {
    if (!tunnelEstablished) {
      log.error("upstream handshake timeout", { provider: providerName });
      providerSelector.recordFailure(providerName);
      recordError();
      safeSocketWrite(clientSocket, "HTTP/1.1 504 Gateway Timeout\r\nX-DominusNode-Error: UPSTREAM_TIMEOUT\r\n\r\n");
      psSocket.destroy();
      safeDecrement();
    }
  }, CONNECT_TIMEOUT_MS);

  psSocket.once("close", () => clearTimeout(handshakeTimeout));
  clientSocket.once("close", () => clearTimeout(handshakeTimeout));
}

// ─── Server bootstrap ────────────────────────────────────────────────

import { getStats, getPrometheusMetrics } from "./stats.js";
import { terminateUserSessions } from "./session-manager.js";

export async function startProxyServer(port: number = 8080, providerSelector?: ProviderSelector): Promise<http.Server> {
  await initGeoCheck();

  // Lazily create default provider selector if none provided
  if (!providerSelector) {
    const { createProviderSelector } = await import("@dominusnode/pool-manager");
    providerSelector = createProviderSelector();
  }
  const selector = providerSelector;

  // R18-H4: Derive a separate stats secret from JWT_SECRET using HMAC instead of
  // reusing the raw JWT_SECRET as a Bearer token (prevents JWT signing key exposure)
  const STATS_SECRET = process.env["PROXY_STATS_SECRET"] ??
    (process.env["JWT_SECRET"]
      ? crypto.createHmac("sha256", process.env["JWT_SECRET"]).update("proxy-stats-endpoint").digest("hex")
      : "");

  const server = http.createServer((req, res) => {
    // Internal stats endpoint (localhost + optional shared secret auth)
    if (req.url === "/internal/stats" && req.method === "GET") {
      const remoteIp = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
      const isLoopback = remoteIp === "127.0.0.1" || remoteIp === "::1";
      if (!isLoopback) {
        // Allow non-loopback internal callers only when shared secret auth is configured.
        if (!STATS_SECRET) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden");
          return;
        }
        const authHeader = req.headers["authorization"] ?? "";
        const expected = `Bearer ${STATS_SECRET}`;
        if (authHeader.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))) {
          res.writeHead(401, { "Content-Type": "text/plain" });
          res.end("Unauthorized");
          return;
        }
      }
      const stats = getStats();
      const providerStats = selector.getStats();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...stats, providers: providerStats }));
      return;
    }

    // Prometheus metrics endpoint (same auth as /internal/stats)
    if (req.url === "/metrics" && req.method === "GET") {
      const metricsIp = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
      const metricsLoopback = metricsIp === "127.0.0.1" || metricsIp === "::1";
      if (!metricsLoopback) {
        if (!STATS_SECRET) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden");
          return;
        }
        const authHeader = req.headers["authorization"] ?? "";
        const expected = `Bearer ${STATS_SECRET}`;
        if (authHeader.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))) {
          res.writeHead(401, { "Content-Type": "text/plain" });
          res.end("Unauthorized");
          return;
        }
      }
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(getPrometheusMetrics());
      return;
    }

    // Internal endpoint: terminate all sessions for a user (called by dashboard on admin suspend)
    if (req.url?.startsWith("/internal/terminate-sessions/") && req.method === "POST") {
      const remoteIp = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
      const isLoopback = remoteIp === "127.0.0.1" || remoteIp === "::1";
      if (!isLoopback) {
        if (!STATS_SECRET) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden");
          return;
        }
        const authHeader = req.headers["authorization"] ?? "";
        const expected = `Bearer ${STATS_SECRET}`;
        if (authHeader.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))) {
          res.writeHead(401, { "Content-Type": "text/plain" });
          res.end("Unauthorized");
          return;
        }
      }
      const userId = req.url.replace("/internal/terminate-sessions/", "");
      if (!/^[0-9a-f-]{36}$/i.test(userId)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid user ID");
        return;
      }
      terminateUserSessions(userId).then((count) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ terminated: count }));
      }).catch((err) => {
        log.error("session termination failed", { userId, error: err instanceof Error ? err.message : String(err) });
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal error");
      });
      return;
    }

    handleRequest(req, res, selector).catch((err) => {
      log.error("unhandled request error", { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
      }
      res.end("Internal proxy error");
    });
  });

  server.on("connect", (req, socket: net.Socket, head) => {
    handleConnect(req, socket, head, selector).catch((err) => {
      log.error("unhandled connect error", { error: err instanceof Error ? err.message : String(err) });
      if (!socket.destroyed) {
        socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
        socket.end();
      }
    });
  });

  // Connection limits and timeouts
  server.maxConnections = MAX_CONNECTIONS;
  server.timeout = 300_000; // 5 minute total timeout
  server.keepAliveTimeout = 60_000;

  server.listen(port, () => {
    log.info(`proxy gateway listening on port ${port}`, { maxConnections: MAX_CONNECTIONS, providers: selector.getProviderCount() });
  });

  return server;
}
