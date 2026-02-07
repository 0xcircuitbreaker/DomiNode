import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildUpstreamProxy,
  validateConfig,
  generateStickySession,
  getConfig,
  addBalance,
  getUserInfo,
} from "./packetstream.js";

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("packetstream", () => {
  // ─── getConfig ─────────────────────────────────────────────────────

  describe("getConfig", () => {
    it("should return config from env vars", () => {
      const config = getConfig();
      expect(config.gatewayHost).toBe("gw.test.io");
      expect(config.gatewayPort).toBe(31112);
      expect(config.username).toBe("testuser");
      expect(config.password).toBe("testpass");
    });
  });

  // ─── validateConfig ────────────────────────────────────────────────

  describe("validateConfig", () => {
    it("should not throw when username and password are set", () => {
      expect(() => validateConfig()).not.toThrow();
    });

    it("should throw when username is empty", () => {
      const orig = process.env["PACKETSTREAM_USERNAME"];
      process.env["PACKETSTREAM_USERNAME"] = "";
      try {
        expect(() => validateConfig()).toThrow(
          "PACKETSTREAM_USERNAME and PACKETSTREAM_PASSWORD are required",
        );
      } finally {
        process.env["PACKETSTREAM_USERNAME"] = orig;
      }
    });

    it("should throw when password is empty", () => {
      const orig = process.env["PACKETSTREAM_PASSWORD"];
      process.env["PACKETSTREAM_PASSWORD"] = "";
      try {
        expect(() => validateConfig()).toThrow(
          "PACKETSTREAM_USERNAME and PACKETSTREAM_PASSWORD are required",
        );
      } finally {
        process.env["PACKETSTREAM_PASSWORD"] = orig;
      }
    });
  });

  // ─── generateStickySession ─────────────────────────────────────────

  describe("generateStickySession", () => {
    it("should return an 8-character hex string", () => {
      const session = generateStickySession();
      expect(session).toMatch(/^[0-9a-f]{8}$/);
    });

    it("should generate unique sessions", () => {
      const s1 = generateStickySession();
      const s2 = generateStickySession();
      expect(s1).not.toBe(s2);
    });
  });

  // ─── buildUpstreamProxy ────────────────────────────────────────────

  describe("buildUpstreamProxy", () => {
    it("should return basic proxy with no options", () => {
      const proxy = buildUpstreamProxy();
      expect(proxy.host).toBe("gw.test.io");
      expect(proxy.port).toBe(31112);
      expect(proxy.username).toBe("testuser");
      expect(proxy.password).toBe("testpass");
      expect(proxy.proxyAuth).toBe(
        Buffer.from("testuser:testpass").toString("base64"),
      );
    });

    it("should append country suffix", () => {
      const proxy = buildUpstreamProxy({ country: "US" });
      expect(proxy.password).toBe("testpass_country-US");
    });

    it("should accept lowercase country and uppercase it", () => {
      const proxy = buildUpstreamProxy({ country: "de" });
      expect(proxy.password).toBe("testpass_country-DE");
    });

    it("should append session suffix when sticky is true", () => {
      const proxy = buildUpstreamProxy({ sticky: true });
      expect(proxy.password).toMatch(/^testpass_session-[a-f0-9]{8}$/);
    });

    it("should use provided sessionId", () => {
      const proxy = buildUpstreamProxy({ sessionId: "abc123" });
      expect(proxy.password).toBe("testpass_session-abc123");
    });

    it("should combine country and session", () => {
      const proxy = buildUpstreamProxy({ country: "US", sessionId: "xyz789" });
      expect(proxy.password).toBe("testpass_country-US_session-xyz789");
    });

    it("should set proxyAuth correctly for combined options", () => {
      const proxy = buildUpstreamProxy({ country: "GB", sessionId: "sess1" });
      const expectedAuth = Buffer.from(
        "testuser:testpass_country-GB_session-sess1",
      ).toString("base64");
      expect(proxy.proxyAuth).toBe(expectedAuth);
    });

    it("should throw for invalid country code (3 letters)", () => {
      expect(() => buildUpstreamProxy({ country: "USA" })).toThrow(
        "Invalid country code: must be exactly 2 ASCII letters",
      );
    });

    it("should throw for invalid country code (1 letter)", () => {
      expect(() => buildUpstreamProxy({ country: "U" })).toThrow(
        "Invalid country code",
      );
    });

    it("should throw for country code with numbers", () => {
      expect(() => buildUpstreamProxy({ country: "U1" })).toThrow(
        "Invalid country code",
      );
    });

    it("should throw for invalid sessionId (non-alphanumeric)", () => {
      expect(() => buildUpstreamProxy({ sessionId: "abc-123" })).toThrow(
        "Invalid sessionId: must be alphanumeric only",
      );
    });

    it("should throw for sessionId with spaces", () => {
      expect(() => buildUpstreamProxy({ sessionId: "abc 123" })).toThrow(
        "Invalid sessionId",
      );
    });

    it("should throw for sessionId with special chars", () => {
      expect(() => buildUpstreamProxy({ sessionId: "abc@123" })).toThrow(
        "Invalid sessionId",
      );
    });
  });

  // ─── addBalance ─────────────────────────────────────────────────────

  describe("addBalance", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      // Set required env vars for reseller API
      process.env["PACKETSTREAM_RESELLER_API_KEY"] = "test-api-key";
      process.env["PACKETSTREAM_RESELLER_API_URL"] = "https://reseller.test.io";
    });

    it("should call the reseller API to add balance", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      await addBalance("testuser", 5.0);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://reseller.test.io/proxy_api/v1/basic/users/add_balance",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer test-api-key",
          }),
          body: JSON.stringify({ username: "testuser", data_gb: 5.0 }),
        }),
      );
    });

    it("should throw on API error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      });

      await expect(addBalance("testuser", 5.0)).rejects.toThrow(
        "PacketStream addBalance failed: 500 Internal Server Error",
      );
    });
  });

  // ─── getUserInfo ──────────────────────────────────────────────────

  describe("getUserInfo", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      process.env["PACKETSTREAM_RESELLER_API_KEY"] = "test-api-key";
      process.env["PACKETSTREAM_RESELLER_API_URL"] = "https://reseller.test.io";
    });

    it("should fetch user info from the reseller API", async () => {
      const userData = { username: "testuser", balance: 10.0 };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(userData),
      });

      const result = await getUserInfo("testuser");
      expect(result).toEqual(userData);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://reseller.test.io/proxy_api/v1/basic/users/get/testuser",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("should throw on API error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve("Not Found"),
      });

      await expect(getUserInfo("testuser")).rejects.toThrow(
        "PacketStream getUserInfo failed: 404 Not Found",
      );
    });
  });
});
