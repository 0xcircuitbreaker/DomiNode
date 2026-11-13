import { describe, it, expect, afterAll } from "vitest";
import { PG_TEST_URL, mkUser, mkNode, mkCharge } from "./pg-fixtures.js";
import { query, closePool, getPool } from "../db.js";
import { resplitAtNodeBytesTx } from "./dispute-resolution-repo.js";

// Opt-in: runs only against a scratch database (see pg-fixtures.ts).
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
    expect(r).toEqual({ adjusted: true, grossBeforeMusd: 50_000n, grossAfterMusd: 20_000n, nodeClawbackMusd: 7_500n, refundCents: 3, overflowCents: 0, unrefundedMusd: 0n });
    const rc = (await query<{ g: string; n: string; p: string }>(
      `SELECT gross_musd::text AS g, node_musd::text AS n, platform_musd::text AS p FROM relay_charges WHERE id = $1`, [charge])).rows[0]!;
    expect(rc).toEqual({ g: "20000", n: "5000", p: "15000" });
    const acct = (await query<{ p: string }>(`SELECT pending_musd::text AS p FROM node_credit_accounts WHERE user_id = $1`, [owner])).rows[0]!;
    expect(acct.p).toBe("5000");
    const bal = (await query<{ b: number }>(`SELECT balance_cents AS b FROM wallets WHERE user_id = $1`, [requester])).rows[0]!;
    expect(bal.b).toBe(103); // 30,000 µUSD back = 3 whole cents
  });
});
