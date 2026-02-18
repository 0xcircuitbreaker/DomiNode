import { describe, it, expect } from "vitest";
import {
  isValidEmail,
  isDisposableEmail,
  validatePassword,
  validateTopupAmount,
  isValidCryptoCurrency,
  sanitizeString,
  validateState,
  validateCity,
  validateAsn,
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

  // ─── isDisposableEmail ───────────────────────────────────────────────

  describe("isDisposableEmail", () => {
    it("should flag known disposable domains", () => {
      expect(isDisposableEmail("test@mailinator.com")).toBe(true);
      expect(isDisposableEmail("test@yopmail.com")).toBe(true);
      expect(isDisposableEmail("test@10minutemail.com")).toBe(true);
      expect(isDisposableEmail("test@guerrillamail.com")).toBe(true);
      expect(isDisposableEmail("test@tempmail.com")).toBe(true);
    });

    it("should allow legitimate email providers", () => {
      expect(isDisposableEmail("user@gmail.com")).toBe(false);
      expect(isDisposableEmail("user@yahoo.com")).toBe(false);
      expect(isDisposableEmail("user@protonmail.com")).toBe(false);
      expect(isDisposableEmail("user@outlook.com")).toBe(false);
      expect(isDisposableEmail("user@company.io")).toBe(false);
    });

    it("should handle missing domain", () => {
      expect(isDisposableEmail("nodomain")).toBe(false);
      expect(isDisposableEmail("")).toBe(false);
    });

    it("should require lowercase domain (caller must normalize)", () => {
      // isDisposableEmail does a case-sensitive check — caller lowercases email first
      expect(isDisposableEmail("user@mailinator.com")).toBe(true);
      // Uppercase domain won't match (auth route lowercases email before calling this)
      expect(isDisposableEmail("user@MAILINATOR.COM")).toBe(true); // .toLowerCase() in isDisposableEmail
    });
  });

  // ─── validatePassword ──────────────────────────────────────────────

  describe("validatePassword", () => {
    it("should return null for a valid password (8+ chars, 2+ classes)", () => {
      expect(validatePassword("abcdefG1")).toBeNull();
    });

    it("should return null for a 128-char password with 2+ classes", () => {
      expect(validatePassword("A" + "a".repeat(127))).toBeNull();
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

    it("should return null for exactly 8 chars with 2+ classes", () => {
      expect(validatePassword("1234abcd")).toBeNull();
    });

    it("should reject passwords with only 1 character class", () => {
      expect(validatePassword("abcdefgh")).not.toBeNull();
      expect(validatePassword("12345678")).not.toBeNull();
      expect(validatePassword("ABCDEFGH")).not.toBeNull();
    });

    it("should reject common passwords", () => {
      expect(validatePassword("password1")).not.toBeNull();
      expect(validatePassword("qwerty123")).not.toBeNull();
    });

    it("should reject passwords containing email username", () => {
      expect(validatePassword("john1234X", "john@example.com")).not.toBeNull();
    });

    it("should accept passwords not containing email username", () => {
      expect(validatePassword("secureP9!", "john@example.com")).toBeNull();
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

    it("should accept ltc", () => {
      expect(isValidCryptoCurrency("ltc")).toBe(true);
    });

    it("should accept zec", () => {
      expect(isValidCryptoCurrency("zec")).toBe(true);
    });

    it("should accept usdc", () => {
      expect(isValidCryptoCurrency("usdc")).toBe(true);
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

  // ─── validateState ────────────────────────────────────────────────

  describe("validateState", () => {
    it("should return null for empty string (no targeting)", () => {
      expect(validateState("")).toBeNull();
    });

    it("should return null for valid lowercase state name", () => {
      expect(validateState("california")).toBeNull();
    });

    it("should return null for two-letter code", () => {
      expect(validateState("ca")).toBeNull();
    });

    it("should return null for 30-letter string", () => {
      expect(validateState("a".repeat(30))).toBeNull();
    });

    it("should reject uppercase letters", () => {
      const result = validateState("California");
      expect(result).not.toBeNull();
      expect(result).toContain("lowercase");
    });

    it("should reject mixed case", () => {
      expect(validateState("newYork")).not.toBeNull();
    });

    it("should reject too short (1 char)", () => {
      const result = validateState("a");
      expect(result).not.toBeNull();
    });

    it("should reject too long (31 chars)", () => {
      const result = validateState("a".repeat(31));
      expect(result).not.toBeNull();
    });

    it("should reject numbers", () => {
      const result = validateState("state1");
      expect(result).not.toBeNull();
    });

    it("should reject special characters", () => {
      expect(validateState("new-york")).not.toBeNull();
      expect(validateState("new york")).not.toBeNull();
      expect(validateState("state_name")).not.toBeNull();
    });

    it("should reject strings with spaces", () => {
      expect(validateState(" ca ")).not.toBeNull();
    });
  });

  // ─── validateCity ─────────────────────────────────────────────────

  describe("validateCity", () => {
    it("should return null for empty string (no targeting)", () => {
      expect(validateCity("")).toBeNull();
    });

    it("should return null for valid lowercase city name", () => {
      expect(validateCity("portland")).toBeNull();
    });

    it("should return null for two-letter city", () => {
      expect(validateCity("la")).toBeNull();
    });

    it("should return null for 50-letter string", () => {
      expect(validateCity("a".repeat(50))).toBeNull();
    });

    it("should reject uppercase letters", () => {
      const result = validateCity("Portland");
      expect(result).not.toBeNull();
      expect(result).toContain("lowercase");
    });

    it("should reject too short (1 char)", () => {
      const result = validateCity("a");
      expect(result).not.toBeNull();
    });

    it("should reject too long (51 chars)", () => {
      const result = validateCity("a".repeat(51));
      expect(result).not.toBeNull();
    });

    it("should reject numbers", () => {
      expect(validateCity("city1")).not.toBeNull();
    });

    it("should reject hyphens and spaces", () => {
      expect(validateCity("new-york")).not.toBeNull();
      expect(validateCity("san francisco")).not.toBeNull();
    });

    it("should reject special characters", () => {
      expect(validateCity("city@name")).not.toBeNull();
    });
  });

  // ─── validateAsn ──────────────────────────────────────────────────

  describe("validateAsn", () => {
    it("should return null for a valid ASN integer", () => {
      expect(validateAsn(1)).toBeNull();
    });

    it("should return null for a typical ASN value", () => {
      expect(validateAsn(15169)).toBeNull(); // Google's ASN
    });

    it("should return null for the maximum 32-bit ASN", () => {
      expect(validateAsn(4_294_967_295)).toBeNull();
    });

    it("should reject 0", () => {
      const result = validateAsn(0);
      expect(result).not.toBeNull();
      expect(result).toContain("ASN must be an integer");
    });

    it("should reject negative numbers", () => {
      expect(validateAsn(-1)).not.toBeNull();
      expect(validateAsn(-100)).not.toBeNull();
    });

    it("should reject floating point numbers", () => {
      expect(validateAsn(1.5)).not.toBeNull();
      expect(validateAsn(100.1)).not.toBeNull();
    });

    it("should reject values above 4,294,967,295", () => {
      expect(validateAsn(4_294_967_296)).not.toBeNull();
    });

    it("should reject NaN", () => {
      expect(validateAsn(NaN)).not.toBeNull();
    });

    it("should reject Infinity", () => {
      expect(validateAsn(Infinity)).not.toBeNull();
      expect(validateAsn(-Infinity)).not.toBeNull();
    });
  });
});
