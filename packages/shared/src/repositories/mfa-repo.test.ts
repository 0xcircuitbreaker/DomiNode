import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
const mockClientQuery = vi.fn();
const mockClientRelease = vi.fn();
const mockPoolConnect = vi.fn().mockResolvedValue({
  query: mockClientQuery,
  release: mockClientRelease,
});

vi.mock("../db.js", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  getPool: () => ({ connect: mockPoolConnect }),
}));

import {
  createMfaConfig,
  findMfaConfigByUserId,
  enableMfa,
  disableMfa,
  deleteMfaConfig,
  storeBackupCodes,
  deleteAllBackupCodes,
  countUnusedBackupCodes,
} from "./mfa-repo.js";

describe("mfa-repo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-setup pool connect mock (clearAllMocks resets it)
    mockPoolConnect.mockResolvedValue({
      query: mockClientQuery,
      release: mockClientRelease,
    });
  });

  // ─── createMfaConfig ───────────────────────────────────────────────

  describe("createMfaConfig", () => {
    it("should call query with INSERT ... ON CONFLICT and return the config", async () => {
      const config = {
        id: "mfa1",
        user_id: "user1",
        totp_secret_enc: "encrypted-secret",
        totp_secret_iv: "iv-value",
        enabled: false,
        created_at: new Date(),
        enabled_at: null,
      };
      mockQuery.mockResolvedValueOnce({ rows: [config] });

      const result = await createMfaConfig("user1", "encrypted-secret", "iv-value");
      expect(result).toEqual(config);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO mfa_configs"),
        ["user1", "encrypted-secret", "iv-value"],
      );
    });

    it("should use ON CONFLICT for upsert behavior", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: "mfa1" }] });

      await createMfaConfig("user1", "enc", "iv");
      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain("ON CONFLICT");
      expect(sql).toContain("DO UPDATE SET");
    });

    it("should pass correct parameters in order", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: "mfa1" }] });

      await createMfaConfig("u-abc", "enc-xyz", "iv-123");
      const [, params] = mockQuery.mock.calls[0];
      expect(params).toEqual(["u-abc", "enc-xyz", "iv-123"]);
    });
  });

  // ─── findMfaConfigByUserId ─────────────────────────────────────────

  describe("findMfaConfigByUserId", () => {
    it("should return the config when found", async () => {
      const config = {
        id: "mfa1",
        user_id: "user1",
        totp_secret_enc: "enc",
        totp_secret_iv: "iv",
        enabled: true,
        created_at: new Date(),
        enabled_at: new Date(),
      };
      mockQuery.mockResolvedValueOnce({ rows: [config] });

      const result = await findMfaConfigByUserId("user1");
      expect(result).toEqual(config);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("SELECT id, user_id, totp_secret_enc, totp_secret_iv, enabled, created_at, enabled_at FROM mfa_configs WHERE user_id = $1"),
        ["user1"],
      );
    });

    it("should return null when not found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await findMfaConfigByUserId("nonexistent");
      expect(result).toBeNull();
    });
  });

  // ─── enableMfa ─────────────────────────────────────────────────────

  describe("enableMfa", () => {
    it("should update the enabled flag and enabled_at timestamp", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await enableMfa("user1");
      expect(mockQuery).toHaveBeenCalledTimes(1);
      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain("UPDATE mfa_configs");
      expect(sql).toContain("enabled = true");
      expect(sql).toContain("enabled_at = now()");
      expect(mockQuery).toHaveBeenCalledWith(expect.any(String), ["user1"]);
    });
  });

  // ─── disableMfa ────────────────────────────────────────────────────

  describe("disableMfa", () => {
    it("should delete the MFA config record", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await disableMfa("user1");
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM mfa_configs WHERE user_id = $1"),
        ["user1"],
      );
    });
  });

  // ─── deleteMfaConfig ──────────────────────────────────────────────

  describe("deleteMfaConfig", () => {
    it("should delete both the MFA config and all backup codes in a transaction", async () => {
      mockClientQuery.mockResolvedValue({ rowCount: 1 });

      await deleteMfaConfig("user1");
      // BEGIN + DELETE mfa_configs + DELETE mfa_backup_codes + COMMIT = 4 calls
      expect(mockClientQuery).toHaveBeenCalledTimes(4);
      expect(mockClientQuery).toHaveBeenNthCalledWith(1, "BEGIN");
      expect(mockClientQuery).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining("DELETE FROM mfa_configs WHERE user_id = $1"),
        ["user1"],
      );
      expect(mockClientQuery).toHaveBeenNthCalledWith(
        3,
        expect.stringContaining("DELETE FROM mfa_backup_codes WHERE user_id = $1"),
        ["user1"],
      );
      expect(mockClientQuery).toHaveBeenNthCalledWith(4, "COMMIT");
      expect(mockClientRelease).toHaveBeenCalledTimes(1);
    });
  });

  // ─── storeBackupCodes ─────────────────────────────────────────────

  describe("storeBackupCodes", () => {
    it("should delete old codes then insert new ones in a transaction", async () => {
      const hashes = ["hash1", "hash2", "hash3"];
      mockClientQuery.mockResolvedValue({ rowCount: 1 });

      await storeBackupCodes("user1", hashes);

      // BEGIN + DELETE + 3 INSERTs + COMMIT = 6 calls total
      expect(mockClientQuery).toHaveBeenCalledTimes(6);
      expect(mockClientQuery).toHaveBeenNthCalledWith(1, "BEGIN");
      expect(mockClientQuery).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining("DELETE FROM mfa_backup_codes WHERE user_id = $1"),
        ["user1"],
      );
      expect(mockClientQuery).toHaveBeenNthCalledWith(
        3,
        expect.stringContaining("INSERT INTO mfa_backup_codes"),
        ["user1", "hash1"],
      );
      expect(mockClientQuery).toHaveBeenNthCalledWith(
        4,
        expect.stringContaining("INSERT INTO mfa_backup_codes"),
        ["user1", "hash2"],
      );
      expect(mockClientQuery).toHaveBeenNthCalledWith(
        5,
        expect.stringContaining("INSERT INTO mfa_backup_codes"),
        ["user1", "hash3"],
      );
      expect(mockClientQuery).toHaveBeenNthCalledWith(6, "COMMIT");
      expect(mockClientRelease).toHaveBeenCalledTimes(1);
    });

    // Bounded backup codes
    it("should reject more than 20 backup codes", async () => {
      const tooMany = Array.from({ length: 21 }, (_, i) => `hash-${i}`);
      await expect(storeBackupCodes("user1", tooMany)).rejects.toThrow(
        "Cannot store more than 20 backup codes",
      );
    });

    it("should only delete when hashes array is empty", async () => {
      mockClientQuery.mockResolvedValue({ rowCount: 0 });

      await storeBackupCodes("user1", []);
      // BEGIN + DELETE + COMMIT = 3 calls
      expect(mockClientQuery).toHaveBeenCalledTimes(3);
      expect(mockClientQuery).toHaveBeenNthCalledWith(1, "BEGIN");
      expect(mockClientQuery).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining("DELETE FROM mfa_backup_codes"),
        ["user1"],
      );
      expect(mockClientQuery).toHaveBeenNthCalledWith(3, "COMMIT");
      expect(mockClientRelease).toHaveBeenCalledTimes(1);
    });
  });

  // ─── deleteAllBackupCodes ─────────────────────────────────────────

  describe("deleteAllBackupCodes", () => {
    it("should delete all backup codes for the user", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 10 });

      await deleteAllBackupCodes("user1");
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM mfa_backup_codes WHERE user_id = $1"),
        ["user1"],
      );
    });
  });

  // ─── countUnusedBackupCodes ───────────────────────────────────────

  describe("countUnusedBackupCodes", () => {
    it("should return the count of unused backup codes", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: 7 }] });

      const result = await countUnusedBackupCodes("user1");
      expect(result).toBe(7);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("COUNT(*)"),
        ["user1"],
      );
    });

    it("should return 0 when no unused codes remain", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: 0 }] });

      const result = await countUnusedBackupCodes("user1");
      expect(result).toBe(0);
    });

    it("should query only for codes with used_at IS NULL", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: 3 }] });

      await countUnusedBackupCodes("user1");
      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain("used_at IS NULL");
    });
  });
});
