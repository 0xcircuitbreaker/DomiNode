import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import * as net from "node:net";

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
const mockRecordSuccess = vi.fn();
const mockRecordFailure = vi.fn();
const mockGetProviderCount = vi.fn();
const mockGetProviderStats = vi.fn();
const mockGetUserPlan = vi.fn();
const mockStartPrepaidSession = vi.fn();
const mockX402Http = vi.fn();
const mockX402Connect = vi.fn();
const X402_PAYER = "0x" + "9".repeat(40);
const x402Data = { payer: X402_PAYER, userId: "x402-user", amountUsd: "0.005243", amountMusd: 5243n, pricePerGbMusd: 500000n, facilitator: "coinbase", poolType: "residential", maxResponseBytes: 10_485_760 };

vi.mock("./x402-handler.js", () => ({
  handleX402Http: (req: { __x402?: unknown }, ...rest: unknown[]) => mockX402Http(req, ...rest),
  handleX402Connect: (...args: unknown[]) => mockX402Connect(...args),
  build402ResponseBody: () => "Insufficient balance",
  build402ConnectResponse: () => "HTTP/1.1 402 Payment Required\r\n\r\n",
  isX402Verified: (req: { __x402?: unknown }) => !!req.__x402,
  getX402Data: (req: { __x402?: unknown }) => (req.__x402 ? x402Data : null),
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

vi.mock("./counting-stream.js", () => ({
  attachByteCounters: () => ({ bytesIn: 0, bytesOut: 0, maxBytes: 0, onLimitExceeded: null }),
}));



vi.mock("@dominusnode/shared", () => ({
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
    mockX402Http.mockImplementation(async (req: { __x402?: unknown }) => { req.__x402 = x402Data; return true; });
    mockX402Connect.mockResolvedValue({ handled: true, verified: true, ...x402Data, paymentHeader: "" });
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

    it("tunnels an x402-paid CONNECT as a prepaid relay session", async () => {
      mockAuthenticateRequest.mockResolvedValue(null);
      const res = await makeConnect(port, "example.com:443", { "X-Payment": "abc" });
      expect(res.status).toBe(200);
      expect(mockStartPrepaidSession).toHaveBeenCalledWith(expect.objectContaining({ userId: "x402-user", rail: "x402", paidMusd: 5243n }));
      res.socket.destroy();
      await new Promise((r) => setTimeout(r, 20));
      expect(mockEndSession).toHaveBeenCalledWith("session-x402");
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
});
