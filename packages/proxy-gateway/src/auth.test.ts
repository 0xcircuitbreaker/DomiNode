import { describe, it, expect, vi, beforeEach } from "vitest";
import * as http from "node:http";

// Mock @dominusnode/shared
const mockFindUserByApiKeyHash = vi.fn();
const mockFindUserById = vi.fn();
const mockVerifyProxySessionToken = vi.fn();

vi.mock("@dominusnode/shared", () => ({
  hashApiKey: (raw: string) => {
    // Use a simple deterministic hash for tests
    const crypto = require("node:crypto");
    return crypto.createHash("sha256").update(raw).digest("hex");
  },
  verifyProxySessionToken: (...args: unknown[]) => mockVerifyProxySessionToken(...args),
  userRepo: {
    findUserByApiKey: (...args: unknown[]) => mockFindUserByApiKeyHash(...args),
    findUserById: (...args: unknown[]) => mockFindUserById(...args),
  },
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { authenticateRequest, parseProxyOptions } from "./auth.js";

function makeRequest(proxyAuth?: string): http.IncomingMessage {
  const req = new http.IncomingMessage(null as any);
  if (proxyAuth) {
    req.headers["proxy-authorization"] = proxyAuth;
  }
  return req;
}

function encodeBasic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

describe("proxy-gateway/auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── authenticateRequest ──────────────────────────────────────────

  describe("authenticateRequest", () => {
    it("should return null when no proxy-authorization header", async () => {
      const req = makeRequest();
      const result = await authenticateRequest(req);
      expect(result).toBeNull();
    });

    it("should return null for non-Basic auth scheme", async () => {
      const req = makeRequest("Bearer some-token");
      const result = await authenticateRequest(req);
      expect(result).toBeNull();
    });

    it("should return null for invalid base64", async () => {
      const req = makeRequest("Basic !!!invalid!!!");
      const result = await authenticateRequest(req);
      expect(result).toBeNull();
    });

    it("should return null when no colon in decoded string", async () => {
      const req = makeRequest(`Basic ${Buffer.from("nopassword").toString("base64")}`);
      const result = await authenticateRequest(req);
      expect(result).toBeNull();
    });

    it("should return null when API key does not start with dn_live_", async () => {
      const req = makeRequest(encodeBasic("user", "invalid_key_123"));
      const result = await authenticateRequest(req);
      expect(result).toBeNull();
    });

    it("should return null when API key is not found in DB", async () => {
      mockFindUserByApiKeyHash.mockResolvedValueOnce(null);

      const req = makeRequest(encodeBasic("user", "dn_live_abcdef0123456789"));
      const result = await authenticateRequest(req);
      expect(result).toBeNull();
    });

    it("should return auth result with userId and empty proxy options", async () => {
      const mockUser = {
        id: "user-1",
        email: "test@example.com",
        status: "active",
        email_verified: true,
      };
      mockFindUserByApiKeyHash.mockResolvedValueOnce({
        user: mockUser,
        apiKey: { id: "ak1" },
      });

      const req = makeRequest(encodeBasic("user", "dn_live_abc123"));
      const result = await authenticateRequest(req);

      expect(result).not.toBeNull();
      expect(result!.userId).toBe("user-1");
      expect(result!.user).toEqual(mockUser);
      expect(result!.proxyOptions).toEqual({});
    });

    it("should parse country option from username", async () => {
      const mockUser = { id: "u2", email: "a@b.com", status: "active", email_verified: true };
      mockFindUserByApiKeyHash.mockResolvedValueOnce({
        user: mockUser,
        apiKey: { id: "ak2" },
      });

      const req = makeRequest(encodeBasic("country-US", "dn_live_key123"));
      const result = await authenticateRequest(req);

      expect(result!.proxyOptions.country).toBe("US");
    });

    it("should parse session option from username", async () => {
      const mockUser = { id: "u3", email: "a@b.com", status: "active", email_verified: true };
      mockFindUserByApiKeyHash.mockResolvedValueOnce({
        user: mockUser,
        apiKey: { id: "ak3" },
      });

      const req = makeRequest(encodeBasic("session-abc123", "dn_live_key123"));
      const result = await authenticateRequest(req);

      expect(result!.proxyOptions.sessionId).toBe("abc123");
    });

    it("should parse combined country and session from username", async () => {
      const mockUser = { id: "u4", email: "a@b.com", status: "active", email_verified: true };
      mockFindUserByApiKeyHash.mockResolvedValueOnce({
        user: mockUser,
        apiKey: { id: "ak4" },
      });

      const req = makeRequest(
        encodeBasic("country-DE-session-xyz789", "dn_live_key123"),
      );
      const result = await authenticateRequest(req);

      expect(result!.proxyOptions.country).toBe("DE");
      expect(result!.proxyOptions.sessionId).toBe("xyz789");
    });

    it("should return null on DB error", async () => {
      mockFindUserByApiKeyHash.mockRejectedValueOnce(new Error("connection refused"));

      const req = makeRequest(encodeBasic("user", "dn_live_key123"));
      const result = await authenticateRequest(req);
      expect(result).toBeNull();
    });

    // ─── Proxy Session Token Auth ─────────────────────────────────────

    it("should authenticate with a valid proxy session token", async () => {
      const mockUser = {
        id: "wallet-user-1",
        email: "0xabc@wallet.dominusnode.com",
        status: "active",
        email_verified: true,
        wallet_address: "0xabc123",
      };
      mockVerifyProxySessionToken.mockReturnValueOnce({
        userId: "wallet-user-1",
        walletAddress: "0xabc123",
        expiresAt: Date.now() + 3600000,
        nonce: "abc123",
      });
      mockFindUserById.mockResolvedValueOnce(mockUser);

      const req = makeRequest(encodeBasic("country-US", "dn_proxy_payload.hmac"));
      const result = await authenticateRequest(req);

      expect(result).not.toBeNull();
      expect(result!.userId).toBe("wallet-user-1");
      expect(result!.proxyOptions.country).toBe("US");
      expect(result!.teamId).toBeNull();
    });

    it("should return null for invalid proxy session token", async () => {
      mockVerifyProxySessionToken.mockReturnValueOnce(null);

      const req = makeRequest(encodeBasic("user", "dn_proxy_invalid.token"));
      const result = await authenticateRequest(req);
      expect(result).toBeNull();
    });

    it("should reject proxy session for suspended user", async () => {
      mockVerifyProxySessionToken.mockReturnValueOnce({
        userId: "suspended-user",
        walletAddress: "0xdef",
        expiresAt: Date.now() + 3600000,
        nonce: "xyz",
      });
      mockFindUserById.mockResolvedValueOnce({
        id: "suspended-user",
        status: "suspended",
        wallet_address: "0xdef",
      });

      const req = makeRequest(encodeBasic("user", "dn_proxy_payload.hmac"));
      const result = await authenticateRequest(req);
      expect(result).toBeNull();
    });

    it("should reject proxy session when wallet address no longer matches", async () => {
      mockVerifyProxySessionToken.mockReturnValueOnce({
        userId: "user-1",
        walletAddress: "0xold_wallet",
        expiresAt: Date.now() + 3600000,
        nonce: "abc",
      });
      mockFindUserById.mockResolvedValueOnce({
        id: "user-1",
        status: "active",
        wallet_address: "0xnew_wallet",
      });

      const req = makeRequest(encodeBasic("user", "dn_proxy_payload.hmac"));
      const result = await authenticateRequest(req);
      expect(result).toBeNull();
    });

    it("should reject proxy session when user has no wallet", async () => {
      mockVerifyProxySessionToken.mockReturnValueOnce({
        userId: "user-1",
        walletAddress: "0xabc",
        expiresAt: Date.now() + 3600000,
        nonce: "abc",
      });
      mockFindUserById.mockResolvedValueOnce({
        id: "user-1",
        status: "active",
        wallet_address: null,
      });

      const req = makeRequest(encodeBasic("user", "dn_proxy_payload.hmac"));
      const result = await authenticateRequest(req);
      expect(result).toBeNull();
    });
  });
});

describe("parseProxyOptions (relay flags)", () => {
  it("parses country, class, session and allowhttp-1", () => {
    expect(parseProxyOptions("country-us-class-mobile-session-abc123-allowhttp-1")).toEqual({
      country: "US", ipClass: "mobile", sessionId: "abc123", allowHttp: true,
    });
  });

  it("maps deprecated dc-/residential- prefixes to ipClass", () => {
    expect(parseProxyOptions("dc-country-DE")).toMatchObject({ proxyType: "dc", ipClass: "dc", country: "DE" });
    expect(parseProxyOptions("residential")).toMatchObject({ proxyType: "residential", ipClass: "residential" });
    expect(parseProxyOptions("auto-country-US").ipClass).toBeUndefined();
  });

  it("class- overrides the legacy prefix", () => {
    expect(parseProxyOptions("dc-class-residential").ipClass).toBe("residential");
  });

  it("ignores unknown classes and allowhttp values other than 1", () => {
    const o = parseProxyOptions("class-satellite-allowhttp-0");
    expect(o.ipClass).toBeUndefined();
    expect(o.allowHttp).toBeUndefined();
  });
});
