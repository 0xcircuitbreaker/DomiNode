/**
 * Remote MCP endpoint (Streamable HTTP) for hosted agent platforms.
 *
 * Every request authenticates with `Authorization: Bearer dn_live_...`. Each MCP session owns its
 * own McpServer, TokenManager, HttpClient and config copy, bound to the SHA-256 of the key that
 * created it, so one agent's key never serves another agent's session. The key is never logged
 * and every error body is scrubbed.
 */
import * as http from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpConfig, McpHttpConfig } from "./config.js";
import { TokenManager } from "./token-manager.js";
import { HttpClient, scrubCredentials } from "./http-client.js";
import { PACKAGE_VERSION } from "./version.js";
import { registerAuthenticatedTools } from "./register.js";

export const MCP_PATH = "/mcp";
const API_KEY_RE = /^dn_live_[A-Za-z0-9_-]{8,200}$/;
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const RATE_WINDOW_MS = 60_000;
/** Cap on the per-key rate-limit map (rules: in-memory maps need a size cap + cleanup). */
export const MAX_RATE_LIMIT_ENTRIES = 10_000;

/** A per-session MCP server plus the cleanup for its credentials. */
export interface SessionServer {
  server: McpServer;
  dispose(): void;
}

/** Builds an isolated server for one API key. Throws if the key is rejected upstream. */
export type SessionFactory = (apiKey: string) => Promise<SessionServer>;

interface Session {
  keyHash: Buffer;
  transport: StreamableHTTPServerTransport;
  server: SessionServer;
  lastSeen: number;
}

export interface RemoteMcpServer {
  httpServer: http.Server;
  /** Number of live MCP sessions (tests, health). */
  sessionCount(): number;
  /** Drop sessions idle longer than the configured limit; returns how many were closed. */
  sweepIdle(now?: number): number;
  close(): Promise<void>;
}

/** Default factory: verify the key against the API, then register the standard tool set. */
export function defaultSessionFactory(base: McpConfig): SessionFactory {
  return async (apiKey) => {
    const tokenManager = new TokenManager(base.apiUrl);
    await tokenManager.initialize(apiKey);
    const httpClient = new HttpClient(base.apiUrl, tokenManager, base.mcpAgentSecret);
    const config = sessionConfig(base, apiKey);
    const server = new McpServer({ name: "dominusnode", version: PACKAGE_VERSION });
    registerAuthenticatedTools(server, httpClient, config);
    return {
      server,
      dispose() {
        tokenManager.clear();
        config.apiKey = null;
      },
    };
  };
}

/**
 * Per-session config copy. The fetch tool reads config.apiKey, so it must be this agent's key.
 * The operator's signing key files are dropped: a remote agent must never sign node
 * registrations, withdrawals or payout-wallet changes with the operator's wallet.
 */
export function sessionConfig(base: McpConfig, apiKey: string): McpConfig {
  return { ...base, apiKey, walletKeyFile: null, payoutWalletKeyFile: null };
}

export function hashKey(apiKey: string): Buffer {
  return createHash("sha256").update(apiKey, "utf8").digest();
}

/** Parse the bearer key; null when missing or malformed. */
export function bearerKey(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!m || !API_KEY_RE.test(m[1])) return null;
  return m[1];
}

function stripDangerousKeys(obj: unknown, depth = 0): void {
  if (depth > 50 || !obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) stripDangerousKeys(item, depth + 1);
    return;
  }
  for (const key of Object.keys(obj)) {
    if (DANGEROUS_KEYS.has(key)) delete (obj as Record<string, unknown>)[key];
    else stripDangerousKeys((obj as Record<string, unknown>)[key], depth + 1);
  }
}

/** Fixed-window per-key limiter with a capped map and periodic cleanup. */
export class KeyRateLimiter {
  private readonly hits = new Map<string, { count: number; windowStart: number }>();
  constructor(private readonly perMinute: number, private readonly maxEntries = MAX_RATE_LIMIT_ENTRIES) {}

  allow(keyId: string, now = Date.now()): boolean {
    let e = this.hits.get(keyId);
    if (!e || now - e.windowStart >= RATE_WINDOW_MS) {
      if (!e && this.hits.size >= this.maxEntries) {
        this.cleanup(now);
        // Still full: evict the oldest entry (Map preserves insertion order).
        if (this.hits.size >= this.maxEntries) {
          const oldest = this.hits.keys().next().value;
          if (oldest !== undefined) this.hits.delete(oldest);
        }
      }
      e = { count: 0, windowStart: now };
      this.hits.delete(keyId);
      this.hits.set(keyId, e);
    }
    e.count++;
    return e.count <= this.perMinute;
  }

  cleanup(now = Date.now()): void {
    for (const [k, e] of this.hits) if (now - e.windowStart >= RATE_WINDOW_MS) this.hits.delete(k);
  }

  get size(): number {
    return this.hits.size;
  }
}

function sendJsonError(res: http.ServerResponse, status: number, message: string, extra: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: scrubCredentials(message) }, id: null });
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra });
  res.end(body);
}

class BodyError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function readJsonBody(req: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new BodyError(413, "Request body too large"));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        done = true;
        reject(new BodyError(413, "Request body too large"));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        stripDangerousKeys(parsed);
        resolve(parsed);
      } catch {
        reject(new BodyError(400, "Invalid JSON body"));
      }
    });
    req.on("error", () => {
      if (!done) {
        done = true;
        reject(new BodyError(400, "Request body could not be read"));
      }
    });
  });
}

/**
 * Scrub credentials from everything the transport writes (tool errors can echo upstream text).
 * Content-Length is dropped because scrubbing can change the length; Node falls back to chunked.
 */
export function scrubResponse(res: http.ServerResponse): void {
  const scrub = (chunk: unknown): unknown => {
    if (typeof chunk === "string") return scrubCredentials(chunk);
    if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) return scrubCredentials(Buffer.from(chunk).toString("utf8"));
    return chunk;
  };
  const origWriteHead = res.writeHead.bind(res) as (...a: unknown[]) => http.ServerResponse;
  res.writeHead = ((...args: unknown[]) => {
    res.removeHeader("content-length");
    for (const a of args) {
      if (a && typeof a === "object" && !Array.isArray(a)) {
        for (const k of Object.keys(a)) if (k.toLowerCase() === "content-length") delete (a as Record<string, unknown>)[k];
      }
    }
    return origWriteHead(...args);
  }) as typeof res.writeHead;
  const origWrite = res.write.bind(res) as (...a: unknown[]) => boolean;
  res.write = ((chunk: unknown, ...rest: unknown[]) => origWrite(scrub(chunk), ...rest)) as typeof res.write;
  const origEnd = res.end.bind(res) as (...a: unknown[]) => http.ServerResponse;
  res.end = ((chunk?: unknown, ...rest: unknown[]) =>
    typeof chunk === "function" || chunk === undefined ? origEnd(chunk, ...rest) : origEnd(scrub(chunk), ...rest)) as typeof res.end;
}

function isInitialize(body: unknown): boolean {
  if (Array.isArray(body)) return body.some((m) => isInitializeRequest(m));
  return isInitializeRequest(body);
}

export function createRemoteMcpServer(
  httpConfig: McpHttpConfig,
  factory: SessionFactory,
  log: (line: string) => void = (l) => process.stderr.write(`${l}\n`),
): RemoteMcpServer {
  const sessions = new Map<string, Session>();
  const limiter = new KeyRateLimiter(httpConfig.rateLimitPerMinute);
  const allowedOrigins = new Set(httpConfig.allowedOrigins);

  function closeSession(id: string, reason: string): void {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    try {
      s.server.dispose();
    } catch {
      /* ignore */
    }
    void s.transport.close().catch(() => undefined);
    void s.server.server.close().catch(() => undefined);
    log(`mcp-http: session closed (${reason}); ${sessions.size} active`);
  }

  function sweepIdle(now = Date.now()): number {
    let n = 0;
    for (const [id, s] of sessions) {
      if (now - s.lastSeen > httpConfig.sessionIdleMs) {
        closeSession(id, "idle");
        n++;
      }
    }
    limiter.cleanup(now);
    return n;
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname !== MCP_PATH) {
      sendJsonError(res, 404, "Not found");
      return;
    }

    // DNS-rebinding / browser CSRF guard: an Origin, when sent, must be explicitly allowed.
    const origin = req.headers["origin"];
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      sendJsonError(res, 403, "Origin not allowed");
      return;
    }

    const apiKey = bearerKey(req.headers["authorization"]);
    if (!apiKey) {
      sendJsonError(res, 401, "Authorization: Bearer dn_live_ API key required", {
        "WWW-Authenticate": 'Bearer realm="dominusnode-mcp"',
      });
      return;
    }
    const keyHash = hashKey(apiKey);
    if (!limiter.allow(keyHash.toString("hex"))) {
      sendJsonError(res, 429, "Rate limit exceeded", { "Retry-After": "60" });
      return;
    }

    scrubResponse(res);
    const rawSid = req.headers["mcp-session-id"];
    const sessionId = typeof rawSid === "string" ? rawSid : undefined;

    if (req.method === "POST") {
      const ct = String(req.headers["content-type"] ?? "").toLowerCase();
      if (!ct.startsWith("application/json")) {
        sendJsonError(res, 415, "Content-Type must be application/json");
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req, httpConfig.maxBodyBytes);
      } catch (err) {
        if (err instanceof BodyError) sendJsonError(res, err.status, err.message);
        else sendJsonError(res, 400, "Bad request");
        return;
      }

      if (sessionId === undefined) {
        if (!isInitialize(body)) {
          sendJsonError(res, 400, "Missing Mcp-Session-Id header (send initialize first)");
          return;
        }
        if (sessions.size >= httpConfig.maxSessions) {
          sweepIdle();
          if (sessions.size >= httpConfig.maxSessions) {
            sendJsonError(res, 503, "Too many active sessions", { "Retry-After": "30" });
            return;
          }
        }
        let sessionServer: SessionServer;
        try {
          sessionServer = await factory(apiKey);
        } catch {
          // Do not echo upstream details: they could carry the key.
          sendJsonError(res, 401, "API key rejected", { "WWW-Authenticate": 'Bearer error="invalid_token"' });
          return;
        }
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            sessions.set(id, { keyHash, transport, server: sessionServer, lastSeen: Date.now() });
            log(`mcp-http: session opened; ${sessions.size} active`);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) closeSession(transport.sessionId, "closed");
        };
        await sessionServer.server.connect(transport);
        await transport.handleRequest(req, res, body);
        if (!transport.sessionId || !sessions.has(transport.sessionId)) {
          // Initialize failed inside the transport: release the credentials now.
          sessionServer.dispose();
          void transport.close().catch(() => undefined);
        }
        return;
      }

      const session = lookup(sessionId, keyHash, res);
      if (!session) return;
      await session.transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      if (sessionId === undefined) {
        sendJsonError(res, 400, "Missing Mcp-Session-Id header");
        return;
      }
      const session = lookup(sessionId, keyHash, res);
      if (!session) return;
      await session.transport.handleRequest(req, res);
      if (req.method === "DELETE") closeSession(sessionId, "deleted");
      return;
    }

    sendJsonError(res, 405, "Method not allowed", { Allow: "GET, POST, DELETE" });
  }

  /** Session lookup bound to the key that created it. A different key gets the same 404 as an unknown id. */
  function lookup(sessionId: string, keyHash: Buffer, res: http.ServerResponse): Session | null {
    const s = sessions.get(sessionId);
    if (!s || !timingSafeEqual(s.keyHash, keyHash)) {
      sendJsonError(res, 404, "Session not found");
      return null;
    }
    s.lastSeen = Date.now();
    return s;
  }

  const httpServer = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`mcp-http: request failed: ${scrubCredentials(err instanceof Error ? err.message : String(err))}`);
      sendJsonError(res, 500, "Internal error");
    });
  });
  httpServer.headersTimeout = 30_000;
  httpServer.requestTimeout = 120_000;

  const sweeper = setInterval(() => sweepIdle(), Math.min(60_000, httpConfig.sessionIdleMs));
  sweeper.unref();

  return {
    httpServer,
    sessionCount: () => sessions.size,
    sweepIdle,
    async close() {
      clearInterval(sweeper);
      for (const id of [...sessions.keys()]) closeSession(id, "shutdown");
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
