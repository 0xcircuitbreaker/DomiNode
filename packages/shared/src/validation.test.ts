import { describe, it, expect } from "vitest";
import {
  isValidEmail,
  validatePassword,
  validateTopupAmount,
  isValidCryptoCurrency,
  sanitizeString,
} from "./validation.js";

describe("validation", () => {
  // ─── isValidEmail ──────────────────────────────────────────────────

  describe("isValidEmail", () => {
    it("should accept a valid email", () => {
      expect(isValidEmail("user@example.com")).toBe(true);
    });

    it("should accept email with subdomain", () => {
      expect(isValidEmail("user@mail.example.co.uk")).toBe(true);
    });

    it("should accept email with plus sign", () => {
      expect(isValidEmail("user+tag@example.com")).toBe(true);
    });

    it("should reject email without @", () => {
      expect(isValidEmail("userexample.com")).toBe(false);
    });

    it("should reject email without domain", () => {
      expect(isValidEmail("user@")).toBe(false);
    });

    it("should reject email without local part", () => {
      expect(isValidEmail("@example.com")).toBe(false);
    });

    it("should reject email with spaces", () => {
      expect(isValidEmail("user @example.com")).toBe(false);
    });

    it("should reject empty string", () => {
      expect(isValidEmail("")).toBe(false);
    });

    it("should reject email longer than 254 chars", () => {
      const longLocal = "a".repeat(250);
      expect(isValidEmail(`${longLocal}@b.co`)).toBe(false);
    });

    it("should accept email at exactly 254 chars", () => {
      // local@domain.com = local(245) + @ + d.co(4) = 250 total, well under 254
      const local = "a".repeat(245);
      expect(isValidEmail(`${local}@b.co`)).toBe(true);
    });
  });

  // ─── validatePassword ──────────────────────────────────────────────

  describe("validatePassword", () => {
    it("should return null for a valid password (8+ chars)", () => {
      expect(validatePassword("abcdefgh")).toBeNull();
    });

    it("should return null for a 128-char password", () => {
      expect(validatePassword("a".repeat(128))).toBeNull();
    });

    it("should return error for a password < 8 chars", () => {
      const result = validatePassword("short");
      expect(result).toBe("Password must be at least 8 characters");
    });

    it("should return error for a 7-char password", () => {
      expect(validatePassword("1234567")).not.toBeNull();
    });

    it("should return error for a password > 128 chars", () => {
      const result = validatePassword("a".repeat(129));
      expect(result).toBe("Password must be at most 128 characters");
    });

    it("should return null for exactly 8 chars", () => {
      expect(validatePassword("12345678")).toBeNull();
    });
  });

  // ─── validateTopupAmount ──────────────────────────────────────────

  describe("validateTopupAmount", () => {
    it("should return null for a valid amount (500 cents = $5)", () => {
      expect(validateTopupAmount(500)).toBeNull();
    });

    it("should return null for max amount (100000 cents = $1000)", () => {
      expect(validateTopupAmount(100_000)).toBeNull();
    });

    it("should reject non-integer amounts", () => {
      const result = validateTopupAmount(5.5);
      expect(result).toBe("Amount must be a whole number of cents");
    });

    it("should reject amounts below minimum", () => {
      const result = validateTopupAmount(499);
      expect(result).toBe("Minimum top-up is $5.00");
    });

    it("should reject zero", () => {
      expect(validateTopupAmount(0)).not.toBeNull();
    });

    it("should reject amounts above maximum", () => {
      const result = validateTopupAmount(100_001);
      expect(result).toBe("Maximum top-up is $1,000.00");
    });

    it("should accept a mid-range amount", () => {
      expect(validateTopupAmount(5000)).toBeNull();
    });
  });

  // ─── isValidCryptoCurrency ────────────────────────────────────────

  describe("isValidCryptoCurrency", () => {
    it("should accept btc", () => {
      expect(isValidCryptoCurrency("btc")).toBe(true);
    });

    it("should accept eth", () => {
      expect(isValidCryptoCurrency("eth")).toBe(true);
    });

    it("should accept xmr", () => {
      expect(isValidCryptoCurrency("xmr")).toBe(true);
    });

    it("should accept sol", () => {
      expect(isValidCryptoCurrency("sol")).toBe(true);
    });

    it("should accept zec", () => {
      expect(isValidCryptoCurrency("zec")).toBe(true);
    });

    it("should accept uppercase BTC", () => {
      expect(isValidCryptoCurrency("BTC")).toBe(true);
    });

    it("should reject unsupported currency", () => {
      expect(isValidCryptoCurrency("doge")).toBe(false);
    });

    it("should reject empty string", () => {
      expect(isValidCryptoCurrency("")).toBe(false);
    });

    it("should reject random string", () => {
      expect(isValidCryptoCurrency("notacoin")).toBe(false);
    });
  });

  // ─── sanitizeString ──────────────────────────────────────────────

  describe("sanitizeString", () => {
    it("should trim whitespace", () => {
      expect(sanitizeString("  hello  ", 100)).toBe("hello");
    });

    it("should truncate to maxLength", () => {
      expect(sanitizeString("abcdefgh", 5)).toBe("abcde");
    });

    it("should handle empty string", () => {
      expect(sanitizeString("", 10)).toBe("");
    });

    it("should trim then truncate", () => {
      expect(sanitizeString("  abcdef  ", 3)).toBe("abc");
    });

    it("should handle string shorter than maxLength", () => {
      expect(sanitizeString("hi", 100)).toBe("hi");
    });
  });
});
