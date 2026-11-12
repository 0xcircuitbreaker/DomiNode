import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as https from "node:https";
import * as tls from "node:tls";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Mocks ─────────────────────────────────────────────────────────

const mockAuthenticateRequest = vi.fn();
const mockCheckBalance = vi.fn();
const mockStartSession = vi.fn();
const mockEndSession = vi.fn();
const mockGetActiveSessionCount = vi.fn();
const mockCheckSanctionedCountry = vi.fn();
const mockInitGeoCheck = vi.fn();
const mockValidateTarget = vi.fn();
const mockIsValidHostname = vi.fn();
const mockIsValidPort = vi.fn();
const mockIncrementUserConns = vi.fn();
const mockDecrementUserConns = vi.fn();
const mockCheckAuthRateLimit = vi.fn();
const mockRecordAuthFailure = vi.fn();
const mockRecordRequest = vi.fn();
const mockRecordError = vi.fn();
const mockRecordLatency = vi.fn();
const mockGetStats = vi.fn();
const mockSelect = vi.fn();
const mockGetProviderCount = vi.fn();
const mockGetProviderStats = vi.fn();
const mockGetUserPlan = vi.fn();
const mockStartPrepaidSession = vi.fn();
const mockX402Http = vi.fn();
const mockX402Connect = vi.fn();
const X402_PAYER = "0x" + "9".repeat(40);
const mockSettlePending = vi.fn();
const mockReleasePending = vi.fn();
const mockRefundPayer = vi.fn();
const mockAbortPrepaid = vi.fn();
const x402Pending = { state: "verified" };
let mppChallengeHeaders: Record<string, string> = {};
const x402Data = { pending: x402Pending, payer: X402_PAYER, userId: "x402-user", amountUsd: "0.005243", amountMusd: 5243n, pricePerGbMusd: 500000n, facilitator: "coinbase", poolType: "residential", maxResponseBytes: 10_485_760 };

vi.mock("./x402-handler.js", () => ({
  toX402Class: (c?: string | null) => (c === "residential" || c === "dc" || c === "mobile" ? c : "any"),
  selectClassFor: (c: string) => (c === "any" ? undefined : c),
  nodeMatchesQuotedClass: (q: string, n: string) => q === "any" || q === n,
  handleX402Http: (req: { __x402?: unknown }, ...rest: unknown[]) => mockX402Http(req, ...rest),
  handleX402Connect: (...args: unknown[]) => mockX402Connect(...args),
  build402ResponseBody: () => "Insufficient balance",
  build402ConnectResponse: () => "HTTP/1.1 402 Payment Required\r\n\r\n",
  isX402Verified: (req: { __x402?: unknown }) => !!req.__x402,
  getX402Data: (req: { __x402?: { rail?: string } }) => (req.__x402 ? { rail: "x402", ...req.__x402 } : null),
  hasMppCredential: (h: Record<string, unknown>) => /^Payment /i.test(String(h["authorization"] ?? h["proxy-authorization"] ?? "")),
  normalizePayer: (p: string) => (/^0x/i.test(p) ? p.toLowerCase() : p),
  paymentChallengeHeaders: () => mppChallengeHeaders,
  settleX402Pending: (...a: unknown[]) => mockSettlePending(...a),
  releaseX402Pending: (...a: unknown[]) => mockReleasePending(...a),
  refundX402Payer: (...a: unknown[]) => mockRefundPayer(...a),
}));

vi.mock("./auth.js", () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticateRequest(...args),
}));

vi.mock("./balance-check.js", () => ({
  checkBalance: (...args: unknown[]) => mockCheckBalance(...args),
}));

vi.mock("./session-manager.js", () => ({
  startSession: (...args: unknown[]) => mockStartSession(...args),
  startPrepaidSession: (...args: unknown[]) => mockStartPrepaidSession(...args),
  abortPrepaidSession: (...args: unknown[]) => mockAbortPrepaid(...args),
  endSession: (...args: unknown[]) => mockEndSession(...args),
  getActiveSessionCount: () => mockGetActiveSessionCount(),
  registerSessionDestroy: vi.fn(),
  unregisterSessionDestroy: vi.fn(),
  terminateUserSessions: vi.fn(),
}));

vi.mock("./geo-check.js", () => ({
  checkSanctionedCountry: (...args: unknown[]) => mockCheckSanctionedCountry(...args),
  initGeoCheck: () => mockInitGeoCheck(),
}));

vi.mock("./target-validator.js", () => ({
  validateTarget: (...args: unknown[]) => mockValidateTarget(...args),
  isValidHostname: (...args: unknown[]) => mockIsValidHostname(...args),
  isValidPort: (...args: unknown[]) => mockIsValidPort(...args),
}));

vi.mock("./connection-tracker.js", () => ({
  incrementUserConns: (...args: unknown[]) => mockIncrementUserConns(...args),
  decrementUserConns: (...args: unknown[]) => mockDecrementUserConns(...args),
}));

vi.mock("./auth-rate-limit.js", () => ({
  checkAuthRateLimit: (...args: unknown[]) => mockCheckAuthRateLimit(...args),
  recordAuthFailure: (...args: unknown[]) => mockRecordAuthFailure(...args),
}));

vi.mock("./stats.js", () => ({
  recordRequest: () => mockRecordRequest(),
  recordError: () => mockRecordError(),
  recordLatency: (...args: unknown[]) => mockRecordLatency(...args),
  getStats: () => mockGetStats(),
}));

vi.mock("./counting-stream.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  attachByteCounters: () => ({ bytesIn: 0, bytesOut: 0, maxBytes: 0, onLimitExceeded: null }),
}));



vi.mock("@dominusnode/shared", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  planRepo: {
    getUserPlan: (...args: unknown[]) => mockGetUserPlan(...args),
  },
}));

import { startProxyServer } from "./server.js";
import { NodeSelectionError } from "./node-tunnel/selector.js";
import { TunnelOpenError } from "./node-tunnel/mux.js";
import { _resetPolicyEnforcer } from "./policy-enforcer.js";
import { Duplex } from "node:stream";

let policy: { ports: number[]; denyDomains: string[]; plaintext: string; requesterLimits: { reqPerSec: number; dailySpendMusd: number } };
const mockOpenStream = vi.fn();

/** Duplex that echoes everything written back to the reader. */
function echoStream(): Duplex {
  const d: Duplex = new Duplex({
    read() { /* pushed on write */ },
    write(chunk, _enc, cb) { d.push(chunk); cb(); },
    final(cb) { d.push(null); cb(); },
  });
  return d;
}

function liveNode(id: string) {
  return {
    nodeId: id, ipClass: "residential", ownerUserId: "owner-" + id,
    tunnel: { openStream: (h: string, p: number) => mockOpenStream(id, h, p) },
  };
}

// ─── Helpers ───────────────────────────────────────────────────────

function makeRequest(
  port: number,
  options: http.RequestOptions,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, ...options }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 500, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    req.end();
  });
}

function makeConnect(
  port: number,
  target: string,
  headers?: Record<string, string>,
): Promise<{ status: number; socket: net.Socket; head: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      method: "CONNECT",
      path: target,
      headers: {
        Host: target,
        ...headers,
      },
    });
    req.on("connect", (res, socket, head) => {
      resolve({ status: res.statusCode ?? 500, socket, head: head.toString() });
    });
    req.on("error", reject);
    req.end();
  });
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("proxy-gateway server", () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Default happy-path mocks
    mockInitGeoCheck.mockResolvedValue(undefined);
    mockCheckSanctionedCountry.mockReturnValue(null);
    mockCheckAuthRateLimit.mockReturnValue(false);
    mockAuthenticateRequest.mockResolvedValue({
      userId: "user-123",
      user: { id: "user-123", email: "test@test.com", status: "active" },
      proxyOptions: {},
    });
    _resetPolicyEnforcer();
    policy = { ports: [80, 443], denyDomains: [], plaintext: "allow", requesterLimits: { reqPerSec: 1000, dailySpendMusd: 50_000_000 } };
    mockSelect.mockImplementation((o: { excludeNodeIds?: string[] }) => liveNode(o.excludeNodeIds?.length ? "node-2" : "node-1"));
    mockOpenStream.mockImplementation(async () => echoStream());
    mockGetUserPlan.mockResolvedValue({ id: "payg", name: "PAYG", pricePerGbCents: 500, monthlyBandwidthBytes: 0, isDefault: false, maxConnections: 100, maxSessionsPerMinute: 30 });
    mockIncrementUserConns.mockReturnValue(true);
    mockCheckBalance.mockResolvedValue(true);
    mockValidateTarget.mockResolvedValue({ allowed: true });
    mockIsValidHostname.mockReturnValue(true);
    mockIsValidPort.mockReturnValue(true);
    mockStartSession.mockResolvedValue("session-abc");
    mockStartPrepaidSession.mockResolvedValue("session-x402");
    mockSettlePending.mockResolvedValue(true);
    mockReleasePending.mockResolvedValue(undefined);
    mockRefundPayer.mockResolvedValue(true);
    mockAbortPrepaid.mockResolvedValue(true);
    mockX402Http.mockImplementation(async (req: { __x402?: unknown }) => { req.__x402 = x402Data; return true; });
    mockX402Connect.mockResolvedValue({ handled: true, verified: true, ...x402Data, paymentHeader: "" });
    mppChallengeHeaders = {};
    mockEndSession.mockResolvedValue(undefined);
    mockGetStats.mockReturnValue({
      status: "operational",
      activeSessions: 5,
      totalRequests: 100,
      totalErrors: 2,
      avgLatencyMs: 150,
      uptimeSeconds: 3600,
    });
    mockGetProviderStats.mockReturnValue([]);
    mockGetProviderCount.mockReturnValue(1);

    const relay = {
      selector: { select: (o: unknown) => mockSelect(o) },
      getPolicy: () => policy,
      nodeCount: () => mockGetProviderCount(),
    };
    server = await startProxyServer(0, relay as any);
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // ─── Server bootstrap ─────────────────────────────────────────

  describe("bootstrap", () => {
    it("should start and listen on the given port", () => {
      expect(port).toBeGreaterThan(0);
      expect(server.listening).toBe(true);
    });

    it("should call initGeoCheck on startup", () => {
      expect(mockInitGeoCheck).toHaveBeenCalledOnce();
    });

    it("should set maxConnections on server", () => {
      expect(server.maxConnections).toBeGreaterThan(0);
    });
  });

  // ─── /internal/stats endpoint ─────────────────────────────────

  describe("/internal/stats", () => {
    it("should return stats JSON for localhost requests", async () => {
      const res = await makeRequest(port, { path: "/internal/stats", method: "GET" });
      expect(res.status).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.status).toBe("operational");
      expect(json.activeSessions).toBe(5);
      expect(json.totalRequests).toBe(100);
    });

    it("should include the live relay node count", async () => {
      mockGetProviderCount.mockReturnValue(7);
      const res = await makeRequest(port, { path: "/internal/stats", method: "GET" });
      const json = JSON.parse(res.body);
      expect(json.relayNodes).toBe(7);
    });
  });

  // ─── HTTP request handling ────────────────────────────────────

  describe("HTTP requests", () => {
    it("should return 407 when no auth is provided", async () => {
      mockAuthenticateRequest.mockResolvedValue(null);
      const res = await makeRequest(port, {
        path: "http://httpbin.org/ip",
        method: "GET",
      });
      expect(res.status).toBe(407);
      expect(res.headers["proxy-authenticate"]).toContain("Basic");
    });

    it("should return 403 when client is from sanctioned country", async () => {
      mockCheckSanctionedCountry.mockReturnValue("IR");
      const res = await makeRequest(port, {
        path: "http://httpbin.org/ip",
        method: "GET",
      });
      expect(res.status).toBe(403);
      expect(res.body).toContain("unavailable in your region");
    });

    it("should return 429 when auth rate limited", async () => {
      mockCheckAuthRateLimit.mockReturnValue(true);
      const res = await makeRequest(port, {
        path: "http://httpbin.org/ip",
        method: "GET",
      });
      expect(res.status).toBe(429);
      expect(res.headers["retry-after"]).toBe("60");
    });

    it("should return 503 when all providers are down", async () => {
      mockSelect.mockImplementation(() => {
        throw new NodeSelectionError("unavailable", "No nodes available");
      });
      const res = await makeRequest(port, {
        path: "http://httpbin.org/ip",
        method: "GET",
        headers: {
          "Proxy-Authorization": "Basic " + Buffer.from("user:dn_live_test").toString("base64"),
        },
      });
      expect(res.status).toBe(503);
    });

    it("should return 403 when provider says sanctioned", async () => {
      mockSelect.mockImplementation(() => {
        throw new NodeSelectionError("sanctioned", "Country IR is sanctioned");
      });
      const res = await makeRequest(port, {
        path: "http://httpbin.org/ip",
        method: "GET",
      });
      expect(res.status).toBe(403);
    });

    it("should return 429 when user connection limit reached", async () => {
      mockIncrementUserConns.mockReturnValue(false);
      const res = await makeRequest(port, {
        path: "http://httpbin.org/ip",
        method: "GET",
      });
      expect(res.status).toBe(429);
      expect(res.body).toContain("Too many concurrent connections");
    });

    it("402 carries the MPP WWW-Authenticate challenge when MPP is configured", async () => {
      mockCheckBalance.mockResolvedValue(false);
      mppChallengeHeaders = { "WWW-Authenticate": 'Payment id="i", realm="dn", method="tempo", intent="charge", request="r"', "Cache-Control": "no-store" };
      const res = await makeRequest(port, { path: "http://httpbin.org/ip", method: "GET" });
      expect(res.status).toBe(402);
      expect(res.headers["www-authenticate"]).toMatch(/^Payment id="i"/);
      expect(res.headers["cache-control"]).toBe("no-store");
    });

    it("relays an MPP-paid request as rail mpp: verify → stream → settle, credential not forwarded", async () => {
      mockAuthenticateRequest.mockResolvedValue(null);
      mockX402Http.mockImplementation(async (req: { __x402?: unknown }) => { req.__x402 = { ...x402Data, rail: "mpp" }; return true; });
      const written: Buffer[] = [];
      mockOpenStream.mockImplementation(async () => {
        const d: Duplex = new Duplex({
          read() { /* */ },
          write(c, _e, cb) { written.push(Buffer.from(c)); d.push("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"); d.push(null); cb(); },
        });
        return d;
      });
      const res = await makeRequest(port, { path: "http://httpbin.org/ip", method: "GET", headers: { Authorization: "Payment eyJ4IjoxfQ" } });
      expect(res.status).toBe(200);
      expect(mockX402Http).toHaveBeenCalled();
      expect(mockStartPrepaidSession).toHaveBeenCalledWith(expect.objectContaining({ userId: "x402-user", rail: "mpp", paidMusd: 5243n }));
      expect(mockOpenStream.mock.invocationCallOrder[0]).toBeLessThan(mockSettlePending.mock.invocationCallOrder[0]);
      expect(Buffer.concat(written).toString()).not.toMatch(/authorization: payment/i);
    });

    it("MPP: settled but client gone → refund to payer identity, never charged", async () => {
      mockAuthenticateRequest.mockResolvedValue(null);
      mockX402Http.mockImplementation(async (req: { __x402?: unknown }) => { req.__x402 = { ...x402Data, rail: "mpp" }; return true; });
      mockOpenStream.mockImplementation(async () => new Duplex({ read() { /* */ }, write(_c, _e, cb) { cb(new Error("boom")); } }));
      await makeRequest(port, { path: "http://httpbin.org/ip", method: "GET", headers: { Authorization: "Payment eyJ4IjoxfQ" } }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 20));
      expect(mockSettlePending).toHaveBeenCalled();
      expect(mockRefundPayer).toHaveBeenCalled();
    });

    it("should return 402 when balance is insufficient", async () => {
      mockCheckBalance.mockResolvedValue(false);
      const res = await makeRequest(port, {
        path: "http://httpbin.org/ip",
        method: "GET",
      });
      expect(res.status).toBe(402);
      expect(res.body).toContain("Insufficient balance");
    });

    it("should return 403 when SSRF target is blocked", async () => {
      mockValidateTarget.mockResolvedValue({ allowed: false, reason: "Private address" });
      const res = await makeRequest(port, {
        path: "http://localhost:6379/",
        method: "GET",
      });
      expect(res.status).toBe(403);
      expect(res.body).toContain("Private address");
    });

    it("should return 402 when startSession fails with insufficient balance", async () => {
      mockStartSession.mockRejectedValue(new Error("Insufficient balance"));
      const res = await makeRequest(port, {
        path: "http://httpbin.org/ip",
        method: "GET",
      });
      expect(res.status).toBe(402);
    });

    it("should return 403 when bandwidth limit exceeded", async () => {
      mockStartSession.mockRejectedValue(new Error("Monthly bandwidth limit exceeded"));
      const res = await makeRequest(port, {
        path: "http://httpbin.org/ip",
        method: "GET",
      });
      expect(res.status).toBe(403);
    });

    it("should return 429 when session rate limit exceeded", async () => {
      mockStartSession.mockRejectedValue(new Error("Session rate limit exceeded"));
      const res = await makeRequest(port, {
        path: "http://httpbin.org/ip",
        method: "GET",
      });
      expect(res.status).toBe(429);
    });

    it("should record auth failure on failed auth", async () => {
      mockAuthenticateRequest.mockResolvedValue(null);
      await makeRequest(port, { path: "http://httpbin.org/ip", method: "GET" });
      expect(mockRecordAuthFailure).toHaveBeenCalled();
    });

    it("should call recordRequest for every request", async () => {
      mockAuthenticateRequest.mockResolvedValue(null);
      await makeRequest(port, { path: "http://httpbin.org/ip", method: "GET" });
      expect(mockRecordRequest).toHaveBeenCalled();
    });

    it("returns 400 PLAINTEXT_DISABLED under opt_in without allowhttp-1", async () => {
      policy.plaintext = "opt_in";
      const res = await makeRequest(port, { path: "http://httpbin.org/ip", method: "GET" });
      expect(res.status).toBe(400);
      expect(res.headers["x-dominusnode-error"]).toBe("PLAINTEXT_DISABLED");
      expect(mockSelect).not.toHaveBeenCalled();
    });

    it("forwards plaintext over a node stream with allowhttp-1 and marks exit visible", async () => {
      policy.plaintext = "opt_in";
      mockAuthenticateRequest.mockResolvedValue({
        userId: "user-123", user: { id: "user-123", status: "active" }, proxyOptions: { allowHttp: true }, teamId: null,
      });
      // Node stream acting as an origin server
      mockOpenStream.mockImplementation(async () => {
        const d: Duplex = new Duplex({
          read() { /* */ },
          write(_c, _e, cb) {
            d.push("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
            d.push(null);
            cb();
          },
        });
        return d;
      });
      const res = await makeRequest(port, { path: "http://httpbin.org/ip", method: "GET" });
      expect(res.status).toBe(200);
      expect(res.body).toBe("ok");
      expect(res.headers["x-dominusnode-exit-visible"]).toBe("1");
      expect(mockOpenStream).toHaveBeenCalledWith("node-1", "httpbin.org", 80);
      expect(mockStartSession.mock.calls[0][4]).toMatchObject({ nodeId: "node-1", ipClass: "residential", nodeOwnerUserId: "owner-node-1", destPort: 80 });
    });

    it("overwrites a spoofed Host header and meters request + response headers on the stream", async () => {
      const written: Buffer[] = [];
      const RESP = "HTTP/1.1 304 Not Modified\r\nETag: x\r\nConnection: close\r\n\r\n";
      mockOpenStream.mockImplementation(async () => {
        const d: Duplex = new Duplex({
          read() { /* */ },
          write(c, _e, cb) {
            written.push(Buffer.from(c));
            if (Buffer.concat(written).includes("\r\n\r\n") && written.length === 1) { d.push(RESP); d.push(null); }
            cb();
          },
        });
        return d;
      });
      const res = await makeRequest(port, {
        path: "http://httpbin.org/ip", method: "HEAD", headers: { Host: "denied-bank.example", "X-Big": "a".repeat(4000) },
      });
      expect(res.status).toBe(304);
      const sent = Buffer.concat(written).toString();
      expect(sent).toMatch(/\r\nhost: httpbin\.org\r\n/i);
      expect(sent).not.toContain("denied-bank.example");
      await new Promise((r) => setTimeout(r, 20));
      const counter = mockStartSession.mock.calls[0][2] as { bytesIn: number; bytesOut: number };
      // No body either way, yet every relayed byte is billed.
      expect(counter.bytesIn).toBe(Buffer.concat(written).length);
      expect(counter.bytesIn).toBeGreaterThan(4000);
      expect(counter.bytesOut).toBe(Buffer.byteLength(RESP));
    });

    it("relays an x402-paid request as the payer's wallet-identity user and settles as rail x402", async () => {
      mockAuthenticateRequest.mockResolvedValue(null);
      mockOpenStream.mockImplementation(async () => {
        const d: Duplex = new Duplex({
          read() { /* */ },
          write(_c, _e, cb) { d.push("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"); d.push(null); cb(); },
        });
        return d;
      });
      const res = await makeRequest(port, { path: "http://httpbin.org/ip", method: "GET", headers: { "X-Payment": "abc" } });
      expect(res.status).toBe(200);
      expect(mockSelect).toHaveBeenCalledWith(expect.objectContaining({ requesterUserId: "x402-user", requesterWallet: X402_PAYER }));
      expect(mockStartPrepaidSession).toHaveBeenCalledWith(expect.objectContaining({
        userId: "x402-user", rail: "x402", paidMusd: 5243n, quotedPricePerGbMusd: 500000n, maxBytes: 10_485_760,
      }));
      expect(mockStartSession).not.toHaveBeenCalled();
      await new Promise((r) => setTimeout(r, 20));
      expect(mockEndSession).toHaveBeenCalledWith("session-x402");
    });

    it("x402: settles only after the node stream is open and the session (snapshot) is started", async () => {
      mockAuthenticateRequest.mockResolvedValue(null);
      mockOpenStream.mockImplementation(async () => {
        const d: Duplex = new Duplex({
          read() { /* */ },
          write(_c, _e, cb) { d.push("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"); d.push(null); cb(); },
        });
        return d;
      });
      const res = await makeRequest(port, { path: "http://httpbin.org/ip", method: "GET", headers: { "X-Payment": "abc" } });
      expect(res.status).toBe(200);
      expect(mockSettlePending).toHaveBeenCalledWith(x402Pending);
      expect(mockOpenStream.mock.invocationCallOrder[0]).toBeLessThan(mockSettlePending.mock.invocationCallOrder[0]);
      expect(mockStartPrepaidSession.mock.invocationCallOrder[0]).toBeLessThan(mockSettlePending.mock.invocationCallOrder[0]);
      expect(mockRefundPayer).not.toHaveBeenCalled();
    });

    it("x402: selects nodes of the quoted class and refuses a node of another class (released, never settled)", async () => {
      mockAuthenticateRequest.mockResolvedValue(null);
      mockX402Http.mockImplementation(async (req: { __x402?: unknown }) => { req.__x402 = { ...x402Data, poolType: "mobile" }; return true; });
      const res = await makeRequest(port, { path: "http://httpbin.org/ip", method: "GET", headers: { "X-Payment": "abc" } });
      expect(mockSelect).toHaveBeenCalledWith(expect.objectContaining({ ipClass: "mobile" }));
      // The (mocked) selector returned a residential node for a mobile quote
      expect(res.status).toBe(503);
      expect(mockSettlePending).not.toHaveBeenCalled();
      expect(mockReleasePending).toHaveBeenCalledWith(x402Pending);
      expect(mockStartPrepaidSession).not.toHaveBeenCalled();
    });

    it("x402: no node available → payment released, never settled", async () => {
      mockAuthenticateRequest.mockResolvedValue(null);
      mockSelect.mockReturnValue(null);
      const res = await makeRequest(port, { path: "http://httpbin.org/ip", method: "GET", headers: { "X-Payment": "abc" } });
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(mockSettlePending).not.toHaveBeenCalled();
      expect(mockReleasePending).toHaveBeenCalledWith(x402Pending);
      expect(mockStartPrepaidSession).not.toHaveBeenCalled();
    });

    it("x402: session start (snapshot) failure → released, never settled", async () => {
      mockAuthenticateRequest.mockResolvedValue(null);
      mockStartPrepaidSession.mockRejectedValue(new Error("Unable to lock relay pricing"));
      const res = await makeRequest(port, { path: "http://httpbin.org/ip", method: "GET", headers: { "X-Payment": "abc" } });
      expect(res.status).toBe(500);
      expect(mockSettlePending).not.toHaveBeenCalled();
      expect(mockReleasePending).toHaveBeenCalledWith(x402Pending);
    });

    it("x402: settlement failure tears down the stream and aborts the session without charging", async () => {
      mockAuthenticateRequest.mockResolvedValue(null);
      mockSettlePending.mockResolvedValue(false);
      const res = await makeRequest(port, { path: "http://httpbin.org/ip", method: "GET", headers: { "X-Payment": "abc" } });
      expect(res.status).toBe(402);
      expect(res.headers["x-dominusnode-error"]).toBe("X402_SETTLEMENT_FAILED");
      expect(mockAbortPrepaid).toHaveBeenCalledWith("session-x402");
      expect(mockEndSession).not.toHaveBeenCalled();
      expect(mockRefundPayer).not.toHaveBeenCalled();
    });

    it("x402: upstream failure after settlement refunds the payer's wallet", async () => {
      mockAuthenticateRequest.mockResolvedValue(null);
      mockOpenStream.mockImplementation(async () => {
        const d: Duplex = new Duplex({
          read() { /* */ },
          write(_c, _e, cb) { cb(); setImmediate(() => d.destroy(new Error("node reset"))); },
        });
        return d;
      });
      const res = await makeRequest(port, { path: "http://httpbin.org/ip", method: "GET", headers: { "X-Payment": "abc" } });
      expect(res.status).toBe(502);
      expect(mockSettlePending).toHaveBeenCalled();
      expect(mockAbortPrepaid).toHaveBeenCalledWith("session-x402");
      expect(mockRefundPayer).toHaveBeenCalledWith(x402Pending, expect.any(String));
      expect(mockEndSession).not.toHaveBeenCalled();
    });

    // Node sends OPEN_OK, then RST while startSession is still awaiting the DB.
    async function rstDuringSessionStart(startMock: typeof mockStartSession, path = "http://example.com/") {
      const { TunnelMux } = await import("./node-tunnel/mux.js");
      const { FrameDecoder, FrameType, encodeFrame, encodeControl, FLAG_RST } = await import("@dominusnode/shared");
      const sent: Buffer[] = [];
      const mux = new TunnelMux({ send: (b: Buffer) => sent.push(b), maxStreams: 4, initialWindow: 65536, openTimeoutMs: 1000 });
      const frame = (t: number, flags = 0, obj: unknown = {}) =>
        mux.handleFrame(new FrameDecoder().push(encodeFrame(t, 1, flags, encodeControl(obj)))[0]);
      mockOpenStream.mockImplementation(async () => {
        const p = mux.openStream("example.com", 80);
        frame(FrameType.OPEN_OK);
        return p;
      });
      let release!: (v: string) => void;
      const started = new Promise<void>((r) => {
        startMock.mockImplementation(() => { r(); return new Promise<string>((res) => { release = res; }); });
      });
      const resP = makeRequest(port, {
        path, method: "GET",
        headers: startMock === mockStartSession
          ? { "Proxy-Authorization": "Basic " + Buffer.from("user:dn_live_test").toString("base64") }
          : { "X-Payment": "abc" },
      });
      await started;
      // Plain node RST: destroys the MuxStream with an error while no caller listener is attached.
      frame(FrameType.CLOSE, FLAG_RST, { bytesIn: 0, bytesOut: 0, reason: "rst" });
      await new Promise((r) => setImmediate(r));
      release(startMock === mockStartSession ? "session-abc" : "session-x402");
      return resP;
    }

    it("node RST while startSession is pending: no crash, slot released, session settled", async () => {
      const res = await rstDuringSessionStart(mockStartSession);
      expect(res.status).toBe(502);
      expect(mockEndSession).toHaveBeenCalledWith("session-abc");
      expect(mockIncrementUserConns).toHaveBeenCalledTimes(1);
      expect(mockDecrementUserConns).toHaveBeenCalledTimes(1);
    });

    it("x402: node RST while the prepaid session starts aborts it and never settles", async () => {
      mockAuthenticateRequest.mockResolvedValue(null);
      const res = await rstDuringSessionStart(mockStartPrepaidSession);
      expect(res.status).toBe(502);
      expect(mockAbortPrepaid).toHaveBeenCalledWith("session-x402");
      expect(mockReleasePending).toHaveBeenCalled();
      expect(mockSettlePending).not.toHaveBeenCalled();
    });

    it("rejects with 413 up front when the body exceeds the session byte cap (nothing billed)", async () => {
      const written: Buffer[] = [];
      mockOpenStream.mockImplementation(async () => new Duplex({
        read() { /* */ },
        write(c, _e, cb) { written.push(c); cb(); },
      }));
      mockStartSession.mockImplementation(async (_u: string, _h: string, counter: { maxBytes: number }) => {
        counter.maxBytes = 50;
        return "session-abc";
      });
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request({
          hostname: "127.0.0.1", port, path: "http://example.com/upload", method: "POST",
          headers: { "Proxy-Authorization": "Basic " + Buffer.from("user:dn_live_test").toString("base64") },
        }, (r) => {
          let d = "";
          r.on("data", (c) => (d += c));
          r.on("end", () => resolve({ status: r.statusCode ?? 0, body: d }));
        });
        req.on("error", reject);
        req.end(Buffer.alloc(200, 0x61));
      });
      expect(res.status).toBe(413);
      expect(written).toHaveLength(0);
      expect(mockEndSession).toHaveBeenCalledWith("session-abc");
      expect(mockDecrementUserConns).toHaveBeenCalledTimes(1);
    });

    it("x402: blocked target releases the payment without settling", async () => {
      mockAuthenticateRequest.mockResolvedValue(null);
      mockValidateTarget.mockResolvedValue({ allowed: false, reason: "private" });
      const res = await makeRequest(port, { path: "http://10.0.0.1/", method: "GET", headers: { "X-Payment": "abc" } });
      expect(res.status).toBe(403);
      expect(mockReleasePending).toHaveBeenCalledWith(x402Pending);
      expect(mockSettlePending).not.toHaveBeenCalled();
    });

    it("does not relay when the x402 handler rejected the payment", async () => {
      mockAuthenticateRequest.mockResolvedValue(null);
      mockX402Http.mockImplementation(async (_req: unknown, res: http.ServerResponse) => { res.writeHead(402); res.end(); return true; });
      const res = await makeRequest(port, { path: "http://httpbin.org/ip", method: "GET", headers: { "X-Payment": "abc" } });
      expect(res.status).toBe(402);
      expect(mockSelect).not.toHaveBeenCalled();
      expect(mockStartPrepaidSession).not.toHaveBeenCalled();
    });

    it("blocks hostnames whose resolved addresses are in a sanctioned country", async () => {
      mockValidateTarget.mockResolvedValue({ allowed: true, addresses: ["93.184.216.34", "5.0.0.1"] });
      mockCheckSanctionedCountry.mockImplementation((ip: string) => (ip === "5.0.0.1" ? "IR" : null));
      const res = await makeRequest(port, { path: "http://ir-hosted.example/", method: "GET" });
      expect(res.status).toBe(403);
      expect(res.headers["x-dominusnode-error"]).toBe("SANCTIONED_DESTINATION");
      expect(mockSelect).not.toHaveBeenCalled();
    });

    it("returns 403 PORT_BLOCKED for ports outside policy", async () => {
      const res = await makeRequest(port, { path: "http://httpbin.org:8080/ip", method: "GET" });
      expect(res.status).toBe(403);
      expect(res.headers["x-dominusnode-error"]).toBe("PORT_BLOCKED");
    });

    it("returns 403 DOMAIN_BLOCKED for denylisted domains (suffix match)", async () => {
      policy.denyDomains = ["httpbin.org"];
      const res = await makeRequest(port, { path: "http://api.httpbin.org/ip", method: "GET" });
      expect(res.status).toBe(403);
      expect(res.headers["x-dominusnode-error"]).toBe("DOMAIN_BLOCKED");
    });

    it("should decrement user conns on balance check failure", async () => {
      mockCheckBalance.mockResolvedValue(false);
      await makeRequest(port, { path: "http://httpbin.org/ip", method: "GET" });
      expect(mockDecrementUserConns).toHaveBeenCalledWith("user-123");
    });
  });

  // ─── HTTPS CONNECT handling ───────────────────────────────────

  describe("HTTPS CONNECT requests", () => {
    it("should return 407 when no auth on CONNECT", async () => {
      mockAuthenticateRequest.mockResolvedValue(null);
      const res = await makeConnect(port, "example.com:443");
      expect(res.status).toBe(407);
      res.socket.destroy();
    });

    it("should return 403 on CONNECT from sanctioned country", async () => {
      mockCheckSanctionedCountry.mockReturnValue("CU");
      const res = await makeConnect(port, "example.com:443");
      expect(res.status).toBe(403);
      res.socket.destroy();
    });

    it("should return 429 on CONNECT when auth rate limited", async () => {
      mockCheckAuthRateLimit.mockReturnValue(true);
      const res = await makeConnect(port, "example.com:443");
      expect(res.status).toBe(429);
      res.socket.destroy();
    });

    it("should return 503 on CONNECT when all providers down", async () => {
      mockSelect.mockImplementation(() => {
        throw new NodeSelectionError("unavailable", "No nodes available");
      });
      const res = await makeConnect(port, "example.com:443");
      expect(res.status).toBe(503);
      res.socket.destroy();
    });

    it("should return 429 on CONNECT when user conn limit reached", async () => {
      mockIncrementUserConns.mockReturnValue(false);
      const res = await makeConnect(port, "example.com:443");
      expect(res.status).toBe(429);
      res.socket.destroy();
    });

    it("should return 402 on CONNECT when balance insufficient", async () => {
      mockCheckBalance.mockResolvedValue(false);
      const res = await makeConnect(port, "example.com:443");
      expect(res.status).toBe(402);
      res.socket.destroy();
    });

    it("should return 400 for malformed CONNECT URL (bad IPv6 brackets)", async () => {
      mockIsValidHostname.mockReturnValue(false);
      const res = await makeConnect(port, "[::1:443");
      expect(res.status).toBe(400);
      res.socket.destroy();
    });

    it("should return 403 on CONNECT when SSRF target blocked", async () => {
      mockValidateTarget.mockResolvedValue({ allowed: false, reason: "Private address" });
      const res = await makeConnect(port, "10.0.0.1:443");
      expect(res.status).toBe(403);
      res.socket.destroy();
    });

    it("should record auth failure on failed CONNECT auth", async () => {
      mockAuthenticateRequest.mockResolvedValue(null);
      const res = await makeConnect(port, "example.com:443");
      expect(mockRecordAuthFailure).toHaveBeenCalled();
      res.socket.destroy();
    });

    it("should call recordRequest for CONNECT", async () => {
      mockAuthenticateRequest.mockResolvedValue(null);
      const res = await makeConnect(port, "example.com:443");
      expect(mockRecordRequest).toHaveBeenCalled();
      res.socket.destroy();
    });

    it("treats CONNECT to a non-TLS port (8080) as plaintext under opt_in", async () => {
      policy.ports = [80, 443, 8080];
      policy.plaintext = "opt_in";
      const res = await makeConnect(port, "example.com:8080");
      expect(res.status).toBe(400);
      expect(mockSelect).not.toHaveBeenCalled();
      res.socket.destroy();
    });

    it("tunnels an MPP-paid CONNECT (Proxy-Authorization: Payment) as rail mpp", async () => {
      mockAuthenticateRequest.mockResolvedValue(null);
      mockX402Connect.mockResolvedValue({ handled: true, verified: true, ...x402Data, rail: "mpp", paymentHeader: "" });
      const res = await makeConnect(port, "example.com:443", { "Proxy-Authorization": "Payment eyJ4IjoxfQ" });
      expect(res.status).toBe(200);
      expect(mockX402Connect).toHaveBeenCalled();
      expect(mockStartPrepaidSession).toHaveBeenCalledWith(expect.objectContaining({ userId: "x402-user", rail: "mpp" }));
      expect(mockOpenStream.mock.invocationCallOrder[0]).toBeLessThan(mockSettlePending.mock.invocationCallOrder[0]);
      res.socket.destroy();
    });

    it("tunnels an x402-paid CONNECT as a prepaid relay session", async () => {
      mockAuthenticateRequest.mockResolvedValue(null);
      const res = await makeConnect(port, "example.com:443", { "X-Payment": "abc" });
      expect(res.status).toBe(200);
      expect(mockStartPrepaidSession).toHaveBeenCalledWith(expect.objectContaining({ userId: "x402-user", rail: "x402", paidMusd: 5243n }));
      res.socket.destroy();
      await new Promise((r) => setTimeout(r, 20));
      expect(mockEndSession).toHaveBeenCalledWith("session-x402");
    });

    it("x402 CONNECT: settles after the stream opens; settlement failure → 402, session aborted", async () => {
      mockAuthenticateRequest.mockResolvedValue(null);
      mockSettlePending.mockResolvedValue(false);
      const res = await makeConnect(port, "example.com:443", { "X-Payment": "abc" });
      expect(res.status).toBe(402);
      expect(mockOpenStream.mock.invocationCallOrder[0]).toBeLessThan(mockSettlePending.mock.invocationCallOrder[0]);
      expect(mockAbortPrepaid).toHaveBeenCalledWith("session-x402");
      expect(mockEndSession).not.toHaveBeenCalled();
      res.socket.destroy();
    });

    it("x402 CONNECT: no node → released, never settled", async () => {
      mockAuthenticateRequest.mockResolvedValue(null);
      mockSelect.mockReturnValue(null);
      const res = await makeConnect(port, "example.com:443", { "X-Payment": "abc" });
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(mockSettlePending).not.toHaveBeenCalled();
      expect(mockReleasePending).toHaveBeenCalledWith(x402Pending);
      res.socket.destroy();
    });

    it("tunnels CONNECT through a node stream", async () => {
      const res = await makeConnect(port, "example.com:443");
      expect(res.status).toBe(200);
      expect(mockOpenStream).toHaveBeenCalledWith("node-1", "example.com", 443);
      const echoed = await new Promise<string>((resolve) => {
        res.socket.once("data", (d) => resolve(d.toString()));
        res.socket.write("ping");
      });
      expect(echoed).toBe("ping");
      res.socket.destroy();
    });

    it("retries once on another node after DIAL_FAIL", async () => {
      mockOpenStream.mockImplementation(async (id: string) => {
        if (id === "node-1") throw new TunnelOpenError("DIAL_FAIL");
        return echoStream();
      });
      const res = await makeConnect(port, "example.com:443");
      expect(res.status).toBe(200);
      expect(mockSelect).toHaveBeenCalledTimes(2);
      expect(mockSelect.mock.calls[1][0]).toMatchObject({ excludeNodeIds: ["node-1"] });
      res.socket.destroy();
    });

    it("returns 403 without retry on FLOOR_BLOCKED", async () => {
      mockOpenStream.mockRejectedValue(new TunnelOpenError("FLOOR_BLOCKED"));
      const res = await makeConnect(port, "example.com:443");
      expect(res.status).toBe(403);
      expect(mockSelect).toHaveBeenCalledTimes(1);
      expect(mockDecrementUserConns).toHaveBeenCalledWith("user-123");
      res.socket.destroy();
    });

    it("should decrement user conns on CONNECT balance failure", async () => {
      mockCheckBalance.mockResolvedValue(false);
      const res = await makeConnect(port, "example.com:443");
      expect(mockDecrementUserConns).toHaveBeenCalledWith("user-123");
      res.socket.destroy();
    });
  });

  // ─── TLS listener + plaintext auth guard ──────────────────────

  describe("TLS proxy listener", () => {
    const fx = path.join(__dirname, "__fixtures__");
    const tlsCreds = { cert: fs.readFileSync(path.join(fx, "test-proxy-tls.crt")), key: fs.readFileSync(path.join(fx, "test-proxy-tls.key")) };
    let tlsServer: http.Server;
    let tlsPort: number;

    beforeEach(async () => {
      const relay = { selector: { select: (o: unknown) => mockSelect(o) }, getPolicy: () => policy, nodeCount: () => 1 };
      tlsServer = await startProxyServer(0, relay as any, { tls: tlsCreds, plaintextAuth: () => false });
      await new Promise((r) => setImmediate(r));
      const a = tlsServer.address();
      tlsPort = typeof a === "object" && a ? a.port : 0;
    });
    afterEach(async () => {
      await new Promise<void>((resolve) => tlsServer.close(() => resolve()));
    });

    it("accepts CONNECT inside TLS with Proxy-Authorization through the same auth path", async () => {
      const sock = tls.connect({ host: "127.0.0.1", port: tlsPort, ca: tlsCreds.cert, servername: "localhost" });
      await new Promise<void>((r, j) => { sock.once("secureConnect", () => r()); sock.once("error", j); });
      const auth = Buffer.from("user:dn_live_testkey").toString("base64");
      sock.write(`CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
      let buf = "";
      await new Promise<void>((r) => sock.on("data", (d) => { buf += d.toString(); if (buf.includes("\r\n\r\n")) r(); }));
      expect(buf).toMatch(/^HTTP\/1\.1 200/);
      expect(mockAuthenticateRequest).toHaveBeenCalled();
      sock.write("ping");
      const echoed = await new Promise<string>((r) => sock.once("data", (d) => r(d.toString())));
      expect(echoed).toBe("ping");
      sock.destroy();
    });

    it("ignores the plaintext guard on the TLS listener", async () => {
      const res = await new Promise<number>((resolve, reject) => {
        const req = https.request({ host: "127.0.0.1", port: tlsPort, ca: tlsCreds.cert, servername: "localhost", path: "/internal/stats", headers: { "Proxy-Authorization": "Basic eA==" } }, (r) => { r.resume(); resolve(r.statusCode ?? 0); });
        req.on("error", reject);
        req.end();
      });
      expect(res).toBe(200);
    });
  });

  describe("plaintext auth guard (PROXY_REQUIRE_TLS)", () => {
    let plain: http.Server;
    let plainPort: number;
    const guard = vi.fn();

    beforeEach(async () => {
      const relay = { selector: { select: (o: unknown) => mockSelect(o) }, getPolicy: () => policy, nodeCount: () => 1 };
      plain = await startProxyServer(0, relay as any, { plaintextAuth: (l) => guard(l) });
      await new Promise((r) => setImmediate(r));
      const a = plain.address();
      plainPort = typeof a === "object" && a ? a.port : 0;
    });
    afterEach(async () => {
      await new Promise<void>((resolve) => plain.close(() => resolve()));
    });

    it("refuses HTTP requests carrying credentials when the guard says no", async () => {
      guard.mockReturnValue(false);
      const res = await makeRequest(plainPort, { path: "http://httpbin.org/ip", method: "GET", headers: { "Proxy-Authorization": "Basic eA==" } });
      expect(res.status).toBe(403);
      expect(res.body).toContain("TLS required");
      expect(mockAuthenticateRequest).not.toHaveBeenCalled();
    });

    it("refuses CONNECT carrying credentials when the guard says no", async () => {
      guard.mockReturnValue(false);
      const res = await makeConnect(plainPort, "example.com:443", { "Proxy-Authorization": "Basic eA==" });
      expect(res.status).toBe(403);
      expect(mockAuthenticateRequest).not.toHaveBeenCalled();
      res.socket.destroy();
    });

    it("refuses X-PAYMENT / MPP Payment credentials on plaintext when TLS is required", async () => {
      guard.mockReturnValue(false);
      const r1 = await makeRequest(plainPort, { path: "http://httpbin.org/ip", method: "GET", headers: { "X-Payment": "eyJ4IjoxfQ==" } });
      expect(r1.status).toBe(403);
      const r2 = await makeRequest(plainPort, { path: "http://httpbin.org/ip", method: "GET", headers: { Authorization: "Payment abc_-1" } });
      expect(r2.status).toBe(403);
      const r3 = await makeConnect(plainPort, "example.com:443", { "X-Payment": "eyJ4IjoxfQ==" });
      expect(r3.status).toBe(403);
      r3.socket.destroy();
      expect(mockAuthenticateRequest).not.toHaveBeenCalled();
    });

    it("lets credentials through when the guard allows (warn-only mode)", async () => {
      guard.mockReturnValue(true);
      const res = await makeConnect(plainPort, "example.com:443", { "Proxy-Authorization": "Basic eA==" });
      expect(res.status).toBe(200);
      expect(guard).toHaveBeenCalledWith("http");
      res.socket.destroy();
    });
  });
});

describe("meterStream byte cap", () => {
  it("refuses a write that would cross the cap and truncates reads at the cap", async () => {
    const { meterStream } = await import("./server.js");
    const written: Buffer[] = [];
    const d = new Duplex({ read() { /* */ }, write(c, _e, cb) { written.push(c); cb(); } });
    const counter = { bytesIn: 0, bytesOut: 0, maxBytes: 10, onLimitExceeded: vi.fn() };
    meterStream(d, counter);
    expect(d.write(Buffer.from("123456"))).toBe(true);
    expect(d.write(Buffer.from("abcdef"))).toBe(false);
    expect(counter.bytesIn).toBe(6);
    expect(counter.onLimitExceeded).toHaveBeenCalledTimes(1);
    const got: Buffer[] = [];
    d.on("data", (c: Buffer) => got.push(c));
    d.push(Buffer.from("ZZZZZZZZ"));
    await new Promise((r) => setImmediate(r));
    expect(Buffer.concat(got).toString()).toBe("ZZZZ");
    expect(counter.bytesIn + counter.bytesOut).toBe(10);
    await new Promise((r) => setImmediate(r));
    expect(Buffer.concat(written).toString()).toBe("123456");
  });
});

describe("gateway X-Request-Id on raw CONNECT responses", () => {
  it("inserts the id after the status line once", async () => {
    const { withRequestIdHeader } = await import("./server.js");
    expect(withRequestIdHeader("HTTP/1.1 403 Forbidden\r\nX-DominusNode-Error: TARGET_BLOCKED\r\n\r\n", "rid-1"))
      .toBe("HTTP/1.1 403 Forbidden\r\nX-Request-Id: rid-1\r\nX-DominusNode-Error: TARGET_BLOCKED\r\n\r\n");
    const once = withRequestIdHeader("HTTP/1.1 200 OK\r\n\r\n", "a");
    expect(withRequestIdHeader(once, "b")).toBe(once);
    expect(withRequestIdHeader("not http", "a")).toBe("not http");
  });
});
