import { describe, it, expect, afterAll } from "vitest";
import { PG_TEST_URL, mkUser } from "./pg-fixtures.test.helpers.js";
import { query, closePool, getPool } from "../db.js";
import {
  reserveSessionBudget, recordSessionReservation, releaseOrphanedSessionReservations, settleSessionTx, deleteWallet,
} from "./agentic-wallet-repo.js";

async function mkAgentic(userId: string, balance: number, daily: number | null = null): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO agentic_wallets (user_id, balance_cents, daily_limit_cents) VALUES ($1, $2, $3) RETURNING id`, [userId, balance, daily]);
  return r.rows[0]!.id;
}
const row = async (id: string) => (await query<{ b: number; r: number }>(
  `SELECT balance_cents AS b, reserved_cents AS r FROM agentic_wallets WHERE id = $1`, [id])).rows[0]!;
const mkSession = async (u: string) => (await query<{ id: string }>(`INSERT INTO sessions (user_id) VALUES ($1) RETURNING id`, [u])).rows[0]!.id;

// Opt-in: runs only against a scratch database (see pg-fixtures.test.helpers.ts).
describe.skipIf(!PG_TEST_URL)("agentic reservations of sessions that never settle", () => {
  afterAll(async () => { await closePool(); });

  it("returns a crashed session's reservation, keeps an active one and restores the daily room", async () => {
    const u = await mkUser();
    const w = await mkAgentic(u, 500, 100);
    const crashed = await mkSession(u);
    const live = await mkSession(u);
    expect(await reserveSessionBudget(w, u, 60)).toBe(60);
    await recordSessionReservation(w, crashed, 60);
    expect(await reserveSessionBudget(w, u, 60)).toBe(40);
    await recordSessionReservation(w, live, 40);
    expect(await row(w)).toEqual({ b: 400, r: 100 });
    // Gateway restart: cleanupOrphanedSessions marks the crashed session 'error'.
    await query(`UPDATE sessions SET status = 'error', ended_at = now() WHERE id = $1`, [crashed]);
    expect(await releaseOrphanedSessionReservations(w)).toBe(60);
    expect(await row(w)).toEqual({ b: 460, r: 40 });
    expect(await releaseOrphanedSessionReservations(w)).toBe(0); // once
    // Daily room: 100 - 0 spent - 40 in flight = 60 (it stayed 0 before the fix).
    expect(await reserveSessionBudget(w, u, 100)).toBe(60);
  });

  it("does not release a session with a pending settle retry, and settlement removes the row", async () => {
    const u = await mkUser();
    const w = await mkAgentic(u, 200);
    const s = await mkSession(u);
    expect(await reserveSessionBudget(w, u, 50)).toBe(50);
    await recordSessionReservation(w, s, 50);
    await query(`UPDATE sessions SET status = 'error' WHERE id = $1`, [s]);
    await query(
      `INSERT INTO relay_settle_retries (session_id, requester_user_id, bytes_gateway, bytes_in, bytes_out, payload) VALUES ($1, $2, 0, 0, 0, '{}')`, [s, u]);
    expect(await releaseOrphanedSessionReservations(w)).toBe(0);
    const c = await getPool().connect();
    try {
      await c.query("BEGIN");
      expect(await settleSessionTx(c, w, 50, 120_000n, s)).toEqual({ debitCents: 12, paidInFull: true });
      await c.query("COMMIT");
    } finally { c.release(); }
    await query(`UPDATE relay_settle_retries SET status = 'done' WHERE session_id = $1`, [s]);
    expect(await releaseOrphanedSessionReservations(w)).toBe(0); // no double return
    expect(await row(w)).toEqual({ b: 188, r: 0 });
  });

  it("deleteWallet refunds a leftover reservation instead of refusing forever, but refuses while a session is active", async () => {
    const u = await mkUser();
    const w = await mkAgentic(u, 300);
    const s = await mkSession(u);
    expect(await reserveSessionBudget(w, u, 70)).toBe(70);
    await recordSessionReservation(w, s, 70);
    await expect(deleteWallet(w, u)).rejects.toThrow(/in progress/);
    await query(`UPDATE sessions SET status = 'error' WHERE id = $1`, [s]);
    expect(await deleteWallet(w, u)).toEqual({ refundedCents: 300 });
  });
});
