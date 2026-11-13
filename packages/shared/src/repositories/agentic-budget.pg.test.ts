import { describe, it, expect, afterAll } from "vitest";
import { PG_TEST_URL, mkUser } from "./pg-fixtures.test.helpers.js";
import { query, closePool, getPool } from "../db.js";
import { reserveSessionBudget, releaseSessionBudget, settleSessionTx } from "./agentic-wallet-repo.js";

async function mkAgentic(userId: string, o: { balance: number; spending?: number; daily?: number | null }): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO agentic_wallets (user_id, balance_cents, spending_limit_cents, daily_limit_cents) VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, o.balance, o.spending ?? 0, o.daily ?? null]);
  return r.rows[0]!.id;
}
const row = async (id: string) => (await query<{ b: number; r: number; c: string }>(
  `SELECT balance_cents AS b, reserved_cents AS r, carry_musd::text AS c FROM agentic_wallets WHERE id = $1`, [id])).rows[0]!;
async function settle(walletId: string, userId: string, reserved: number, grossMusd: bigint) {
  const s = await query<{ id: string }>(`INSERT INTO sessions (user_id) VALUES ($1) RETURNING id`, [userId]);
  const c = await getPool().connect();
  try {
    await c.query("BEGIN");
    const r = await settleSessionTx(c, walletId, reserved, grossMusd, s.rows[0]!.id);
    await c.query("COMMIT");
    return r;
  } finally { c.release(); }
}

// Opt-in: runs only against a scratch database (see pg-fixtures.test.helpers.ts).
describe.skipIf(!PG_TEST_URL)("agentic wallet relay budget against PostgreSQL", () => {
  afterAll(async () => { await closePool(); });

  it("caps reservations by the daily budget including in-flight sessions, and bills spend to the wallet", async () => {
    const u = await mkUser();
    const w = await mkAgentic(u, { balance: 500, daily: 100 });
    expect(await reserveSessionBudget(w, u, 80)).toBe(80);
    expect(await reserveSessionBudget(w, u, 80)).toBe(20); // 100 - 80 in flight
    expect(await reserveSessionBudget(w, u, 80)).toBe(0);
    expect(await row(w)).toEqual({ b: 400, r: 100, c: "0" });
    // Session 1 used 333,333 µUSD: 33 cents debited, 3,333 µUSD carried, 47 cents back.
    expect(await settle(w, u, 80, 333_333n)).toEqual({ debitCents: 33, paidInFull: true });
    expect(await row(w)).toEqual({ b: 447, r: 20, c: "3333" });
    const spent = await query<{ s: string }>(`SELECT SUM(amount_cents)::text AS s FROM agentic_wallet_transactions WHERE wallet_id = $1 AND type = 'spend'`, [w]);
    expect(spent.rows[0]!.s).toBe("33");
    // Daily room now 100 - 33 spent - 20 in flight = 47.
    expect(await reserveSessionBudget(w, u, 100)).toBe(47);
    await releaseSessionBudget(w, 47);
    expect(await row(w)).toEqual({ b: 447, r: 20, c: "3333" });
  });

  it("caps each session at the per-session spending limit and the balance", async () => {
    const u = await mkUser();
    const w = await mkAgentic(u, { balance: 15, spending: 10 });
    expect(await reserveSessionBudget(w, u, 80)).toBe(10);
    expect(await reserveSessionBudget(w, u, 80)).toBe(5);
    expect(await reserveSessionBudget(w, u, 80)).toBe(0);
  });

  it("refuses another user's or a frozen wallet", async () => {
    const u = await mkUser();
    const w = await mkAgentic(u, { balance: 100 });
    expect(await reserveSessionBudget(w, await mkUser(), 10)).toBe(0);
    await query(`UPDATE agentic_wallets SET status = 'frozen' WHERE id = $1`, [w]);
    expect(await reserveSessionBudget(w, u, 10)).toBe(0);
  });
});
