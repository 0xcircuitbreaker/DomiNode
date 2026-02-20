import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
vi.mock("../db.js", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

import {
  hashToken,
  newFamilyId,
  storeToken,
  findValidToken,
  findTokenByHash,
  revokeToken,
  revokeFamily,
  revokeAllForUser,
  purgeExpired,
} from "./refresh-token-repo.js";

describe("refresh-token-repo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("hashToken", () => {
    it("should produce a consistent SHA-256 hash", () => {
      const hash1 = hashToken("test-token-123");
      const hash2 = hashToken("test-token-123");
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 hex = 64 chars
    });

    it("should produce different hashes for different tokens", () => {
      const hash1 = hashToken("token-a");
      const hash2 = hashToken("token-b");
      expect(hash1).not.toBe(hash2);
    });
  });

  describe("newFamilyId", () => {
    it("should return a valid UUID", () => {
      const id = newFamilyId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it("should generate unique IDs", () => {
      const id1 = newFamilyId();
      const id2 = newFamilyId();
      expect(id1).not.toBe(id2);
    });
  });

  describe("storeToken", () => {
    it("should insert a token record without returning token_hash", async () => {
      const record = {
        id: "tok-1",
        user_id: "user-1",
        family_id: "fam-1",
        revoked: false,
        expires_at: new Date(),
        created_at: new Date(),
      };
      mockQuery.mockResolvedValue({ rows: [record] });

      const result = await storeToken("user-1", "hash-1", "fam-1", new Date());

      expect(result).toEqual(record);
      // R37 C-3: RETURNING clause must NOT include token_hash
      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain("INSERT INTO refresh_tokens");
      const returningClause = sql.split("RETURNING")[1];
      expect(returningClause).toBeDefined();
      expect(returningClause).not.toContain("token_hash");
    });
  });

  describe("findValidToken", () => {
    it("should return token if found", async () => {
      const record = { id: "tok-1", user_id: "user-1", revoked: false };
      mockQuery.mockResolvedValue({ rows: [record] });

      const result = await findValidToken("hash-1");
      expect(result).toEqual(record);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("NOT revoked AND expires_at > now()"),
        ["hash-1"],
      );
    });

    it("should return null if not found", async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      const result = await findValidToken("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("findTokenByHash", () => {
    it("should find token regardless of revocation", async () => {
      const record = { id: "tok-1", revoked: true };
      mockQuery.mockResolvedValue({ rows: [record] });

      const result = await findTokenByHash("hash-1");
      expect(result).toEqual(record);
      // Should NOT filter by revoked
      expect(mockQuery).toHaveBeenCalledWith(
        expect.not.stringContaining("NOT revoked"),
        ["hash-1"],
      );
    });
  });

  describe("revokeToken", () => {
    it("should set revoked=true for the token", async () => {
      mockQuery.mockResolvedValue({ rowCount: 1 });

      await revokeToken("hash-1");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("SET revoked = true"),
        ["hash-1"],
      );
    });
  });

  describe("revokeFamily", () => {
    it("should revoke all tokens in the family", async () => {
      mockQuery.mockResolvedValue({ rowCount: 3 });

      const count = await revokeFamily("fam-1");
      expect(count).toBe(3);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("family_id = $1"),
        ["fam-1"],
      );
    });

    it("should return 0 if no tokens in family", async () => {
      mockQuery.mockResolvedValue({ rowCount: 0 });
      const count = await revokeFamily("fam-empty");
      expect(count).toBe(0);
    });
  });

  describe("revokeAllForUser", () => {
    it("should revoke all tokens for the user", async () => {
      mockQuery.mockResolvedValue({ rowCount: 5 });

      const count = await revokeAllForUser("user-1");
      expect(count).toBe(5);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("user_id = $1"),
        ["user-1"],
      );
    });
  });

  describe("purgeExpired", () => {
    it("should delete expired tokens", async () => {
      mockQuery.mockResolvedValue({ rowCount: 10 });

      const count = await purgeExpired();
      expect(count).toBe(10);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("expires_at < now()"),
        [],
      );
    });
  });
});
