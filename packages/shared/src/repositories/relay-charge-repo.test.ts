import { describe, it, expect, vi, beforeEach } from "vitest";
import { routedClient, type Route } from "./relay-net-test-helpers.js";

const mockConnect = vi.fn();
vi.mock("../db.js", () => ({ query: vi.fn(), getPool: () => ({ connect: () => mockConnect() }) }));
import { settleRelayCharge, computeSplit, isByteDispute, type SettleRelayChargeInput } from "./relay-charge-repo.js";

const base: SettleRelayChargeInput = {
  sessionId: "s1", requesterUserId: "req", requesterWallet: null, rail: "wallet", reservedCents: 10,
  nodeId: "n1", bytesGateway: 1_000_000_000n, bytesIn: 500, bytesOut: 500, pricePerGbMusd: 500_000n,
  snapshot: { splitConfigId: 1, tierId: 1, nodeShareBps: 2500, holdDays: 14 }, destHost: "Example.com", destPort: 443,
};
const sessRoute: Route = [/FROM sessions WHERE id/, () => ({ rows: [{ id: "s1", user_id: "req", status: "active" }] })];
function setup(routes: Route[], session: Route | null = sessRoute) { const r = routedClient(session ? [session, ...routes] : routes); mockConnect.mockResolvedValue(r.client); return r; }
const nodeRow = (owner = "own", status = "active") => ({ rows: [{ owner_user_id: owner, owner_wallet: "0x" + "a".repeat(40), status }] });

describe("relay-charge-repo", () => {
  beforeEach(() => vi.clearAllMocks());

  it("computeSplit: gross is the true charge ceil'd to 1 µUSD, never to a cent", () => {
    const s = computeSplit(1n, 500_000n, 2500, "wallet");
    expect(s.rawMusd).toBe(1n);
    expect(s.grossMusd).toBe(1n);
    expect(s.nodeMusd + s.platformMusd).toBe(s.grossMusd);
    const k = computeSplit(4096n, 500_000n, 2500, "wallet");
    expect(k.grossMusd).toBe(3n); // 4096 * 0.0005 µUSD/B = 2.048 -> 3
  });

  it("1000 x 4KB sessions at $0.50/GB accrue sub-cent carry (~0.3c total, not 1000c)", async () => {
    let carry = 0n;
    let debited = 0;
    let grossTotal = 0n;
    for (let k = 0; k < 1000; k++) {
      setup([
        [/SELECT id, carry_musd FROM wallets/, () => ({ rows: [{ id: "w1", carry_musd: carry.toString() }] })],
        [/UPDATE wallets SET carry_musd/, (p) => { carry = BigInt(p[0] as string); return { rows: [] }; }],
        [/FROM wallets WHERE user_id/, () => ({ rows: [{ id: "w1", balance_cents: 1000 }] })],
        [/FROM nodes WHERE id/, () => nodeRow()],
        [/INSERT INTO relay_charges/, () => ({ rows: [{ id: "rc" }] })],
      ]);
      const r = await settleRelayCharge({ ...base, reservedCents: 0, bytesGateway: 4096n });
      debited += r.debitCents;
      grossTotal += r.grossMusd;
      expect(r.nodeMusd + r.platformMusd).toBe(r.grossMusd);
      expect(carry).toBeGreaterThanOrEqual(0n);
      expect(carry).toBeLessThan(10_000n);
    }
    // True cost: 1000 * 4096 B * $0.50/GB = 2048 µUSD ≈ 0.2c; ceil-to-µUSD gives 3000 µUSD.
    expect(grossTotal).toBe(3000n);
    expect(debited).toBe(0);
    expect(BigInt(debited) * 10_000n + carry).toBe(grossTotal);
  });

  it("carry rolls over into whole cents", async () => {
    setup([
      [/SELECT id, carry_musd FROM wallets/, () => ({ rows: [{ id: "w1", carry_musd: "9999" }] })],
      [/FROM wallets WHERE user_id/, () => ({ rows: [{ id: "w1", balance_cents: 1000 }] })],
      [/FROM nodes WHERE id/, () => nodeRow()],
      [/INSERT INTO relay_charges/, () => ({ rows: [{ id: "rc" }] })],
    ]);
    const r = await settleRelayCharge({ ...base, reservedCents: 0, bytesGateway: 4096n });
    expect(r.debitCents).toBe(1);
  });

  it("marks disputed + records byte_disputes when node bytes differ >10% and >1MiB", async () => {
    const r = setup([
      [/FROM wallets WHERE user_id/, () => ({ rows: [{ id: "w1", balance_cents: 1000 }] })],
      [/FROM nodes WHERE id/, () => nodeRow()],
      [/INSERT INTO relay_charges/, () => ({ rows: [{ id: "rcd" }] })],
    ]);
    const res = await settleRelayCharge({ ...base, bytesGateway: 10_000_000n, bytesNode: 5_000_000n });
    expect(res.disputed).toBe(true);
    const ins = r.calls.find((c) => /INSERT INTO relay_charges/.test(c.sql))!;
    expect(ins.params[6]).toBe("5000000");
    expect(ins.params[16]).toBe(true);
    expect(r.sqls().some((x) => /INSERT INTO byte_disputes/.test(x))).toBe(true);
    expect(isByteDispute(10_000_000n, 9_500_000n)).toBe(false); // 5%
    expect(isByteDispute(1_000_000n, 0n)).toBe(false); // <1MiB
    expect(isByteDispute(100_000_000n, null)).toBe(false);
  });

  it("applies a platform-funded buyer discount: node share unchanged, requester pays less", async () => {
    const r = setup([
      [/FROM relay_charges WHERE session_id/, () => ({ rows: [] })],
      [/FROM wallets WHERE user_id/, () => ({ rows: [{ id: "w1", balance_cents: 1000 }] })],
      [/FROM nodes WHERE id/, () => nodeRow()],
      [/INSERT INTO relay_charges/, () => ({ rows: [{ id: "rc1" }] })],
    ]);
    const res = await settleRelayCharge({
      ...base,
      snapshot: { ...base.snapshot, genesisBonusBps: 0, buyerTierId: 6, buyerDiscountBps: 2500, minPlatformMarginBps: 2500 },
    });
    // list 500000; node 25% = 125000 (unchanged); discount 25% = 125000; paid 375000; platform 250000
    expect(res).toMatchObject({ grossMusd: 375_000n, nodeMusd: 125_000n, platformMusd: 250_000n });
    const ins = r.calls.find((c) => /INSERT INTO relay_charges/.test(c.sql))!;
    expect(ins.params.slice(17)).toEqual([0, "500000", 2500, "125000", 6, null]);
  });

  it("settles wallet rail in one tx and credits node pending", async () => {
    const r = setup([
      [/FROM relay_charges WHERE session_id/, () => ({ rows: [] })],
      [/FROM wallets WHERE user_id/, () => ({ rows: [{ id: "w1", balance_cents: 1000 }] })],
      [/FROM nodes WHERE id/, () => nodeRow()],
      [/INSERT INTO relay_charges/, () => ({ rows: [{ id: "rc1" }] })],
    ]);
    const res = await settleRelayCharge(base);
    expect(res).toMatchObject({ status: "settled", relayChargeId: "rc1", grossMusd: 500_000n, nodeMusd: 125_000n, debitCents: 50 });
    const s = r.sqls();
    expect(s.filter((x) => x === "BEGIN")).toHaveLength(1);
    expect(s.at(-1)).toBe("COMMIT");
    expect(s.some((x) => /RETURNING \*/.test(x))).toBe(false);
    expect(s.some((x) => /'earn'/.test(x))).toBe(true);
    const ins = r.calls.find((c) => /INSERT INTO relay_charges/.test(c.sql))!;
    expect(ins.params.slice(11, 17)).toEqual([1, 1, 2500, null, 14, false]);
    expect(ins.params.slice(17)).toEqual([0, "500000", 0, "0", null, null]); // genesis 0, list = gross, no buyer discount
    const log = r.calls.find((c) => /relay_abuse_log/.test(c.sql))!;
    expect(log.params[3]).toBe("example.com");
    expect(r.calls.find((c) => /INSERT INTO usage_records/.test(c.sql))!.params[5]).toBe("relay");
  });

  it("does not re-create abuse-log or usage destination for an erased requester", async () => {
    const r = setup([
      [/FROM users WHERE id/, () => ({ rows: [{ status: "deleted" }] })],
      [/FROM wallets WHERE user_id/, () => ({ rows: [{ id: "w1", balance_cents: 1000 }] })],
      [/FROM nodes WHERE id/, () => nodeRow()],
      [/INSERT INTO relay_charges/, () => ({ rows: [{ id: "rc-erased" }] })],
    ]);
    const res = await settleRelayCharge({ ...base, usageTargetHost: "example.com" });
    expect(res.status).toBe("settled");
    expect(r.sqls().some((x) => /INSERT INTO relay_abuse_log/.test(x))).toBe(false);
    const usage = r.calls.find((c) => /INSERT INTO usage_records/.test(c.sql))!;
    expect(JSON.stringify(usage.params)).not.toContain("example.com");
  });

  it("is idempotent when a charge exists", async () => {
    const r = setup([[/FROM relay_charges WHERE session_id/, () => ({ rows: [{ id: "rc1", gross_musd: "1", node_musd: "0", platform_musd: "1", zero_reason: null }] })]]);
    const res = await settleRelayCharge(base);
    expect(res.status).toBe("duplicate");
    expect(r.sqls().some((x) => /wallets/.test(x))).toBe(false);
  });

  it("zeroes node share on self-dealing (team member owner)", async () => {
    const r = setup([
      [/FROM team_wallets/, () => ({ rows: [{ id: "tw", balance_cents: 1000 }] })],
      [/FROM nodes WHERE id/, () => nodeRow("teammate")],
      [/FROM team_members/, () => ({ rows: [{ one: 1 }] })],
      [/INSERT INTO relay_charges/, () => ({ rows: [{ id: "rc2" }] })],
    ]);
    const res = await settleRelayCharge({ ...base, rail: "team", requesterTeamId: "t1" });
    expect(res).toMatchObject({ zeroReason: "self_dealing", nodeMusd: 0n, platformMusd: 500_000n });
    expect(r.sqls().some((x) => /'earn'/.test(x))).toBe(false);
  });

  it("zeroes node share when requester wallet matches owner wallet", async () => {
    setup([
      [/FROM wallets WHERE user_id/, () => ({ rows: [{ id: "w1", balance_cents: 1000 }] })],
      [/FROM nodes WHERE id/, () => nodeRow()],
      [/INSERT INTO relay_charges/, () => ({ rows: [{ id: "rc3" }] })],
    ]);
    const res = await settleRelayCharge({ ...base, requesterWallet: "0x" + "A".repeat(40) });
    expect(res.zeroReason).toBe("self_dealing");
  });

  it("zeroes node share when a Solana payer identity belongs to the node owner", async () => {
    const SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    const r = setup([
      [/FROM nodes WHERE id/, () => nodeRow()],
      [/FROM payer_identities/, () => ({ rows: [{ one: 1 }] })],
      [/INSERT INTO relay_charges/, () => ({ rows: [{ id: "rcs" }] })],
    ]);
    const res = await settleRelayCharge({ ...base, rail: "x402", reservedCents: 0, prepaidGrossMusd: 500_000n, requesterWallet: SOL });
    expect(res.zeroReason).toBe("self_dealing");
    expect(r.calls.find((c) => /payer_identities/.test(c.sql))!.params).toEqual([SOL, "own"]);
  });

  it("rejects dest with a path and rolls back on missing node", async () => {
    await expect(settleRelayCharge({ ...base, destHost: "a.com/secret" })).rejects.toThrow(/bare hostname/);
    const r = setup([[/FROM wallets WHERE user_id/, () => ({ rows: [{ id: "w1", balance_cents: 1000 }] })]]);
    await expect(settleRelayCharge(base)).rejects.toThrow(/Node not found/);
    expect(r.sqls()).toContain("ROLLBACK");
  });

  it("holds node share when the requester underpaid (partial settle)", async () => {
    const r = setup([
      [/FROM wallets WHERE user_id/, () => ({ rows: [{ id: "w1", balance_cents: 0 }] })],
      [/FROM nodes WHERE id/, () => nodeRow()],
      [/INSERT INTO relay_charges/, () => ({ rows: [{ id: "rc9" }] })],
    ]);
    const res = await settleRelayCharge(base);
    expect(res).toMatchObject({ paidInFull: false, zeroReason: "collusion_hold", nodeMusd: 0n });
    expect(r.sqls().some((x) => /'earn'/.test(x))).toBe(false);
  });

  it("throws when the session row is missing", async () => {
    const r = setup([[/FROM wallets WHERE user_id/, () => ({ rows: [{ id: "w1", balance_cents: 1000 }] })]], null);
    await expect(settleRelayCharge(base)).rejects.toThrow(/Session not found/);
    expect(r.sqls().some((x) => /UPDATE wallets|INSERT INTO relay_charges/.test(x))).toBe(false);
    expect(r.sqls()).toContain("ROLLBACK");
  });

  it("throws when the session belongs to another user or already ended", async () => {
    setup([], [/FROM sessions WHERE id/, () => ({ rows: [{ id: "s1", user_id: "other", status: "active" }] })]);
    await expect(settleRelayCharge(base)).rejects.toThrow(/does not belong/);
    setup([], [/FROM sessions WHERE id/, () => ({ rows: [{ id: "s1", user_id: "req", status: "completed" }] })]);
    await expect(settleRelayCharge(base)).rejects.toThrow(/already ended/);
  });

  it("flags self-dealing on wallet rail when requester shares any team with owner", async () => {
    const r = setup([
      [/FROM wallets WHERE user_id/, () => ({ rows: [{ id: "w1", balance_cents: 1000 }] })],
      [/FROM nodes WHERE id/, () => nodeRow("teammate")],
      [/FROM team_members a JOIN team_members b/, () => ({ rows: [{ one: 1 }] })],
      [/INSERT INTO relay_charges/, () => ({ rows: [{ id: "rc10" }] })],
    ]);
    const res = await settleRelayCharge(base);
    expect(res).toMatchObject({ zeroReason: "self_dealing", nodeMusd: 0n });
    const q = r.calls.find((c) => /team_members a JOIN/.test(c.sql))!;
    expect(q.params).toEqual(["req", "teammate"]);
  });

  it("x402 rail: gross = prepaid µUSD, split by locked bps, no wallet movement", async () => {
    const r = setup([
      [/FROM nodes WHERE id/, () => nodeRow()],
      [/INSERT INTO relay_charges/, () => ({ rows: [{ id: "rcx" }] })],
    ]);
    const res = await settleRelayCharge({ ...base, rail: "x402", reservedCents: 0, bytesGateway: 4096n, prepaidGrossMusd: 4883n });
    expect(res.grossMusd).toBe(4883n);
    expect(res.nodeMusd).toBe(1220n); // floor(4883 * 2500 / 10000)
    expect(res.nodeMusd + res.platformMusd).toBe(4883n);
    expect(res.debitCents).toBe(0);
    expect(r.sqls().some((x) => /wallets/.test(x))).toBe(false);
    const ins = r.calls.find((c) => /INSERT INTO relay_charges/.test(c.sql))!;
    expect(ins.params[1]).toBe("req"); // requester_user_id is the payer's wallet-identity user
    expect(ins.params[4]).toBe("x402");
    expect(ins.params[8]).toBe("4883");
  });

  it("rejects prepaidGrossMusd on wallet rails or out of range", async () => {
    await expect(settleRelayCharge({ ...base, prepaidGrossMusd: 10n })).rejects.toThrow(/only valid/);
    await expect(settleRelayCharge({ ...base, rail: "x402", prepaidGrossMusd: 0n })).rejects.toThrow(/range/);
  });
});
