import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @dominusnode/shared
const mockIsBlockedCountry = vi.fn();

vi.mock("@dominusnode/shared", () => ({
  isBlockedCountry: (...args: unknown[]) => mockIsBlockedCountry(...args),
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// We need to mock geoip-lite. The geo-check module imports it dynamically,
// so we mock it at the module level.
const mockLookup = vi.fn();

vi.mock("geoip-lite", () => ({
  default: {
    lookup: (...args: unknown[]) => mockLookup(...args),
  },
  lookup: (...args: unknown[]) => mockLookup(...args),
}));

import { initGeoCheck, checkSanctionedCountry } from "./geo-check.js";

describe("proxy-gateway/geo-check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBlockedCountry.mockReturnValue(false);
  });

  // IMPORTANT: These tests for "fail-closed" behavior MUST run BEFORE initGeoCheck()
  // is called, because geoLookup starts as null and once initGeoCheck sets it,
  // it stays set for the rest of the module lifetime.
  describe("checkSanctionedCountry (before init - fail-closed mode)", () => {
    it("should return null for invalid IP even before init", () => {
      const result = checkSanctionedCountry("not-an-ip");
      expect(result).toBeNull();
    });

    it("should return null for private IPs before init", () => {
      expect(checkSanctionedCountry("127.0.0.1")).toBeNull();
      expect(checkSanctionedCountry("10.0.0.1")).toBeNull();
      expect(checkSanctionedCountry("192.168.1.1")).toBeNull();
    });

    it("should return UNKNOWN for non-private IPs when geoLookup unavailable (fail-closed)", () => {
      // Before initGeoCheck is called, geoLookup is null
      // For non-private, valid IPs, it should block with "UNKNOWN"
      const result = checkSanctionedCountry("8.8.8.8");
      expect(result).toBe("UNKNOWN");
    });

    it("should return UNKNOWN for any public IP when geo unavailable", () => {
      expect(checkSanctionedCountry("1.1.1.1")).toBe("UNKNOWN");
      expect(checkSanctionedCountry("203.0.113.1")).toBe("UNKNOWN");
    });
  });

  describe("initGeoCheck", () => {
    it("should initialize without throwing", async () => {
      await expect(initGeoCheck()).resolves.toBeUndefined();
    });
  });

  // These tests run AFTER initGeoCheck has been called
  describe("checkSanctionedCountry (after init)", () => {
    it("should return null for invalid IP (not a valid IP format)", () => {
      const result = checkSanctionedCountry("not-an-ip");
      expect(result).toBeNull();
    });

    it("should return null for empty string", () => {
      const result = checkSanctionedCountry("");
      expect(result).toBeNull();
    });

    it("should return null for private IP 127.0.0.1 (loopback)", () => {
      const result = checkSanctionedCountry("127.0.0.1");
      expect(result).toBeNull();
    });

    it("should return null for private IP ::1 (IPv6 loopback)", () => {
      const result = checkSanctionedCountry("::1");
      expect(result).toBeNull();
    });

    it("should return null for private IP 0.0.0.0", () => {
      const result = checkSanctionedCountry("0.0.0.0");
      expect(result).toBeNull();
    });

    it("should return null for private IP 10.x.x.x", () => {
      const result = checkSanctionedCountry("10.0.0.1");
      expect(result).toBeNull();
    });

    it("should return null for private IP 10.255.255.255", () => {
      const result = checkSanctionedCountry("10.255.255.255");
      expect(result).toBeNull();
    });

    it("should return null for private IP 192.168.x.x", () => {
      const result = checkSanctionedCountry("192.168.1.1");
      expect(result).toBeNull();
    });

    it("should return null for private IP 192.168.0.1", () => {
      const result = checkSanctionedCountry("192.168.0.1");
      expect(result).toBeNull();
    });

    it("should return null for private IP 172.16.x.x", () => {
      const result = checkSanctionedCountry("172.16.0.1");
      expect(result).toBeNull();
    });

    it("should return null for private IP 172.31.255.255", () => {
      const result = checkSanctionedCountry("172.31.255.255");
      expect(result).toBeNull();
    });

    it("should not treat 172.32.x.x as private", () => {
      mockLookup.mockReturnValue({ country: "US" });
      const result = checkSanctionedCountry("172.32.0.1");
      expect(mockLookup).toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it("should not treat 172.15.x.x as private", () => {
      mockLookup.mockReturnValue({ country: "US" });
      checkSanctionedCountry("172.15.0.1");
      expect(mockLookup).toHaveBeenCalled();
    });

    it("should return null for IPv6 private fc prefix", () => {
      const result = checkSanctionedCountry("fc00::1");
      expect(result).toBeNull();
    });

    it("should return null for IPv6 private fd prefix", () => {
      const result = checkSanctionedCountry("fd12::1");
      expect(result).toBeNull();
    });

    it("should return null for IPv6 link-local fe80 prefix", () => {
      const result = checkSanctionedCountry("fe80::1");
      expect(result).toBeNull();
    });

    it("should return blocked country code for sanctioned country", () => {
      mockLookup.mockReturnValue({ country: "IR" });
      mockIsBlockedCountry.mockReturnValue(true);

      const result = checkSanctionedCountry("8.8.8.8");
      expect(result).toBe("IR");
      expect(mockIsBlockedCountry).toHaveBeenCalledWith("IR");
    });

    it("should return null for allowed country", () => {
      mockLookup.mockReturnValue({ country: "US" });
      mockIsBlockedCountry.mockReturnValue(false);

      const result = checkSanctionedCountry("8.8.4.4");
      expect(result).toBeNull();
    });

    it("should return null when geo lookup returns null", () => {
      mockLookup.mockReturnValue(null);

      const result = checkSanctionedCountry("203.0.113.1");
      expect(result).toBeNull();
    });

    it("should return null when geo lookup returns object without country", () => {
      mockLookup.mockReturnValue({ country: "" });

      const result = checkSanctionedCountry("203.0.113.2");
      expect(result).toBeNull();
    });

    it("should block RU (Russia)", () => {
      mockLookup.mockReturnValue({ country: "RU" });
      mockIsBlockedCountry.mockReturnValue(true);

      const result = checkSanctionedCountry("1.2.3.4");
      expect(result).toBe("RU");
    });

    it("should block KP (North Korea)", () => {
      mockLookup.mockReturnValue({ country: "KP" });
      mockIsBlockedCountry.mockReturnValue(true);

      const result = checkSanctionedCountry("5.6.7.8");
      expect(result).toBe("KP");
    });

    it("should block CU (Cuba)", () => {
      mockLookup.mockReturnValue({ country: "CU" });
      mockIsBlockedCountry.mockReturnValue(true);

      const result = checkSanctionedCountry("9.10.11.12");
      expect(result).toBe("CU");
    });

    it("should block SY (Syria)", () => {
      mockLookup.mockReturnValue({ country: "SY" });
      mockIsBlockedCountry.mockReturnValue(true);

      const result = checkSanctionedCountry("13.14.15.16");
      expect(result).toBe("SY");
    });

    it("should allow GB (United Kingdom)", () => {
      mockLookup.mockReturnValue({ country: "GB" });
      mockIsBlockedCountry.mockReturnValue(false);

      const result = checkSanctionedCountry("1.1.1.1");
      expect(result).toBeNull();
    });

    it("should allow DE (Germany)", () => {
      mockLookup.mockReturnValue({ country: "DE" });
      mockIsBlockedCountry.mockReturnValue(false);

      const result = checkSanctionedCountry("2.2.2.2");
      expect(result).toBeNull();
    });

    it("should allow JP (Japan)", () => {
      mockLookup.mockReturnValue({ country: "JP" });
      mockIsBlockedCountry.mockReturnValue(false);

      const result = checkSanctionedCountry("3.3.3.3");
      expect(result).toBeNull();
    });

    it("should call isBlockedCountry with the country code from geo lookup", () => {
      mockLookup.mockReturnValue({ country: "FR" });
      mockIsBlockedCountry.mockReturnValue(false);

      checkSanctionedCountry("4.4.4.4");
      expect(mockIsBlockedCountry).toHaveBeenCalledWith("FR");
    });
  });
});
