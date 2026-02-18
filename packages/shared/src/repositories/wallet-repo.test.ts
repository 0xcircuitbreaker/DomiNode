import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the database module before importing wallet-repo
const mockQuery = vi.fn();
const mockClientQuery = vi.fn();
const mockClientRelease = vi.fn();
const mockConnect = vi.fn();

vi.mock("../db.js", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  getPool: () => ({
    connect: () => mockConnect(),
  }),
}));

import {
  creditWallet,
  debitWallet,
  reserveBalance,
  settleSession,
  releaseReservation,
  createWallet,
  getWallet,
  getBalance,
  getTransactions,
} from "./wallet-repo.js";

describe("wallet-repo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue({
      query: mockClientQuery,
      release: mockClientRelease,
    });
  });

  // ─── createWallet ──────────────────────────────────────────────────

  describe("createWallet", () => {
    it("should create a wallet and return it", async () => {
      const wallet = { id: "w1", user_id: "u1", balance_cents: 0, currency: "USD", last_topped_up: null };
      mockQuery.mockResolvedValueOnce({ rows: [wallet] });

      const result = await createWallet("u1");
      expect(result).toEqual(wallet);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO wallets"),
        ["u1"],
      );
    });

    it("should pass the correct SQL query", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: "w2" }] });
      await createWallet("u2");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("RETURNING *"),
        ["u2"],
      );
    });
  });

  // ─── getWallet ─────────────────────────────────────────────────────

  describe("getWallet", () => {
    it("should return the wallet if it exists", async () => {
      const wallet = { id: "w1", user_id: "u1", balance_cents: 1000 };
      mockQuery.mockResolvedValueOnce({ rows: [wallet] });

      const result = await getWallet("u1");
      expect(result).toEqual(wallet);
    });

    it("should return null if no wallet found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await getWallet("u-missing");
      expect(result).toBeNull();
    });

    it("should query by user_id", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await getWallet("user-abc");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("WHERE user_id = $1"),
        ["user-abc"],
      );
    });
  });

  // ─── getBalance ────────────────────────────────────────────────────

  describe("getBalance", () => {
    it("should return balance_cents", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ balance_cents: 5000 }] });

      const result = await getBalance("u1");
      expect(result).toBe(5000);
    });

    it("should return 0 if no wallet found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await getBalance("u-missing");
      expect(result).toBe(0);
    });

    it("should handle zero balance explicitly", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ balance_cents: 0 }] });

      const result = await getBalance("u-zero");
      expect(result).toBe(0);
    });
  });

  // ─── creditWallet ──────────────────────────────────────────────────

  describe("creditWallet", () => {
    it("should credit wallet within a transaction", async () => {
      const walletRow = { id: "w1", user_id: "u1", balance_cents: 5000 };
      const txRow = { id: "tx1", wallet_id: "w1", type: "topup", amount_cents: 1000 };

      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // SET LOCAL lock_timeout
        .mockResolvedValueOnce({ rows: [walletRow] }) // SELECT FOR UPDATE (balance check)
        .mockResolvedValueOnce({ rows: [walletRow] }) // UPDATE wallets RETURNING
        .mockResolvedValueOnce({ rows: [txRow] }) // INSERT wallet_transactions
        .mockResolvedValueOnce({}); // COMMIT

      const result = await creditWallet("u1", 1000, "stripe", "pay_123", "Top-up $10");
      expect(result).toEqual(txRow);
      expect(mockClientQuery).toHaveBeenCalledWith("BEGIN");
      expect(mockClientQuery).toHaveBeenCalledWith("SET LOCAL lock_timeout = '5s'");
      expect(mockClientQuery).toHaveBeenCalledWith("COMMIT");
      expect(mockClientRelease).toHaveBeenCalled();
    });

    it("should throw if amount is zero or negative", async () => {
      await expect(creditWallet("u1", 0, "stripe", "pay_123", "desc")).rejects.toThrow(
        "Credit amount must be a positive integer within valid range",
      );
      await expect(creditWallet("u1", -100, "stripe", "pay_123", "desc")).rejects.toThrow(
        "Credit amount must be a positive integer within valid range",
      );
    });

    it("should throw and rollback if no wallet found", async () => {
      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // SET LOCAL lock_timeout
        .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE returns nothing
        .mockResolvedValueOnce({}); // ROLLBACK

      await expect(
        creditWallet("u-missing", 1000, "stripe", "pay_123", "desc"),
      ).rejects.toThrow("No wallet found for user u-missing");
      expect(mockClientQuery).toHaveBeenCalledWith("ROLLBACK");
      expect(mockClientRelease).toHaveBeenCalled();
    });

    it("should rollback and release client on unexpected error", async () => {
      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // SET LOCAL lock_timeout
        .mockRejectedValueOnce(new Error("connection failed")); // SELECT FOR UPDATE throws

      await expect(
        creditWallet("u1", 1000, "stripe", "pay_123", "desc"),
      ).rejects.toThrow("connection failed");
      expect(mockClientQuery).toHaveBeenCalledWith("ROLLBACK");
      expect(mockClientRelease).toHaveBeenCalled();
    });

    it("should pass correct parameters to INSERT wallet_transactions", async () => {
      const walletRow = { id: "w-test", user_id: "u1", balance_cents: 1000 };
      const txRow = { id: "tx1" };

      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // SET LOCAL lock_timeout
        .mockResolvedValueOnce({ rows: [walletRow] }) // SELECT FOR UPDATE (balance check)
        .mockResolvedValueOnce({ rows: [walletRow] }) // UPDATE wallets RETURNING
        .mockResolvedValueOnce({ rows: [txRow] }) // INSERT wallet_transactions
        .mockResolvedValueOnce({}); // COMMIT

      await creditWallet("u1", 500, "nowpayments", "pay_abc", "Crypto top-up");
      // The INSERT call is the 5th call (index 4) due to lock_timeout + balance check
      const insertCall = mockClientQuery.mock.calls[4];
      expect(insertCall[0]).toContain("INSERT INTO wallet_transactions");
      expect(insertCall[1]).toEqual(["w-test", 500, "Crypto top-up", "nowpayments", "pay_abc"]);
    });

    it("should reject credit that would exceed max balance", async () => {
      const walletRow = { id: "w1", user_id: "u1", balance_cents: 999_500 };

      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // SET LOCAL lock_timeout
        .mockResolvedValueOnce({ rows: [walletRow] }) // SELECT FOR UPDATE (balance=999500)
        .mockResolvedValueOnce({}); // ROLLBACK

      await expect(
        creditWallet("u1", 1000, "stripe", "pay_123", "Top-up $10"),
      ).rejects.toThrow("exceed maximum wallet balance");
      expect(mockClientQuery).toHaveBeenCalledWith("ROLLBACK");
      expect(mockClientRelease).toHaveBeenCalled();
    });
  });

  // ─── debitWallet ───────────────────────────────────────────────────

  describe("debitWallet", () => {
    it("should debit wallet and return the transaction", async () => {
      const wallet = { id: "w1", user_id: "u1", balance_cents: 5000 };
      const txRow = { id: "tx2", wallet_id: "w1", type: "debit", amount_cents: 100 };

      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // SET LOCAL lock_timeout
        .mockResolvedValueOnce({ rows: [wallet] }) // SELECT FOR UPDATE
        .mockResolvedValueOnce({}) // UPDATE balance
        .mockResolvedValueOnce({ rows: [txRow] }) // INSERT tx
        .mockResolvedValueOnce({}); // COMMIT

      const result = await debitWallet("u1", 100, "Proxy usage");
      expect(result).toEqual(txRow);
    });

    it("should return null if amount is zero or negative", async () => {
      const result = await debitWallet("u1", 0, "desc");
      expect(result).toBeNull();
    });

    it("should return null for negative amount", async () => {
      const result = await debitWallet("u1", -50, "desc");
      expect(result).toBeNull();
    });

    it("should return null if insufficient balance", async () => {
      const wallet = { id: "w1", user_id: "u1", balance_cents: 50 };

      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // SET LOCAL lock_timeout
        .mockResolvedValueOnce({ rows: [wallet] }) // SELECT FOR UPDATE
        .mockResolvedValueOnce({}); // ROLLBACK

      const result = await debitWallet("u1", 100, "Proxy usage");
      expect(result).toBeNull();
    });

    it("should return null if no wallet found", async () => {
      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // SET LOCAL lock_timeout
        .mockResolvedValueOnce({ rows: [] }) // SELECT returns nothing
        .mockResolvedValueOnce({}); // ROLLBACK

      const result = await debitWallet("u-missing", 100, "desc");
      expect(result).toBeNull();
    });

    it("should rollback and release client on error", async () => {
      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockRejectedValueOnce(new Error("lock timeout"));

      await expect(debitWallet("u1", 100, "desc")).rejects.toThrow("lock timeout");
      expect(mockClientQuery).toHaveBeenCalledWith("ROLLBACK");
      expect(mockClientRelease).toHaveBeenCalled();
    });

    it("should debit exact balance leaving 0", async () => {
      const wallet = { id: "w1", user_id: "u1", balance_cents: 100 };
      const txRow = { id: "tx3", wallet_id: "w1", type: "debit", amount_cents: 100 };

      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // SET LOCAL lock_timeout
        .mockResolvedValueOnce({ rows: [wallet] }) // SELECT FOR UPDATE
        .mockResolvedValueOnce({}) // UPDATE balance
        .mockResolvedValueOnce({ rows: [txRow] }) // INSERT tx
        .mockResolvedValueOnce({}); // COMMIT

      const result = await debitWallet("u1", 100, "Full debit");
      expect(result).toEqual(txRow);
    });

    it("should use FOR UPDATE lock", async () => {
      const wallet = { id: "w1", user_id: "u1", balance_cents: 5000 };
      const txRow = { id: "tx1" };

      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // SET LOCAL lock_timeout
        .mockResolvedValueOnce({ rows: [wallet] }) // SELECT FOR UPDATE
        .mockResolvedValueOnce({}) // UPDATE
        .mockResolvedValueOnce({ rows: [txRow] }) // INSERT
        .mockResolvedValueOnce({}); // COMMIT

      await debitWallet("u1", 100, "desc");
      const selectCall = mockClientQuery.mock.calls[2]; // index shifted by 1 due to lock_timeout
      expect(selectCall[0]).toContain("FOR UPDATE");
    });
  });

  // ─── reserveBalance ────────────────────────────────────────────────

  describe("reserveBalance", () => {
    it("should reserve and return wallet ID on success", async () => {
      const wallet = { id: "w1", user_id: "u1", balance_cents: 5000 };

      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // SET LOCAL lock_timeout
        .mockResolvedValueOnce({ rows: [wallet] }) // SELECT FOR UPDATE
        .mockResolvedValueOnce({}) // UPDATE balance
        .mockResolvedValueOnce({}) // INSERT wallet_transactions (reservation hold)
        .mockResolvedValueOnce({}); // COMMIT

      const result = await reserveBalance("u1", 10);
      expect(result).toBe("w1");
    });

    it("should return null if amount is zero or negative", async () => {
      expect(await reserveBalance("u1", 0)).toBeNull();
      expect(await reserveBalance("u1", -5)).toBeNull();
    });

    it("should return null if insufficient balance", async () => {
      const wallet = { id: "w1", user_id: "u1", balance_cents: 5 };

      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // SET LOCAL lock_timeout
        .mockResolvedValueOnce({ rows: [wallet] }) // SELECT FOR UPDATE
        .mockResolvedValueOnce({}); // ROLLBACK

      const result = await reserveBalance("u1", 10);
      expect(result).toBeNull();
    });

    it("should return null if no wallet found", async () => {
      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // SET LOCAL lock_timeout
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({}); // ROLLBACK

      const result = await reserveBalance("u-none", 10);
      expect(result).toBeNull();
    });

    it("should rollback and release on error", async () => {
      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockRejectedValueOnce(new Error("DB error"));

      await expect(reserveBalance("u1", 10)).rejects.toThrow("DB error");
      expect(mockClientQuery).toHaveBeenCalledWith("ROLLBACK");
      expect(mockClientRelease).toHaveBeenCalled();
    });
  });

  // ─── settleSession ─────────────────────────────────────────────────

  describe("settleSession", () => {
    it("should settle when actual cost equals reserved", async () => {
      const wallet = { id: "w1", user_id: "u1", balance_cents: 5000 };

      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // SET LOCAL lock_timeout
        .mockResolvedValueOnce({ rows: [wallet] }) // SELECT FOR UPDATE
        // diff = 0, reservation matched actual — no additional transaction needed
        .mockResolvedValueOnce({}); // COMMIT

      const result = await settleSession("u1", 100, 100, "sess-12345678");
      expect(result).toBe(true);
    });

    it("should refund excess when actual < reserved", async () => {
      const wallet = { id: "w1", user_id: "u1", balance_cents: 5000 };

      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // SET LOCAL lock_timeout
        .mockResolvedValueOnce({ rows: [wallet] }) // SELECT FOR UPDATE
        .mockResolvedValueOnce({}) // UPDATE balance (refund diff)
        .mockResolvedValueOnce({}) // INSERT tx
        .mockResolvedValueOnce({}); // COMMIT

      const result = await settleSession("u1", 100, 50, "sess-12345678");
      expect(result).toBe(true);
    });

    it("should charge extra when actual > reserved and balance allows", async () => {
      const wallet = { id: "w1", user_id: "u1", balance_cents: 5000 };

      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // SET LOCAL lock_timeout
        .mockResolvedValueOnce({ rows: [wallet] }) // SELECT FOR UPDATE
        .mockResolvedValueOnce({}) // UPDATE balance (debit diff)
        .mockResolvedValueOnce({}) // INSERT tx
        .mockResolvedValueOnce({}); // COMMIT

      const result = await settleSession("u1", 100, 200, "sess-12345678");
      expect(result).toBe(true);
    });

    it("should return false if no wallet found", async () => {
      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // SET LOCAL lock_timeout
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({}); // ROLLBACK

      const result = await settleSession("u-none", 100, 50, "sess-123");
      expect(result).toBe(false);
    });

    it("should return false for partial payment when balance insufficient for overage", async () => {
      const wallet = { id: "w1", user_id: "u1", balance_cents: 20 };

      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // SET LOCAL lock_timeout
        .mockResolvedValueOnce({ rows: [wallet] }) // SELECT FOR UPDATE (balance=20)
        // diff = 200 - 100 = 100, wallet has 20 < 100
        .mockResolvedValueOnce({}) // UPDATE wallets SET balance_cents = 0
        .mockResolvedValueOnce({}) // INSERT tx for charged amount
        .mockResolvedValueOnce({}); // COMMIT

      const result = await settleSession("u1", 100, 200, "sess-12345678");
      expect(result).toBe(false);
    });

    it("should refund full reservation when actualCostCents is 0", async () => {
      const wallet = { id: "w1", user_id: "u1", balance_cents: 5000 };

      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // SET LOCAL lock_timeout
        .mockResolvedValueOnce({ rows: [wallet] }) // SELECT FOR UPDATE
        // diff = 0 - 100 = -100, refund 100
        .mockResolvedValueOnce({}) // UPDATE balance (refund +100)
        .mockResolvedValueOnce({}) // INSERT topup tx (reservation refund)
        .mockResolvedValueOnce({}); // COMMIT

      const result = await settleSession("u1", 100, 0, "sess-zero-cost");
      expect(result).toBe(true);

      // Verify refund INSERT was called
      const calls = mockClientQuery.mock.calls.map((c) => String(c[0]));
      const insertCalls = calls.filter((c) => c.includes("INSERT INTO wallet_transactions"));
      expect(insertCalls.length).toBe(1);
    });

    it("should rollback and release on unexpected error", async () => {
      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockRejectedValueOnce(new Error("deadlock detected"));

      await expect(
        settleSession("u1", 100, 50, "sess-err"),
      ).rejects.toThrow("deadlock detected");
      expect(mockClientQuery).toHaveBeenCalledWith("ROLLBACK");
      expect(mockClientRelease).toHaveBeenCalled();
    });

    it("should handle partial payment with zero wallet balance", async () => {
      const wallet = { id: "w1", user_id: "u1", balance_cents: 0 };

      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // SET LOCAL lock_timeout
        .mockResolvedValueOnce({ rows: [wallet] }) // SELECT FOR UPDATE (balance=0)
        // diff = 50 - 10 = 40, wallet has 0 < 40 => partial
        .mockResolvedValueOnce({}) // UPDATE wallets SET balance_cents = 0 (already 0)
        // additional = 0, so no INSERT (nothing extra charged)
        .mockResolvedValueOnce({}); // COMMIT

      const result = await settleSession("u1", 10, 50, "sess-partial-zero");
      expect(result).toBe(false);
    });

    it("should record correct debit description with session ID prefix", async () => {
      const wallet = { id: "w1", user_id: "u1", balance_cents: 5000 };

      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // SET LOCAL lock_timeout
        .mockResolvedValueOnce({ rows: [wallet] }) // SELECT FOR UPDATE
        .mockResolvedValueOnce({}) // UPDATE balance (debit diff=100)
        .mockResolvedValueOnce({}) // INSERT settlement tx
        .mockResolvedValueOnce({}); // COMMIT

      // Use actual > reserved so diff > 0 triggers an INSERT
      await settleSession("u1", 100, 200, "sess-abcdefgh-1234");

      // Find the INSERT call
      const insertCall = mockClientQuery.mock.calls.find(
        (c) => String(c[0]).includes("INSERT INTO wallet_transactions"),
      );
      expect(insertCall).toBeDefined();
      // The params array has [walletId, amountCents, description]
      // Description should contain first 8 chars of session ID: "sess-abc"
      const description = insertCall![1][2];
      expect(description).toContain("sess-abc");
    });
  });

  // ─── releaseReservation ────────────────────────────────────────────

  describe("releaseReservation", () => {
    it("should release reserved amount back to wallet", async () => {
      const wallet = { id: "w1", user_id: "u1", balance_cents: 1100 };

      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // SET LOCAL lock_timeout
        .mockResolvedValueOnce({ rows: [wallet] }) // SELECT FOR UPDATE (R13 H-1)
        .mockResolvedValueOnce({}) // UPDATE wallets SET balance_cents + $1
        .mockResolvedValueOnce({}) // INSERT wallet_transactions (reservation released)
        .mockResolvedValueOnce({}); // COMMIT

      await releaseReservation("u1", 100);
      expect(mockClientQuery).toHaveBeenCalledWith("BEGIN");
      expect(mockClientQuery).toHaveBeenCalledWith(
        expect.stringContaining("FOR UPDATE"),
        ["u1"],
      );
      expect(mockClientQuery).toHaveBeenCalledWith(
        expect.stringContaining("balance_cents + $1"),
        [100, "w1"],
      );
      expect(mockClientQuery).toHaveBeenCalledWith("COMMIT");
      expect(mockClientRelease).toHaveBeenCalled();
    });

    it("should be a no-op if amount is zero", async () => {
      await releaseReservation("u1", 0);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it("should be a no-op if amount is negative", async () => {
      await releaseReservation("u1", -10);
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  // ─── getTransactions ────────────────────────────────────────────────

  describe("getTransactions", () => {
    it("should return transactions for a user", async () => {
      const txns = [
        { id: "tx1", wallet_id: "w1", type: "topup", amount_cents: 1000 },
        { id: "tx2", wallet_id: "w1", type: "debit", amount_cents: 50 },
      ];
      mockQuery.mockResolvedValueOnce({ rows: txns });

      const result = await getTransactions("u1");
      expect(result).toEqual(txns);
      expect(result.length).toBe(2);
    });

    it("should use default limit of 50 and offset of 0", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await getTransactions("u1");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("LIMIT $2 OFFSET $3"),
        ["u1", 50, 0],
      );
    });

    it("should accept custom limit and offset", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await getTransactions("u1", 10, 20);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("LIMIT $2 OFFSET $3"),
        ["u1", 10, 20],
      );
    });

    it("should return empty array when no transactions", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await getTransactions("u-no-txns");
      expect(result).toEqual([]);
    });

    it("should order by created_at DESC", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await getTransactions("u1");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("ORDER BY wt.created_at DESC"),
        expect.any(Array),
      );
    });

    it("should join wallets table to filter by user_id", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await getTransactions("u1");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("JOIN wallets w ON w.id = wt.wallet_id"),
        expect.any(Array),
      );
    });
  });
});
