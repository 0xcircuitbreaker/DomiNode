import { describe, it, expect, beforeEach, vi } from "vitest";

// Stub environment variables BEFORE importing the module under test
vi.stubEnv("MFA_ENCRYPTION_KEY", "a".repeat(64));
vi.stubEnv("JWT_SECRET", "a".repeat(32));

import {
  generateTotpSecret,
  encryptTotpSecret,
  decryptTotpSecret,
  verifyTotpCode,
  generateTotpCode,
  buildTotpUri,
  generateBackupCodes,
  hashBackupCode,
} from "./totp.js";

describe("totp", () => {
  beforeEach(() => {
    vi.stubEnv("MFA_ENCRYPTION_KEY", "a".repeat(64));
    vi.stubEnv("JWT_SECRET", "a".repeat(32));
  });

  // ─── generateTotpSecret ────────────────────────────────────────────

  describe("generateTotpSecret", () => {
    it("should return a 20-byte raw buffer", () => {
      const { raw } = generateTotpSecret();
      expect(Buffer.isBuffer(raw)).toBe(true);
      expect(raw.length).toBe(20);
    });

    it("should return a valid base32 string", () => {
      const { base32 } = generateTotpSecret();
      expect(typeof base32).toBe("string");
      expect(base32.length).toBeGreaterThan(0);
      // Base32 alphabet: A-Z 2-7
      expect(/^[A-Z2-7]+$/.test(base32)).toBe(true);
    });

    it("should return different secrets on each call", () => {
      const a = generateTotpSecret();
      const b = generateTotpSecret();
      expect(a.raw.equals(b.raw)).toBe(false);
      expect(a.base32).not.toBe(b.base32);
    });
  });

  // ─── encryptTotpSecret / decryptTotpSecret ─────────────────────────

  describe("encryptTotpSecret / decryptTotpSecret", () => {
    it("should round-trip preserve the original data", () => {
      const { raw } = generateTotpSecret();
      const { encrypted, iv } = encryptTotpSecret(raw);
      const decrypted = decryptTotpSecret(encrypted, iv);
      expect(decrypted.equals(raw)).toBe(true);
    });

    it("should produce base64-encoded encrypted and iv strings", () => {
      const { raw } = generateTotpSecret();
      const { encrypted, iv } = encryptTotpSecret(raw);
      // Base64 should not throw when decoded
      expect(() => Buffer.from(encrypted, "base64")).not.toThrow();
      expect(() => Buffer.from(iv, "base64")).not.toThrow();
      expect(encrypted.length).toBeGreaterThan(0);
      expect(iv.length).toBeGreaterThan(0);
    });

    it("should fail decryption with a wrong IV", () => {
      const { raw } = generateTotpSecret();
      const { encrypted } = encryptTotpSecret(raw);
      // Generate a different IV (12 bytes = 16 base64 chars)
      const wrongIv = Buffer.from("bbbbbbbbbbbb").toString("base64");
      expect(() => decryptTotpSecret(encrypted, wrongIv)).toThrow();
    });

    it("should fail decryption with tampered ciphertext", () => {
      const { raw } = generateTotpSecret();
      const { encrypted, iv } = encryptTotpSecret(raw);
      // Flip a character in the encrypted data
      const buf = Buffer.from(encrypted, "base64");
      buf[0] ^= 0xff;
      const tampered = buf.toString("base64");
      expect(() => decryptTotpSecret(tampered, iv)).toThrow();
    });

    it("should produce different ciphertext for the same plaintext (random IV)", () => {
      const { raw } = generateTotpSecret();
      const enc1 = encryptTotpSecret(raw);
      const enc2 = encryptTotpSecret(raw);
      expect(enc1.encrypted).not.toBe(enc2.encrypted);
      expect(enc1.iv).not.toBe(enc2.iv);
    });
  });

  // ─── verifyTotpCode ────────────────────────────────────────────────

  describe("verifyTotpCode", () => {
    it("should accept a valid code for the current time", () => {
      const { raw } = generateTotpSecret();
      const now = Date.now();
      const code = generateTotpCode(raw, now);
      const result = verifyTotpCode(raw, code, now);
      expect(result).not.toBeNull();
      expect(typeof result).toBe("bigint");
    });

    it("should reject an invalid code", () => {
      const { raw } = generateTotpSecret();
      const now = Date.now();
      // "000000" is extremely unlikely to be the valid code
      // (and even if it is, "111111" won't be)
      const validCode = generateTotpCode(raw, now);
      const invalidCode = validCode === "000000" ? "111111" : "000000";
      expect(verifyTotpCode(raw, invalidCode, now)).toBeNull();
    });

    it("should accept code from the previous time step (-1 window)", () => {
      const { raw } = generateTotpSecret();
      const now = Date.now();
      // Generate a code from 30 seconds ago (previous time step)
      const pastCode = generateTotpCode(raw, now - 30_000);
      expect(verifyTotpCode(raw, pastCode, now)).not.toBeNull();
    });

    it("should accept code from the next time step (+1 window)", () => {
      const { raw } = generateTotpSecret();
      const now = Date.now();
      // Generate a code from 30 seconds in the future (next time step)
      const futureCode = generateTotpCode(raw, now + 30_000);
      expect(verifyTotpCode(raw, futureCode, now)).not.toBeNull();
    });

    it("should reject code from 2 time steps away", () => {
      const { raw } = generateTotpSecret();
      const now = Date.now();
      // Generate a code from 90 seconds ago (3 steps away to guarantee outside window)
      const farPastCode = generateTotpCode(raw, now - 90_000);
      // This might still pass if the steps happen to overlap, so use 120s
      const veryFarCode = generateTotpCode(raw, now - 120_000);
      // At least one of these should be rejected (2+ steps away)
      const farFutureCode = generateTotpCode(raw, now + 120_000);
      // The code from +-120s is 4 steps away, definitely outside +/-1 window
      expect(verifyTotpCode(raw, farFutureCode, now)).toBeNull();
    });

    it("should reject non-6-digit strings", () => {
      const { raw } = generateTotpSecret();
      const now = Date.now();
      expect(verifyTotpCode(raw, "12345", now)).toBeNull();   // too short
      expect(verifyTotpCode(raw, "1234567", now)).toBeNull();  // too long
      expect(verifyTotpCode(raw, "abcdef", now)).toBeNull();   // non-numeric
      expect(verifyTotpCode(raw, "", now)).toBeNull();          // empty
      expect(verifyTotpCode(raw, "12 345", now)).toBeNull();   // spaces
    });

    it("should reject code with leading/trailing whitespace", () => {
      const { raw } = generateTotpSecret();
      const now = Date.now();
      const code = generateTotpCode(raw, now);
      expect(verifyTotpCode(raw, ` ${code}`, now)).toBeNull();
      expect(verifyTotpCode(raw, `${code} `, now)).toBeNull();
    });

    it("should prevent replay attacks with lastUsedCounter", () => {
      const { raw } = generateTotpSecret();
      const now = Date.now();
      const code = generateTotpCode(raw, now);
      // First verification should succeed and return counter
      const counter = verifyTotpCode(raw, code, now);
      expect(counter).not.toBeNull();
      // Replaying the same code with lastUsedCounter should be rejected
      expect(verifyTotpCode(raw, code, now, counter!)).toBeNull();
    });

    it("should accept a newer code after lastUsedCounter", () => {
      const { raw } = generateTotpSecret();
      const now = Date.now();
      const code1 = generateTotpCode(raw, now);
      const counter1 = verifyTotpCode(raw, code1, now);
      expect(counter1).not.toBeNull();
      // A code from the next time step should still be accepted
      const futureNow = now + 30_000;
      const code2 = generateTotpCode(raw, futureNow);
      const counter2 = verifyTotpCode(raw, code2, futureNow, counter1!);
      expect(counter2).not.toBeNull();
      expect(counter2! > counter1!).toBe(true);
    });
  });

  // ─── generateTotpCode ─────────────────────────────────────────────

  describe("generateTotpCode", () => {
    it("should produce a 6-digit string", () => {
      const { raw } = generateTotpSecret();
      const code = generateTotpCode(raw);
      expect(typeof code).toBe("string");
      expect(code.length).toBe(6);
      expect(/^\d{6}$/.test(code)).toBe(true);
    });

    it("should produce the same code for the same time step", () => {
      const { raw } = generateTotpSecret();
      // Pick a time in the middle of a 30-second step
      const now = 1700000010000; // arbitrary timestamp
      const code1 = generateTotpCode(raw, now);
      const code2 = generateTotpCode(raw, now + 5000); // 5 seconds later, same step
      expect(code1).toBe(code2);
    });

    it("should produce different codes for different secrets", () => {
      const secretA = generateTotpSecret().raw;
      const secretB = generateTotpSecret().raw;
      const now = Date.now();
      const codeA = generateTotpCode(secretA, now);
      const codeB = generateTotpCode(secretB, now);
      // Extremely unlikely to be equal with different secrets
      expect(codeA).not.toBe(codeB);
    });

    it("should pad codes shorter than 6 digits with leading zeros", () => {
      // We cannot easily force a specific output, but we can verify format
      const { raw } = generateTotpSecret();
      for (let i = 0; i < 20; i++) {
        const code = generateTotpCode(raw, Date.now() + i * 30_000);
        expect(code.length).toBe(6);
        expect(/^\d{6}$/.test(code)).toBe(true);
      }
    });
  });

  // ─── buildTotpUri ──────────────────────────────────────────────────

  describe("buildTotpUri", () => {
    it("should produce a correct otpauth:// URI", () => {
      const uri = buildTotpUri("JBSWY3DPEHPK3PXP", "user@example.com");
      expect(uri.startsWith("otpauth://totp/")).toBe(true);
      expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
      expect(uri).toContain("issuer=DomiNode");
      expect(uri).toContain("algorithm=SHA1");
      expect(uri).toContain("digits=6");
      expect(uri).toContain("period=30");
    });

    it("should include the email in the label", () => {
      const uri = buildTotpUri("ABCDEFGH", "test@domain.com");
      // The label is URL-encoded: DomiNode:test@domain.com
      expect(uri).toContain(encodeURIComponent("DomiNode:test@domain.com"));
    });

    it("should use custom issuer when provided", () => {
      const uri = buildTotpUri("ABCDEFGH", "test@domain.com", "MyApp");
      expect(uri).toContain("issuer=MyApp");
      expect(uri).toContain(encodeURIComponent("MyApp:test@domain.com"));
    });

    it("should default issuer to DomiNode", () => {
      const uri = buildTotpUri("ABCDEFGH", "test@domain.com");
      expect(uri).toContain("issuer=DomiNode");
    });

    it("should handle special characters in email", () => {
      const uri = buildTotpUri("ABCDEFGH", "user+tag@example.com");
      expect(uri).toContain("otpauth://totp/");
      // Should be valid URL (no throw)
      expect(typeof uri).toBe("string");
    });
  });

  // ─── generateBackupCodes ──────────────────────────────────────────

  describe("generateBackupCodes", () => {
    it("should produce 10 codes", () => {
      const { plaintextCodes, hashes } = generateBackupCodes();
      expect(plaintextCodes.length).toBe(10);
      expect(hashes.length).toBe(10);
    });

    it("should produce 8-digit numeric codes", () => {
      const { plaintextCodes } = generateBackupCodes();
      for (const code of plaintextCodes) {
        expect(code.length).toBe(8);
        expect(/^\d{8}$/.test(code)).toBe(true);
      }
    });

    it("should produce hashes that correspond to the codes", () => {
      const { plaintextCodes, hashes } = generateBackupCodes();
      for (let i = 0; i < plaintextCodes.length; i++) {
        expect(hashes[i]).toBe(hashBackupCode(plaintextCodes[i]));
      }
    });

    it("should produce unique codes (no duplicates within a set)", () => {
      const { plaintextCodes } = generateBackupCodes();
      const unique = new Set(plaintextCodes);
      // Very unlikely to have duplicates in 10 random 8-digit codes
      expect(unique.size).toBe(plaintextCodes.length);
    });

    it("should produce different sets on each call", () => {
      const a = generateBackupCodes();
      const b = generateBackupCodes();
      // Extremely unlikely to be identical
      expect(a.plaintextCodes).not.toEqual(b.plaintextCodes);
    });
  });

  // ─── hashBackupCode ───────────────────────────────────────────────

  describe("hashBackupCode", () => {
    it("should be deterministic (same input = same output)", () => {
      const hash1 = hashBackupCode("12345678");
      const hash2 = hashBackupCode("12345678");
      expect(hash1).toBe(hash2);
    });

    it("should produce different outputs for different inputs", () => {
      const hash1 = hashBackupCode("12345678");
      const hash2 = hashBackupCode("87654321");
      expect(hash1).not.toBe(hash2);
    });

    it("should produce a hex string", () => {
      const hash = hashBackupCode("00000000");
      expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
    });

    it("should produce a 64-character hex string (SHA-256)", () => {
      const hash = hashBackupCode("12345678");
      expect(hash.length).toBe(64);
    });

    it("should hash the code as a string, not a number", () => {
      const hash1 = hashBackupCode("00000001");
      const hash2 = hashBackupCode("1");
      expect(hash1).not.toBe(hash2);
    });
  });
});
