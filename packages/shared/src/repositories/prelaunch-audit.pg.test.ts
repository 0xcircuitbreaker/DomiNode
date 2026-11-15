import crypto from "node:crypto";
import { describe, it, expect, afterAll } from "vitest";
import { PG_TEST_URL, mkUser } from "./pg-fixtures.test.helpers.js";
import { query, closePool } from "../db.js";
import { refundWalletMusd } from "./wallet-repo.js";
import { reserveSessionBudget, recordSessionReservation, releaseSessionReservation, releaseOrphanedSessionReservations } from "./agentic-wallet-repo.js";
import { recordPayoutTx, listSubmittedPayouts, listStrandedPayouts } from "./payout-repo.js";
import { deleteUser } from "./admin-repo.js";
import * as owedFundsRepo from "./owed-funds-repo.js";
import { withTx } from "./node-credit-repo.js";
import { countActiveUsers, findOrCreateX402User } from "./user-repo.js";
import { createTeam, createTeamApiKey, reserveTeamBalance, settleTeamSession, releaseTeamReservation } from "./team-repo.js";
import { releaseReservation } from "./wallet-repo.js";

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

  it("erases two users who each hold two rows per rail, team + team key + two invoices", async () => {
    const mkPaid = async () => {
      const u = await mkUser({ balanceCents: 100 });
      const w = (await query<{ id: string }>(`SELECT id FROM wallets WHERE user_id = $1`, [u])).rows[0]!.id;
      for (const [prov, pid] of [["nowpayments", "np-1"], ["nowpayments", "np-2"], ["x402", "x-1"], ["x402", "x-2"], ["node_credits", null], ["node_credits", null]] as const) {
        await query(
          `INSERT INTO wallet_transactions (wallet_id, type, amount_cents, description, payment_provider, payment_id)
           VALUES ($1, 'topup', 1, 't', $2, $3)`, [w, prov, pid === null ? null : `${pid}-${u}`]);
      }
      for (const ext of ["inv-a", "inv-b"]) {
        await query(
          `INSERT INTO payment_invoices (user_id, provider, external_id, amount_cents, status)
           VALUES ($1, 'nowpayments', $2, 100, 'pending')`, [u, `${ext}-${u}`]);
      }
      const team = await createTeam(u, `t-${u.slice(0, 8)}`);
      await createTeamApiKey(team.id, u, crypto.randomBytes(32).toString("hex"), "dn_live_abcd", "k");
      return u;
    };
    const a = await mkPaid();
    const b = await mkPaid();
    await deleteUser(a);
    await deleteUser(b);
    for (const u of [a, b]) {
      const r = (await query<{ status: string; w: string | null }>(`SELECT status, wallet_address AS w FROM users WHERE id = $1`, [u])).rows[0]!;
      expect(r).toEqual({ status: "deleted", w: null });
      const nulls = (await query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM wallet_transactions t JOIN wallets w ON w.id = t.wallet_id
          WHERE w.user_id = $1 AND t.payment_provider = 'node_credits' AND t.payment_id IS NULL`, [u])).rows[0]!.n;
      expect(nulls).toBe("2");
      expect((await query(`SELECT id FROM teams WHERE owner_id = $1`, [u])).rows).toHaveLength(0);
    }
  });

  it("team ledger reconciles with the balance across refund, exact and overage settlements", async () => {
    const u = await mkUser();
    const team = await createTeam(u, `ledger-${u.slice(0, 8)}`);
    await query(`UPDATE team_wallets SET balance_cents = 1000 WHERE team_id = $1`, [team.id]);
    const sid = () => crypto.randomUUID();
    for (const [reserve, actual] of [[50, 1], [50, 50], [50, 70], [50, 0]] as const) {
      expect(await reserveTeamBalance(team.id, reserve)).toBeTruthy();
      expect(await settleTeamSession(team.id, reserve, actual, sid())).toBe(true);
    }
    const bal = (await query<{ b: number }>(`SELECT balance_cents AS b FROM team_wallets WHERE team_id = $1`, [team.id])).rows[0]!.b;
    expect(bal).toBe(1000 - 1 - 50 - 70);
    const net = (await query<{ n: string }>(
      `SELECT COALESCE(SUM(CASE WHEN type = 'debit' THEN -amount_cents ELSE amount_cents END), 0)::text AS n
         FROM team_wallet_transactions t JOIN team_wallets w ON w.id = t.wallet_id WHERE w.team_id = $1`, [team.id])).rows[0]!.n;
    expect(Number(net)).toBe(bal - 1000);
  });

  it("releasing a reservation into a capped wallet credits to the cap and records the rest as owed", async () => {
    const u = await mkUser({ balanceCents: 999_990 });
    await releaseReservation(u, 50);
    expect((await wallet(u)).b).toBe(1_000_000);
    const owed = (await query<{ c: number }>(`SELECT amount_cents AS c FROM wallet_overflow_credits WHERE user_id = $1`, [u])).rows;
    expect(owed).toEqual([{ c: 40 }]);
    const team = await createTeam(u, `cap-${u.slice(0, 8)}`);
    await query(`UPDATE team_wallets SET balance_cents = 1000000 WHERE team_id = $1`, [team.id]);
    await releaseTeamReservation(team.id, 30);
    const towed = (await query<{ c: number }>(`SELECT amount_cents AS c FROM wallet_overflow_credits WHERE team_id = $1`, [team.id])).rows;
    expect(towed).toEqual([{ c: 30 }]);
  });

  it("x402/MPP payer identities do not consume registration slots", async () => {
    const before = await countActiveUsers();
    const r = await findOrCreateX402User(`0x${crypto.randomBytes(20).toString("hex")}`);
    expect(r.created).toBe(true);
    expect(await countActiveUsers()).toBe(before);
    await mkUser();
    expect(await countActiveUsers()).toBe(before + 1);
  });

  it("owed-funds reconciliation lists open rows of all four ledgers and resolves them once", async () => {
    const u = await mkUser();
    const ov = (await query<{ id: string }>(`INSERT INTO wallet_overflow_credits (user_id, amount_cents, reason) VALUES ($1, 12, 't') RETURNING id::text AS id`, [u])).rows[0]!.id;
    const pr = (await query<{ id: string }>(
      `INSERT INTO payer_refunds_owed (payer_address, rail, pay_hash, amount_musd, reason) VALUES ('So1ana', 'x402', $1, 5243, 't') RETURNING id::text AS id`,
      [crypto.randomBytes(16).toString("hex")])).rows[0]!.id;
    const mp = (await query<{ id: string }>(
      `INSERT INTO mpp_transactions (payment_hash, user_id, amount_musd, status) VALUES ($1, $2, 5243, 'refund_due') RETURNING id::text AS id`,
      [crypto.randomBytes(32).toString("hex"), u])).rows[0]!.id;
    const tp = (await query<{ id: string }>(
      `INSERT INTO tempo_payments (tx_hash, charge_id, amount_units, status) VALUES ($1, 'c1', 5000000, 'unmatched') RETURNING id::text AS id`,
      ["0x" + crypto.randomBytes(32).toString("hex")])).rows[0]!.id;
    const s = await owedFundsRepo.summary();
    expect(s.totalOpen).toBeGreaterThanOrEqual(4);
    for (const [src, id] of [["overflow", ov], ["payer_refund", pr], ["mpp", mp], ["tempo", tp]] as const) {
      expect((await owedFundsRepo.listOpen(src)).map((r) => r.id)).toContain(id);
      const res = owedFundsRepo.OWED_RESOLUTIONS[src][0]!;
      expect(await withTx((c) => owedFundsRepo.resolveTx(c, src, id, res))).toBe(true);
      expect(await withTx((c) => owedFundsRepo.resolveTx(c, src, id, res))).toBe(false);
      expect((await owedFundsRepo.listOpen(src)).map((r) => r.id)).not.toContain(id);
    }
  });
});
