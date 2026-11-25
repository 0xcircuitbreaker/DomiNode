import { describe, it, expect, afterAll } from "vitest";
import { PG_TEST_URL, mkUser } from "./pg-fixtures.test.helpers.js";
import { query, closePool } from "../db.js";
import { createProxyToken, reserveSessionBudget, settleSessionBudget, revokeProxyToken, findEndedTokenIds } from "./proxy-token-repo.js";

const used = async (id: string) => (await query<{ b: string; s: string }>(
  `SELECT bytes_used::text AS b, spend_used_musd::text AS s FROM proxy_tokens WHERE id = $1`, [id])).rows[0]!;

// Opt-in: runs only against a scratch database (see pg-fixtures.test.helpers.ts).
describe.skipIf(!PG_TEST_URL)("proxy token session budgets against PostgreSQL", () => {
  afterAll(async () => { await closePool(); });

  it("concurrent reservations near the byte cap never grant more than the cap", async () => {
    const u = await mkUser();
    const t = (await createProxyToken(u, { maxBytes: 10_000n }))!.record;
    await query(`UPDATE proxy_tokens SET bytes_used = 7000 WHERE id = $1`, [t.id]);
    const grants = await Promise.all(Array.from({ length: 12 }, () => reserveSessionBudget(t.id, 1_000n, 500_000n)));
    const ok = grants.filter((g) => g !== null);
    expect(ok.reduce((a, g) => a + g!.bytes, 0n)).toBe(3_000n);
    expect(ok.length).toBe(3);
    expect((await used(t.id)).b).toBe("10000");
    // settling returns what was not used
    await settleSessionBudget(t.id, ok[0]!, 200n, 1n);
    expect((await used(t.id)).b).toBe("9200");
  });

  it("concurrent reservations near the spend cap stay within it", async () => {
    const u = await mkUser();
    const t = (await createProxyToken(u, { maxSpendMusd: 100n }))!.record;
    // $0.50/GB: 100 µUSD buys 200_000 bytes; each session wants 60_000 (30 µUSD)
    const grants = await Promise.all(Array.from({ length: 10 }, () => reserveSessionBudget(t.id, 60_000n, 500_000n)));
    const ok = grants.filter((g) => g !== null);
    expect(ok.reduce((a, g) => a + g!.spendMusd, 0n)).toBeLessThanOrEqual(100n);
    expect(ok.reduce((a, g) => a + g!.bytes, 0n)).toBe(200_000n);
    expect(BigInt((await used(t.id)).s)).toBeLessThanOrEqual(100n);
  });

  it("refuses a revoked token and reports it as ended", async () => {
    const u = await mkUser();
    const t = (await createProxyToken(u, {}))!.record;
    expect(await findEndedTokenIds([t.id])).toEqual([]);
    expect(await revokeProxyToken(u, t.id)).toBe(true);
    expect(await reserveSessionBudget(t.id, 10n, 1n)).toBeNull();
    expect(await findEndedTokenIds([t.id])).toEqual([t.id]);
  });
});
