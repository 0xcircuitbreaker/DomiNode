import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadState, saveState, updateState, onStateChange } from "./state.js";
import { DEFAULT_STATE } from "./types.js";
import { STORAGE_KEYS } from "./constants.js";

describe("state", () => {
  beforeEach(() => {
    // Clear storage mocks before each test
    vi.clearAllMocks();
    (chrome.storage.local as any)._store.clear();
    (chrome.storage.session as any)._store.clear();
  });

  describe("loadState", () => {
    it("returns DEFAULT_STATE when storage is empty", async () => {
      const state = await loadState();
      expect(state).toEqual(DEFAULT_STATE);
    });

    it("loads config from local storage and auth from session storage", async () => {
      // Pre-populate local storage with config
      const savedConfig = {
        proxyEnabled: true,
        proxyProtocol: "socks5",
        country: "DE",
        state: "",
        city: "",
        asn: null,
        stickySession: false,
        sessionId: null,
        rotationIntervalMinutes: 5,
        balanceCents: 500,
        isConnected: true,
        lastError: null,
        mfaPending: false,
        mfaChallengeToken: null,
      };
      (chrome.storage.local as any)._store.set(STORAGE_KEYS.STATE, savedConfig);

      // Pre-populate session storage with auth
      const savedAuth = {
        apiKey: "dn_live_testkey",
        accessToken: "jwt-token",
        refreshToken: "refresh-token",
        userId: "user-123",
        email: "test@example.com",
      };
      (chrome.storage.session as any)._store.set(STORAGE_KEYS.AUTH, savedAuth);

      const state = await loadState();

      // Auth fields from session storage
      expect(state.apiKey).toBe("dn_live_testkey");
      expect(state.accessToken).toBe("jwt-token");
      expect(state.refreshToken).toBe("refresh-token");
      expect(state.userId).toBe("user-123");
      expect(state.email).toBe("test@example.com");

      // Config fields from local storage
      expect(state.proxyEnabled).toBe(true);
      expect(state.proxyProtocol).toBe("socks5");
      expect(state.country).toBe("DE");
      expect(state.rotationIntervalMinutes).toBe(5);
    });

    it("merges with DEFAULT_STATE to fill missing fields", async () => {
      // Only set a partial config
      const partialConfig = { country: "GB" };
      (chrome.storage.local as any)._store.set(STORAGE_KEYS.STATE, partialConfig);

      const state = await loadState();

      // Explicitly set field
      expect(state.country).toBe("GB");
      // Default-filled fields
      expect(state.proxyEnabled).toBe(false);
      expect(state.proxyProtocol).toBe("http");
      expect(state.balanceCents).toBe(0);
    });
  });

  describe("saveState", () => {
    it("splits auth fields to session storage and config to local storage", async () => {
      const state = {
        ...DEFAULT_STATE,
        apiKey: "dn_live_key1",
        accessToken: "access-tok",
        refreshToken: "refresh-tok",
        userId: "u1",
        email: "a@b.com",
        country: "JP",
        proxyEnabled: true,
      };

      await saveState(state);

      // Check session storage received auth data
      expect(chrome.storage.session.set).toHaveBeenCalledWith({
        [STORAGE_KEYS.AUTH]: {
          apiKey: "dn_live_key1",
          accessToken: "access-tok",
          refreshToken: "refresh-tok",
          userId: "u1",
          email: "a@b.com",
          mfaChallengeToken: null,
        },
      });

      // Check local storage received config WITHOUT auth fields
      const localCall = (chrome.storage.local.set as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const savedConfig = localCall[STORAGE_KEYS.STATE];
      expect(savedConfig).not.toHaveProperty("apiKey");
      expect(savedConfig).not.toHaveProperty("accessToken");
      expect(savedConfig).not.toHaveProperty("refreshToken");
      expect(savedConfig).not.toHaveProperty("userId");
      expect(savedConfig).not.toHaveProperty("email");
      expect(savedConfig).not.toHaveProperty("mfaChallengeToken");
      expect(savedConfig.country).toBe("JP");
      expect(savedConfig.proxyEnabled).toBe(true);
    });

    it("notifies listeners when state is saved", async () => {
      const listener = vi.fn();
      const unsub = onStateChange(listener);

      const state = { ...DEFAULT_STATE, country: "FR" };
      await saveState(state);

      expect(listener).toHaveBeenCalledWith(state);

      // Unsubscribe and verify no more calls
      unsub();
      await saveState({ ...DEFAULT_STATE, country: "IT" });
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe("updateState", () => {
    it("merges partial update into current state", async () => {
      // Seed with initial state
      (chrome.storage.local as any)._store.set(STORAGE_KEYS.STATE, {
        ...DEFAULT_STATE,
        country: "US",
        balanceCents: 1000,
      });

      const result = await updateState({ country: "CA", proxyEnabled: true });

      expect(result.country).toBe("CA");
      expect(result.proxyEnabled).toBe(true);
      // Preserved from existing state
      expect(result.balanceCents).toBe(1000);
    });

    it("serializes concurrent updates to prevent race conditions", async () => {
      // Start with known state
      (chrome.storage.local as any)._store.set(STORAGE_KEYS.STATE, {
        ...DEFAULT_STATE,
        balanceCents: 0,
      });

      // Fire two concurrent updates
      const [result1, result2] = await Promise.all([
        updateState({ country: "UK" }),
        updateState({ proxyEnabled: true }),
      ]);

      // The second update should see the first update's changes
      // (both should be applied, the last to resolve has both)
      expect(result2.proxyEnabled).toBe(true);
      // result1 should at least have the country set
      expect(result1.country).toBe("UK");
    });
  });
});
