import { describe, it, expect, vi, beforeEach } from "vitest";
import * as http from "node:http";

// Mock @dominusnode/shared
const mockFindUserByApiKeyHash = vi.fn();

vi.mock("@dominusnode/shared", () => ({
  hashApiKey: (raw: string) => {
    // Use a simple deterministic hash for tests
    const crypto = require("node:crypto");
    return crypto.createHash("sha256").update(raw).digest("hex");
  },
  userRepo: {
    findUserByApiKeyHash: (...args: unknown[]) => mockFindUserByApiKeyHash(...args),
  },
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { authenticateRequest } from "./auth.js";

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
  });
});
