import { describe, it, expect, afterAll } from "vitest";
import { PG_TEST_URL, mkUser } from "./pg-fixtures.test.helpers.js";
import { query, closePool } from "../db.js";
import { refundWalletMusd } from "./wallet-repo.js";
import { reserveSessionBudget, recordSessionReservation, releaseSessionReservation, releaseOrphanedSessionReservations } from "./agentic-wallet-repo.js";
import { recordPayoutTx, listSubmittedPayouts, listStrandedPayouts } from "./payout-repo.js";

const wallet = async (u: string) => (await query<{ b: number; c: string }>(
  `SELECT balance_cents AS b, carry_musd::text AS c FROM wallets WHERE user_id = $1`, [u])).rows[0]!;

// Opt-in: runs only against a scratch database (see pg-fixtures.test.helpers.ts).
describe.skipIf(!PG_TEST_URL)("pre-launch audit fixes (PostgreSQL)", () => {
  afterAll(async () => { await closePool(); });

  it("refundWalletMusd refunds sub-cent payments exactly across calls", async () => {
    const u = await mkUser();
    // Default residential quote is 5,243 µUSD: two refunds = 10,486 µUSD.
    expect((await refundWalletMusd(u, 5_243n, "mpp", "mpp-refund:a", "t")).creditedCents).toBe(1);
    expect(await wallet(u)).toEqual({ b: 1, c: "4757" }); // 1 cent credited, 4,757 µUSD owed back
    expect((await refundWalletMusd(u, 5_243n, "mpp", "mpp-refund:b", "t")).creditedCents).toBe(1);
    expect(await wallet(u)).toEqual({ b: 2, c: "9514" }); // net 20,000 - 9,514 = 10,486 µUSD
    expect((await refundWalletMusd(u, 486n, "mpp", "mpp-refund:c", "t")).creditedCents).toBe(0);
    expect(await wallet(u)).toEqual({ b: 2, c: "9028" });
  });

  it("releaseSessionReservation returns the cents once and removes the row so the sweeper cannot repeat it", async () => {
    const u = await mkUser();
    const w = (await query<{ id: string }>(`INSERT INTO agentic_wallets (user_id, balance_cents) VALUES ($1, 200) RETURNING id`, [u])).rows[0]!.id;
    const s = (await query<{ id: string }>(`INSERT INTO sessions (user_id) VALUES ($1) RETURNING id`, [u])).rows[0]!.id;
    expect(await reserveSessionBudget(w, u, 50)).toBe(50);
    await recordSessionReservation(w, s, 50);
    await releaseSessionReservation(w, s, 50);
    await query(`UPDATE sessions SET status = 'error' WHERE id = $1`, [s]);
    expect(await releaseOrphanedSessionReservations(w)).toBe(0);
    const r = (await query<{ b: number; r: number }>(`SELECT balance_cents AS b, reserved_cents AS r FROM agentic_wallets WHERE id = $1`, [w])).rows[0];
    expect(r).toEqual({ b: 200, r: 0 });
  });

  it("recordPayoutTx persists the nonce; stranded rows are listed", async () => {
    const u = await mkUser();
    const mk = async (key: string) => (await query<{ id: string }>(
      `INSERT INTO node_payouts (user_id, idempotency_key, amount_musd, trigger, status, updated_at)
       VALUES ($1, $2, 1000000, 'auto', 'submitted', now() - interval '2 hours') RETURNING id`, [u, key])).rows[0]!.id;
    const a = await mk("prelaunch-a");
    const b = await mk("prelaunch-b");
    const hash = "0x" + "ef".repeat(32);
    expect(await recordPayoutTx(a, hash, 17)).toBe(true);
    expect((await listSubmittedPayouts()).find((x) => x.id === a)).toEqual({ id: a, txHash: hash, nonce: 17 });
    const stranded = (await listStrandedPayouts()).map((x) => x.id);
    expect(stranded).toContain(b);
    expect(stranded).not.toContain(a);
  });
});
