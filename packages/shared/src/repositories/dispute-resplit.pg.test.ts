import { describe, it, expect, afterAll } from "vitest";
import { PG_TEST_URL, mkUser, mkNode, mkCharge } from "./pg-fixtures.test.helpers.js";
import { query, closePool, getPool } from "../db.js";
import { resplitAtNodeBytesTx } from "./dispute-resolution-repo.js";

// Opt-in: runs only against a scratch database (see pg-fixtures.test.helpers.ts).
describe.skipIf(!PG_TEST_URL)("resolved_node re-split against PostgreSQL", () => {
  afterAll(async () => { await closePool(); });

  it("re-splits at the node count, claws back the node difference and refunds the requester", async () => {
    const owner = await mkUser();
    const admin = await mkUser();
    const requester = await mkUser({ balanceCents: 100 });
    const node = await mkNode(owner, "198.18.0.10");
    // 100,000,000 gateway bytes at $0.50/GB = 50,000 µUSD gross, 12,500 node share (25%).
    const charge = await mkCharge({ requester, node, owner, bytes: 100_000_000, grossMusd: 50_000, nodeMusd: 12_500, matured: false, disputed: true });
    await query(`UPDATE relay_charges SET bytes_node = 40000000 WHERE id = $1`, [charge]);
    await query(`INSERT INTO node_credit_accounts (user_id, pending_musd) VALUES ($1, 12500) ON CONFLICT (user_id) DO UPDATE SET pending_musd = 12500`, [owner]);
    const c = await getPool().connect();
    let r;
    try {
      await c.query("BEGIN");
      r = await resplitAtNodeBytesTx(c, charge, admin);
      await c.query("COMMIT");
    } finally { c.release(); }
    // 40% of the bytes: gross 20,000, node 5,000, platform 15,000.
    expect(r).toEqual({ adjusted: true, grossBeforeMusd: 50_000n, grossAfterMusd: 20_000n, nodeClawbackMusd: 7_500n, refundCents: 3, overflowCents: 0, unrefundedMusd: 0n, starterRestoredMusd: 0n, starterForfeitMusd: 0n });
    const rc = (await query<{ g: string; n: string; p: string }>(
      `SELECT gross_musd::text AS g, node_musd::text AS n, platform_musd::text AS p FROM relay_charges WHERE id = $1`, [charge])).rows[0]!;
    expect(rc).toEqual({ g: "20000", n: "5000", p: "15000" });
    const acct = (await query<{ p: string }>(`SELECT pending_musd::text AS p FROM node_credit_accounts WHERE user_id = $1`, [owner])).rows[0]!;
    expect(acct.p).toBe("5000");
    const bal = (await query<{ b: number }>(`SELECT balance_cents AS b FROM wallets WHERE user_id = $1`, [requester])).rows[0]!;
    expect(bal.b).toBe(103); // 30,000 µUSD back = 3 whole cents
  });

  async function starterCase(grantStatus: "active" | "expired") {
    const owner = await mkUser();
    const admin = await mkUser();
    const requester = await mkUser({ balanceCents: 100 });
    const node = await mkNode(owner, "198.18.0.11");
    // Grant of $1.00 with 960,000 µUSD left; this charge drew 40,000 of its 50,000 µUSD gross from it.
    const g = (await query<{ id: string }>(
      `INSERT INTO starter_credit_grants (user_id, amount_musd, remaining_musd, funding_source, status, expires_at)
       VALUES ($1, 1000000, 960000, 'test', $2, now() + interval '1 day') RETURNING id`, [requester, grantStatus])).rows[0]!.id;
    const charge = await mkCharge({ requester, node, owner, bytes: 100_000_000, grossMusd: 50_000, nodeMusd: 12_500, matured: false, disputed: true, starterMusd: 40_000 });
    await query(`UPDATE relay_charges SET bytes_node = 40000000 WHERE id = $1`, [charge]);
    const c = await getPool().connect();
    let r;
    try {
      await c.query("BEGIN");
      r = await resplitAtNodeBytesTx(c, charge, admin);
      await c.query("COMMIT");
    } finally { c.release(); }
    const grant = (await query<{ rem: string }>(`SELECT remaining_musd::text AS rem FROM starter_credit_grants WHERE id = $1`, [g])).rows[0]!;
    const bal = (await query<{ b: number }>(`SELECT balance_cents AS b FROM wallets WHERE user_id = $1`, [requester])).rows[0]!;
    const st = (await query<{ s: string }>(`SELECT starter_musd::text AS s FROM relay_charges WHERE id = $1`, [charge])).rows[0]!;
    return { r: r!, grant: grant.rem, bal: bal.b, starter: st.s };
  }

  it("returns the starter-funded share of the refund to an open grant (still locked), not as free balance", async () => {
    const x = await starterCase("active");
    // Gross 50,000 -> 20,000: 30,000 back, of which 40,000 * 30,000 / 50,000 = 24,000 was starter.
    expect(x.r).toMatchObject({ refundCents: 3, starterRestoredMusd: 24_000n, starterForfeitMusd: 0n });
    expect(x.grant).toBe("984000");
    expect(x.starter).toBe("16000");
    expect(x.bal).toBe(103); // the 3 cents are back, but 2.4 of them are locked starter cents again
  });

  it("drops the starter share when the grant is closed and refunds only the paid part", async () => {
    const x = await starterCase("expired");
    // 30,000 - 24,000 starter = 6,000 µUSD paid -> 0 whole cents.
    expect(x.r).toMatchObject({ refundCents: 0, starterRestoredMusd: 0n, starterForfeitMusd: 24_000n });
    expect(x.grant).toBe("960000");
    expect(x.bal).toBe(100);
  });
});
