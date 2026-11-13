import * as crypto from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import { createLogger, planRepo, resolveRequestId, runWithRequestId, pqTlsOptions } from "@dominusnode/shared";
import type { ExitClass } from "@dominusnode/shared";
import { checkAgenticWalletPolicy } from "./wallet-policy.js";
import type { Duplex } from "node:stream";
import { authenticateRequest, type AuthResult } from "./auth.js";
import { checkBalance, checkTeamBalance } from "./balance-check.js";
import { bindTunnelLifecycle } from "./tunnel-lifecycle.js";
import { attachByteCounters, capReadable, type ByteCounter } from "./counting-stream.js";
import { startSession, startPrepaidSession, abortPrepaidSession, endSession, registerSessionDestroy, unregisterSessionDestroy, type RelayBinding } from "./session-manager.js";
import { checkClientCountry, initGeoCheck } from "./geo-check.js";
import { validateTarget, isValidHostname, isValidPort } from "./target-validator.js";
import { incrementUserConns, decrementUserConns } from "./connection-tracker.js";
import { checkAuthRateLimit, recordAuthFailure } from "./auth-rate-limit.js";
import { recordRequest, recordError, recordLatency } from "./stats.js";
import { handleX402Http, handleX402Connect, build402ResponseBody, build402ConnectResponse, isX402Verified, getX402Data, settleX402Pending, releaseX402Pending, refundX402Payer, hasMppCredential, normalizePayer, paymentChallengeHeaders, toX402Class, selectClassFor, nodeMatchesQuotedClass } from "./x402-handler.js";
import { checkRequesterAccess, checkAnonymousPayer } from "./access-gate.js";
import { enforcePolicy, isPlaintextPort, EXIT_VISIBLE_HEADER } from "./policy-enforcer.js";
import { openRelayStream, RelayOpenError, type RelayRuntime, type RelayUpstream } from "./relay.js";
import type { SelectOpts } from "./node-tunnel/selector.js";
import type { LiveNode } from "./node-tunnel/registry.js";
import type { X402ConnectResult } from "./x402-handler.js";
import type { PlaintextAuthGuard } from "./proxy-tls.js";

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

/** Write to socket only if not destroyed, then end */
/** Request id per CONNECT socket, echoed on every raw response line written to it. */
const socketRequestIds = new WeakMap<net.Socket, string>();

/** Insert X-Request-Id after the status line of a raw HTTP response. */
export function withRequestIdHeader(data: string, requestId: string | undefined): string {
  if (!requestId || !data.startsWith("HTTP/1.") || /\r\nX-Request-Id:/i.test(data)) return data;
  const i = data.indexOf("\r\n");
  if (i < 0) return data;
  return data.slice(0, i + 2) + `X-Request-Id: ${requestId}\r\n` + data.slice(i + 2);
}

function safeSocketWrite(socket: net.Socket, data: string): void {
  if (!socket.destroyed) {
    socket.write(withRequestIdHeader(data, socketRequestIds.get(socket)));
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
if (isNaN(CONNECT_TIMEOUT_MS) || CONNECT_TIMEOUT_MS < 1_000 || CONNECT_TIMEOUT_MS > 120_000) {
  throw new Error("PROXY_CONNECT_TIMEOUT_MS must be between 1000 and 120000");
}

// Parse and validate tunnel idle timeout once at module level
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


// ─── Relay helpers ───────────────────────────────────────────────────

/**
 * x402 on the relay (DESIGN.md §7): the payer is mapped to a wallet-identity
 * user, the request runs as a prepaid relay session and settles through
 * settleRelayCharge(rail "x402"). X402_RELAY_ENABLED=false is a kill switch
 * that refuses x402 BEFORE verification so payers are never charged.
 */
export const X402_RELAY_ENABLED = process.env["X402_RELAY_ENABLED"] !== "false";

function x402Binding(node: LiveNode, port: number, payer: string, stream: Duplex): RelayBinding {
  return {
    nodeId: node.nodeId,
    ipClass: node.ipClass,
    nodeOwnerUserId: node.ownerUserId,
    destPort: port,
    requesterWallet: /^0x[0-9a-fA-F]{40}$|^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(payer) ? normalizePayer(payer) : null,
    nodeBytes: () => {
      const rep = (stream as { nodeReport?: { bytesIn: number; bytesOut: number } | null }).nodeReport;
      return rep ? BigInt(rep.bytesIn) + BigInt(rep.bytesOut) : null;
    },
  };
}

function x402RelayUnavailableBody(): string {
  return JSON.stringify({
    error: "X402_RELAY_UNAVAILABLE",
    message: "x402 payments are temporarily unavailable on the relay network. Use an API key.",
  });
}

/** Host header value for an absolute-form target (brackets IPv6, omits :80). */
export function hostHeaderFor(host: string, port: number): string {
  const h = host.includes(":") ? `[${host}]` : host;
  return port === 80 ? h : `${h}:${port}`;
}

/**
 * Meter every byte that crosses a relay stream (request line, headers, body
 * and the full response) so billing matches what the node carried.
 * Writes count as bytesIn (requester -> target), reads as bytesOut.
 */
export function meterStream(stream: Duplex, counter: ByteCounter): void {
  let fired = false;
  const fire = (): void => {
    if (fired || counter.maxBytes <= 0 || !counter.onLimitExceeded) return;
    fired = true;
    counter.onLimitExceeded();
  };
  const origWrite = stream.write.bind(stream) as (...args: unknown[]) => boolean;
  (stream as { write: (...args: unknown[]) => boolean }).write = (...args: unknown[]): boolean => {
    const chunk = args[0];
    let len = 0;
    if (typeof chunk === "string") {
      len = Buffer.byteLength(chunk, typeof args[1] === "string" ? (args[1] as BufferEncoding) : "utf8");
    } else if (chunk instanceof Uint8Array) {
      len = chunk.length;
    }
    // Refuse (and never bill) a write that would cross the cap.
    if (counter.maxBytes > 0 && counter.bytesIn + counter.bytesOut + len > counter.maxBytes) {
      fire();
      return false;
    }
    counter.bytesIn += len;
    return origWrite(...args);
  };
  // Reads: truncate at the cap before the chunk enters the stream, so only
  // delivered bytes are counted.
  capReadable(stream, () => counter.bytesIn + counter.bytesOut, (n) => { counter.bytesOut += n; }, () => counter.maxBytes, fire);
}

const HOP_BY_HOP_REQUEST = new Set([
  "proxy-authorization", "proxy-connection", "connection",
  "keep-alive", "te", "trailer", "upgrade", "transfer-encoding",
]);
const HOP_BY_HOP_RESPONSE = new Set([
  "proxy-authenticate", "proxy-authorization", "proxy-connection",
  "connection", "keep-alive", "te", "trailer", "upgrade",
]);

function clientIpOf(socket: net.Socket): string {
  return (socket.remoteAddress ?? "").replace(/^::ffff:/, "");
}

function relaySelectOpts(
  auth: AuthResult | null,
  requesterKey: string,
  clientIp: string,
  host: string,
  port: number,
  ipClass?: ExitClass,
): SelectOpts {
  const o = auth?.proxyOptions;
  return {
    country: o?.country,
    ipClass: o?.ipClass ?? ipClass,
    requesterUserId: auth?.userId ?? requesterKey,
    requesterWallet: auth?.user.wallet_address ?? undefined,
    requesterTeamId: auth?.teamId ?? undefined,
    clientIp,
    targetHost: host,
    port,
    sticky: o?.sessionId,
  };
}

function relayBinding(auth: AuthResult, node: LiveNode, port: number, stream?: Duplex): RelayBinding {
  return {
    nodeId: node.nodeId,
    ipClass: node.ipClass,
    nodeOwnerUserId: node.ownerUserId,
    destPort: port,
    requesterWallet: auth.user.wallet_address ?? null,
    nodeBytes: () => {
      const rep = (stream as { nodeReport?: { bytesIn: number; bytesOut: number } | null } | undefined)?.nodeReport;
      return rep ? BigInt(rep.bytesIn) + BigInt(rep.bytesOut) : null;
    },
  };
}

function relayErrorOf(err: unknown): RelayOpenError {
  return err instanceof RelayOpenError ? err : new RelayOpenError(502, "UPSTREAM_UNAVAILABLE", "Bad gateway");
}

function connectErrorLine(e: RelayOpenError): string {
  const text = http.STATUS_CODES[e.status] ?? "Error";
  const retry = e.status === 503 ? "Retry-After: 30\r\n" : "";
  return `HTTP/1.1 ${e.status} ${text}\r\nX-DominusNode-Error: ${e.code}\r\n${retry}\r\n`;
}

/** Parse an absolute-form proxy request URL; only http: targets are accepted. */
function parseForwardTarget(rawUrl: string): { host: string; port: number; path: string } | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "http:") return null;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const port = u.port ? parseInt(u.port, 10) : 80;
  if (!host) return null;
  return { host, port, path: `${u.pathname || "/"}${u.search}` };
}

/** Parse CONNECT authority-form host:port (IPv6 bracketed). */
function parseConnectTarget(connectUrl: string): { host: string; port: number } | null {
  if (connectUrl.startsWith("[")) {
    const closeBracket = connectUrl.indexOf("]");
    if (closeBracket === -1) return null;
    let host = connectUrl.slice(1, closeBracket);
    const zoneIdx = host.indexOf("%");
    if (zoneIdx !== -1) host = host.substring(0, zoneIdx);
    const after = connectUrl.slice(closeBracket + 1);
    return { host, port: after.startsWith(":") ? parseInt(after.slice(1), 10) : 443 };
  }
  const lastColon = connectUrl.lastIndexOf(":");
  if (lastColon === -1) return { host: connectUrl, port: 443 };
  return { host: connectUrl.slice(0, lastColon), port: parseInt(connectUrl.slice(lastColon + 1), 10) };
}

/** Send one origin-form HTTP/1.1 request over an open relay stream. */
function requestOverStream(
  stream: Duplex,
  method: string,
  path: string,
  headers: http.OutgoingHttpHeaders,
  body: Buffer,
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    // Mux streams are plain Duplexes (no setTimeout/setNoDelay): time the
    // response head ourselves instead of using the socket timeout option.
    const timer = setTimeout(() => req.destroy(new Error("upstream timeout")), CONNECT_TIMEOUT_MS);
    // One-shot agent whose only "connection" is the relay stream.
    const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
    agent.createConnection = () => stream as unknown as net.Socket;
    const req = http.request({
      method,
      path,
      headers,
      agent,
      setHost: false,
    }, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end(body.length > 0 ? body : undefined);
  });
}

async function readBody(req: http.IncomingMessage): Promise<Buffer | "too_large"> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_BODY_SIZE) return "too_large";
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

// ─── HTTP forwarding (plain HTTP PROXY requests) ─────────────────────

async function handleRequest(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  relay: RelayRuntime,
): Promise<void> {
  recordRequest();

  // Geo-check: block sanctioned countries
  const clientIp = clientIpOf(clientReq.socket);
  const blockedCountry = checkClientCountry(clientIp);
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
    const paidAttempt = !!clientReq.headers["x-payment"] || hasMppCredential(clientReq.headers);
    if (paidAttempt && !X402_RELAY_ENABLED) {
      clientRes.writeHead(503, { "Content-Type": "application/json", "X-DominusNode-Error": "X402_RELAY_UNAVAILABLE", "Retry-After": "3600" });
      clientRes.end(x402RelayUnavailableBody());
      return;
    }
    if (paidAttempt) {
      // policy.allowAnonymousPayers: refuse BEFORE verification so the payer is never charged
      const anon = checkAnonymousPayer(relay.getPolicy());
      if (!anon.allowed) {
        sendError(clientRes, anon.status, anon.code, anon.message);
        return;
      }
      const x402Handled = await handleX402Http(clientReq, clientRes);
      if (x402Handled && !isX402Verified(clientReq)) return;
    }
    if (!isX402Verified(clientReq)) {
      recordAuthFailure(clientIp);
      clientRes.writeHead(407, {
        "Proxy-Authenticate": 'Basic realm="Dominus Node Proxy"',
        "Content-Type": "text/plain",
      });
      clientRes.end("Proxy authentication required");
      return;
    }
  }

  const target = parseForwardTarget(clientReq.url ?? "");
  if (!target || !isValidHostname(target.host) || !isValidPort(target.port)) {
    sendError(clientRes, 400, "INVALID_TARGET", "Bad request: absolute http:// URL required");
    return;
  }
  const targetHost = target.host;
  const targetPort = target.port;

  // ─── x402 path: no user account, skip plan/balance/session ────────
  const x402Data = getX402Data(clientReq);
  if (x402Data && !auth) {
    const X402_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
    if (!X402_SAFE_METHODS.has((clientReq.method ?? "").toUpperCase())) {
      await releaseX402Pending(x402Data.pending);
      sendError(clientRes, 405, "METHOD_NOT_ALLOWED", "x402 micropayment requests only support GET, HEAD, and OPTIONS methods");
      return;
    }

    const targetCheck = await validateTarget(targetHost, targetPort);
    if (!targetCheck.allowed) {
      await releaseX402Pending(x402Data.pending);
      sendError(clientRes, 403, "TARGET_BLOCKED", targetCheck.reason || "Blocked: target is a private/internal address");
      return;
    }
    const x402User = x402Data.userId;
    const enforced = enforcePolicy(relay.getPolicy(), {
      userId: x402User, host: targetHost, port: targetPort, plaintext: true, allowHttp: false, resolvedIps: targetCheck.addresses,
    });
    if (!enforced.allowed) {
      await releaseX402Pending(x402Data.pending);
      sendError(clientRes, enforced.status, enforced.code, enforced.message);
      return;
    }

    const x402Headers: http.OutgoingHttpHeaders = { ...clientReq.headers };
    for (const h of HOP_BY_HOP_REQUEST) delete x402Headers[h];
    delete x402Headers["x-payment"];
    delete x402Headers["x-pool-type"];
    if (x402Data.rail === "mpp") delete x402Headers["authorization"]; // the MPP credential is for us, not the origin
    x402Headers["host"] = hostHeaderFor(targetHost, targetPort); // policy was checked on the URL authority

    const x402Body = await readBody(clientReq);
    if (x402Body === "too_large") {
      await releaseX402Pending(x402Data.pending);
      sendError(clientRes, 413, "BODY_TOO_LARGE", "Request body too large");
      return;
    }

    let upstream: RelayUpstream;
    try {
      upstream = await openRelayStream(relay, {
        ...relaySelectOpts(null, x402User, clientIp, targetHost, targetPort, selectClassFor(x402Data.poolType)),
        requesterWallet: normalizePayer(x402Data.payer),
        targetAddresses: targetCheck.addresses,
      });
    } catch (err) {
      const e = relayErrorOf(err);
      recordError();
      await releaseX402Pending(x402Data.pending);
      log.error("x402 paid request could not be relayed", { code: e.code, payer: x402Data.payer.slice(0, 10) + "..." });
      sendError(clientRes, e.status, e.code, e.message, e.status === 503 ? { "Retry-After": "30" } : undefined);
      return;
    }
    // The payment was quoted for one exit class; never serve it from another.
    if (!nodeMatchesQuotedClass(x402Data.poolType, upstream.node.ipClass)) {
      upstream.stream.destroy();
      await releaseX402Pending(x402Data.pending);
      log.error("x402 node class differs from quote", { quoted: x402Data.poolType, node: upstream.node.ipClass });
      sendError(clientRes, 503, "QUOTE_CLASS_MISMATCH", "No node of the quoted exit class is available. Request a new quote.", { "Retry-After": "5" });
      return;
    }
    recordLatency(upstream.latencyMs);

    const x402Counter: ByteCounter = { bytesIn: 0, bytesOut: 0, maxBytes: 0, onLimitExceeded: null };
    let x402SessionId: string;
    try {
      x402SessionId = await startPrepaidSession({
        userId: x402User, targetHost, counter: x402Counter, connectLatencyMs: upstream.latencyMs,
        relay: x402Binding(upstream.node, targetPort, x402Data.payer, upstream.stream),
        rail: x402Data.rail, paidMusd: x402Data.amountMusd, quotedPricePerGbMusd: x402Data.pricePerGbMusd, maxBytes: x402Data.maxResponseBytes,
      });
    } catch (err) {
      upstream.stream.destroy();
      await releaseX402Pending(x402Data.pending);
      log.error("x402 session start failed", { error: err instanceof Error ? err.message.slice(0, 120) : "unknown" });
      sendError(clientRes, 500, "INTERNAL_ERROR", "Internal proxy error");
      return;
    }

    // The node may have reset the stream (or the tunnel dropped) while the
    // session was starting: never take the payment for a dead stream.
    if (upstream.stream.destroyed) {
      await abortPrepaidSession(x402SessionId);
      await releaseX402Pending(x402Data.pending);
      recordError();
      sendError(clientRes, 502, "UPSTREAM_UNAVAILABLE", "Bad gateway");
      return;
    }

    if (x402Counter.maxBytes > 0 && x402Body.length > x402Counter.maxBytes) {
      upstream.stream.destroy();
      await abortPrepaidSession(x402SessionId);
      await releaseX402Pending(x402Data.pending);
      sendError(clientRes, 413, "BODY_TOO_LARGE", "Request body exceeds the paid byte cap");
      return;
    }

    // Node selected, snapshot locked, stream open: only now take the payment.
    const x402Pending = x402Data.pending;
    if (!x402Pending || !(await settleX402Pending(x402Pending))) {
      upstream.stream.destroy();
      await abortPrepaidSession(x402SessionId);
      sendError(clientRes, 402, "X402_SETTLEMENT_FAILED", "Payment settlement failed. Please try again.");
      return;
    }
    // Settled but nothing served yet: refund to the payer's wallet, never charge.
    const x402Unserved = async (reason: string) => {
      unregisterSessionDestroy(x402SessionId);
      if (!upstream.stream.destroyed) upstream.stream.destroy();
      // Only refund if the session was never charged (abort won the race).
      if (await abortPrepaidSession(x402SessionId)) await refundX402Payer(x402Pending, reason);
    };
    if (clientRes.destroyed || clientReq.socket.destroyed) {
      await x402Unserved("client disconnected before relay");
      return;
    }

    let x402Done = false;
    const x402Cleanup = () => {
      if (x402Done) return;
      x402Done = true;
      unregisterSessionDestroy(x402SessionId);
      if (!upstream.stream.destroyed) upstream.stream.destroy();
      endSession(x402SessionId).catch((e) => log.error("x402 session end failed", { error: e instanceof Error ? e.message : String(e) }));
    };
    registerSessionDestroy(x402SessionId, () => {
      if (!clientRes.headersSent) clientRes.writeHead(413, { "Content-Type": "text/plain" });
      clientRes.end();
      x402Cleanup();
    });
    meterStream(upstream.stream, x402Counter);

    let proxyRes: http.IncomingMessage;
    try {
      proxyRes = await requestOverStream(upstream.stream, clientReq.method ?? "GET", target.path, x402Headers, x402Body);
    } catch (err) {
      recordError();
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("x402 upstream error", { error: sanitizeUpstreamMsg(errMsg) });
      x402Done = true;
      await x402Unserved("upstream error before response");
      if (!clientRes.headersSent) sendError(clientRes, 502, "UPSTREAM_UNAVAILABLE", "Bad gateway");
      return;
    }
    try {
      const responseHeaders = { ...proxyRes.headers };
      for (const h of HOP_BY_HOP_RESPONSE) delete responseHeaders[h];
      if (enforced.exitVisible) responseHeaders[EXIT_VISIBLE_HEADER.toLowerCase()] = "1";

      clientRes.writeHead(proxyRes.statusCode ?? 502, responseHeaders);
      proxyRes.pipe(clientRes, { end: true });
      clientRes.on("close", () => {
        if (!proxyRes.destroyed) proxyRes.destroy();
        x402Cleanup();
      });
      proxyRes.on("end", x402Cleanup);
      proxyRes.on("error", x402Cleanup);
      proxyRes.on("close", x402Cleanup);
    } catch (err) {
      recordError();
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("x402 upstream error", { error: sanitizeUpstreamMsg(errMsg) });
      if (!clientRes.headersSent) sendError(clientRes, 502, "UPSTREAM_UNAVAILABLE", "Bad gateway");
      x402Cleanup();
    }
    return;
  }

  // ─── Standard auth path (API key authenticated) ───────────────────
  const a = auth!;

  // Team API keys use the team's plan; fetch ONCE (TOCTOU)
  const userPlan = a.teamId
    ? await planRepo.getTeamPlan(a.teamId)
    : await planRepo.getUserPlan(a.userId);

  // Contribution requirement + starter-credit seed-only routing (access-gate.ts)
  const access = await checkRequesterAccess(relay.getPolicy(), a.userId);
  if (!access.allowed) {
    sendError(clientRes, access.status, access.code, access.message);
    return;
  }

  // SSRF protection: validate target is not a private/internal address
  const targetCheck = await validateTarget(targetHost, targetPort);
  if (!targetCheck.allowed) {
    sendError(clientRes, 403, "TARGET_BLOCKED", targetCheck.reason || "Blocked: target is a private/internal address");
    return;
  }

  // Policy: ports, denylist, OFAC destination, plaintext opt-in, requester caps
  const enforced = enforcePolicy(relay.getPolicy(), {
    userId: a.userId, host: targetHost, port: targetPort, plaintext: true, allowHttp: a.proxyOptions.allowHttp === true,
    resolvedIps: targetCheck.addresses,
  });
  if (!enforced.allowed) {
    sendError(clientRes, enforced.status, enforced.code, enforced.message);
    return;
  }

  // Per-user connection limit (plan-aware)
  if (!incrementUserConns(a.userId, userPlan.maxConnections)) {
    sendError(clientRes, 429, "TOO_MANY_CONNECTIONS", "Too many concurrent connections.", { "Retry-After": "5" });
    return;
  }

  // Every relay session is paid: always check balance (no free rail).
  {
    let hasBalance: boolean;
    try {
      hasBalance = a.teamId ? await checkTeamBalance(a.teamId) : await checkBalance(a.userId);
    } catch (err) {
      decrementUserConns(a.userId);
      log.error("balance check failed", { error: err instanceof Error ? err.message : String(err) });
      sendError(clientRes, 503, "SERVICE_UNAVAILABLE", "Balance check unavailable, retry later");
      return;
    }
    if (!hasBalance) {
      decrementUserConns(a.userId);
      clientRes.writeHead(402, { "Content-Type": "application/json", "X-DominusNode-Error": "INSUFFICIENT_BALANCE", ...paymentChallengeHeaders(toX402Class(a.proxyOptions.ipClass)) });
      clientRes.end(build402ResponseBody(toX402Class(a.proxyOptions.ipClass)));
      return;
    }
  }

  // Agentic wallet policy check (domain allowlist + daily budget)
  const walletPolicy = await checkAgenticWalletPolicy(a.proxyOptions.walletId, a.userId, targetHost);
  if (!walletPolicy.allowed) {
    decrementUserConns(a.userId);
    sendError(clientRes, 403, walletPolicy.errorCode!, walletPolicy.message!);
    return;
  }

  // Buffer the client request body before opening a node stream
  let requestBody: Buffer;
  try {
    const b = await readBody(clientReq);
    if (b === "too_large") {
      decrementUserConns(a.userId);
      sendError(clientRes, 413, "BODY_TOO_LARGE", "Request body too large");
      return;
    }
    requestBody = b;
  } catch {
    decrementUserConns(a.userId);
    if (!clientRes.headersSent && !clientRes.destroyed) {
      try { sendError(clientRes, 400, "BODY_ABORTED", "Request body aborted"); } catch { /* best effort */ }
    }
    return;
  }

  // Select a node and open a stream (DIAL_FAIL/DNS_FAIL retry once on another node)
  let upstream: RelayUpstream;
  try {
    upstream = await openRelayStream(relay, { ...relaySelectOpts(a, a.userId, clientIp, targetHost, targetPort), seedOnly: access.seedOnly, targetAddresses: targetCheck.addresses });
  } catch (err) {
    decrementUserConns(a.userId);
    const e = relayErrorOf(err);
    recordError();
    sendError(clientRes, e.status, e.code, e.status === 503 ? "Service temporarily unavailable. No relay nodes available." : e.message,
      e.status === 503 ? { "Retry-After": "30" } : undefined);
    return;
  }
  recordLatency(upstream.latencyMs);

  // Bytes are metered on the relay stream itself (headers included), see meterStream.
  const counter: ByteCounter = { bytesIn: 0, bytesOut: 0, maxBytes: 0, onLimitExceeded: null };

  let sessionId: string;
  try {
    sessionId = await startSession(a.userId, targetHost, counter, upstream.latencyMs, relayBinding(a, upstream.node, targetPort, upstream.stream),
      userPlan, a.user.log_target_hosts ?? false, a.teamId, walletPolicy.isAgent);
  } catch (err) {
    upstream.stream.destroy();
    decrementUserConns(a.userId);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Insufficient balance")) {
      clientRes.writeHead(402, { "Content-Type": "application/json", "X-DominusNode-Error": "INSUFFICIENT_BALANCE", ...paymentChallengeHeaders(toX402Class(upstream.node.ipClass)) });
      clientRes.end(build402ResponseBody(toX402Class(upstream.node.ipClass)));
    } else if (msg.includes("bandwidth limit")) {
      sendError(clientRes, 403, "BANDWIDTH_LIMIT_EXCEEDED", "Monthly bandwidth limit exceeded. Upgrade your plan at the Dominus Node dashboard.");
    } else if (msg.includes("spend cap")) {
      sendError(clientRes, 429, "SPEND_CAP_EXCEEDED", "Daily spend cap reached");
    } else if (msg.includes("rate limit")) {
      sendError(clientRes, 429, "TOO_MANY_CONNECTIONS", "Session rate limit exceeded. Please slow down.");
    } else {
      log.error("failed to start session", { error: msg });
      sendError(clientRes, 500, "INTERNAL_ERROR", "Internal proxy error");
    }
    return;
  }

  // Once-guard: release slot and settle exactly once
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    unregisterSessionDestroy(sessionId);
    decrementUserConns(a.userId);
    if (!upstream.stream.destroyed) upstream.stream.destroy();
    endSession(sessionId).catch((err) => {
      log.error("failed to end session", { error: err instanceof Error ? err.message : String(err) });
    });
  };

  // Node RST / tunnel drop while the session was starting: settle (nothing
  // was carried) and release the slot instead of writing to a dead stream.
  if (upstream.stream.destroyed) {
    cleanup();
    recordError();
    sendError(clientRes, 502, "UPSTREAM_UNAVAILABLE", "Bad gateway");
    return;
  }

  // The body alone exceeds what the session may carry: reject before sending
  // anything rather than forwarding (and billing) a request we must cut off.
  if (counter.maxBytes > 0 && requestBody.length > counter.maxBytes) {
    cleanup();
    sendError(clientRes, 413, "BODY_TOO_LARGE", "Request body exceeds the session byte cap");
    return;
  }

  registerSessionDestroy(sessionId, () => {
    if (!clientRes.headersSent) clientRes.writeHead(413, { "Content-Type": "text/plain" });
    clientRes.end();
    cleanup();
  });

  const headers: http.OutgoingHttpHeaders = { ...clientReq.headers };
  for (const h of HOP_BY_HOP_REQUEST) delete headers[h];
  // Policy and SSRF checks ran on the URL authority: never forward a different vhost.
  headers["host"] = hostHeaderFor(targetHost, targetPort);
  meterStream(upstream.stream, counter);

  try {
    const proxyRes = await requestOverStream(upstream.stream, clientReq.method ?? "GET", target.path, headers, requestBody);

    const connHeaders = (proxyRes.headers["connection"] ?? "").toString()
      .split(",").map(h => h.trim().toLowerCase()).filter(Boolean);
    const responseHeaders = { ...proxyRes.headers };
    for (const h of HOP_BY_HOP_RESPONSE) delete responseHeaders[h];
    for (const h of connHeaders) delete responseHeaders[h];
    if (upstream.retries > 0) responseHeaders["x-dominusnode-retries"] = String(upstream.retries);
    if (enforced.exitVisible) responseHeaders[EXIT_VISIBLE_HEADER.toLowerCase()] = "1";

    clientRes.writeHead(proxyRes.statusCode ?? 502, responseHeaders);
    proxyRes.pipe(clientRes, { end: true });
    clientRes.on("close", () => {
      if (!proxyRes.destroyed) proxyRes.destroy();
      cleanup();
    });
    proxyRes.on("end", cleanup);
    proxyRes.on("error", cleanup);
    proxyRes.on("close", cleanup);
  } catch (err) {
    recordError();
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error("upstream error", { error: sanitizeUpstreamMsg(errMsg), nodeId: upstream.node.nodeId });
    if (!clientRes.headersSent) {
      if (errMsg.includes("timeout")) sendError(clientRes, 504, "UPSTREAM_TIMEOUT", "Gateway timeout");
      else sendError(clientRes, 502, "UPSTREAM_UNAVAILABLE", "Bad gateway");
    }
    cleanup();
  }
}

// ─── HTTPS tunneling (CONNECT method) ────────────────────────────────

async function handleConnect(
  req: http.IncomingMessage,
  clientSocket: net.Socket,
  head: Buffer,
  relay: RelayRuntime,
): Promise<void> {
  recordRequest();

  const connectClientIp = clientIpOf(clientSocket);
  if (checkClientCountry(connectClientIp)) {
    safeSocketWrite(clientSocket, "HTTP/1.1 403 Forbidden\r\nX-DominusNode-Error: SANCTIONED_COUNTRY\r\n\r\n");
    return;
  }

  if (checkAuthRateLimit(connectClientIp)) {
    safeSocketWrite(clientSocket, "HTTP/1.1 429 Too Many Requests\r\nX-DominusNode-Error: AUTH_RATE_LIMITED\r\nRetry-After: 60\r\n\r\n");
    return;
  }

  const auth = await authenticateRequest(req);
  if (!auth) {
    const paidAttempt = !!req.headers["x-payment"] || hasMppCredential(req.headers);
    if (paidAttempt && !X402_RELAY_ENABLED) {
      safeSocketWrite(clientSocket, "HTTP/1.1 503 Service Unavailable\r\nX-DominusNode-Error: X402_RELAY_UNAVAILABLE\r\nRetry-After: 3600\r\n\r\n");
      return;
    }
    if (paidAttempt) {
      const anon = checkAnonymousPayer(relay.getPolicy());
      if (!anon.allowed) {
        safeSocketWrite(clientSocket, `HTTP/1.1 ${anon.status} Forbidden\r\nX-DominusNode-Error: ${anon.code}\r\nConnection: close\r\n\r\n`);
        return;
      }
      const x402Result = await handleX402Connect(req, clientSocket);
      if (x402Result) {
        if (!x402Result.verified) return;
        await handleX402ConnectTunnel(req, clientSocket, head, relay, x402Result);
        return;
      }
    }
    recordAuthFailure(connectClientIp);
    safeSocketWrite(clientSocket,
      "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"Dominus Node Proxy\"\r\n\r\n",
    );
    return;
  }

  const userId = auth.userId;
  const connectTeamId = auth.teamId;

  const connectPlan = connectTeamId
    ? await planRepo.getTeamPlan(connectTeamId)
    : await planRepo.getUserPlan(userId);

  const connectAccess = await checkRequesterAccess(relay.getPolicy(), userId);
  if (!connectAccess.allowed) {
    safeSocketWrite(clientSocket, `HTTP/1.1 ${connectAccess.status} ${http.STATUS_CODES[connectAccess.status] ?? "Error"}\r\nX-DominusNode-Error: ${connectAccess.code}\r\nConnection: close\r\n\r\n`);
    return;
  }

  const parsed = parseConnectTarget(req.url ?? "");
  if (!parsed || !isValidHostname(parsed.host) || !isValidPort(parsed.port) || /[\x00-\x1f\x7f]/.test(parsed.host)) {
    safeSocketWrite(clientSocket, "HTTP/1.1 400 Bad Request\r\nX-DominusNode-Error: INVALID_TARGET\r\n\r\n");
    return;
  }
  const targetHost = parsed.host;
  const targetPort = parsed.port;

  const connectTargetCheck = await validateTarget(targetHost, targetPort);
  if (!connectTargetCheck.allowed) {
    safeSocketWrite(clientSocket, "HTTP/1.1 403 Forbidden\r\nX-DominusNode-Error: TARGET_BLOCKED\r\n\r\n");
    return;
  }

  const enforced = enforcePolicy(relay.getPolicy(), {
    userId, host: targetHost, port: targetPort, plaintext: isPlaintextPort(targetPort), allowHttp: auth.proxyOptions.allowHttp === true,
    resolvedIps: connectTargetCheck.addresses,
  });
  if (!enforced.allowed) {
    safeSocketWrite(clientSocket, `HTTP/1.1 ${enforced.status} ${http.STATUS_CODES[enforced.status] ?? "Error"}\r\nX-DominusNode-Error: ${enforced.code}\r\n\r\n`);
    return;
  }

  if (!incrementUserConns(userId, connectPlan.maxConnections)) {
    safeSocketWrite(clientSocket, "HTTP/1.1 429 Too Many Requests\r\nX-DominusNode-Error: TOO_MANY_CONNECTIONS\r\nRetry-After: 5\r\n\r\n");
    return;
  }

  // Once-guard to prevent double-decrement of user connections
  let decremented = false;
  const safeDecrement = (): void => {
    if (!decremented) {
      decremented = true;
      decrementUserConns(userId);
    }
  };

  {
    let hasBalance: boolean;
    try {
      hasBalance = connectTeamId ? await checkTeamBalance(connectTeamId) : await checkBalance(userId);
    } catch (err) {
      safeDecrement();
      log.error("balance check failed", { error: err instanceof Error ? err.message : String(err) });
      safeSocketWrite(clientSocket, "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      return;
    }
    if (!hasBalance) {
      safeDecrement();
      safeSocketWrite(clientSocket, build402ConnectResponse(toX402Class(auth.proxyOptions.ipClass)));
      return;
    }
  }

  const connectWalletPolicy = await checkAgenticWalletPolicy(auth.proxyOptions.walletId, userId, targetHost);
  if (!connectWalletPolicy.allowed) {
    safeDecrement();
    safeSocketWrite(clientSocket, `HTTP/1.1 403 Forbidden\r\nX-DominusNode-Error: ${connectWalletPolicy.errorCode}\r\n\r\n`);
    return;
  }

  const redactedHost = targetHost.split(".").slice(-2).join(".");
  log.debug("CONNECT", { target: `${redactedHost}:${targetPort}`, userId, country: auth.proxyOptions.country, sticky: !!auth.proxyOptions.sessionId });

  let clientGone = false;
  clientSocket.once("close", () => { clientGone = true; });
  clientSocket.on("error", (err) => log.error("client socket error", { error: err.message }));

  let upstream: RelayUpstream;
  try {
    upstream = await openRelayStream(relay, { ...relaySelectOpts(auth, userId, connectClientIp, targetHost, targetPort), seedOnly: connectAccess.seedOnly, targetAddresses: connectTargetCheck.addresses });
  } catch (err) {
    safeDecrement();
    recordError();
    safeSocketWrite(clientSocket, connectErrorLine(relayErrorOf(err)));
    return;
  }
  recordLatency(upstream.latencyMs);
  const psStream = upstream.stream;
  psStream.on("error", (err) => log.warn("relay stream error", { error: err.message, nodeId: upstream.node.nodeId }));
  if (clientGone || clientSocket.destroyed) {
    psStream.destroy();
    safeDecrement();
    return;
  }

  const counter = attachByteCounters(clientSocket, psStream);

  // Start session BEFORE sending 200 to client (billing race condition fix)
  let sessionId: string;
  try {
    sessionId = await startSession(userId, targetHost, counter, upstream.latencyMs, relayBinding(auth, upstream.node, targetPort, upstream.stream),
      connectPlan, auth.user.log_target_hosts ?? false, connectTeamId, connectWalletPolicy.isAgent);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Insufficient balance")) {
      safeSocketWrite(clientSocket, build402ConnectResponse(toX402Class(upstream.node.ipClass)));
    } else if (msg.includes("bandwidth limit")) {
      safeSocketWrite(clientSocket, "HTTP/1.1 403 Forbidden\r\nX-DominusNode-Error: BANDWIDTH_LIMIT_EXCEEDED\r\n\r\n");
    } else if (msg.includes("spend cap")) {
      safeSocketWrite(clientSocket, "HTTP/1.1 429 Too Many Requests\r\nX-DominusNode-Error: SPEND_CAP_EXCEEDED\r\n\r\n");
    } else if (msg.includes("rate limit")) {
      safeSocketWrite(clientSocket, "HTTP/1.1 429 Too Many Requests\r\nX-DominusNode-Error: TOO_MANY_CONNECTIONS\r\nRetry-After: 60\r\n\r\n");
    } else {
      log.error("failed to start session", { error: msg });
      safeSocketWrite(clientSocket, "HTTP/1.1 500 Internal Server Error\r\n\r\n");
    }
    safeDecrement();
    psStream.destroy();
    return;
  }

  registerSessionDestroy(sessionId, () => {
    clientSocket.destroy();
    psStream.destroy();
  });

  let tunnelCleanedUp = false;
  const cleanup = () => {
    if (tunnelCleanedUp) return;
    tunnelCleanedUp = true;
    unregisterSessionDestroy(sessionId);
    safeDecrement();
    if (!clientSocket.destroyed) clientSocket.destroy();
    if (!psStream.destroyed) psStream.destroy();
    endSession(sessionId).catch((cleanupErr) => {
      log.error("session end failed", { sessionId, error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) });
    });
  };

  if (clientSocket.destroyed) {
    cleanup();
    return;
  }

  const visible = enforced.exitVisible ? `${EXIT_VISIBLE_HEADER}: 1\r\n` : "";
  clientSocket.write(`HTTP/1.1 200 Connection Established\r\n${visible}\r\n`);

  if (head.length > 0) {
    counter.bytesIn += head.length; // Count head buffer from CONNECT handshake
    psStream.write(head);
  }

  psStream.pipe(clientSocket);
  clientSocket.pipe(psStream);

  clientSocket.setTimeout(TUNNEL_IDLE_TIMEOUT_MS);
  clientSocket.on("timeout", () => clientSocket.destroy());

  // Half-close aware: a client FIN ends only the upstream write side.
  bindTunnelLifecycle(clientSocket, psStream, cleanup);
}

// ─── x402 CONNECT tunnel (no user account, payment-per-request) ─────

async function handleX402ConnectTunnel(
  req: http.IncomingMessage,
  clientSocket: net.Socket,
  head: Buffer,
  relay: RelayRuntime,
  x402Result: X402ConnectResult,
): Promise<void> {
  const pending = x402Result.pending;
  const reject = async (line: string) => {
    await releaseX402Pending(pending);
    safeSocketWrite(clientSocket, line);
  };
  const parsed = parseConnectTarget(req.url ?? "");
  if (!parsed || !isValidHostname(parsed.host) || !isValidPort(parsed.port) || /[\x00-\x1f\x7f]/.test(parsed.host)) {
    await reject("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  const { host: targetHost, port: targetPort } = parsed;

  const targetCheck = await validateTarget(targetHost, targetPort);
  if (!targetCheck.allowed) {
    await reject("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }

  const x402User = x402Result.userId;
  if (!x402User || !pending || x402Result.amountMusd === undefined || x402Result.pricePerGbMusd === undefined) {
    await reject( "HTTP/1.1 500 Internal Server Error\r\n\r\n");
    return;
  }
  const enforced = enforcePolicy(relay.getPolicy(), {
    userId: x402User, host: targetHost, port: targetPort, plaintext: isPlaintextPort(targetPort), allowHttp: false,
    resolvedIps: targetCheck.addresses,
  });
  if (!enforced.allowed) {
    await reject(`HTTP/1.1 ${enforced.status} ${http.STATUS_CODES[enforced.status] ?? "Error"}\r\nX-DominusNode-Error: ${enforced.code}\r\n\r\n`);
    return;
  }

  let upstream: RelayUpstream;
  try {
    upstream = await openRelayStream(relay, {
      ...relaySelectOpts(null, x402User, clientIpOf(clientSocket), targetHost, targetPort, selectClassFor(x402Result.poolType)),
      requesterWallet: normalizePayer(x402Result.payer),
      targetAddresses: targetCheck.addresses,
    });
  } catch (err) {
    recordError();
    await reject(connectErrorLine(relayErrorOf(err)));
    return;
  }
  // The payment was quoted for one exit class; never serve it from another.
  if (!nodeMatchesQuotedClass(x402Result.poolType, upstream.node.ipClass)) {
    upstream.stream.destroy();
    log.error("x402 node class differs from quote", { quoted: x402Result.poolType, node: upstream.node.ipClass });
    await reject("HTTP/1.1 503 Service Unavailable\r\nX-DominusNode-Error: QUOTE_CLASS_MISMATCH\r\nRetry-After: 5\r\n\r\n");
    return;
  }
  recordLatency(upstream.latencyMs);
  const psStream = upstream.stream;
  psStream.on("error", () => undefined);
  if (clientSocket.destroyed) {
    psStream.destroy();
    await releaseX402Pending(pending);
    return;
  }

  const x402Counter = attachByteCounters(clientSocket, psStream);
  let sessionId: string;
  try {
    sessionId = await startPrepaidSession({
      userId: x402User, targetHost, counter: x402Counter, connectLatencyMs: upstream.latencyMs,
      relay: x402Binding(upstream.node, targetPort, x402Result.payer, psStream),
      rail: x402Result.rail ?? "x402", paidMusd: x402Result.amountMusd, quotedPricePerGbMusd: x402Result.pricePerGbMusd, maxBytes: x402Result.maxResponseBytes,
    });
  } catch (err) {
    log.error("x402 CONNECT session start failed", { error: err instanceof Error ? err.message.slice(0, 120) : "unknown" });
    psStream.destroy();
    await reject("HTTP/1.1 500 Internal Server Error\r\n\r\n");
    return;
  }

  // Node selected, snapshot locked, stream open: only now take the payment.
  if (!(await settleX402Pending(pending))) {
    psStream.destroy();
    await abortPrepaidSession(sessionId);
    const errBody = JSON.stringify({ error: "X402_SETTLEMENT_FAILED", message: "Payment settlement failed. Please try again." });
    safeSocketWrite(clientSocket,
      `HTTP/1.1 402 Payment Required\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(errBody)}\r\nX-DominusNode-Error: X402_SETTLEMENT_FAILED\r\n\r\n${errBody}`);
    return;
  }

  let tunnelCleanedUp = false;
  const x402Cleanup = () => {
    if (tunnelCleanedUp) return;
    tunnelCleanedUp = true;
    unregisterSessionDestroy(sessionId);
    if (!clientSocket.destroyed) clientSocket.destroy();
    if (!psStream.destroyed) psStream.destroy();
    endSession(sessionId).catch((e) => log.error("x402 CONNECT session end failed", { error: e instanceof Error ? e.message : String(e) }));
  };
  registerSessionDestroy(sessionId, () => {
    clientSocket.destroy();
    psStream.destroy();
  });
  if (clientSocket.destroyed || psStream.destroyed) {
    // Settled but the tunnel never opened: refund instead of charging.
    tunnelCleanedUp = true;
    unregisterSessionDestroy(sessionId);
    if (!clientSocket.destroyed) safeSocketWrite(clientSocket, "HTTP/1.1 502 Bad Gateway\r\n\r\n");
    if (!psStream.destroyed) psStream.destroy();
    if (await abortPrepaidSession(sessionId)) await refundX402Payer(pending, "tunnel closed before establishment");
    return;
  }

  const visible = enforced.exitVisible ? `${EXIT_VISIBLE_HEADER}: 1\r\n` : "";
  clientSocket.write(`HTTP/1.1 200 Connection Established\r\n${visible}\r\n`);

  if (head.length > 0) {
    x402Counter.bytesIn += head.length;
    psStream.write(head);
  }

  psStream.pipe(clientSocket);
  clientSocket.pipe(psStream);

  clientSocket.setTimeout(TUNNEL_IDLE_TIMEOUT_MS);
  clientSocket.on("timeout", () => clientSocket.destroy());

  // Half-close aware: a client FIN ends only the upstream write side.
  bindTunnelLifecycle(clientSocket, psStream, x402Cleanup);
}

// ─── Server bootstrap ────────────────────────────────────────────────

import { getStats, getPrometheusMetrics } from "./stats.js";
import { terminateUserSessions } from "./session-manager.js";

export interface ProxyServerOptions {
  /** Serve the proxy over TLS ("https proxy"): Proxy-Authorization never crosses the wire in clear. */
  tls?: { cert: Buffer; key: Buffer };
  /** Plaintext listener only: decides whether proxy credentials are accepted (PROXY_REQUIRE_TLS). */
  plaintextAuth?: PlaintextAuthGuard;
}

/**
 * Any credential a client can present to the gateway: proxy Basic/MPP auth, an
 * x402 X-PAYMENT header, or an MPP "Authorization: Payment" credential. With
 * PROXY_REQUIRE_TLS these are all refused on the plaintext listener.
 */
export function carriesProxyCredential(h: http.IncomingHttpHeaders): boolean {
  if (h["proxy-authorization"] || h["x-payment"]) return true;
  const a = h["authorization"];
  if (typeof a === "string" && /^\s*payment\s/i.test(a)) return true;
  return hasMppCredential(h);
}

export async function startProxyServer(port: number, relay: RelayRuntime, opts: ProxyServerOptions = {}): Promise<http.Server> {
  await initGeoCheck();
  const plaintextAuth = opts.tls ? undefined : opts.plaintextAuth;

  // Derive a separate stats secret from JWT_SECRET using HMAC instead of
  // reusing the raw JWT_SECRET as a Bearer token (prevents JWT signing key exposure)
  const STATS_SECRET = process.env["PROXY_STATS_SECRET"] ??
    (process.env["JWT_SECRET"]
      ? crypto.createHmac("sha256", process.env["JWT_SECRET"]).update("proxy-stats-endpoint").digest("hex")
      : "");

  const onRequest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const rid = resolveRequestId(req.headers["x-request-id"]);
    res.setHeader("X-Request-Id", rid);
    if (plaintextAuth && carriesProxyCredential(req.headers) && !plaintextAuth("http")) {
      res.writeHead(403, { "Content-Type": "text/plain", Connection: "close", "X-DominusNode-Error": "TLS_REQUIRED" });
      res.end("TLS required: connect to the gateway's HTTPS proxy port");
      return;
    }
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
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...stats, relayNodes: relay.nodeCount ? relay.nodeCount() : null }));
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

    runWithRequestId(rid, () => handleRequest(req, res, relay)).catch((err) => {
      log.error("unhandled request error", { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
      }
      res.end("Internal proxy error");
    });
  };
  const server: http.Server = opts.tls
    ? (https.createServer({ cert: opts.tls.cert, key: opts.tls.key, ...pqTlsOptions() }, onRequest) as unknown as http.Server)
    : http.createServer(onRequest);

  server.on("connect", (req, socket: net.Socket, head) => {
    const rid = resolveRequestId(req.headers["x-request-id"]);
    socketRequestIds.set(socket, rid);
    if (plaintextAuth && carriesProxyCredential(req.headers) && !plaintextAuth("http")) {
      safeSocketWrite(socket, "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nX-DominusNode-Error: TLS_REQUIRED\r\nConnection: close\r\n\r\nTLS required: connect to the gateway's HTTPS proxy port");
      return;
    }
    runWithRequestId(rid, () => handleConnect(req, socket, head, relay)).catch((err) => {
      log.error("unhandled connect error", { error: err instanceof Error ? err.message : String(err) });
      if (!socket.destroyed) {
        socket.write(withRequestIdHeader("HTTP/1.1 500 Internal Server Error\r\n\r\n", rid));
        socket.end();
      }
    });
  });

  // Connection limits and timeouts
  server.maxConnections = MAX_CONNECTIONS;
  server.timeout = 300_000; // 5 minute total timeout
  server.keepAliveTimeout = 60_000;

  server.listen(port, () => {
    log.info(`proxy gateway listening on port ${port}`, { maxConnections: MAX_CONNECTIONS, tls: !!opts.tls });
  });

  return server;
}
