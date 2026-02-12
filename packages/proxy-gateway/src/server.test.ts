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

vi.mock("./auth.js", () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticateRequest(...args),
}));

vi.mock("./balance-check.js", () => ({
  checkBalance: (...args: unknown[]) => mockCheckBalance(...args),
}));

vi.mock("./session-manager.js", () => ({
  startSession: (...args: unknown[]) => mockStartSession(...args),
  endSession: (...args: unknown[]) => mockEndSession(...args),
  getActiveSessionCount: () => mockGetActiveSessionCount(),
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
  attachByteCounters: () => ({ bytesIn: 0, bytesOut: 0 }),
}));

vi.mock("./retry.js", () => ({
  executeWithRetry: vi.fn(),
  promisifyRequest: vi.fn(),
  DEFAULT_RETRY_OPTIONS: { maxRetries: 2, baseDelayMs: 200, maxDelayMs: 2000 },
}));

vi.mock("@dominode/shared", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("@dominode/pool-manager", () => ({
  createProviderSelector: () => ({
    select: (...args: unknown[]) => mockSelect(...args),
    recordSuccess: (...args: unknown[]) => mockRecordSuccess(...args),
    recordFailure: (...args: unknown[]) => mockRecordFailure(...args),
    getProviderCount: () => mockGetProviderCount(),
    getStats: () => mockGetProviderStats(),
  }),
}));

import { startProxyServer } from "./server.js";

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
    mockSelect.mockReturnValue({
      provider: { name: "packetstream" },
      proxy: { host: "gw.test.io", port: 31112, proxyAuth: Buffer.from("u:p").toString("base64") },
    });
    mockIncrementUserConns.mockReturnValue(true);
    mockCheckBalance.mockResolvedValue(true);
    mockValidateTarget.mockResolvedValue({ allowed: true });
    mockIsValidHostname.mockReturnValue(true);
    mockIsValidPort.mockReturnValue(true);
    mockStartSession.mockResolvedValue("session-abc");
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

    // Create a mock provider selector
    const mockProviderSelector = {
      select: (...args: unknown[]) => mockSelect(...args),
      recordSuccess: (...args: unknown[]) => mockRecordSuccess(...args),
      recordFailure: (...args: unknown[]) => mockRecordFailure(...args),
      getProviderCount: () => mockGetProviderCount(),
      getStats: () => mockGetProviderStats(),
    };

    server = await startProxyServer(0, mockProviderSelector as any);
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

    it("should include provider stats", async () => {
      mockGetProviderStats.mockReturnValue([{ name: "packetstream", state: "closed" }]);
      const res = await makeRequest(port, { path: "/internal/stats", method: "GET" });
      const json = JSON.parse(res.body);
      expect(json.providers).toHaveLength(1);
      expect(json.providers[0].name).toBe("packetstream");
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
        throw new Error("All providers unavailable");
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
        throw new Error("Target in sanctioned country");
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
        throw new Error("All providers unavailable");
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

    it("should decrement user conns on CONNECT balance failure", async () => {
      mockCheckBalance.mockResolvedValue(false);
      const res = await makeConnect(port, "example.com:443");
      expect(mockDecrementUserConns).toHaveBeenCalledWith("user-123");
      res.socket.destroy();
    });
  });
});
