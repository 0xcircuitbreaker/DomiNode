import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import express from "express";
import http from "http";
import cookieParser from "cookie-parser";

// ─── Mocks ─────────────────────────────────────────────────────────────

vi.mock("@dominusnode/shared", () => ({
  userRepo: {
    findUserByEmail: vi.fn(),
    findUserForAuth: vi.fn(),
    findUserById: vi.fn(),
    findUserByApiKeyHash: vi.fn(),
    createUser: vi.fn(),
    updatePassword: vi.fn(),
    revokeAllApiKeys: vi.fn(),
    countActiveUsers: vi.fn(() => Promise.resolve(0)),
    createEmailVerificationToken: vi.fn(() => Promise.resolve()),
    markEmailVerified: vi.fn(() => Promise.resolve()),
  },
  walletRepo: { createWallet: vi.fn() },
  adminRepo: { hasAnyAdmin: vi.fn(), bootstrapFirstAdmin: vi.fn() },
  waitlistRepo: { markRegistered: vi.fn(() => Promise.resolve()) },
  isDisposableEmail: vi.fn(() => false),
  isWalletEmail: vi.fn(() => false),
  sendVerificationEmail: vi.fn(() => Promise.resolve()),
  query: vi.fn(() => Promise.resolve({ rows: [{ count: "0" }] })),
  refreshTokenRepo: {
    newFamilyId: vi.fn(() => "family-1"),
    hashToken: vi.fn(() => "token-hash"),
    storeToken: vi.fn(),
    findTokenByHash: vi.fn(),
    findSuccessorClientHash: vi.fn(),
    clientBindingHash: vi.fn((ua?: string) => `client:${ua ?? ""}`),
    revokeToken: vi.fn(),
    revokeFamily: vi.fn(),
    revokeAllForUser: vi.fn(),
    isWithinRotationGrace: vi.fn((t: { rotated_at?: Date | null }) =>
      !!t.rotated_at && Date.now() - new Date(t.rotated_at).getTime() <= 10_000),
  },
  mfaRepo: {
    findMfaConfigByUserId: vi.fn(),
    createMfaConfig: vi.fn(),
    enableMfa: vi.fn(),
    disableMfa: vi.fn(),
    deleteMfaConfig: vi.fn(),
    storeBackupCodes: vi.fn(),
    consumeBackupCodeAtomic: vi.fn(),
    countUnusedBackupCodes: vi.fn(),
  },
  hashPassword: vi.fn(() => Promise.resolve("hashed-pw")),
  verifyPassword: vi.fn(() => Promise.resolve(true)),
  createTokenPair: vi.fn(() => ({
    accessToken: "access-token-123",
    refreshToken: "refresh-token-456",
  })),
  verifyRefreshToken: vi.fn(),
  signJwt: vi.fn(() => "signed-jwt"),
  signMfaChallengeToken: vi.fn(() => "mfa-challenge-token"),
  verifyMfaChallengeToken: vi.fn(),
  hashApiKey: vi.fn(() => "api-key-hash"),
  isValidEmail: vi.fn(() => true),
  validatePassword: vi.fn(() => null),
  sanitizeString: vi.fn((s: string) => s),
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  generateTotpSecret: vi.fn(() => ({
    raw: Buffer.from("01234567890123456789"),
    base32: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
  })),
  encryptTotpSecret: vi.fn(() => ({ encrypted: "enc-secret", iv: "enc-iv" })),
  decryptTotpSecret: vi.fn(() => Buffer.from("01234567890123456789")),
  verifyTotpCode: vi.fn(),
  buildTotpUri: vi.fn(() => "otpauth://totp/Dominus Node:test@example.com?secret=ABC"),
  generateBackupCodes: vi.fn(() => ({
    plaintextCodes: ["00000001", "00000002", "00000003", "00000004", "00000005",
                     "00000006", "00000007", "00000008", "00000009", "00000010"],
    hashes: ["h1", "h2", "h3", "h4", "h5", "h6", "h7", "h8", "h9", "h10"],
  })),
  hashBackupCode: vi.fn(() => "backup-hash"),
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: vi.fn(
    (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      (req as unknown as { user: { userId: string; email: string; isAdmin: boolean } }).user = {
        userId: "user1",
        email: "test@example.com",
        isAdmin: false,
      };
      next();
    },
  ),
}));

vi.mock("../helpers/cookies.js", () => ({
  setAuthCookies: vi.fn(),
  clearAuthCookies: vi.fn(),
  getRefreshCookieName: vi.fn(() => "dominusnode_refresh"),
}));

// Import AFTER mocks are set up
import authRouter from "./auth.js";
import {
  userRepo,
  adminRepo,
  mfaRepo,
  verifyMfaChallengeToken,
  verifyTotpCode,
  verifyPassword,
  verifyRefreshToken,
  refreshTokenRepo,
  query as dbQueryMock,
} from "@dominusnode/shared";

// ─── Helpers ───────────────────────────────────────────────────────────

function createApp(): express.Express {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api/auth", authRouter);
  return app;
}

function request(
  app: express.Express,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Failed to get server address"));
        return;
      }
      const port = addr.port;
      const jsonBody = body ? JSON.stringify(body) : undefined;
      const options: http.RequestOptions = {
        hostname: "127.0.0.1",
        port,
        path,
        method: method.toUpperCase(),
        headers: {
          "Content-Type": "application/json",
          ...(headers ?? {}),
          ...(jsonBody ? { "Content-Length": Buffer.byteLength(jsonBody).toString() } : {}),
        },
      };

      const req = http.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          server.close();
          try {
            resolve({ status: res.statusCode ?? 500, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 500, body: {} });
          }
        });
      });
      req.on("error", (err) => {
        server.close();
        reject(err);
      });
      if (jsonBody) req.write(jsonBody);
      req.end();
    });
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe("MFA auth routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env["ADMIN_HUMAN_LOGIN"] = "true";
    // Reset default mock behaviors
    (verifyPassword as ReturnType<typeof vi.fn>).mockResolvedValue(true);
  });

  // ─── Login with MFA ──────────────────────────────────────────────

  describe("POST /api/auth/login (MFA flow)", () => {
    it("should return mfaRequired: true when MFA is enabled", async () => {
      (userRepo.findUserForAuth as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "user1",
        email: "test@example.com",
        password_hash: "hashed-pw",
        status: "active",
        is_admin: false, admin_role: "admin",
        created_at: new Date(),
        password_changed_at: null,
      });
      (mfaRepo.findMfaConfigByUserId as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "mfa1",
        user_id: "user1",
        enabled: true,
        totp_secret_enc: "enc",
        totp_secret_iv: "iv",
      });

      const app = createApp();
      const res = await request(app, "POST", "/api/auth/login", {
        email: "test@example.com",
        password: "Password1!",
      });

      expect(res.status).toBe(200);
      expect(res.body.mfaRequired).toBe(true);
      // Non-browser client should receive challenge token in body
      expect(res.body.mfaChallengeToken).toBe("mfa-challenge-token");
    });

    it("should issue normal tokens when MFA is not enabled", async () => {
      (userRepo.findUserForAuth as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "user1",
        email: "test@example.com",
        password_hash: "hashed-pw",
        status: "active",
        is_admin: false, admin_role: "admin",
        created_at: new Date(),
        password_changed_at: null,
      });
      (mfaRepo.findMfaConfigByUserId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

      const app = createApp();
      const res = await request(app, "POST", "/api/auth/login", {
        email: "test@example.com",
        password: "Password1!",
      });

      expect(res.status).toBe(200);
      expect(res.body.mfaRequired).toBeUndefined();
      // Non-browser client gets tokens in body
      expect(res.body.token).toBe("access-token-123");
    });
  });

  // ─── MFA Verify ──────────────────────────────────────────────────

  describe("POST /api/auth/mfa/verify", () => {
    it("should issue tokens with valid TOTP code", async () => {
      (verifyMfaChallengeToken as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        userId: "user1",
        email: "test@example.com",
        mfaPending: true,
        jti: `test-jti-${Math.random().toString(36).slice(2)}`,
      });
      (mfaRepo.findMfaConfigByUserId as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "mfa1",
        user_id: "user1",
        enabled: true,
        totp_secret_enc: "enc",
        totp_secret_iv: "iv",
      });
      (verifyTotpCode as ReturnType<typeof vi.fn>).mockReturnValueOnce(BigInt(1));
      (userRepo.findUserById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "user1",
        email: "test@example.com",
        status: "active",
        is_admin: false, admin_role: "admin",
        created_at: new Date(),
        password_changed_at: null,
      });

      const app = createApp();
      const res = await request(app, "POST", "/api/auth/mfa/verify", {
        mfaChallengeToken: "valid-challenge-token",
        code: "123456",
      });

      expect(res.status).toBe(200);
      // Non-browser client gets tokens
      expect(res.body.token).toBe("access-token-123");
      expect(res.body.refreshToken).toBe("refresh-token-456");
      expect(res.body.userId).toBe("user1");
    });

    it("should issue tokens with valid backup code", async () => {
      (verifyMfaChallengeToken as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        userId: "user1",
        email: "test@example.com",
        mfaPending: true,
        jti: `test-jti-${Math.random().toString(36).slice(2)}`,
      });
      (mfaRepo.findMfaConfigByUserId as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "mfa1",
        user_id: "user1",
        enabled: true,
        totp_secret_enc: "enc",
        totp_secret_iv: "iv",
      });
      // Atomic consume returns the consumed code
      (mfaRepo.consumeBackupCodeAtomic as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "bc1",
        user_id: "user1",
        code_hash: "backup-hash",
        used_at: new Date(),
      });
      (userRepo.findUserById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "user1",
        email: "test@example.com",
        status: "active",
        is_admin: false, admin_role: "admin",
        created_at: new Date(),
        password_changed_at: null,
      });

      const app = createApp();
      const res = await request(app, "POST", "/api/auth/mfa/verify", {
        mfaChallengeToken: "valid-challenge-token",
        code: "00000001",
        isBackupCode: true,
      });

      expect(res.status).toBe(200);
      expect(res.body.token).toBe("access-token-123");
      expect(mfaRepo.consumeBackupCodeAtomic).toHaveBeenCalledWith("user1", "backup-hash");
    });

    it("should return 401 with expired challenge token", async () => {
      (verifyMfaChallengeToken as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);

      const app = createApp();
      const res = await request(app, "POST", "/api/auth/mfa/verify", {
        mfaChallengeToken: "expired-challenge-token",
        code: "123456",
      });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Invalid or expired MFA challenge");
    });

    it("should return 401 with invalid TOTP code", async () => {
      (verifyMfaChallengeToken as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        userId: "user1",
        email: "test@example.com",
        mfaPending: true,
        jti: `test-jti-${Math.random().toString(36).slice(2)}`,
      });
      (mfaRepo.findMfaConfigByUserId as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "mfa1",
        user_id: "user1",
        enabled: true,
        totp_secret_enc: "enc",
        totp_secret_iv: "iv",
      });
      (verifyTotpCode as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);

      const app = createApp();
      const res = await request(app, "POST", "/api/auth/mfa/verify", {
        mfaChallengeToken: "valid-challenge-token",
        code: "000000",
      });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Invalid verification code");
    });

    it("should return 400 when no challenge token is provided", async () => {
      const app = createApp();
      const res = await request(app, "POST", "/api/auth/mfa/verify", {
        code: "123456",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("MFA challenge token required");
    });

    it("should return 400 when no code is provided", async () => {
      (verifyMfaChallengeToken as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        userId: "user1",
        email: "test@example.com",
        mfaPending: true,
        jti: `test-jti-${Math.random().toString(36).slice(2)}`,
      });

      const app = createApp();
      const res = await request(app, "POST", "/api/auth/mfa/verify", {
        mfaChallengeToken: "valid-challenge-token",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Verification code required");
    });

    it("should return 400 when MFA is not enabled for the user", async () => {
      (verifyMfaChallengeToken as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        userId: "user1",
        email: "test@example.com",
        mfaPending: true,
        jti: `test-jti-${Math.random().toString(36).slice(2)}`,
      });
      (mfaRepo.findMfaConfigByUserId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

      const app = createApp();
      const res = await request(app, "POST", "/api/auth/mfa/verify", {
        mfaChallengeToken: "valid-challenge-token",
        code: "123456",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("MFA is not enabled");
    });
  });

  // ─── MFA Setup ───────────────────────────────────────────────────

  describe("POST /api/auth/mfa/setup", () => {
    it("should return secret, otpauthUri, and backup codes", async () => {
      (mfaRepo.findMfaConfigByUserId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
      (mfaRepo.createMfaConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "mfa1" });
      (mfaRepo.storeBackupCodes as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);

      const app = createApp();
      const res = await request(app, "POST", "/api/auth/mfa/setup");

      expect(res.status).toBe(200);
      expect(res.body.secret).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
      expect(res.body.otpauthUri).toBe("otpauth://totp/Dominus Node:test@example.com?secret=ABC");
      expect(res.body.backupCodes).toHaveLength(10);
    });

    it("should return 409 if MFA is already enabled", async () => {
      (mfaRepo.findMfaConfigByUserId as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "mfa1",
        user_id: "user1",
        enabled: true,
      });

      const app = createApp();
      const res = await request(app, "POST", "/api/auth/mfa/setup");

      expect(res.status).toBe(409);
      expect(res.body.error).toContain("already enabled");
    });

    it("should allow re-setup when MFA exists but is not yet enabled", async () => {
      (mfaRepo.findMfaConfigByUserId as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "mfa1",
        user_id: "user1",
        enabled: false,
      });
      (mfaRepo.createMfaConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "mfa1" });
      (mfaRepo.storeBackupCodes as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);

      const app = createApp();
      const res = await request(app, "POST", "/api/auth/mfa/setup");

      expect(res.status).toBe(200);
      expect(res.body.secret).toBeDefined();
    });
  });

  // ─── MFA Enable ──────────────────────────────────────────────────

  describe("POST /api/auth/mfa/enable", () => {
    it("should activate MFA with valid code", async () => {
      (mfaRepo.findMfaConfigByUserId as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "mfa1",
        user_id: "user1",
        enabled: false,
        totp_secret_enc: "enc",
        totp_secret_iv: "iv",
      });
      (verifyTotpCode as ReturnType<typeof vi.fn>).mockReturnValueOnce(BigInt(1));
      (mfaRepo.enableMfa as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);

      const app = createApp();
      const res = await request(app, "POST", "/api/auth/mfa/enable", {
        code: "123456",
      });

      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(true);
      expect(mfaRepo.enableMfa).toHaveBeenCalledWith("user1");
    });

    it("should return 401 with invalid TOTP code", async () => {
      (mfaRepo.findMfaConfigByUserId as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "mfa1",
        user_id: "user1",
        enabled: false,
        totp_secret_enc: "enc",
        totp_secret_iv: "iv",
      });
      (verifyTotpCode as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);

      const app = createApp();
      const res = await request(app, "POST", "/api/auth/mfa/enable", {
        code: "000000",
      });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain("Invalid TOTP code");
    });

    it("should return 400 when setup has not been started", async () => {
      (mfaRepo.findMfaConfigByUserId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

      const app = createApp();
      const res = await request(app, "POST", "/api/auth/mfa/enable", {
        code: "123456",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("setup not started");
    });

    it("should return 409 when MFA is already enabled", async () => {
      (mfaRepo.findMfaConfigByUserId as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "mfa1",
        user_id: "user1",
        enabled: true,
        totp_secret_enc: "enc",
        totp_secret_iv: "iv",
      });

      const app = createApp();
      const res = await request(app, "POST", "/api/auth/mfa/enable", {
        code: "123456",
      });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain("already enabled");
    });

    it("should return 400 for non-6-digit code", async () => {
      const app = createApp();
      const res = await request(app, "POST", "/api/auth/mfa/enable", {
        code: "12345",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("6-digit");
    });

    it("should return 400 when code is empty", async () => {
      const app = createApp();
      const res = await request(app, "POST", "/api/auth/mfa/enable", {
        code: "",
      });

      expect(res.status).toBe(400);
    });
  });

  // ─── MFA Disable ─────────────────────────────────────────────────

  describe("POST /api/auth/mfa/disable", () => {
    it("should disable MFA with valid password and TOTP code", async () => {
      (userRepo.findUserForAuth as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "user1",
        email: "test@example.com",
        password_hash: "hashed-pw",
        status: "active",
      });
      (mfaRepo.findMfaConfigByUserId as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "mfa1",
        user_id: "user1",
        enabled: true,
        totp_secret_enc: "enc",
        totp_secret_iv: "iv",
      });
      (verifyTotpCode as ReturnType<typeof vi.fn>).mockReturnValueOnce(BigInt(1));
      (mfaRepo.deleteMfaConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);

      const app = createApp();
      const res = await request(app, "POST", "/api/auth/mfa/disable", {
        password: "Password1!",
        code: "123456",
      });

      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(false);
      expect(mfaRepo.deleteMfaConfig).toHaveBeenCalledWith("user1");
    });

    it("should disable MFA with valid password and backup code", async () => {
      (userRepo.findUserForAuth as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "user1",
        email: "test@example.com",
        password_hash: "hashed-pw",
        status: "active",
      });
      (mfaRepo.findMfaConfigByUserId as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "mfa1",
        user_id: "user1",
        enabled: true,
        totp_secret_enc: "enc",
        totp_secret_iv: "iv",
      });
      // TOTP check fails, then atomic backup code consume succeeds
      (verifyTotpCode as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
      (mfaRepo.consumeBackupCodeAtomic as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "bc1",
        code_hash: "backup-hash",
        used_at: new Date(),
      });
      (mfaRepo.deleteMfaConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);

      const app = createApp();
      const res = await request(app, "POST", "/api/auth/mfa/disable", {
        password: "Password1!",
        code: "00000001",
      });

      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(false);
      expect(mfaRepo.consumeBackupCodeAtomic).toHaveBeenCalledWith("user1", "backup-hash");
    });

    it("should return 400 when password is missing", async () => {
      const app = createApp();
      const res = await request(app, "POST", "/api/auth/mfa/disable", {
        code: "123456",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Password is required");
    });

    it("should return 400 when code is missing", async () => {
      const app = createApp();
      const res = await request(app, "POST", "/api/auth/mfa/disable", {
        password: "Password1!",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("code");
    });

    it("should return 401 when password is incorrect", async () => {
      (userRepo.findUserForAuth as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "user1",
        email: "test@example.com",
        password_hash: "hashed-pw",
        status: "active",
      });
      (verifyPassword as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

      const app = createApp();
      const res = await request(app, "POST", "/api/auth/mfa/disable", {
        password: "WrongPassword1!",
        code: "123456",
      });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain("Invalid password");
    });

    it("should return 401 when both TOTP and backup code are invalid", async () => {
      (userRepo.findUserForAuth as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "user1",
        email: "test@example.com",
        password_hash: "hashed-pw",
        status: "active",
      });
      (mfaRepo.findMfaConfigByUserId as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "mfa1",
        user_id: "user1",
        enabled: true,
        totp_secret_enc: "enc",
        totp_secret_iv: "iv",
      });
      (verifyTotpCode as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
      // Atomic consume returns null (no matching unused code)
      (mfaRepo.consumeBackupCodeAtomic as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

      const app = createApp();
      const res = await request(app, "POST", "/api/auth/mfa/disable", {
        password: "Password1!",
        code: "000000",
      });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain("Invalid verification code");
    });

    it("should return 400 when MFA is not enabled", async () => {
      (userRepo.findUserForAuth as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "user1",
        email: "test@example.com",
        password_hash: "hashed-pw",
        status: "active",
      });
      (mfaRepo.findMfaConfigByUserId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

      const app = createApp();
      const res = await request(app, "POST", "/api/auth/mfa/disable", {
        password: "Password1!",
        code: "123456",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("MFA is not enabled");
    });
  });

  // ─── MFA Status ──────────────────────────────────────────────────

  describe("GET /api/auth/mfa/status", () => {
    it("should return enabled: true and backup codes remaining", async () => {
      (mfaRepo.findMfaConfigByUserId as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "mfa1",
        user_id: "user1",
        enabled: true,
      });
      (mfaRepo.countUnusedBackupCodes as ReturnType<typeof vi.fn>).mockResolvedValueOnce(8);

      const app = createApp();
      const res = await request(app, "GET", "/api/auth/mfa/status");

      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(true);
      expect(res.body.backupCodesRemaining).toBe(8);
    });

    it("should return enabled: false and 0 backup codes when MFA is not set up", async () => {
      (mfaRepo.findMfaConfigByUserId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

      const app = createApp();
      const res = await request(app, "GET", "/api/auth/mfa/status");

      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(false);
      expect(res.body.backupCodesRemaining).toBe(0);
    });

    it("should return enabled: false when config exists but is not enabled", async () => {
      (mfaRepo.findMfaConfigByUserId as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "mfa1",
        user_id: "user1",
        enabled: false,
      });

      const app = createApp();
      const res = await request(app, "GET", "/api/auth/mfa/status");

      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(false);
      expect(res.body.backupCodesRemaining).toBe(0);
    });
  });

  // ─── verify-key skips MFA ────────────────────────────────────────

  describe("POST /api/auth/verify-key (MFA bypass)", () => {
    it("should return tokens without MFA challenge for valid API key", async () => {
      (userRepo.findUserByApiKeyHash as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        user: {
          id: "user1",
          email: "test@example.com",
          status: "active",
          is_admin: false, admin_role: "admin",
        },
        apiKey: { id: "ak1" },
      });

      const app = createApp();
      const res = await request(app, "POST", "/api/auth/verify-key", {
        apiKey: "dn_live_abc123",
      });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.token).toBe("access-token-123");
      expect(res.body.refreshToken).toBe("refresh-token-456");
      // verify-key now checks MFA — should call findMfaConfigByUserId
      // but since mock returns null (no MFA), tokens are still issued
      expect(mfaRepo.findMfaConfigByUserId).toHaveBeenCalledWith("user1");
    });
  });
});

describe("human auth gate (ADMIN_HUMAN_LOGIN)", () => {
  const prev = { login: process.env["ADMIN_HUMAN_LOGIN"], boot: process.env["ADMIN_BOOTSTRAP_EMAIL"] };
  beforeEach(() => {
    vi.clearAllMocks();
    (verifyPassword as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    delete process.env["ADMIN_HUMAN_LOGIN"];
    delete process.env["ADMIN_BOOTSTRAP_EMAIL"];
  });
  afterAll(() => {
    if (prev.login === undefined) delete process.env["ADMIN_HUMAN_LOGIN"]; else process.env["ADMIN_HUMAN_LOGIN"] = prev.login;
    if (prev.boot === undefined) delete process.env["ADMIN_BOOTSTRAP_EMAIL"]; else process.env["ADMIN_BOOTSTRAP_EMAIL"] = prev.boot;
  });

  it("404s every human auth route when the flag is off (default)", async () => {
    const app = createApp();
    for (const path of ["/api/auth/register", "/api/auth/login", "/api/auth/forgot-password", "/api/auth/reset-password", "/api/auth/mfa/verify", "/api/auth/mfa/setup"]) {
      const res = await request(app, "POST", path, { email: "a@example.com", password: "x" });
      expect(res.status, path).toBe(404);
    }
    expect((await request(app, "GET", "/api/auth/mfa/status")).status).toBe(404);
    expect(userRepo.findUserForAuth).not.toHaveBeenCalled();
  });

  it("keeps non-human routes (verify-key) available when the flag is off", async () => {
    (userRepo.findUserByApiKeyHash as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      user: { id: "user1", email: "w@example.com", status: "active", is_admin: false }, apiKey: { id: "ak1" },
    });
    const res = await request(createApp(), "POST", "/api/auth/verify-key", { apiKey: "dn_live_abc123" });
    expect(res.status).toBe(200);
  });

  it("with the flag on, login is refused for non-admin users", async () => {
    process.env["ADMIN_HUMAN_LOGIN"] = "true";
    (userRepo.findUserForAuth as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "u2", email: "user@example.com", password_hash: "h", status: "active", is_admin: false, admin_role: "none",
      created_at: new Date(), password_changed_at: null,
    });
    const res = await request(createApp(), "POST", "/api/auth/login", { email: "user@example.com", password: "Password1!" });
    expect(res.status).toBe(401);
    expect(mfaRepo.findMfaConfigByUserId).not.toHaveBeenCalled();
  });

  it("with the flag on, admins can log in", async () => {
    process.env["ADMIN_HUMAN_LOGIN"] = "true";
    (userRepo.findUserForAuth as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "a1", email: "ops@example.com", password_hash: "h", status: "active", is_admin: true, admin_role: "admin",
      created_at: new Date(), password_changed_at: null,
    });
    (mfaRepo.findMfaConfigByUserId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const res = await request(createApp(), "POST", "/api/auth/login", { email: "ops@example.com", password: "Password1!" });
    expect(res.status).toBe(200);
    expect(res.body.token).toBe("access-token-123");
  });

  it("with the flag on, registration is closed without ADMIN_BOOTSTRAP_EMAIL", async () => {
    process.env["ADMIN_HUMAN_LOGIN"] = "true";
    const res = await request(createApp(), "POST", "/api/auth/register", { email: "x@example.com", password: "Password1!" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("REGISTRATION_CLOSED");
    expect(userRepo.createUser).not.toHaveBeenCalled();
  });

  it("bootstrap: only the named address, only while no admin exists", async () => {
    process.env["ADMIN_HUMAN_LOGIN"] = "true";
    process.env["ADMIN_BOOTSTRAP_EMAIL"] = "Root@Example.com";
    const app = createApp();
    // Different address
    let res = await request(app, "POST", "/api/auth/register", { email: "other@example.com", password: "Password1!" });
    expect(res.status).toBe(403);
    // An admin already exists
    (adminRepo.hasAnyAdmin as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
    res = await request(app, "POST", "/api/auth/register", { email: "root@example.com", password: "Password1!" });
    expect(res.status).toBe(403);
    expect(userRepo.createUser).not.toHaveBeenCalled();
    // First admin
    (adminRepo.hasAnyAdmin as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    (userRepo.createUser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "a1", email: "root@example.com", status: "active", is_admin: false, admin_role: "none", created_at: new Date(),
    });
    (adminRepo.bootstrapFirstAdmin as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
    res = await request(app, "POST", "/api/auth/register", { email: "root@example.com", password: "Password1!" });
    expect(res.status).toBe(201);
    expect(adminRepo.bootstrapFirstAdmin).toHaveBeenCalledWith("a1");
    expect((res.body.user as Record<string, unknown>).admin_role).toBe("admin");
  });
});

describe("POST /api/auth/refresh (rotation race)", () => {
  const base = {
    id: "rt1", user_id: "user1", family_id: "fam-1",
    expires_at: new Date(Date.now() + 3600_000), created_at: new Date(),
  };
  beforeEach(() => {
    vi.clearAllMocks();
    (verifyRefreshToken as ReturnType<typeof vi.fn>).mockReturnValue({ userId: "user1" });
    (userRepo.findUserById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "user1", email: "a@b.c", status: "active", is_admin: false, admin_role: "none", password_changed_at: null,
    });
  });

  it("token rotated within grace window -> 401 retry, no family or API key revocation", async () => {
    (refreshTokenRepo.findTokenByHash as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...base, revoked: true, rotated_at: new Date(Date.now() - 2000),
    });
    (refreshTokenRepo.findSuccessorClientHash as ReturnType<typeof vi.fn>).mockResolvedValueOnce("client:tab-ua");
    const res = await request(createApp(), "POST", "/api/auth/refresh", { refreshToken: "rt" }, { "User-Agent": "tab-ua" });
    expect(res.status).toBe(401);
    expect(res.body.retry).toBe(true);
    expect(refreshTokenRepo.revokeFamily).not.toHaveBeenCalled();
    expect(userRepo.revokeAllApiKeys).not.toHaveBeenCalled();
  });

  it("token rotated within grace window by a DIFFERENT client -> family revoked (attacker rotated first)", async () => {
    (refreshTokenRepo.findTokenByHash as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...base, revoked: true, rotated_at: new Date(Date.now() - 2000),
    });
    (refreshTokenRepo.findSuccessorClientHash as ReturnType<typeof vi.fn>).mockResolvedValueOnce("client:attacker-ua");
    const res = await request(createApp(), "POST", "/api/auth/refresh", { refreshToken: "rt" }, { "User-Agent": "victim-ua" });
    expect(res.status).toBe(401);
    expect(res.body.retry).toBeUndefined();
    expect(refreshTokenRepo.revokeFamily).toHaveBeenCalledWith("fam-1");
    expect(userRepo.revokeAllApiKeys).not.toHaveBeenCalled();
  });

  it("token rotated within grace window with no successor -> family revoked", async () => {
    (refreshTokenRepo.findTokenByHash as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...base, revoked: true, rotated_at: new Date(Date.now() - 2000),
    });
    (refreshTokenRepo.findSuccessorClientHash as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    const res = await request(createApp(), "POST", "/api/auth/refresh", { refreshToken: "rt" });
    expect(refreshTokenRepo.revokeFamily).toHaveBeenCalledWith("fam-1");
    expect(res.body.retry).toBeUndefined();
  });

  it("losing the concurrent rotation UPDATE -> 401 retry, nothing revoked", async () => {
    (refreshTokenRepo.findTokenByHash as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...base, revoked: false, rotated_at: null });
    (dbQueryMock as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(createApp(), "POST", "/api/auth/refresh", { refreshToken: "rt" });
    expect(res.status).toBe(401);
    expect(res.body.retry).toBe(true);
    expect(refreshTokenRepo.revokeFamily).not.toHaveBeenCalled();
    expect(userRepo.revokeAllApiKeys).not.toHaveBeenCalled();
  });

  it("reuse outside grace window revokes the family but never API keys", async () => {
    (refreshTokenRepo.findTokenByHash as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...base, revoked: true, rotated_at: new Date(Date.now() - 60_000),
    });
    const res = await request(createApp(), "POST", "/api/auth/refresh", { refreshToken: "rt" });
    expect(res.status).toBe(401);
    expect(refreshTokenRepo.revokeFamily).toHaveBeenCalledWith("fam-1");
    expect(userRepo.revokeAllApiKeys).not.toHaveBeenCalled();
  });

  it("successful rotation stamps rotated_at", async () => {
    (refreshTokenRepo.findTokenByHash as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...base, revoked: false, rotated_at: null });
    (dbQueryMock as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ family_id: "fam-1" }], rowCount: 1 });
    const res = await request(createApp(), "POST", "/api/auth/refresh", { refreshToken: "rt" });
    expect(res.status).toBe(200);
    expect(String((dbQueryMock as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain("rotated_at = now()");
    expect((refreshTokenRepo.storeToken as ReturnType<typeof vi.fn>).mock.calls[0][4]).toBe("client:");
  });
});
