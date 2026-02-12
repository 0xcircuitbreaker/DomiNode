import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies
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
  };
});

vi.mock("./auth-manager.js", () => ({
  isTokenExpired: vi.fn(() => false),
  refreshToken: vi.fn(async () => "new-token"),
  login: vi.fn(),
  logout: vi.fn(),
  loginWithKey: vi.fn(),
  getValidToken: vi.fn(),
  verifyMfaCode: vi.fn(),
}));

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

import { refreshTokenIfNeeded } from "./token-refresher.js";
import { isTokenExpired, refreshToken } from "./auth-manager.js";
import { loadState, updateState } from "../shared/state.js";
import { disableProxy } from "./proxy-controller.js";
import { updateBadge } from "./badge-manager.js";

const mockedIsTokenExpired = vi.mocked(isTokenExpired);
const mockedRefreshToken = vi.mocked(refreshToken);
const mockedLoadState = vi.mocked(loadState);
const mockedUpdateState = vi.mocked(updateState);
const mockedDisableProxy = vi.mocked(disableProxy);

const stateModule = await import("../shared/state.js");
const _setMockState = (stateModule as any)._setMockState;

describe("token-refresher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _setMockState({
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      proxyEnabled: true,
      isConnected: true,
    });
    mockedIsTokenExpired.mockReturnValue(false);
    mockedRefreshToken.mockResolvedValue("new-token");
  });

  describe("refreshTokenIfNeeded", () => {
    it("skips refresh when not authenticated", async () => {
      _setMockState({ accessToken: null, refreshToken: null });

      await refreshTokenIfNeeded();

      expect(mockedIsTokenExpired).not.toHaveBeenCalled();
      expect(mockedRefreshToken).not.toHaveBeenCalled();
    });

    it("skips refresh when access token is missing", async () => {
      _setMockState({ accessToken: null, refreshToken: "valid-refresh" });

      await refreshTokenIfNeeded();

      expect(mockedRefreshToken).not.toHaveBeenCalled();
    });

    it("skips refresh when token is not expired", async () => {
      _setMockState({
        accessToken: "valid-access-token",
        refreshToken: "valid-refresh-token",
      });
      mockedIsTokenExpired.mockReturnValue(false);

      await refreshTokenIfNeeded();

      expect(mockedRefreshToken).not.toHaveBeenCalled();
    });

    it("calls refreshToken when token is expired", async () => {
      _setMockState({
        accessToken: "expiring-token",
        refreshToken: "valid-refresh",
      });
      mockedIsTokenExpired.mockReturnValue(true);

      await refreshTokenIfNeeded();

      expect(mockedRefreshToken).toHaveBeenCalled();
    });

    it("handles transient network errors gracefully without disabling proxy", async () => {
      _setMockState({
        accessToken: "expired-token",
        refreshToken: "valid-refresh",
      });
      mockedIsTokenExpired.mockReturnValue(true);
      mockedRefreshToken.mockRejectedValue(new Error("Failed to fetch"));

      // Should not throw
      await refreshTokenIfNeeded();

      // Should NOT have disabled proxy or cleared tokens (transient error)
      expect(mockedDisableProxy).not.toHaveBeenCalled();
      expect(mockedUpdateState).not.toHaveBeenCalled();
    });

    it("disables proxy and clears tokens on auth errors", async () => {
      _setMockState({
        accessToken: "expired-token",
        refreshToken: "invalid-refresh",
        proxyEnabled: true,
        isConnected: true,
      });
      mockedIsTokenExpired.mockReturnValue(true);
      mockedRefreshToken.mockRejectedValue(new Error("Refresh token expired"));

      await refreshTokenIfNeeded();

      // Should have disabled proxy
      expect(mockedDisableProxy).toHaveBeenCalled();

      // Should have cleared auth state and set error
      expect(mockedUpdateState).toHaveBeenCalledWith({
        accessToken: null,
        refreshToken: null,
        proxyEnabled: false,
        isConnected: false,
        lastError: "Session expired — please log in again",
      });

      // Badge should be updated
      expect(updateBadge).toHaveBeenCalled();
    });

    it("attempts to show notification on session expiry", async () => {
      _setMockState({
        accessToken: "expired-token",
        refreshToken: "invalid-refresh",
      });
      mockedIsTokenExpired.mockReturnValue(true);
      mockedRefreshToken.mockRejectedValue(new Error("Token invalid"));

      await refreshTokenIfNeeded();

      expect(chrome.notifications.create).toHaveBeenCalledWith(
        "session-expired",
        expect.objectContaining({
          type: "basic",
          title: "DomiNode",
          message: "Session expired. Please log in again.",
        }),
      );
    });
  });
});
