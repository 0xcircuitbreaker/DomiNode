import { describe, it, expect } from "vitest";
import {
  isBlockedCountry,
  SANCTIONED_COUNTRIES,
  BLOCKED_COUNTRY_CODES,
} from "./sanctions.js";

describe("sanctions", () => {
  describe("isBlockedCountry", () => {
    it("should block Cuba (CU)", () => {
      expect(isBlockedCountry("CU")).toBe(true);
    });

    it("should block Iran (IR)", () => {
      expect(isBlockedCountry("IR")).toBe(true);
    });

    it("should block North Korea (KP)", () => {
      expect(isBlockedCountry("KP")).toBe(true);
    });

    it("should block Russia (RU)", () => {
      expect(isBlockedCountry("RU")).toBe(true);
    });

    it("should block Syria (SY)", () => {
      expect(isBlockedCountry("SY")).toBe(true);
    });

    it("should block lowercase codes", () => {
      expect(isBlockedCountry("cu")).toBe(true);
      expect(isBlockedCountry("ir")).toBe(true);
    });

    it("should block mixed case codes", () => {
      expect(isBlockedCountry("Ru")).toBe(true);
      expect(isBlockedCountry("sY")).toBe(true);
    });

    it("should allow US", () => {
      expect(isBlockedCountry("US")).toBe(false);
    });

    it("should allow GB", () => {
      expect(isBlockedCountry("GB")).toBe(false);
    });

    it("should allow DE", () => {
      expect(isBlockedCountry("DE")).toBe(false);
    });

    it("should allow JP", () => {
      expect(isBlockedCountry("JP")).toBe(false);
    });

    it("should allow AU", () => {
      expect(isBlockedCountry("AU")).toBe(false);
    });

    it("should allow UA (Ukraine is NOT fully blocked)", () => {
      expect(isBlockedCountry("UA")).toBe(false);
    });

    it("should return false for empty string", () => {
      expect(isBlockedCountry("")).toBe(false);
    });

    it("should return false for random string", () => {
      expect(isBlockedCountry("XX")).toBe(false);
    });
  });

  describe("SANCTIONED_COUNTRIES", () => {
    it("should have 5 sanctioned countries", () => {
      expect(SANCTIONED_COUNTRIES.length).toBe(5);
    });

    it("should have expected structure", () => {
      for (const country of SANCTIONED_COUNTRIES) {
        expect(country).toHaveProperty("code");
        expect(country).toHaveProperty("name");
        expect(country).toHaveProperty("program");
        expect(country.code).toMatch(/^[A-Z]{2}$/);
      }
    });
  });

  describe("BLOCKED_COUNTRY_CODES", () => {
    it("should be a Set with 5 entries", () => {
      expect(BLOCKED_COUNTRY_CODES.size).toBe(5);
    });

    it("should contain all sanctioned country codes", () => {
      expect(BLOCKED_COUNTRY_CODES.has("CU")).toBe(true);
      expect(BLOCKED_COUNTRY_CODES.has("IR")).toBe(true);
      expect(BLOCKED_COUNTRY_CODES.has("KP")).toBe(true);
      expect(BLOCKED_COUNTRY_CODES.has("RU")).toBe(true);
      expect(BLOCKED_COUNTRY_CODES.has("SY")).toBe(true);
    });
  });
});
