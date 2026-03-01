import { describe, it, expect, vi, beforeEach } from "vitest";
import { WalletAuthResource } from "../src/resources/wallet-auth.js";

function createMockHttp() {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    request: vi.fn(),
  };
}

function createMockTokenManager() {
  return {
    setTokens: vi.fn(),
    getAccessToken: vi.fn().mockReturnValue(null),
    setRefreshFunction: vi.fn(),
    clear: vi.fn(),
  };
}

const VALID_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
// Valid EIP-191 signature: 0x + 130 hex chars (65 bytes)
const VALID_SIGNATURE = "0x" + "a".repeat(130);
const VALID_CHALLENGE = "Sign this message to authenticate: abc123";

describe("WalletAuthResource", () => {
  let http: ReturnType<typeof createMockHttp>;
  let tokenManager: ReturnType<typeof createMockTokenManager>;
  let resource: WalletAuthResource;

  beforeEach(() => {
    http = createMockHttp();
    tokenManager = createMockTokenManager();
    resource = new WalletAuthResource(http as any, tokenManager as any);
  });

  describe("challenge", () => {
    it("calls POST /api/auth/wallet/challenge without auth", async () => {
      const mockResponse = {
        challenge: "Sign this message to authenticate: abc123",
        expiresAt: "2026-03-01T00:00:00Z",
      };
      http.post.mockResolvedValue(mockResponse);

      const result = await resource.challenge(VALID_ADDRESS);

      expect(http.post).toHaveBeenCalledWith(
        "/api/auth/wallet/challenge",
        { address: VALID_ADDRESS },
        false,
      );
      expect(result.challenge).toBe(mockResponse.challenge);
      expect(result.expiresAt).toBe(mockResponse.expiresAt);
    });

    it("rejects invalid Ethereum address", async () => {
      await expect(resource.challenge("not-an-address")).rejects.toThrow(
        "valid Ethereum address",
      );
    });

    it("rejects empty address", async () => {
      await expect(resource.challenge("")).rejects.toThrow("address is required");
    });

    it("rejects address without 0x prefix", async () => {
      await expect(
        resource.challenge("1234567890abcdef1234567890abcdef12345678"),
      ).rejects.toThrow("valid Ethereum address");
    });

    it("rejects address with wrong length", async () => {
      await expect(resource.challenge("0x1234")).rejects.toThrow(
        "valid Ethereum address",
      );
    });
  });

  describe("verify", () => {
    it("calls POST /api/auth/wallet/verify without auth", async () => {
      const mockResponse = {
        token: "jwt-token",
        refreshToken: "refresh-token",
        user: { id: "u1", email: "wallet@example.com", is_admin: false },
      };
      http.post.mockResolvedValue(mockResponse);

      const result = await resource.verify(
        VALID_ADDRESS,
        VALID_SIGNATURE,
        VALID_CHALLENGE,
      );

      expect(http.post).toHaveBeenCalledWith(
        "/api/auth/wallet/verify",
        {
          address: VALID_ADDRESS,
          signature: VALID_SIGNATURE,
          challenge: VALID_CHALLENGE,
        },
        false,
      );
      expect(result.token).toBe("jwt-token");
      expect(result.refreshToken).toBe("refresh-token");
      expect(result.user.id).toBe("u1");
    });

    it("stores tokens in TokenManager after verify", async () => {
      const mockResponse = {
        token: "jwt-token",
        refreshToken: "refresh-token",
        user: { id: "u1", email: "wallet@example.com", is_admin: false },
      };
      http.post.mockResolvedValue(mockResponse);

      await resource.verify(VALID_ADDRESS, VALID_SIGNATURE);

      expect(tokenManager.setTokens).toHaveBeenCalledWith("jwt-token", "refresh-token");
    });

    it("works without challenge parameter (optional)", async () => {
      const mockResponse = {
        token: "jwt-token",
        refreshToken: "refresh-token",
        user: { id: "u1", email: "w@e.com", is_admin: false },
      };
      http.post.mockResolvedValue(mockResponse);

      const result = await resource.verify(VALID_ADDRESS, VALID_SIGNATURE);

      expect(http.post).toHaveBeenCalledWith(
        "/api/auth/wallet/verify",
        { address: VALID_ADDRESS, signature: VALID_SIGNATURE },
        false,
      );
      expect(result.token).toBe("jwt-token");
    });

    it("rejects invalid address", async () => {
      await expect(
        resource.verify("bad-addr", VALID_SIGNATURE, VALID_CHALLENGE),
      ).rejects.toThrow("valid Ethereum address");
    });

    it("rejects empty signature", async () => {
      await expect(
        resource.verify(VALID_ADDRESS, ""),
      ).rejects.toThrow("signature is required");
    });

    it("rejects short signature (not EIP-191 format)", async () => {
      await expect(
        resource.verify(VALID_ADDRESS, "0xdeadbeef"),
      ).rejects.toThrow("valid EIP-191 signature");
    });

    it("rejects signature without 0x prefix", async () => {
      await expect(
        resource.verify(VALID_ADDRESS, "a".repeat(130)),
      ).rejects.toThrow("valid EIP-191 signature");
    });

    it("rejects oversized signature", async () => {
      await expect(
        resource.verify(VALID_ADDRESS, "0x" + "a".repeat(250)),
      ).rejects.toThrow("must not exceed 200 characters");
    });
  });

  describe("link", () => {
    it("calls POST /api/auth/wallet/link with auth", async () => {
      const mockResponse = {
        success: true,
        walletAddress: VALID_ADDRESS,
      };
      http.post.mockResolvedValue(mockResponse);

      const result = await resource.link(
        VALID_ADDRESS,
        VALID_SIGNATURE,
        VALID_CHALLENGE,
      );

      // link() should use default auth (no false third arg)
      expect(http.post).toHaveBeenCalledWith("/api/auth/wallet/link", {
        address: VALID_ADDRESS,
        signature: VALID_SIGNATURE,
        challenge: VALID_CHALLENGE,
      });
      expect(result.success).toBe(true);
      expect(result.walletAddress).toBe(VALID_ADDRESS);
    });

    it("works without challenge parameter (optional)", async () => {
      const mockResponse = { success: true, walletAddress: VALID_ADDRESS };
      http.post.mockResolvedValue(mockResponse);

      await resource.link(VALID_ADDRESS, VALID_SIGNATURE);

      expect(http.post).toHaveBeenCalledWith("/api/auth/wallet/link", {
        address: VALID_ADDRESS,
        signature: VALID_SIGNATURE,
      });
    });

    it("rejects invalid address", async () => {
      await expect(
        resource.link("bad-addr", VALID_SIGNATURE, VALID_CHALLENGE),
      ).rejects.toThrow("valid Ethereum address");
    });
  });
});
