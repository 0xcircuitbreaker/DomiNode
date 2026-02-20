import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import http from "http";

// ─── Mocks ──────────────────────────────────────────────────────────

vi.mock("@dominusnode/shared", () => ({
  hashPassword: vi.fn().mockResolvedValue("$2b$10$unusable-hashed-password"),
  userRepo: {
    findUserByWalletAddress: vi.fn(),
    createWalletUser: vi.fn(),
    linkWalletAddress: vi.fn(),
    findUserById: vi.fn(),
    countActiveUsers: vi.fn().mockResolvedValue(0),
  },
  walletRepo: { createWallet: vi.fn() },
  walletChallengeRepo: {
    createChallenge: vi.fn(),
    consumeChallenge: vi.fn(),
    countActiveChallengesForIp: vi.fn(),
    purgeExpiredChallenges: vi.fn(),
  },
  refreshTokenRepo: {
    newFamilyId: vi.fn(() => "fam-1"),
    hashToken: vi.fn(() => "hashed-rt"),
    storeToken: vi.fn(),
  },
  waitlistRepo: {
    markRegistered: vi.fn().mockResolvedValue(false),
  },
  createTokenPair: vi.fn().mockReturnValue({
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
  }),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  sanitizeString: (s: string, max: number) => s.trim().slice(0, max),
  isValidEvmAddress: (addr: string) => /^0x[0-9a-fA-F]{40}$/.test(addr),
  generateWalletNonce: vi.fn().mockReturnValue("a".repeat(64)),
  buildSignMessage: vi.fn().mockReturnValue("test sign message"),
  walletToSyntheticEmail: (addr: string) => `${addr.toLowerCase()}@wallet.dominusnode.com`,
  isWalletEmail: (email: string) => email.endsWith("@wallet.dominusnode.com"),
}));

vi.mock("../helpers/verify-signature.js", () => ({
  recoverSignerAddress: vi.fn(),
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => {
    (_req as any).user = { userId: "u1", email: "test@example.com", isAdmin: false };
    next();
  },
}));

vi.mock("../helpers/cookies.js", () => ({
  setAuthCookies: vi.fn(),
  clearAuthCookies: vi.fn(),
  getRefreshCookieName: () => "dominusnode_refresh",
}));

import {
  userRepo,
  walletChallengeRepo,
  walletRepo,
  refreshTokenRepo,
} from "@dominusnode/shared";
import { recoverSignerAddress } from "../helpers/verify-signature.js";
import walletAuthRoutes from "./wallet-auth.js";

const VALID_ADDRESS = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const VALID_SIGNATURE = "0x" + "a".repeat(128) + "1b";

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/auth/wallet", walletAuthRoutes);
  return app;
}

function request(
  app: express.Express,
  method: string,
  path: string,
  body?: Record<string, unknown>,
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

describe("wallet-auth routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(walletChallengeRepo.countActiveChallengesForIp).mockResolvedValue(0);
  });

  // ─── POST /challenge ──────────────────────────────────────────────

  describe("POST /challenge", () => {
    it("should issue a challenge for a valid address", async () => {
      vi.mocked(walletChallengeRepo.createChallenge).mockResolvedValue({
        id: "ch-1",
        address: VALID_ADDRESS,
        nonce: "a".repeat(64),

        created_at: new Date(),
        consumed: false,
      });

      const app = createApp();
      const res = await request(app, "POST", "/api/auth/wallet/challenge", {
        address: VALID_ADDRESS,
      });

      expect(res.status).toBe(200);
      expect(res.body.message).toBeDefined();
      expect(res.body.nonce).toBeDefined();
    });

    it("should reject invalid address", async () => {
      const app = createApp();
      const res = await request(app, "POST", "/api/auth/wallet/challenge", {
        address: "not-an-address",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid Ethereum address");
    });

    it("should reject when DB active challenges exceed limit", async () => {
      vi.mocked(walletChallengeRepo.countActiveChallengesForIp).mockResolvedValue(5);

      const app = createApp();
      const res = await request(app, "POST", "/api/auth/wallet/challenge", {
        address: VALID_ADDRESS,
      });

      expect(res.status).toBe(429);
    });
  });

  // ─── POST /verify ─────────────────────────────────────────────────

  describe("POST /verify", () => {
    it("should create a new user for a new wallet", async () => {
      const now = new Date();
      vi.mocked(walletChallengeRepo.consumeChallenge).mockResolvedValue({
        id: "ch-1",
        address: VALID_ADDRESS,
        nonce: "abc",

        created_at: now,
        consumed: true,
      });
      vi.mocked(recoverSignerAddress).mockReturnValue(VALID_ADDRESS);
      vi.mocked(userRepo.findUserByWalletAddress).mockResolvedValue(null);
      vi.mocked(userRepo.createWalletUser).mockResolvedValue({
        id: "u-new",
        email: `${VALID_ADDRESS}@wallet.dominusnode.com`,
        status: "active",
        is_admin: false,
        wallet_address: VALID_ADDRESS,
        created_at: now,
        password_hash: "",
        password_changed_at: null,
      } as any);
      vi.mocked(walletRepo.createWallet).mockResolvedValue({} as any);
      vi.mocked(refreshTokenRepo.storeToken).mockResolvedValue({} as any);

      const app = createApp();
      const res = await request(app, "POST", "/api/auth/wallet/verify", {
        address: VALID_ADDRESS,
        signature: VALID_SIGNATURE,
      });

      expect(res.status).toBe(201);
      expect(res.body.token).toBe("test-access-token");
      expect((res.body.user as any).isNewUser).toBe(true);
      expect((res.body.user as any).wallet_address).toBe(VALID_ADDRESS);
    });

    it("should login existing wallet user", async () => {
      const now = new Date();
      vi.mocked(walletChallengeRepo.consumeChallenge).mockResolvedValue({
        id: "ch-1",
        address: VALID_ADDRESS,
        nonce: "abc",

        created_at: now,
        consumed: true,
      });
      vi.mocked(recoverSignerAddress).mockReturnValue(VALID_ADDRESS);
      vi.mocked(userRepo.findUserByWalletAddress).mockResolvedValue({
        id: "u-existing",
        email: `${VALID_ADDRESS}@wallet.dominusnode.com`,
        status: "active",
        is_admin: false,
        wallet_address: VALID_ADDRESS,
        created_at: now,
        password_hash: "",
        password_changed_at: null,
      } as any);
      vi.mocked(refreshTokenRepo.storeToken).mockResolvedValue({} as any);

      const app = createApp();
      const res = await request(app, "POST", "/api/auth/wallet/verify", {
        address: VALID_ADDRESS,
        signature: VALID_SIGNATURE,
      });

      expect(res.status).toBe(200);
      expect((res.body.user as any).isNewUser).toBe(false);
    });

    it("should reject when no challenge exists", async () => {
      vi.mocked(walletChallengeRepo.consumeChallenge).mockResolvedValue(null);

      const app = createApp();
      const res = await request(app, "POST", "/api/auth/wallet/verify", {
        address: VALID_ADDRESS,
        signature: VALID_SIGNATURE,
      });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain("No valid challenge");
    });

    it("should reject invalid signature", async () => {
      vi.mocked(walletChallengeRepo.consumeChallenge).mockResolvedValue({
        id: "ch-1",
        address: VALID_ADDRESS,
        nonce: "abc",

        created_at: new Date(),
        consumed: true,
      });
      vi.mocked(recoverSignerAddress).mockReturnValue("0x0000000000000000000000000000000000000000");

      const app = createApp();
      const res = await request(app, "POST", "/api/auth/wallet/verify", {
        address: VALID_ADDRESS,
        signature: VALID_SIGNATURE,
      });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain("Signature verification failed");
    });

    it("should reject short signature", async () => {
      const app = createApp();
      const res = await request(app, "POST", "/api/auth/wallet/verify", {
        address: VALID_ADDRESS,
        signature: "0xshort",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid signature");
    });

    it("should reject suspended wallet user", async () => {
      const now = new Date();
      vi.mocked(walletChallengeRepo.consumeChallenge).mockResolvedValue({
        id: "ch-1",
        address: VALID_ADDRESS,
        nonce: "abc",

        created_at: now,
        consumed: true,
      });
      vi.mocked(recoverSignerAddress).mockReturnValue(VALID_ADDRESS);
      vi.mocked(userRepo.findUserByWalletAddress).mockResolvedValue({
        id: "u-suspended",
        email: `${VALID_ADDRESS}@wallet.dominusnode.com`,
        status: "suspended",
        is_admin: false,
        wallet_address: VALID_ADDRESS,
        created_at: now,
        password_hash: "",
        password_changed_at: null,
      } as any);

      const app = createApp();
      const res = await request(app, "POST", "/api/auth/wallet/verify", {
        address: VALID_ADDRESS,
        signature: VALID_SIGNATURE,
      });

      expect(res.status).toBe(403);
    });

    // NOTE: Rate limit test must be LAST in this describe block because
    // it exhausts the in-memory rate limiter for the test IP (127.0.0.1)
    it("should rate limit /verify endpoint (R18 H-1)", async () => {
      // consumeChallenge returns null so each request fails fast after rate limit check
      vi.mocked(walletChallengeRepo.consumeChallenge).mockResolvedValue(null);

      const app = createApp();
      // Send enough requests to exhaust the limit (10 per 5 min).
      // Previous tests in this describe block may have already consumed some allowance.
      const results: number[] = [];
      for (let i = 0; i < 20; i++) {
        const res = await request(app, "POST", "/api/auth/wallet/verify", {
          address: VALID_ADDRESS,
          signature: VALID_SIGNATURE,
        });
        results.push(res.status);
      }
      // At least one should be 429 (rate limited)
      expect(results).toContain(429);
    });
  });

  // ─── POST /link ───────────────────────────────────────────────────

  describe("POST /link", () => {
    it("should link wallet to existing account", async () => {
      const now = new Date();
      vi.mocked(userRepo.findUserByWalletAddress).mockResolvedValue(null);
      vi.mocked(walletChallengeRepo.consumeChallenge).mockResolvedValue({
        id: "ch-1",
        address: VALID_ADDRESS,
        nonce: "abc",

        created_at: now,
        consumed: true,
      });
      vi.mocked(recoverSignerAddress).mockReturnValue(VALID_ADDRESS);
      vi.mocked(userRepo.linkWalletAddress).mockResolvedValue(true);

      const app = createApp();
      const res = await request(app, "POST", "/api/auth/wallet/link", {
        address: VALID_ADDRESS,
        signature: VALID_SIGNATURE,
      });

      expect(res.status).toBe(200);
      expect(res.body.linked).toBe(true);
      expect(res.body.wallet_address).toBe(VALID_ADDRESS);
    });

    it("should reject if wallet already linked to another account", async () => {
      vi.mocked(userRepo.findUserByWalletAddress).mockResolvedValue({
        id: "u-other",
        wallet_address: VALID_ADDRESS,
      } as any);

      const app = createApp();
      const res = await request(app, "POST", "/api/auth/wallet/link", {
        address: VALID_ADDRESS,
        signature: VALID_SIGNATURE,
      });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain("already linked");
    });

    it("should reject if account already has a wallet", async () => {
      const now = new Date();
      vi.mocked(userRepo.findUserByWalletAddress).mockResolvedValue(null);
      vi.mocked(walletChallengeRepo.consumeChallenge).mockResolvedValue({
        id: "ch-1",
        address: VALID_ADDRESS,
        nonce: "abc",

        created_at: now,
        consumed: true,
      });
      vi.mocked(recoverSignerAddress).mockReturnValue(VALID_ADDRESS);
      vi.mocked(userRepo.linkWalletAddress).mockResolvedValue(false);

      const app = createApp();
      const res = await request(app, "POST", "/api/auth/wallet/link", {
        address: VALID_ADDRESS,
        signature: VALID_SIGNATURE,
      });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain("already has a wallet");
    });
  });
});
