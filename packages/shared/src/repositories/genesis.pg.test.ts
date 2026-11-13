import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { PG_TEST_URL, mkUser, mkNode, mkCharge } from "./pg-fixtures.test.helpers.js";
import { query, closePool } from "../db.js";
import { enrol, listCreditCandidates, grantCredit } from "./genesis-repo.js";

async function paidTopup(userId: string, cents = 500): Promise<void> {
  await query(
    `INSERT INTO wallet_transactions (wallet_id, type, amount_cents, description, payment_provider)
     SELECT id, 'topup', $2, 'test', 'crypto' FROM wallets WHERE user_id = $1`, [userId, cents]);
}
const isMember = async (u: string) => (await query(`SELECT 1 FROM genesis_members WHERE owner_user_id = $1`, [u])).rows.length === 1;

// Opt-in: runs only against a scratch database (see pg-fixtures.test.helpers.ts).
describe.skipIf(!PG_TEST_URL)("genesis cohort against PostgreSQL", () => {
  beforeAll(async () => {
    await query(`DELETE FROM genesis_members`);
    await query(`INSERT INTO genesis_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    await query(`UPDATE genesis_settings SET enabled = true, max_owners = 200 WHERE id = 1`);
  });
  afterAll(async () => {
    await query(`DELETE FROM genesis_members`);
    await query(`UPDATE genesis_settings SET enabled = false WHERE id = 1`);
    await closePool();
  });

  it("is seeded disabled", async () => {
    const r = await query<{ d: string }>(
      `SELECT column_default AS d FROM information_schema.columns WHERE table_name = 'genesis_settings' AND column_name = 'enabled'`);
    expect(r.rows[0]!.d).toBe("false");
  });

  it("needs >= $1 of paid spend from each of 3 payers, then gates the credit on $10 of node earnings, not 5 GB", async () => {
    const owner = await mkUser();
    const node = await mkNode(owner, "203.0.113.10", "masked");
    const payers = [await mkUser(), await mkUser(), await mkUser()];
    // The farm: 5 GB of masked traffic ($0.10/GB) = $0.50 gross, 30% node share.
    for (const p of payers) {
      await mkCharge({ requester: p, node, owner, bytes: 1_700_000_000, grossMusd: 170_000, nodeMusd: 51_000 });
    }
    await enrol();
    expect(await isMember(owner)).toBe(false); // unpaid payers, each under $1
    for (const p of payers) await paidTopup(p);
    await enrol();
    expect(await isMember(owner)).toBe(false); // still under $1 each
    for (const p of payers) await mkCharge({ requester: p, node, owner, bytes: 1000, grossMusd: 830_000, nodeMusd: 249_000 });
    await enrol();
    expect(await isMember(owner)).toBe(true); // each payer now spent exactly $1.000000
    expect(await listCreditCandidates()).not.toContain(owner); // 5.1 GB but only $0.90 node earnings
    await mkCharge({ requester: payers[0]!, node, owner, bytes: 1000, grossMusd: 30_400_000, nodeMusd: 9_100_000 });
    expect(await listCreditCandidates()).toContain(owner); // exactly 10,000,000 µUSD
    await query(
      `INSERT INTO collusion_flags (kind, owner_user_id, node_id, share_bps, volume_musd, total_musd, window_days)
       VALUES ('concentration', $1, $2, 9000, 1, 1, 30)`, [owner, node]);
    expect(await grantCredit(owner)).toBe(false); // open collusion flag blocks the grant
  });

  it("gives one slot per beneficial owner (same egress /24)", async () => {
    const a = await mkUser();
    const b = await mkUser();
    // A fresh /24 per run, so owners left over from earlier runs never share it.
    const net = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const na = await mkNode(a, `${net}.10`);
    const nb = await mkNode(b, `${net}.20`);
    await query(`UPDATE nodes SET ip_prefix24 = $2::cidr WHERE id = ANY($1::uuid[])`, [[na, nb], `${net}.0/24`]);
    const payers = [await mkUser(), await mkUser(), await mkUser()];
    for (const p of payers) {
      await paidTopup(p);
      await mkCharge({ requester: p, node: na, owner: a, grossMusd: 1_000_000, daysAgo: 2 });
      await mkCharge({ requester: p, node: nb, owner: b, grossMusd: 1_000_000, daysAgo: 1 });
    }
    await enrol();
    expect(await isMember(a)).toBe(true);
    expect(await isMember(b)).toBe(false);
  });
});
