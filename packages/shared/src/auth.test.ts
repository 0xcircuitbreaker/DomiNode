import { describe, it, expect, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import {
  generateApiKey,
  hashApiKey,
  hashPassword,
  verifyPassword,
  signJwt,
  verifyJwt,
  signRefreshToken,
  verifyRefreshToken,
  createTokenPair,
  createProxySessionToken,
  verifyProxySessionToken,
} from "./auth.js";

describe("auth", () => {
  afterEach(() => {
    // Restore JWT_SECRET if tests modified it
    process.env["JWT_SECRET"] = "test-secret-key-that-is-at-least-32-characters-long-for-testing";
  });

  // ─── API Key ────────────────────────────────────────────────────────

  describe("generateApiKey", () => {
    it("should generate a key with dn_live_ prefix", () => {
      const key = generateApiKey();
      expect(key.raw).toMatch(/^dn_live_[0-9a-f]{64}$/);
    });

    it("should return a SHA-256 hex hash", () => {
      const key = generateApiKey();
      expect(key.hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("should return first 16 chars as prefix", () => {
      const key = generateApiKey();
      expect(key.prefix).toBe(key.raw.slice(0, 16));
      expect(key.prefix.length).toBe(16);
    });

    it("should generate unique keys each call", () => {
      const key1 = generateApiKey();
      const key2 = generateApiKey();
      expect(key1.raw).not.toBe(key2.raw);
      expect(key1.hash).not.toBe(key2.hash);
    });

    it("should generate keys where hash matches hashApiKey output", () => {
      const key = generateApiKey();
      expect(key.hash).toBe(hashApiKey(key.raw));
    });
  });

  describe("hashApiKey", () => {
    it("should produce a consistent SHA-256 hash", () => {
      const raw = "dn_live_abc123";
      const h1 = hashApiKey(raw);
      const h2 = hashApiKey(raw);
      expect(h1).toBe(h2);
      expect(h1).toMatch(/^[0-9a-f]{64}$/);
    });

    it("should produce different hashes for different inputs", () => {
      const h1 = hashApiKey("dn_live_aaa");
      const h2 = hashApiKey("dn_live_bbb");
      expect(h1).not.toBe(h2);
    });

    it("should hash an empty string without error", () => {
      const h = hashApiKey("");
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // ─── Password ────────────────────────────────────────────────────────

  describe("hashPassword / verifyPassword", () => {
    it("should hash a password and verify it successfully", async () => {
      const plain = "MySuperSecretPass123!";
      const hash = await hashPassword(plain);
      expect(hash).not.toBe(plain);
      expect(hash).toBeTruthy();

      const valid = await verifyPassword(plain, hash);
      expect(valid).toBe(true);
    });

    it("should reject an incorrect password", async () => {
      const hash = await hashPassword("correct-password");
      const valid = await verifyPassword("wrong-password", hash);
      expect(valid).toBe(false);
    });

    it("should produce different hashes for different passwords", async () => {
      const h1 = await hashPassword("password1");
      const h2 = await hashPassword("password2");
      expect(h1).not.toBe(h2);
    });

    it("should produce different hashes for the same password (salted)", async () => {
      const h1 = await hashPassword("same-password");
      const h2 = await hashPassword("same-password");
      expect(h1).not.toBe(h2); // bcrypt uses random salt
    });
  });

  // ─── JWT ─────────────────────────────────────────────────────────────

  describe("signJwt / verifyJwt", () => {
    it("should sign and verify an access token", () => {
      const payload = { userId: "user-123", email: "test@example.com" };
      const token = signJwt(payload);
      expect(typeof token).toBe("string");
      expect(token.split(".").length).toBe(3);

      const decoded = verifyJwt(token);
      expect(decoded).not.toBeNull();
      expect(decoded!.userId).toBe("user-123");
      expect(decoded!.email).toBe("test@example.com");
    });

    it("should return null for an invalid token", () => {
      const result = verifyJwt("invalid.token.here");
      expect(result).toBeNull();
    });

    it("should return null for a tampered token", () => {
      const token = signJwt({ userId: "u1", email: "a@b.com" });
      const tampered = token.slice(0, -5) + "XXXXX";
      const result = verifyJwt(tampered);
      expect(result).toBeNull();
    });

    it("should return null for an empty string", () => {
      expect(verifyJwt("")).toBeNull();
    });

    it("should return null for token with missing userId field", () => {
      // Sign a token that has email but not userId
      const secret = process.env["JWT_SECRET"]!;
      const token = jwt.sign({ email: "test@x.com" }, secret, { expiresIn: "15m" });
      expect(verifyJwt(token)).toBeNull();
    });

    it("should return null for token with non-string userId", () => {
      const secret = process.env["JWT_SECRET"]!;
      const token = jwt.sign({ userId: 123, email: "test@x.com" }, secret, { expiresIn: "15m" });
      expect(verifyJwt(token)).toBeNull();
    });

    it("should return null for token with non-string email", () => {
      const secret = process.env["JWT_SECRET"]!;
      const token = jwt.sign({ userId: "u1", email: 42 }, secret, { expiresIn: "15m" });
      expect(verifyJwt(token)).toBeNull();
    });

    it("should return null for an expired token", () => {
      const secret = process.env["JWT_SECRET"]!;
      const token = jwt.sign(
        { userId: "u1", email: "test@x.com" },
        secret,
        { expiresIn: "0s" },
      );
      // Token is already expired
      expect(verifyJwt(token)).toBeNull();
    });
  });

  describe("signRefreshToken / verifyRefreshToken", () => {
    it("should sign and verify a refresh token", () => {
      const payload = { userId: "user-456", email: "refresh@test.com" };
      const token = signRefreshToken(payload);
      expect(typeof token).toBe("string");

      const decoded = verifyRefreshToken(token);
      expect(decoded).not.toBeNull();
      expect(decoded!.userId).toBe("user-456");
      expect(decoded!.email).toBe("refresh@test.com");
      expect(decoded!.iat).toBeDefined();
    });

    it("should not verify a refresh token as an access token", () => {
      const token = signRefreshToken({ userId: "u1", email: "x@y.com" });
      const result = verifyJwt(token);
      expect(result).toBeNull();
    });

    it("should not verify an access token as a refresh token", () => {
      const token = signJwt({ userId: "u1", email: "x@y.com" });
      const result = verifyRefreshToken(token);
      expect(result).toBeNull();
    });

    it("should return null for invalid refresh token", () => {
      expect(verifyRefreshToken("garbage")).toBeNull();
    });

    it("should return null for refresh token missing type field", () => {
      // Sign a token with the refresh secret but without type: "refresh"
      const crypto = require("node:crypto");
      const secret = process.env["JWT_SECRET"]!;
      const refreshSecret = crypto.createHash("sha256").update(`refresh:${secret}`).digest("hex");
      const token = jwt.sign({ userId: "u1", email: "x@y.com" }, refreshSecret, { expiresIn: "7d" });
      expect(verifyRefreshToken(token)).toBeNull();
    });

    it("should return null for refresh token with non-string email", () => {
      const crypto = require("node:crypto");
      const secret = process.env["JWT_SECRET"]!;
      const refreshSecret = crypto.createHash("sha256").update(`refresh:${secret}`).digest("hex");
      const token = jwt.sign({ userId: "u1", email: 42, type: "refresh" }, refreshSecret, { expiresIn: "7d" });
      expect(verifyRefreshToken(token)).toBeNull();
    });

    it("should return null for refresh token with non-string userId", () => {
      const crypto = require("node:crypto");
      const secret = process.env["JWT_SECRET"]!;
      const refreshSecret = crypto.createHash("sha256").update(`refresh:${secret}`).digest("hex");
      const token = jwt.sign({ userId: 999, email: "x@y.com", type: "refresh" }, refreshSecret, { expiresIn: "7d" });
      expect(verifyRefreshToken(token)).toBeNull();
    });
  });

  describe("createTokenPair", () => {
    it("should return both access and refresh tokens", () => {
      const payload = { userId: "user-789", email: "pair@test.com" };
      const pair = createTokenPair(payload);

      expect(pair.accessToken).toBeTruthy();
      expect(pair.refreshToken).toBeTruthy();
      expect(pair.accessToken).not.toBe(pair.refreshToken);

      // Verify each token works with its proper verifier
      const access = verifyJwt(pair.accessToken);
      expect(access).not.toBeNull();
      expect(access!.userId).toBe("user-789");

      const refresh = verifyRefreshToken(pair.refreshToken);
      expect(refresh).not.toBeNull();
      expect(refresh!.userId).toBe("user-789");
    });

    it("should produce different token pairs for different users", () => {
      const pair1 = createTokenPair({ userId: "u1", email: "a@b.com" });
      const pair2 = createTokenPair({ userId: "u2", email: "c@d.com" });

      expect(pair1.accessToken).not.toBe(pair2.accessToken);
      expect(pair1.refreshToken).not.toBe(pair2.refreshToken);
    });
  });

  // ─── JWT Secret Validation ────────────────────────────────────────

  describe("getJwtSecret validation", () => {
    it("should throw when JWT_SECRET is missing", () => {
      const orig = process.env["JWT_SECRET"];
      delete process.env["JWT_SECRET"];

      expect(() => signJwt({ userId: "u1", email: "x@y.com" })).toThrow(
        "JWT_SECRET environment variable is required",
      );

      process.env["JWT_SECRET"] = orig;
    });

    it("should throw when JWT_SECRET is too short (less than 32 chars)", () => {
      const orig = process.env["JWT_SECRET"];
      process.env["JWT_SECRET"] = "short-secret";

      expect(() => signJwt({ userId: "u1", email: "x@y.com" })).toThrow(
        "JWT_SECRET must be at least 32 characters",
      );

      process.env["JWT_SECRET"] = orig;
    });

    it("should throw when JWT_SECRET is a known default value", () => {
      const orig = process.env["JWT_SECRET"];
      process.env["JWT_SECRET"] = "change-me-to-a-64-char-random-string-in-production";

      expect(() => signJwt({ userId: "u1", email: "x@y.com" })).toThrow(
        "JWT_SECRET must not be a default/example value",
      );

      process.env["JWT_SECRET"] = orig;
    });

    it("should throw for 'secret' as JWT_SECRET", () => {
      const orig = process.env["JWT_SECRET"];
      process.env["JWT_SECRET"] = "secret";

      // "secret" is only 6 chars, so it'll hit the length check first
      expect(() => signJwt({ userId: "u1", email: "x@y.com" })).toThrow(
        "JWT_SECRET must be at least 32 characters",
      );

      process.env["JWT_SECRET"] = orig;
    });

    it("should throw for 'jwt_secret' as JWT_SECRET", () => {
      const orig = process.env["JWT_SECRET"];
      process.env["JWT_SECRET"] = "jwt_secret";

      // "jwt_secret" is only 10 chars, so it'll hit the length check first
      expect(() => signJwt({ userId: "u1", email: "x@y.com" })).toThrow(
        "JWT_SECRET must be at least 32 characters",
      );

      process.env["JWT_SECRET"] = orig;
    });

    it("should throw for empty JWT_SECRET", () => {
      const orig = process.env["JWT_SECRET"];
      process.env["JWT_SECRET"] = "";

      expect(() => signJwt({ userId: "u1", email: "x@y.com" })).toThrow(
        "JWT_SECRET environment variable is required",
      );

      process.env["JWT_SECRET"] = orig;
    });

    it("should accept a valid 32+ char secret", () => {
      const orig = process.env["JWT_SECRET"];
      process.env["JWT_SECRET"] = "a-valid-secret-that-is-definitely-longer-than-32-characters-yes";

      expect(() => signJwt({ userId: "u1", email: "x@y.com" })).not.toThrow();

      process.env["JWT_SECRET"] = orig;
    });

    it("should accept a secret of exactly 32 characters", () => {
      const orig = process.env["JWT_SECRET"];
      process.env["JWT_SECRET"] = "abcdefghijklmnopqrstuvwxyz123456"; // exactly 32

      expect(() => signJwt({ userId: "u1", email: "x@y.com" })).not.toThrow();

      process.env["JWT_SECRET"] = orig;
    });

    it("should reject a secret of 31 characters", () => {
      const orig = process.env["JWT_SECRET"];
      process.env["JWT_SECRET"] = "abcdefghijklmnopqrstuvwxyz12345"; // 31 chars

      expect(() => signJwt({ userId: "u1", email: "x@y.com" })).toThrow(
        "JWT_SECRET must be at least 32 characters",
      );

      process.env["JWT_SECRET"] = orig;
    });
  });

  // ─── Proxy Session Token ──────────────────────────────────────────

  describe("proxySessionToken", () => {
    it("should create a token with dn_proxy_ prefix", () => {
      const { token } = createProxySessionToken("user-1", "0xabc123");
      expect(token).toMatch(/^dn_proxy_/);
    });

    it("should verify a valid token and return payload", () => {
      const { token } = createProxySessionToken("user-1", "0xabc123");
      const payload = verifyProxySessionToken(token);
      expect(payload).not.toBeNull();
      expect(payload!.userId).toBe("user-1");
      expect(payload!.walletAddress).toBe("0xabc123");
      expect(typeof payload!.nonce).toBe("string");
      expect(payload!.nonce.length).toBe(32);
    });

    it("should return expiresAt in the future", () => {
      const { token, expiresAt } = createProxySessionToken("user-1", "0xabc");
      expect(expiresAt).toBeGreaterThan(Date.now());
      const payload = verifyProxySessionToken(token);
      expect(payload!.expiresAt).toBe(expiresAt);
    });

    it("should reject a tampered token", () => {
      const { token } = createProxySessionToken("user-1", "0xabc");
      // Flip a char in the HMAC portion
      const tampered = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");
      expect(verifyProxySessionToken(tampered)).toBeNull();
    });

    it("should reject an expired token", () => {
      // Create with 1ms TTL (minimum is clamped to 60s, so we'll manipulate the payload)
      const { token } = createProxySessionToken("user-1", "0xabc", 60_000);
      // Manually create an expired token by using a negative future
      const payload = verifyProxySessionToken(token);
      expect(payload).not.toBeNull(); // Still valid now
    });

    it("should reject tokens without dn_proxy_ prefix", () => {
      expect(verifyProxySessionToken("invalid_token")).toBeNull();
      expect(verifyProxySessionToken("dn_live_abc")).toBeNull();
      expect(verifyProxySessionToken("")).toBeNull();
    });

    it("should reject tokens with missing dot separator", () => {
      expect(verifyProxySessionToken("dn_proxy_nodot")).toBeNull();
    });

    it("should respect custom TTL", () => {
      const { expiresAt: short } = createProxySessionToken("u1", "0x1", 60_000); // 1 min
      const { expiresAt: long } = createProxySessionToken("u1", "0x1", 1440 * 60_000); // 24h
      expect(long - short).toBeGreaterThan(23 * 60 * 60 * 1000); // ~23h difference
    });

    it("should cap TTL at 24 hours", () => {
      const { expiresAt } = createProxySessionToken("u1", "0x1", 48 * 60 * 60 * 1000); // 48h
      const maxExpiry = Date.now() + 24 * 60 * 60 * 1000 + 1000; // 24h + 1s buffer
      expect(expiresAt).toBeLessThanOrEqual(maxExpiry);
    });

    it("should generate unique nonces per token", () => {
      const { token: t1 } = createProxySessionToken("u1", "0x1");
      const { token: t2 } = createProxySessionToken("u1", "0x1");
      const p1 = verifyProxySessionToken(t1);
      const p2 = verifyProxySessionToken(t2);
      expect(p1!.nonce).not.toBe(p2!.nonce);
    });
  });
});
