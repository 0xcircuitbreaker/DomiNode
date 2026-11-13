import { describe, it, expect, afterAll, beforeEach } from "vitest";
import crypto from "node:crypto";
import { PG_TEST_URL, mkUser } from "./pg-fixtures.js";
import { query, closePool } from "../db.js";
import { redeemReferralCode } from "./referral-repo.js";

async function mkCode(userId: string): Promise<string> {
  const hash = crypto.randomBytes(32).toString("hex");
  await query(`INSERT INTO referral_codes (user_id, code_hash, code_prefix, max_uses, credit_cents) VALUES ($1, $2, 'ABCD', 0, 100)`, [userId, hash]);
  return hash;
}
const balance = async (u: string) => Number((await query<{ b: number }>(`SELECT balance_cents AS b FROM wallets WHERE user_id = $1`, [u])).rows[0]!.b);

// Opt-in: runs only against a scratch database (see pg-fixtures.ts).
describe.skipIf(!PG_TEST_URL)("referral redemption mints no balance", () => {
  afterAll(async () => {
    await query(`UPDATE referral_settings SET redemption_enabled = false WHERE id = 1`);
    await closePool();
  });
  beforeEach(async () => { await query(`UPDATE referral_settings SET redemption_enabled = false WHERE id = 1`); });

  it("is disabled by default: no redemption row and no credit", async () => {
    const referrer = await mkUser();
    const hash = await mkCode(referrer);
    const referee = await mkUser();
    expect(await redeemReferralCode(hash, referee)).toBeNull();
    expect(await balance(referee)).toBe(0);
    expect(await balance(referrer)).toBe(0);
    const n = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM referral_redemptions WHERE referee_id = $1`, [referee]);
    expect(n.rows[0]!.n).toBe("0");
  });

  it("when enabled, records the referral with 0 credit and moves no money", async () => {
    await query(`UPDATE referral_settings SET redemption_enabled = true WHERE id = 1`);
    const referrer = await mkUser();
    const hash = await mkCode(referrer);
    const referee = await mkUser();
    const r = await redeemReferralCode(hash, referee);
    expect(r?.redemption.credit_cents).toBe(0);
    expect(await balance(referee)).toBe(0);
    expect(await balance(referrer)).toBe(0);
    const tx = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM wallet_transactions wt JOIN wallets w ON w.id = wt.wallet_id WHERE w.user_id = ANY($1::uuid[])`,
      [[referrer, referee]]);
    expect(tx.rows[0]!.n).toBe("0");
  });
});
