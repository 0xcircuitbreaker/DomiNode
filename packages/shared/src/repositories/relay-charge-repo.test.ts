import { describe, it, expect, vi, beforeEach } from "vitest";
import { routedClient, type Route } from "./relay-net-test-helpers.js";

const mockConnect = vi.fn();
vi.mock("../db.js", () => ({ query: vi.fn(), getPool: () => ({ connect: () => mockConnect() }) }));
import { settleRelayCharge, computeSplit, type SettleRelayChargeInput } from "./relay-charge-repo.js";

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

  it("computeSplit: wallet gross rounded to cents, node share on raw", () => {
    const s = computeSplit(1n, 500_000n, 2500, "wallet");
    expect(s.rawMusd).toBe(1n);
    expect(s.debitCents).toBe(1n);
    expect(s.grossMusd).toBe(10_000n);
    expect(s.nodeMusd + s.platformMusd).toBe(s.grossMusd);
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
    expect(ins.params.slice(11)).toEqual([1, 1, 2500, null, 14]);
    const log = r.calls.find((c) => /relay_abuse_log/.test(c.sql))!;
    expect(log.params[3]).toBe("example.com");
    expect(r.calls.find((c) => /INSERT INTO usage_records/.test(c.sql))!.params[5]).toBe("relay");
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
});
