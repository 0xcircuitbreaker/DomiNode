import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all dependencies
vi.mock("../shared/state.js", () => {
  let mockState: Record<string, unknown> = {
    apiKey: "dn_live_testkey",
    accessToken: "jwt-token",
    balanceCents: 1000,
    proxyEnabled: false,
    proxyProtocol: "http",
    country: "US",
    state: "",
    city: "",
    asn: null,
    stickySession: false,
    sessionId: null,
    rotationIntervalMinutes: 0,
    isConnected: false,
    lastError: null,
  };
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

vi.mock("../shared/api-client.js", () => ({
  apiPost: vi.fn(),
  apiGet: vi.fn(),
  getApiBase: vi.fn(() => "http://localhost:3000"),
  setApiBase: vi.fn(),
}));

vi.mock("../shared/proxy-config.js", () => ({
  buildProxyUsername: vi.fn(() => "user-country_US"),
  generateSessionId: vi.fn(() => "abcd1234"),
}));

vi.mock("./badge-manager.js", () => ({
  updateBadge: vi.fn(),
  setBadgeConnected: vi.fn(),
  setBadgeDisconnected: vi.fn(),
  setBadgeError: vi.fn(),
  setBadgeLowBalance: vi.fn(),
}));

// Mock the adapter imports used by proxy-controller
// The proxy-controller dynamically imports adapters, so we mock the chromium adapter
vi.mock("../adapters/chromium-proxy.js", () => ({
  enable: vi.fn(),
  disable: vi.fn(),
  isActive: vi.fn(() => false),
}));

vi.mock("../adapters/firefox-proxy.js", () => ({
  enable: vi.fn(),
  disable: vi.fn(),
  isActive: vi.fn(() => false),
}));

import { enableProxy, disableProxy, reconfigureProxy } from "./proxy-controller.js";
import { loadState, updateState } from "../shared/state.js";
import { updateBadge } from "./badge-manager.js";
import { buildProxyUsername } from "../shared/proxy-config.js";

const stateModule = await import("../shared/state.js");
const _setMockState = (stateModule as any)._setMockState;

describe("proxy-controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _setMockState({
      apiKey: "dn_live_testkey",
      accessToken: "jwt-token",
      balanceCents: 1000,
      proxyEnabled: false,
      proxyProtocol: "http",
      country: "US",
      state: "",
      city: "",
      asn: null,
      stickySession: false,
      sessionId: null,
      rotationIntervalMinutes: 0,
      isConnected: false,
      lastError: null,
    });
  });

  describe("enableProxy", () => {
    it("enables proxy and updates state to connected", async () => {
      await enableProxy();

      // State should be updated with proxyEnabled and isConnected
      expect(updateState).toHaveBeenCalledWith({
        proxyEnabled: true,
        isConnected: true,
        lastError: null,
      });

      // Badge should be updated
      expect(updateBadge).toHaveBeenCalled();
    });

    it("throws if no API key is configured", async () => {
      _setMockState({
        apiKey: null,
        balanceCents: 1000,
        proxyProtocol: "http",
        country: "US",
        state: "",
        city: "",
        asn: null,
        stickySession: false,
        sessionId: null,
        rotationIntervalMinutes: 0,
      });

      await expect(enableProxy()).rejects.toThrow("No API key configured");
    });

    it("throws if wallet balance is zero", async () => {
      _setMockState({
        apiKey: "dn_live_key",
        balanceCents: 0,
        proxyProtocol: "http",
        country: "US",
        state: "",
        city: "",
        asn: null,
        stickySession: false,
        sessionId: null,
        rotationIntervalMinutes: 0,
      });

      await expect(enableProxy()).rejects.toThrow("Cannot enable proxy: wallet balance is $0.00");
    });

    it("creates session rotation alarm when rotation interval is set", async () => {
      _setMockState({
        apiKey: "dn_live_key",
        balanceCents: 500,
        proxyProtocol: "http",
        country: "US",
        state: "",
        city: "",
        asn: null,
        stickySession: false,
        sessionId: null,
        rotationIntervalMinutes: 10,
        isConnected: false,
        lastError: null,
      });

      await enableProxy();

      expect(chrome.alarms.create).toHaveBeenCalledWith("dominusnode_session_rotate", {
        periodInMinutes: 10,
      });
    });

    it("does not create alarm when rotation interval is zero", async () => {
      _setMockState({
        apiKey: "dn_live_key",
        balanceCents: 500,
        proxyProtocol: "http",
        country: "US",
        state: "",
        city: "",
        asn: null,
        stickySession: false,
        sessionId: null,
        rotationIntervalMinutes: 0,
        isConnected: false,
        lastError: null,
      });

      await enableProxy();

      expect(chrome.alarms.create).not.toHaveBeenCalled();
    });

    it("sets WebRTC leak prevention policy", async () => {
      await enableProxy();

      expect(chrome.privacy.network.webRTCIPHandlingPolicy.set).toHaveBeenCalledWith({
        value: "disable_non_proxied_udp",
      });
    });
  });

  describe("disableProxy", () => {
    it("disables proxy and updates state to disconnected", async () => {
      await disableProxy();

      expect(updateState).toHaveBeenCalledWith({
        proxyEnabled: false,
        isConnected: false,
      });

      // Badge should be updated
      expect(updateBadge).toHaveBeenCalled();
    });

    it("clears session rotation alarm", async () => {
      await disableProxy();

      expect(chrome.alarms.clear).toHaveBeenCalledWith("dominusnode_session_rotate");
    });

    it("restores default WebRTC policy", async () => {
      await disableProxy();

      expect(chrome.privacy.network.webRTCIPHandlingPolicy.set).toHaveBeenCalledWith({
        value: "default",
      });
    });
  });

  describe("reconfigureProxy", () => {
    it("re-enables proxy when proxy is currently enabled", async () => {
      _setMockState({
        apiKey: "dn_live_key",
        balanceCents: 500,
        proxyEnabled: true,
        proxyProtocol: "http",
        country: "DE",
        state: "",
        city: "",
        asn: null,
        stickySession: false,
        sessionId: null,
        rotationIntervalMinutes: 0,
        isConnected: true,
        lastError: null,
      });

      await reconfigureProxy();

      // disableProxy then enableProxy should both be called
      // updateState should be called for both disable and enable
      const calls = vi.mocked(updateState).mock.calls;
      const disableCall = calls.find(
        (c) => (c[0] as any).proxyEnabled === false,
      );
      const enableCall = calls.find(
        (c) => (c[0] as any).proxyEnabled === true,
      );
      expect(disableCall).toBeDefined();
      expect(enableCall).toBeDefined();
    });

    it("does nothing when proxy is not enabled", async () => {
      _setMockState({
        proxyEnabled: false,
      });

      await reconfigureProxy();

      // Should only call loadState, no state updates
      expect(updateState).not.toHaveBeenCalled();
    });
  });
});
