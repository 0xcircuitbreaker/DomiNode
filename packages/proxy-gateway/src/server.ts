import * as http from "node:http";
import * as net from "node:net";
import { createLogger } from "@dominode/shared";
import { buildUpstreamProxy } from "@dominode/pool-manager";
import { authenticateRequest } from "./auth.js";
import { checkBalance } from "./balance-check.js";
import { attachByteCounters } from "./counting-stream.js";
import { startSession, endSession, getActiveSessionCount } from "./session-manager.js";
import { checkSanctionedCountry, initGeoCheck } from "./geo-check.js";
import { executeWithRetry, promisifyRequest, DEFAULT_RETRY_OPTIONS } from "./retry.js";

const log = createLogger("proxy:server");

const MAX_CONNECTIONS = parseInt(process.env["PROXY_MAX_CONNECTIONS"] ?? "5000", 10);
const MAX_PER_USER = parseInt(process.env["PROXY_MAX_PER_USER"] ?? "100", 10);

// Validate config at module load
if (isNaN(MAX_CONNECTIONS) || MAX_CONNECTIONS <= 0) {
  throw new Error("PROXY_MAX_CONNECTIONS must be a positive integer");
}
if (isNaN(MAX_PER_USER) || MAX_PER_USER <= 0) {
  throw new Error("PROXY_MAX_PER_USER must be a positive integer");
}

const userConnectionCounts = new Map<string, number>();

// Track failed auth attempts per IP for rate limiting
const authFailures = new Map<string, { count: number; firstAt: number }>();
const AUTH_FAIL_WINDOW_MS = 60_000; // 1 minute
const AUTH_FAIL_MAX = 20; // 20 failures per minute per IP

function checkAuthRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = authFailures.get(ip);
  if (!entry || now - entry.firstAt > AUTH_FAIL_WINDOW_MS) {
    return true; // allowed
  }
  return entry.count < AUTH_FAIL_MAX;
}

function recordAuthFailure(ip: string): void {
  const now = Date.now();
  const entry = authFailures.get(ip);
  if (!entry || now - entry.firstAt > AUTH_FAIL_WINDOW_MS) {
    authFailures.set(ip, { count: 1, firstAt: now });
  } else {
    entry.count++;
  }
}

// Cleanup auth failure map every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of authFailures) {
    if (now - entry.firstAt > AUTH_FAIL_WINDOW_MS) {
      authFailures.delete(ip);
    }
  }
}, 300_000).unref();

function incrementUserConns(userId: string): boolean {
  const current = userConnectionCounts.get(userId) ?? 0;
  if (current >= MAX_PER_USER) return false;
  userConnectionCounts.set(userId, current + 1);
  return true;
}

function decrementUserConns(userId: string): void {
  const current = userConnectionCounts.get(userId) ?? 0;
  if (current <= 1) {
    userConnectionCounts.delete(userId);
  } else {
    userConnectionCounts.set(userId, current - 1);
  }
}

// ─── HTTP forwarding (plain HTTP PROXY requests) ─────────────────────

async function handleRequest(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
): Promise<void> {
  // Geo-check: block sanctioned countries
  const clientIp = (clientReq.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  const blockedCountry = checkSanctionedCountry(clientIp);
  if (blockedCountry) {
    clientRes.writeHead(403, { "Content-Type": "text/plain" });
    clientRes.end("Access denied: service unavailable in your region.");
    return;
  }

  // Auth rate limiting
  if (!checkAuthRateLimit(clientIp)) {
    clientRes.writeHead(429, { "Content-Type": "text/plain" });
    clientRes.end("Too many authentication attempts.");
    return;
  }

  const auth = await authenticateRequest(clientReq);
  if (!auth) {
    recordAuthFailure(clientIp);
    clientRes.writeHead(407, {
      "Proxy-Authenticate": 'Basic realm="DomiNode Proxy"',
      "Content-Type": "text/plain",
    });
    clientRes.end("Proxy authentication required");
    return;
  }

  // Per-user connection limit
  if (!incrementUserConns(auth.userId)) {
    clientRes.writeHead(429, { "Content-Type": "text/plain" });
    clientRes.end("Too many concurrent connections.");
    return;
  }

  const hasBalance = await checkBalance(auth.userId);
  if (!hasBalance) {
    decrementUserConns(auth.userId);
    clientRes.writeHead(402, { "Content-Type": "text/plain" });
    clientRes.end("Insufficient balance. Top up your wallet at the DomiNode dashboard.");
    return;
  }

  const upstream = buildUpstreamProxy(auth.proxyOptions);
  const targetUrl = clientReq.url ?? "/";

  // Strip our Proxy-Authorization before forwarding
  const headers = { ...clientReq.headers };
  delete headers["proxy-authorization"];

  // Byte counting — bytesIn is set after buffering the request body (below)
  const counter = { bytesIn: 0, bytesOut: 0 };

  const targetHost = new URL(targetUrl, "http://localhost").hostname || "unknown";

  // C1+C6 fix: Reserve balance and start session — fails with 402 if insufficient balance
  let sessionId: string;
  try {
    sessionId = await startSession(auth.userId, targetHost, counter);
  } catch (err) {
    decrementUserConns(auth.userId);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Insufficient balance")) {
      clientRes.writeHead(402, { "Content-Type": "text/plain" });
      clientRes.end("Insufficient balance. Top up your wallet at the DomiNode dashboard.");
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
  for await (const chunk of clientReq) {
    bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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
    timeout: 30_000,
  };

  try {
    const { response: proxyRes, retries, totalDelayMs } = await executeWithRetry(
      () => promisifyRequest(reqOptions, requestBody),
      DEFAULT_RETRY_OPTIONS,
    );

    // Count response bytes BEFORE piping to ensure no chunks are missed
    proxyRes.on("data", (chunk: Buffer) => {
      counter.bytesOut += chunk.length;
    });

    // Build response headers, adding retry info
    const responseHeaders = { ...proxyRes.headers };
    if (retries > 0) {
      responseHeaders["x-dominode-retries"] = String(retries);
      responseHeaders["x-dominode-retry-after"] = `${totalDelayMs}ms`;
    }

    clientRes.writeHead(proxyRes.statusCode ?? 502, responseHeaders);
    proxyRes.pipe(clientRes, { end: true });

    proxyRes.on("end", cleanup);
    proxyRes.on("error", cleanup);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error("upstream error", { error: errMsg, target: targetUrl });
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { "Content-Type": "text/plain" });
    }
    clientRes.end("Bad gateway");
    cleanup();
  }
}

// ─── HTTPS tunneling (CONNECT method) ────────────────────────────────

async function handleConnect(
  req: http.IncomingMessage,
  clientSocket: net.Socket,
  head: Buffer,
): Promise<void> {
  // Geo-check: block sanctioned countries
  const connectClientIp = (clientSocket.remoteAddress ?? "").replace(/^::ffff:/, "");
  const connectBlockedCountry = checkSanctionedCountry(connectClientIp);
  if (connectBlockedCountry) {
    clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    clientSocket.end();
    return;
  }

  // Auth rate limiting
  if (!checkAuthRateLimit(connectClientIp)) {
    clientSocket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
    clientSocket.end();
    return;
  }

  const auth = await authenticateRequest(req);
  if (!auth) {
    recordAuthFailure(connectClientIp);
    clientSocket.write(
      "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"DomiNode Proxy\"\r\n\r\n",
    );
    clientSocket.end();
    return;
  }

  // Capture userId before nested closures (TS can't narrow nullable across closures)
  const userId = auth.userId;

  // Per-user connection limit
  if (!incrementUserConns(userId)) {
    clientSocket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
    clientSocket.end();
    return;
  }

  const hasBalance = await checkBalance(userId);
  if (!hasBalance) {
    decrementUserConns(userId);
    clientSocket.write("HTTP/1.1 402 Payment Required\r\n\r\n");
    clientSocket.end();
    return;
  }

  const [targetHost, targetPortStr] = (req.url ?? "").split(":");
  const targetPort = parseInt(targetPortStr ?? "443", 10);

  const upstream = buildUpstreamProxy(auth.proxyOptions);

  log.info("CONNECT", { target: `${targetHost}:${targetPort}`, userId, country: auth.proxyOptions.country, sticky: !!auth.proxyOptions.sessionId });

  // Connect to PacketStream gateway
  const psSocket = net.connect(upstream.port, upstream.host, () => {
    // Send CONNECT to PacketStream
    psSocket.write(
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${targetHost}:${targetPort}\r\n` +
        `Proxy-Authorization: Basic ${upstream.proxyAuth}\r\n` +
        `\r\n`,
    );
  });

  let tunnelEstablished = false;
  // C5 fix: Use Buffer array to track all received chunks and their byte offsets
  const headerChunks: Buffer[] = [];
  let headerBytesSoFar = 0;

  // Named function to handle partial headers
  function handleUpstreamData(chunk: Buffer): void {
    if (tunnelEstablished) return;

    headerChunks.push(chunk);
    headerBytesSoFar += chunk.length;

    // Concatenate all chunks to check for header end
    const fullBuffer = Buffer.concat(headerChunks);
    const headerStr = fullBuffer.toString("utf-8");

    if (!headerStr.includes("\r\n\r\n")) {
      // Haven't received full headers yet — wait for more data
      psSocket.once("data", handleUpstreamData);
      return;
    }

    const statusLine = headerStr.split("\r\n")[0];

    if (!statusLine.includes("200")) {
      log.error("PacketStream CONNECT failed", { status: statusLine });
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      clientSocket.end();
      psSocket.destroy();
      decrementUserConns(userId);
      return;
    }

    tunnelEstablished = true;

    // Tell client tunnel is established
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    // C5 fix: Calculate remaining data correctly from the full concatenated buffer
    const headerEndIdx = fullBuffer.indexOf("\r\n\r\n") + 4;
    const remaining = fullBuffer.slice(headerEndIdx);
    if (remaining.length > 0) {
      clientSocket.write(remaining);
    }

    // Write head buffer from original CONNECT request
    if (head.length > 0) {
      psSocket.write(head);
    }

    // Set up byte counting
    const counter = attachByteCounters(clientSocket, psSocket);

    // Start piping
    psSocket.pipe(clientSocket);
    clientSocket.pipe(psSocket);

    // Track session with once-guard cleanup
    startSession(userId, targetHost ?? "unknown", counter)
      .then((sessionId) => {
        let cleanedUp = false;
        const cleanup = () => {
          if (cleanedUp) return;
          cleanedUp = true;
          decrementUserConns(userId);
          endSession(sessionId).catch((err) => {
            log.error("session end failed", { sessionId, error: err instanceof Error ? err.message : String(err) });
          });
        };

        clientSocket.on("end", cleanup);
        clientSocket.on("error", cleanup);
        psSocket.on("end", cleanup);
        psSocket.on("error", cleanup);
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("Insufficient balance")) {
          clientSocket.write("HTTP/1.1 402 Payment Required\r\n\r\n");
        } else {
          log.error("failed to start session", { error: msg });
          clientSocket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
        }
        decrementUserConns(userId);
        clientSocket.end();
        psSocket.destroy();
      });
  }

  psSocket.once("data", handleUpstreamData);

  psSocket.on("error", (err) => {
    log.error("PacketStream socket error", { error: err.message });
    if (!tunnelEstablished) {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      decrementUserConns(userId);
    }
    clientSocket.end();
  });

  clientSocket.on("error", (err) => {
    log.error("client socket error", { error: err.message });
    psSocket.destroy();
  });

  // Timeout for PacketStream handshake
  const handshakeTimeout = setTimeout(() => {
    if (!tunnelEstablished) {
      log.error("PacketStream handshake timeout");
      clientSocket.write("HTTP/1.1 504 Gateway Timeout\r\n\r\n");
      clientSocket.end();
      psSocket.destroy();
      decrementUserConns(userId);
    }
  }, 30_000);

  psSocket.once("close", () => clearTimeout(handshakeTimeout));
  clientSocket.once("close", () => clearTimeout(handshakeTimeout));
}

// ─── Server bootstrap ────────────────────────────────────────────────

export async function startProxyServer(port: number = 8080): Promise<http.Server> {
  await initGeoCheck();

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      log.error("unhandled request error", { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
      }
      res.end("Internal proxy error");
    });
  });

  server.on("connect", (req, socket: net.Socket, head) => {
    handleConnect(req, socket, head).catch((err) => {
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
    log.info(`proxy gateway listening on port ${port}`, { maxConnections: MAX_CONNECTIONS, maxPerUser: MAX_PER_USER });
  });

  return server;
}
