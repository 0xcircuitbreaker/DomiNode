import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the shared modules before importing auth-manager
vi.mock("../shared/api-client.js", () => ({
  apiPost: vi.fn(),
  apiGet: vi.fn(),
  getApiBase: vi.fn(() => "http://localhost:3000"),
  setApiBase: vi.fn(),
}));

vi.mock("../shared/state.js", () => {
  let mockState: Record<string, unknown> = {};
  return {
    loadState: vi.fn(async () => ({ ...mockState })),
    updateState: vi.fn(async (partial: Record<string, unknown>) => {
      mockState = { ...mockState, ...partial };
      return { ...mockState };
    }),
    saveState: vi.fn(async () => {}),
    onStateChange: vi.fn(() => () => {}),
    _setMockState: (s: Record<string, unknown>) => {
      mockState = { ...s };
    },
    _getMockState: () => ({ ...mockState }),
  };
});

vi.mock("./proxy-controller.js", () => ({
  disableProxy: vi.fn(async () => {}),
  enableProxy: vi.fn(async () => {}),
  reconfigureProxy: vi.fn(async () => {}),
}));

vi.mock("./badge-manager.js", () => ({
  updateBadge: vi.fn(),
  setBadgeConnected: vi.fn(),
  setBadgeDisconnected: vi.fn(),
  setBadgeError: vi.fn(),
  setBadgeLowBalance: vi.fn(),
}));

import {
  login,
  verifyMfaCode,
  loginWithKey,
  logout,
  isTokenExpired,
  refreshToken,
  getValidToken,
} from "./auth-manager.js";
import { apiPost } from "../shared/api-client.js";
import { loadState, updateState } from "../shared/state.js";

const mockedApiPost = vi.mocked(apiPost);
const mockedLoadState = vi.mocked(loadState);
const mockedUpdateState = vi.mocked(updateState);

// Access internal mock helpers
const stateModule = await import("../shared/state.js");
const _setMockState = (stateModule as any)._setMockState;

describe("auth-manager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _setMockState({});
  });

  describe("login", () => {
    it("stores tokens on successful login without MFA", async () => {
      mockedApiPost.mockResolvedValue({
        token: "access-jwt",
        refreshToken: "refresh-jwt",
        userId: "user-1",
        email: "test@example.com",
      });

      const result = await login("test@example.com", "password123");

      expect(result).toEqual({ mfaRequired: false });
      expect(mockedApiPost).toHaveBeenCalledWith("/api/auth/login", {
        email: "test@example.com",
        password: "password123",
      });
      expect(mockedUpdateState).toHaveBeenCalledWith({
        accessToken: "access-jwt",
        refreshToken: "refresh-jwt",
        userId: "user-1",
        email: "test@example.com",
        apiKey: null,
        mfaPending: false,
        mfaChallengeToken: null,
        lastError: null,
      });
    });

    it("sets MFA pending state when MFA is required", async () => {
      mockedApiPost.mockResolvedValue({
        mfaRequired: true,
        mfaChallengeToken: "mfa-challenge-jwt",
      });

      const result = await login("user@example.com", "pass");

      expect(result).toEqual({ mfaRequired: true });
      expect(mockedUpdateState).toHaveBeenCalledWith({
        mfaPending: true,
        mfaChallengeToken: "mfa-challenge-jwt",
        lastError: null,
      });
    });

    it("propagates API errors", async () => {
      mockedApiPost.mockRejectedValue(new Error("Invalid credentials"));

      await expect(login("bad@email.com", "wrong")).rejects.toThrow("Invalid credentials");
    });
  });

  describe("verifyMfaCode", () => {
    it("completes MFA flow and stores tokens", async () => {
      _setMockState({ mfaChallengeToken: "challenge-token-xyz" });

      mockedApiPost.mockResolvedValue({
        token: "mfa-access-token",
        refreshToken: "mfa-refresh-token",
        userId: "user-2",
        email: "mfa@example.com",
      });

      await verifyMfaCode("123456");

      expect(mockedApiPost).toHaveBeenCalledWith("/api/auth/mfa/verify", {
        mfaChallengeToken: "challenge-token-xyz",
        code: "123456",
        isBackupCode: false,
      });

      expect(mockedUpdateState).toHaveBeenCalledWith({
        accessToken: "mfa-access-token",
        refreshToken: "mfa-refresh-token",
        userId: "user-2",
        email: "mfa@example.com",
        apiKey: null,
        mfaPending: false,
        mfaChallengeToken: null,
        lastError: null,
      });
    });

    it("supports backup codes with isBackupCode flag", async () => {
      _setMockState({ mfaChallengeToken: "challenge-token" });

      mockedApiPost.mockResolvedValue({
        token: "t",
        refreshToken: "r",
        userId: "u",
        email: "e@e.com",
      });

      await verifyMfaCode("ABCD1234", true);

      expect(mockedApiPost).toHaveBeenCalledWith("/api/auth/mfa/verify", {
        mfaChallengeToken: "challenge-token",
        code: "ABCD1234",
        isBackupCode: true,
      });
    });

    it("throws if no MFA challenge is in progress", async () => {
      _setMockState({ mfaChallengeToken: null });

      await expect(verifyMfaCode("123456")).rejects.toThrow("No MFA challenge in progress");
    });
  });

  describe("loginWithKey", () => {
    it("stores API key and tokens from verify-key response", async () => {
      mockedApiPost.mockResolvedValue({
        valid: true,
        token: "key-access-token",
        refreshToken: "key-refresh-token",
        userId: "user-3",
        email: "apikey@example.com",
      });

      await loginWithKey("dn_live_testapikey");

      expect(mockedApiPost).toHaveBeenCalledWith("/api/auth/verify-key", {
        apiKey: "dn_live_testapikey",
      });

      expect(mockedUpdateState).toHaveBeenCalledWith({
        accessToken: "key-access-token",
        refreshToken: "key-refresh-token",
        userId: "user-3",
        email: "apikey@example.com",
        apiKey: "dn_live_testapikey",
        mfaPending: false,
        mfaChallengeToken: null,
        lastError: null,
      });
    });
  });

  describe("logout", () => {
    it("calls server logout, clears state, clears alarms, and disables proxy", async () => {
      _setMockState({
        accessToken: "active-token",
        refreshToken: "active-refresh",
        proxyEnabled: true,
      });

      // apiPost for logout endpoint (dynamic import inside logout re-uses the mock)
      mockedApiPost.mockResolvedValue(undefined);

      await logout();

      // Should have called server-side logout
      expect(mockedApiPost).toHaveBeenCalledWith("/api/auth/logout", {}, "active-token");

      // Should have cleared all auth/proxy state
      expect(mockedUpdateState).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: null,
          accessToken: null,
          refreshToken: null,
          userId: null,
          email: null,
          proxyEnabled: false,
          isConnected: false,
          balanceCents: 0,
          lastError: null,
        }),
      );

      // Should have cleared all alarms
      expect(chrome.alarms.clearAll).toHaveBeenCalled();
    });

    it("continues with local cleanup even if server logout fails", async () => {
      _setMockState({ accessToken: "token-that-fails" });
      mockedApiPost.mockRejectedValue(new Error("Network error"));

      // Should not throw
      await logout();

      // State should still be cleared
      expect(mockedUpdateState).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: null,
          refreshToken: null,
          proxyEnabled: false,
        }),
      );
    });
  });

  describe("isTokenExpired", () => {
    it("returns false for a valid token with future expiry", () => {
      // Create a JWT payload with exp 1 hour from now
      const payload = { exp: Math.floor(Date.now() / 1000) + 3600 };
      const b64Payload = btoa(JSON.stringify(payload));
      const fakeToken = `header.${b64Payload}.signature`;

      expect(isTokenExpired(fakeToken)).toBe(false);
    });

    it("returns true for a token expiring within 60 seconds", () => {
      // Create a JWT payload that expires in 30 seconds (within 60s buffer)
      const payload = { exp: Math.floor(Date.now() / 1000) + 30 };
      const b64Payload = btoa(JSON.stringify(payload));
      const fakeToken = `header.${b64Payload}.signature`;

      expect(isTokenExpired(fakeToken)).toBe(true);
    });

    it("returns true for an already expired token", () => {
      const payload = { exp: Math.floor(Date.now() / 1000) - 3600 };
      const b64Payload = btoa(JSON.stringify(payload));
      const fakeToken = `header.${b64Payload}.signature`;

      expect(isTokenExpired(fakeToken)).toBe(true);
    });

    it("returns true for malformed token", () => {
      expect(isTokenExpired("not-a-jwt")).toBe(true);
      expect(isTokenExpired("")).toBe(true);
      expect(isTokenExpired("a.b")).toBe(true); // no valid base64 payload
    });
  });

  describe("refreshToken", () => {
    it("sends refresh request and updates state with new tokens", async () => {
      _setMockState({ refreshToken: "old-refresh-token" });

      mockedApiPost.mockResolvedValue({
        token: "new-access-token",
        refreshToken: "new-refresh-token",
      });

      const newToken = await refreshToken();

      expect(newToken).toBe("new-access-token");
      expect(mockedApiPost).toHaveBeenCalledWith("/api/auth/refresh", {
        refreshToken: "old-refresh-token",
      });
      expect(mockedUpdateState).toHaveBeenCalledWith({
        accessToken: "new-access-token",
        refreshToken: "new-refresh-token",
        lastError: null,
      });
    });

    it("throws if no refresh token is available", async () => {
      _setMockState({ refreshToken: null });

      await expect(refreshToken()).rejects.toThrow("No refresh token");
    });

    it("updates only access token when response has no new refresh token", async () => {
      _setMockState({ refreshToken: "existing-refresh" });

      mockedApiPost.mockResolvedValue({
        token: "new-access-only",
        // no refreshToken in response
      });

      await refreshToken();

      expect(mockedUpdateState).toHaveBeenCalledWith({
        accessToken: "new-access-only",
        lastError: null,
      });
    });
  });

  describe("getValidToken", () => {
    it("returns current token when not expired", async () => {
      // Create a valid non-expired token
      const payload = { exp: Math.floor(Date.now() / 1000) + 3600 };
      const b64Payload = btoa(JSON.stringify(payload));
      const validToken = `header.${b64Payload}.signature`;

      _setMockState({ accessToken: validToken });

      const token = await getValidToken();
      expect(token).toBe(validToken);
      // Should NOT have called apiPost for refresh
      expect(mockedApiPost).not.toHaveBeenCalled();
    });

    it("refreshes and returns new token when current is expired", async () => {
      // Expired token
      const payload = { exp: Math.floor(Date.now() / 1000) - 100 };
      const b64Payload = btoa(JSON.stringify(payload));
      const expiredToken = `header.${b64Payload}.signature`;

      _setMockState({ accessToken: expiredToken, refreshToken: "valid-refresh" });

      mockedApiPost.mockResolvedValue({
        token: "fresh-access-token",
        refreshToken: "fresh-refresh",
      });

      const token = await getValidToken();
      expect(token).toBe("fresh-access-token");
    });

    it("throws when not authenticated", async () => {
      _setMockState({ accessToken: null });

      await expect(getValidToken()).rejects.toThrow("Not authenticated");
    });
  });
});
