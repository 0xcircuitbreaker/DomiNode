import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockQuery = vi.fn();

vi.mock("../db.js", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

import {
  createUser,
  findUserByEmail,
  findUserById,
  findUserByApiKey,
  updatePassword,
  createApiKey,
  listApiKeys,
  countActiveKeys,
  revokeApiKey,
  findOrCreateX402User,
} from "./user-repo.js";
import { hashApiKeyV1, hashApiKeyV2, _setApiKeyPepperForTest } from "../api-key-hash.js";

describe("user-repo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── createUser ────────────────────────────────────────────────────

  describe("createUser", () => {
    it("should insert a user and return the row with password_hash redacted", async () => {
      const user = {
        id: "u1",
        email: "test@example.com",
        created_at: new Date(),
        status: "active",
        password_changed_at: null,
        wallet_address: null,
      };
      mockQuery.mockResolvedValueOnce({ rows: [user] });

      const result = await createUser("test@example.com", "hash123");
      expect(result).toEqual({ ...user, password_hash: "", wallet_address: null, log_target_hosts: false, email_verified: false });
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO users"),
        ["test@example.com", "hash123"],
      );
    });
  });

  // ─── findUserByEmail ──────────────────────────────────────────────

  describe("findUserByEmail", () => {
    it("should return user when found (password_hash redacted)", async () => {
      const user = {
        id: "u1",
        email: "test@example.com",
        password_hash: "hash123",
        created_at: new Date(),
        status: "active",
        password_changed_at: null,
      };
      mockQuery.mockResolvedValueOnce({ rows: [user] });

      const result = await findUserByEmail("test@example.com");
      // findUserByEmail now redacts password_hash
      expect(result).toEqual({
        ...user,
        password_hash: "",
        wallet_address: null,
        log_target_hosts: false,
        email_verified: false,
      });
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("SELECT id, email,"),
        ["test@example.com"],
      );
    });

    it("should return null when not found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await findUserByEmail("missing@example.com");
      expect(result).toBeNull();
    });
  });

  // ─── findUserByApiKey ─────────────────────────────────────────

  describe("findUserByApiKey", () => {
    it("should return user and apiKey when found", async () => {
      const row = {
        id: "u1",
        email: "test@example.com",
        password_hash: "hash123",
        created_at: new Date(),
        status: "active",
        password_changed_at: null,
        ak_id: "ak1",
        ak_key_hash: hashApiKeyV1("dn_live_k1"),
        ak_key_prefix: "dn_live_abc123",
        ak_label: "My Key",
        ak_created_at: new Date(),
        ak_revoked_at: null,
      };
      mockQuery.mockResolvedValueOnce({ rows: [row] });

      const result = await findUserByApiKey("dn_live_k1");
      expect(result).not.toBeNull();
      expect(result!.user.id).toBe("u1");
      expect(result!.user.email).toBe("test@example.com");
      expect(result!.apiKey.id).toBe("ak1");
      expect(result!.apiKey.key_hash).toBe("");
      expect(result!.apiKey.label).toBe("My Key");
    });

    describe("pepper (HMAC-SHA256 v2)", () => {
      const pepper = Buffer.alloc(32, 7);
      const raw = "dn_live_pq";
      const baseRow = { id: "u1", email: "a@b.c", created_at: new Date(), status: "active", password_changed_at: null, ak_id: "ak1", ak_key_prefix: "p", ak_label: "", ak_created_at: new Date(), ak_revoked_at: null };
      beforeEach(() => _setApiKeyPepperForTest(pepper));
      afterEach(() => _setApiKeyPepperForTest(undefined));

      it("looks up v2 then v1 in one query", async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });
        expect(await findUserByApiKey(raw)).toBeNull();
        expect(mockQuery.mock.calls[0][1]).toEqual([[hashApiKeyV2(raw, pepper), hashApiKeyV1(raw)]]);
      });

      it("migrates a v1 row to v2 on successful auth", async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ ...baseRow, ak_key_hash: hashApiKeyV1(raw) }] }).mockResolvedValueOnce({ rows: [] });
        const r = await findUserByApiKey(raw);
        expect(r!.user.id).toBe("u1");
        expect(mockQuery).toHaveBeenCalledTimes(2);
        expect(mockQuery.mock.calls[1][0]).toContain("UPDATE api_keys SET key_hash = $1");
        expect(mockQuery.mock.calls[1][1]).toEqual([hashApiKeyV2(raw, pepper), "ak1", hashApiKeyV1(raw)]);
      });

      it("does not rewrite a v2 row", async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ ...baseRow, ak_key_hash: hashApiKeyV2(raw, pepper) }] });
        expect(await findUserByApiKey(raw)).not.toBeNull();
        expect(mockQuery).toHaveBeenCalledTimes(1);
      });

      it("still authenticates when the migration write fails", async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ ...baseRow, ak_key_hash: hashApiKeyV1(raw) }] }).mockRejectedValueOnce(new Error("db"));
        expect(await findUserByApiKey(raw)).not.toBeNull();
      });

      it("rejects a row whose hash matches neither candidate", async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ ...baseRow, ak_key_hash: "f".repeat(64) }] });
        expect(await findUserByApiKey(raw)).toBeNull();
      });
    });

    it("should return null when no matching key", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await findUserByApiKey("nonexistent-hash");
      expect(result).toBeNull();
    });

    it("should correctly separate user and apiKey fields", async () => {
      const now = new Date();
      const row = {
        id: "user-id",
        email: "u@x.com",
        password_hash: "ph",
        created_at: now,
        status: "active" as const,
        password_changed_at: null,
        ak_id: "key-id",
        ak_key_hash: hashApiKeyV1("dn_live_k2"),
        ak_key_prefix: "pf",
        ak_label: "lbl",
        ak_created_at: now,
        ak_revoked_at: null,
      };
      mockQuery.mockResolvedValueOnce({ rows: [row] });

      const result = await findUserByApiKey("dn_live_k2");
      expect(result).not.toBeNull();
      // User should not contain ak_ fields
      expect(result!.user).toEqual({
        id: "user-id",
        email: "u@x.com",
        password_hash: "",
        created_at: now,
        status: "active",
        password_changed_at: null,
        is_admin: false,
        admin_role: "none",
        wallet_address: null,
        log_target_hosts: false,
        email_verified: false,
      });
      // ApiKey should have correct user_id
      expect(result!.apiKey.user_id).toBe("user-id");
    });
  });

  // ─── findUserById ──────────────────────────────────────────────────

  describe("findUserById", () => {
    it("should return user when found", async () => {
      const user = { id: "u1", email: "test@example.com" };
      mockQuery.mockResolvedValueOnce({ rows: [user] });

      const result = await findUserById("u1");
      expect(result).toEqual({ ...user, password_hash: "", wallet_address: null, log_target_hosts: false, email_verified: false });
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("SELECT id, email, created_at, status, password_changed_at, is_admin, admin_role, wallet_address, log_target_hosts, email_verified FROM users WHERE id = $1"),
        ["u1"],
      );
    });

    it("should return null when not found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await findUserById("missing");
      expect(result).toBeNull();
    });
  });

  // ─── updatePassword ───────────────────────────────────────────────

  describe("updatePassword", () => {
    it("should call UPDATE on users table setting password_hash and password_changed_at", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await updatePassword("u1", "new-hash-abc");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE users SET password_hash = $1, password_changed_at = now()"),
        ["new-hash-abc", "u1"],
      );
    });

    it("should pass passwordHash as $1 and userId as $2", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await updatePassword("user-xyz", "hashed-pw-123");
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain("WHERE id = $2");
      expect(params).toEqual(["hashed-pw-123", "user-xyz"]);
    });

    it("should return void (no return value)", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const result = await updatePassword("u1", "hash");
      expect(result).toBeUndefined();
    });

    it("should call query exactly once", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await updatePassword("u1", "hash");
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });
  });

  // ─── createApiKey ──────────────────────────────────────────────────

  describe("createApiKey", () => {
    it("should insert an API key and return it with key_hash redacted", async () => {
      const apiKey = { id: "ak1", user_id: "u1", key_prefix: "dn_live_", label: "My Key", team_id: null };
      mockQuery.mockResolvedValueOnce({ rows: [apiKey] });

      const result = await createApiKey("u1", "hash", "dn_live_", "My Key");
      expect(result).toEqual({ ...apiKey, key_hash: "" });
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO api_keys"),
        ["u1", "hash", "dn_live_", "My Key"],
      );
    });
  });

  // ─── listApiKeys ──────────────────────────────────────────────────

  describe("listApiKeys", () => {
    it("should return list of API keys", async () => {
      const keys = [
        { id: "ak1", user_id: "u1", key_prefix: "pf1", label: "Key 1" },
        { id: "ak2", user_id: "u1", key_prefix: "pf2", label: "Key 2" },
      ];
      mockQuery.mockResolvedValueOnce({ rows: keys });

      const result = await listApiKeys("u1");
      expect(result).toEqual(keys);
      expect(result.length).toBe(2);
    });

    it("should return empty array when no keys", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await listApiKeys("u-nokeys");
      expect(result).toEqual([]);
    });
  });

  // ─── countActiveKeys ──────────────────────────────────────────────

  describe("countActiveKeys", () => {
    it("should return the count of active keys", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: "3" }] });
      const result = await countActiveKeys("u1");
      expect(result).toBe(3);
    });

    it("should return 0 when no active keys", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
      const result = await countActiveKeys("u1");
      expect(result).toBe(0);
    });
  });

  // ─── revokeApiKey ──────────────────────────────────────────────────

  describe("revokeApiKey", () => {
    it("should return true when key was revoked", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      const result = await revokeApiKey("ak1", "u1");
      expect(result).toBe(true);
    });

    it("should return false when key not found or already revoked", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });
      const result = await revokeApiKey("ak-missing", "u1");
      expect(result).toBe(false);
    });

    it("should return false when rowCount is null", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: null });
      const result = await revokeApiKey("ak1", "u1");
      expect(result).toBe(false);
    });
  });

  describe("findOrCreateX402User", () => {
    const ADDR = "0x" + "AB".repeat(20);
    it("reuses an existing user bound to the payer address (lowercased)", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: "u1", status: "active" }] });
      expect(await findOrCreateX402User(ADDR)).toEqual({ id: "u1", status: "active", created: false });
      expect(mockQuery.mock.calls[0][1]).toEqual([ADDR.toLowerCase()]);
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });
    it("creates a wallet-identity user when none exists", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: "u2", status: "active" }] });
      expect(await findOrCreateX402User(ADDR)).toEqual({ id: "u2", status: "active", created: true });
      const [sql, params] = mockQuery.mock.calls[1];
      expect(sql).toMatch(/ON CONFLICT DO NOTHING/);
      expect(sql).not.toMatch(/RETURNING \*/);
      expect(params[0]).toBe(`${ADDR.toLowerCase()}@wallet.dominusnode.com`);
      expect(params[1]).toMatch(/^\$2[aby]\$/); // unusable bcrypt hash
      expect(params[2]).toBe(ADDR.toLowerCase());
    });
    it("collapses a concurrent create onto the winner", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: "u3", status: "active" }] });
      expect(await findOrCreateX402User(ADDR)).toEqual({ id: "u3", status: "active", created: false });
    });
    it("returns suspended status so callers can refuse", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: "u4", status: "suspended" }] });
      expect((await findOrCreateX402User(ADDR)).status).toBe("suspended");
    });
    it("rejects payers that are neither EVM nor Solana", async () => {
      await expect(findOrCreateX402User("So1anaAddr")).rejects.toThrow(/EVM/);
      await expect(findOrCreateX402User("0x" + "0".repeat(39))).rejects.toThrow(/EVM/);
      expect(mockQuery).not.toHaveBeenCalled();
    });
    const SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    it("reuses a Solana payer via payer_identities (case preserved, wallet_address untouched)", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: "s1", status: "active" }] });
      expect(await findOrCreateX402User(SOL)).toEqual({ id: "s1", status: "active", created: false });
      expect(mockQuery.mock.calls[0][0]).toMatch(/payer_identities/);
      expect(mockQuery.mock.calls[0][1]).toEqual([SOL]);
    });
    it("creates user + identity atomically in one statement, never setting wallet_address", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: "s2", status: "active" }] });
      expect(await findOrCreateX402User(SOL)).toEqual({ id: "s2", status: "active", created: true });
      const [sql, params] = mockQuery.mock.calls[1];
      expect(sql).toMatch(/INSERT INTO users[\s\S]*INSERT INTO payer_identities/);
      expect(sql).not.toMatch(/wallet_address/);
      expect(params[0]).toMatch(/^sol-[0-9a-f]{40}@wallet\.dominusnode\.com$/);
      expect(params[2]).toBe(SOL);
    });
    it("collapses a concurrent Solana create onto the winner", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: "s3", status: "suspended" }] });
      expect(await findOrCreateX402User(SOL)).toEqual({ id: "s3", status: "suspended", created: false });
    });
  });
});
