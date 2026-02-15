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
import { recordRequest, recordError, recordLatency } from "./stats.js";

const log = createLogger("proxy:server");

/** Strip potential credentials from upstream status lines or error messages */
function sanitizeUpstreamMsg(msg: string): string {
  // Remove Basic auth tokens, Bearer tokens, and common credential patterns
  return msg
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/Proxy-Authorization:\s*[^\r\n]*/gi, "Proxy-Authorization: [REDACTED]");
}

const MAX_CONNECTIONS = parseInt(process.env["PROXY_MAX_CONNECTIONS"] ?? "5000", 10);

// Validate config at module load
if (isNaN(MAX_CONNECTIONS) || MAX_CONNECTIONS <= 0) {
  throw new Error("PROXY_MAX_CONNECTIONS must be a positive integer");
}

const MAX_BODY_SIZE = 50 * 1024 * 1024; // 50MB
const CONNECT_TIMEOUT_MS = parseInt(process.env["PROXY_CONNECT_TIMEOUT_MS"] ?? "30000", 10);

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

  // Fetch plan for per-plan connection limits and free plan balance bypass
  const userPlan = await planRepo.getUserPlan(auth.userId);

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
  const counter = { bytesIn: 0, bytesOut: 0 };

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
    sessionId = await startSession(auth.userId, targetHost, counter);
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
    decrementUserConns(auth.userId);
    endSession(sessionId).catch((err) => {
      log.error("failed to end session", { error: err instanceof Error ? err.message : String(err) });
    });
  };

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
    });

    // Build response headers, stripping proxy hop-by-hop headers injected by upstream
    const responseHeaders = { ...proxyRes.headers };
    // Strip headers that upstream proxy (PacketStream) may inject — these should
    // not be forwarded to the client as they could override security policies
    delete responseHeaders["proxy-authenticate"];
    delete responseHeaders["proxy-authorization"];
    delete responseHeaders["proxy-connection"];
    if (retries > 0) {
      responseHeaders["x-dominusnode-retries"] = String(retries);
      responseHeaders["x-dominusnode-retry-after"] = `${totalDelayMs}ms`;
    }

    clientRes.writeHead(proxyRes.statusCode ?? 502, responseHeaders);
    proxyRes.pipe(clientRes, { end: true });

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
    clientSocket.write("HTTP/1.1 403 Forbidden\r\nX-DominusNode-Error: SANCTIONED_COUNTRY\r\n\r\n");
    clientSocket.end();
    return;
  }

  // Auth rate limiting
  if (checkAuthRateLimit(connectClientIp)) {
    clientSocket.write("HTTP/1.1 429 Too Many Requests\r\nX-DominusNode-Error: AUTH_RATE_LIMITED\r\nRetry-After: 60\r\n\r\n");
    clientSocket.end();
    return;
  }

  const auth = await authenticateRequest(req);
  if (!auth) {
    recordAuthFailure(connectClientIp);
    clientSocket.write(
      "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"Dominus Node Proxy\"\r\n\r\n",
    );
    clientSocket.end();
    return;
  }

  // Provider selection (replaces global circuit breaker check)
  let selected;
  try {
    selected = providerSelector.select(auth.proxyOptions);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("sanctioned")) {
      clientSocket.write("HTTP/1.1 403 Forbidden\r\nX-DominusNode-Error: SANCTIONED_COUNTRY\r\n\r\n");
      clientSocket.end();
      return;
    }
    if (msg.includes("unavailable")) {
      clientSocket.write("HTTP/1.1 503 Service Unavailable\r\nX-DominusNode-Error: ALL_PROVIDERS_DOWN\r\nRetry-After: 30\r\n\r\n");
      clientSocket.end();
      return;
    }
    throw err;
  }
  const { provider, proxy: upstream } = selected;

  // Capture userId before nested closures (TS can't narrow nullable across closures)
  const userId = auth.userId;

  // Fetch plan for per-plan connection limits and free plan balance bypass
  const connectPlan = await planRepo.getUserPlan(userId);

  // Per-user connection limit (plan-aware)
  if (!incrementUserConns(userId, connectPlan.maxConnections)) {
    clientSocket.write("HTTP/1.1 429 Too Many Requests\r\nX-DominusNode-Error: TOO_MANY_CONNECTIONS\r\nRetry-After: 5\r\n\r\n");
    clientSocket.end();
    return;
  }

  // Free plan: skip wallet balance check (bandwidth checked in startSession)
  if (connectPlan.pricePerGbCents > 0) {
    const hasBalance = await checkBalance(userId);
    if (!hasBalance) {
      decrementUserConns(userId);
      clientSocket.write("HTTP/1.1 402 Payment Required\r\nX-DominusNode-Error: INSUFFICIENT_BALANCE\r\n\r\n");
      clientSocket.end();
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
      clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      clientSocket.end();
      return;
    }
    targetHost = connectUrl.slice(1, closeBracket); // strip brackets
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
    clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    clientSocket.end();
    return;
  }

  // SSRF protection: validate target is not a private/internal address
  const connectTargetCheck = await validateTarget(targetHost, targetPort);
  if (!connectTargetCheck.allowed) {
    decrementUserConns(userId);
    clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    clientSocket.end();
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
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\nX-DominusNode-Error: UPSTREAM_UNAVAILABLE\r\n\r\n");
      clientSocket.end();
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
          clientSocket.write("HTTP/1.1 502 Bad Gateway\r\nX-DominusNode-Error: UPSTREAM_UNAVAILABLE\r\n\r\n");
          clientSocket.end();
          psSocket.destroy();
          safeDecrement();
        });
      });
      return;
    }

    const statusLine = headerStr.split("\r\n")[0];

    if (!statusLine.includes("200")) {
      log.error("upstream CONNECT failed", { status: sanitizeUpstreamMsg(statusLine), provider: providerName });
      providerSelector.recordFailure(providerName);
      recordError();
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\nX-DominusNode-Error: UPSTREAM_UNAVAILABLE\r\n\r\n");
      clientSocket.end();
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
      sessionId = await startSession(userId, targetHost ?? "unknown", counter);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Insufficient balance")) {
        clientSocket.write("HTTP/1.1 402 Payment Required\r\nX-DominusNode-Error: INSUFFICIENT_BALANCE\r\n\r\n");
      } else if (msg.includes("bandwidth limit")) {
        clientSocket.write("HTTP/1.1 403 Forbidden\r\nX-DominusNode-Error: BANDWIDTH_LIMIT_EXCEEDED\r\n\r\n");
      } else if (msg.includes("rate limit")) {
        clientSocket.write("HTTP/1.1 429 Too Many Requests\r\nX-DominusNode-Error: TOO_MANY_CONNECTIONS\r\nRetry-After: 60\r\n\r\n");
      } else {
        log.error("failed to start session", { error: msg });
        clientSocket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
      }
      safeDecrement();
      clientSocket.end();
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
    const TUNNEL_IDLE_TIMEOUT_MS = parseInt(process.env["TUNNEL_IDLE_TIMEOUT_MS"] ?? "300000", 10);
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
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\nX-DominusNode-Error: UPSTREAM_UNAVAILABLE\r\n\r\n");
      clientSocket.end();
      psSocket.destroy();
      safeDecrement();
    });
  });

  psSocket.on("error", (err) => {
    log.error("upstream socket error", { error: err.message, provider: providerName });
    if (!tunnelEstablished) {
      providerSelector.recordFailure(providerName);
      recordError();
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\nX-DominusNode-Error: UPSTREAM_UNAVAILABLE\r\n\r\n");
      safeDecrement();
    }
    clientSocket.end();
  });

  clientSocket.on("error", (err) => {
    log.error("client socket error", { error: err.message });
    psSocket.destroy();
  });

  // Timeout for upstream handshake
  const handshakeTimeout = setTimeout(() => {
    if (!tunnelEstablished) {
      log.error("upstream handshake timeout", { provider: providerName });
      providerSelector.recordFailure(providerName);
      recordError();
      clientSocket.write("HTTP/1.1 504 Gateway Timeout\r\nX-DominusNode-Error: UPSTREAM_TIMEOUT\r\n\r\n");
      clientSocket.end();
      psSocket.destroy();
      safeDecrement();
    }
  }, CONNECT_TIMEOUT_MS);

  psSocket.once("close", () => clearTimeout(handshakeTimeout));
  clientSocket.once("close", () => clearTimeout(handshakeTimeout));
}

// ─── Server bootstrap ────────────────────────────────────────────────

import { getStats } from "./stats.js";
import { terminateUserSessions } from "./session-manager.js";

export async function startProxyServer(port: number = 8080, providerSelector?: ProviderSelector): Promise<http.Server> {
  await initGeoCheck();

  // Lazily create default provider selector if none provided
  if (!providerSelector) {
    const { createProviderSelector } = await import("@dominusnode/pool-manager");
    providerSelector = createProviderSelector();
  }
  const selector = providerSelector;

  const STATS_SECRET = process.env["PROXY_STATS_SECRET"] ?? process.env["JWT_SECRET"] ?? "";

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
      socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
      socket.end();
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
