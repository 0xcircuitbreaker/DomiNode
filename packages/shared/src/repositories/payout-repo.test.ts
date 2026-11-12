import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { routedClient, type Route } from "./relay-net-test-helpers.js";

const mockConnect = vi.fn();
vi.mock("../db.js", () => ({ query: vi.fn(), getPool: () => ({ connect: () => mockConnect() }) }));
import { requestWithdraw, markPayoutReversed, markPayoutConfirmed, markPayoutFailed, changePayoutWallet, PayoutsDisabledError, payoutsEnabled, listDuePayouts, listAutoPayoutCandidates, claimPayoutForSend, blockWalletForSanctions, freezeNodeCreditAccount } from "./payout-repo.js";
import { query as dbQuery } from "../db.js";

function setup(routes: Route[]) { const r = routedClient(routes); mockConnect.mockResolvedValue(r.client); return r; }
const acct = (avail: string) => ({ rows: [{ user_id: "u1", pending_musd: "0", available_musd: avail, auto_convert_pct: 0, frozen: false }] });
const payout = (status: string, extra: Record<string, unknown> = {}) => ({ rows: [{ id: "p1", user_id: "u1", payout_wallet_id: "pw", idempotency_key: "key-12345", amount_musd: "2000000", trigger: "on_demand", status, tx_hash: null, created_at: new Date(), ...extra }] });
const H = "0x" + "b".repeat(64);

function happyRoutes(extra: Route[] = []): Route[] {
  return [
    ...extra,
    [/FROM node_credit_accounts WHERE user_id = \$1 FOR UPDATE/, () => acct("5000000")],
    [/FROM node_payouts WHERE user_id = \$1 AND idempotency_key/, () => ({ rows: [] })],
    [/SELECT id, status FROM payout_wallets/, () => ({ rows: [{ id: "pw", status: "active" }] })],
    [/FROM node_tiers t/, () => ({ rows: [{ daily_withdraw_limit_musd: "50000000", used_today: "0" }] })],
    [/SELECT tax_form_status/, () => ({ rows: [{ tax_form_status: "not_required", ytd_paid_musd: "0", tax_year: 2026, cur_year: 2026 }] })],
    [/INSERT INTO node_payouts/, () => payout("pending")],
  ];
}

describe("payout-repo", () => {
  const prev = process.env["PAYOUTS_ENABLED"];
  beforeEach(() => { vi.clearAllMocks(); process.env["PAYOUTS_ENABLED"] = "true"; });
  afterEach(() => { if (prev === undefined) delete process.env["PAYOUTS_ENABLED"]; else process.env["PAYOUTS_ENABLED"] = prev; });

  it("is disabled by default", async () => {
    delete process.env["PAYOUTS_ENABLED"];
    expect(payoutsEnabled()).toBe(false);
    await expect(requestWithdraw({ userId: "u1", amountMusd: 2_000_000n, idempotencyKey: "key-12345" })).rejects.toBeInstanceOf(PayoutsDisabledError);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("enforces $1 minimum", async () => {
    await expect(requestWithdraw({ userId: "u1", amountMusd: 999_999n, idempotencyKey: "key-12345" })).rejects.toThrow(/\$1/);
  });

  it("debits ledger and inserts payout in one tx", async () => {
    const r = setup(happyRoutes());
    const res = await requestWithdraw({ userId: "u1", amountMusd: 2_000_000n, idempotencyKey: "key-12345" });
    expect(res.duplicate).toBe(false);
    const s = r.sqls();
    expect(s.some((x) => /available_musd = available_musd - \$2/.test(x))).toBe(true);
    expect(s.some((x) => /'withdraw'/.test(x))).toBe(true);
    expect(s.at(-1)).toBe("COMMIT");
  });

  it("returns existing payout for a repeated idempotency key", async () => {
    const r = setup(happyRoutes([[/FROM node_payouts WHERE user_id = \$1 AND idempotency_key/, () => payout("pending")]]));
    const res = await requestWithdraw({ userId: "u1", amountMusd: 2_000_000n, idempotencyKey: "key-12345" });
    expect(res.duplicate).toBe(true);
    expect(r.sqls().some((x) => /INSERT INTO node_payouts/.test(x))).toBe(false);
  });

  it("enforces tier daily limit", async () => {
    setup(happyRoutes([[/FROM node_tiers t/, () => ({ rows: [{ daily_withdraw_limit_musd: "50000000", used_today: "49000000" }] })]]));
    await expect(requestWithdraw({ userId: "u1", amountMusd: 2_000_000n, idempotencyKey: "key-12345" })).rejects.toThrow(/Daily/);
  });

  it("blocks during wallet cooldown", async () => {
    setup(happyRoutes([[/SELECT id, status FROM payout_wallets/, () => ({ rows: [{ id: "pw", status: "pending" }] })]]));
    await expect(requestWithdraw({ userId: "u1", amountMusd: 2_000_000n, idempotencyKey: "key-12345" })).rejects.toThrow(/cooling/);
  });

  it("change sets 72h pending and supersedes old", async () => {
    const r = setup([
      [/SELECT id FROM users/, () => ({ rows: [{ id: "u1" }] })],
      [/FROM node_credit_accounts WHERE user_id = \$1 FOR UPDATE/, () => acct("0")],
      [/SELECT id, user_id, address, chain, status, active_from FROM payout_wallets/, () => ({ rows: [{ id: "old", user_id: "u1", address: "0x" + "1".repeat(40), chain: "base", status: "active", active_from: new Date() }] })],
      [/INSERT INTO payout_wallets/, () => ({ rows: [{ id: "new", user_id: "u1", address: "0x" + "2".repeat(40), chain: "base", status: "pending", active_from: new Date() }] })],
    ]);
    const w = await changePayoutWallet("u1", "0x" + "2".repeat(40), "0x" + "c".repeat(130), { ofacCleared: true });
    expect(w.status).toBe("pending");
    expect(r.calls.find((c) => /INSERT INTO payout_wallets/.test(c.sql))!.params[4]).toBe(72);
    expect(r.sqls().some((x) => /'superseded'/.test(x))).toBe(true);
  });

  it("change reverses unsent payouts to the old wallet and re-credits, in the same tx", async () => {
    const r = setup([
      [/SELECT id FROM users/, () => ({ rows: [{ id: "u1" }] })],
      [/FROM node_credit_accounts WHERE user_id = \$1 FOR UPDATE/, () => acct("0")],
      [/SELECT id, user_id, address, chain, status, active_from FROM payout_wallets/, () => ({ rows: [{ id: "old", user_id: "u1", address: "0x" + "1".repeat(40), chain: "base", status: "active", active_from: new Date() }] })],
      [/UPDATE node_payouts SET status = 'reversed'/, () => ({ rows: [{ id: "p1", amount_musd: "2000000" }, { id: "p2", amount_musd: "3000000" }] })],
      [/INSERT INTO payout_wallets/, () => ({ rows: [{ id: "new", user_id: "u1", address: "0x" + "2".repeat(40), chain: "base", status: "pending", active_from: new Date() }] })],
    ]);
    await changePayoutWallet("u1", "0x" + "2".repeat(40), "0x" + "c".repeat(130), { ofacCleared: true });
    const rev = r.calls.find((c) => /UPDATE node_payouts SET status = 'reversed'/.test(c.sql))!;
    expect(rev.sql).toMatch(/status IN \('pending','held_tax','held_frozen'\)/);
    expect(rev.params.slice(0, 2)).toEqual(["u1", "old"]);
    expect(r.calls.filter((c) => /'withdraw_reversal'/.test(c.sql))).toHaveLength(2);
    const credit = r.calls.find((c) => /available_musd = available_musd \+/.test(c.sql))!;
    expect(credit.params).toEqual(["u1", "5000000"]);
    const sqls = r.sqls();
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls[sqls.length - 1]).toBe("COMMIT");
    // account locked before payout_wallets
    expect(sqls.findIndex((x) => /FROM node_credit_accounts WHERE user_id = \$1 FOR UPDATE/.test(x)))
      .toBeLessThan(sqls.findIndex((x) => /FROM payout_wallets WHERE user_id = \$1 AND status IN/.test(x)));
  });

  it("listDuePayouts excludes frozen accounts", async () => {
    vi.mocked(dbQuery).mockResolvedValueOnce({ rows: [] } as never);
    await listDuePayouts();
    expect(vi.mocked(dbQuery).mock.calls[0][0]).toMatch(/JOIN node_credit_accounts a ON a.user_id = p.user_id[\s\S]*NOT a.frozen/);
  });

  it("claimPayoutForSend requires a non-frozen account (FOR SHARE)", async () => {
    vi.mocked(dbQuery).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    expect(await claimPayoutForSend("p1")).toBe(false);
    expect(vi.mocked(dbQuery).mock.calls[0][0]).toMatch(/NOT a.frozen FOR SHARE/);
  });

  it("sanctions block freezes the account and holds its pending payouts", async () => {
    const r = setup([
      [/FROM node_credit_accounts WHERE user_id = \$1 FOR UPDATE/, () => acct("0")],
      [/SET status = 'held_frozen'/, () => ({ rows: [{ id: "p1" }] })],
    ]);
    await blockWalletForSanctions("pw", "u1");
    const sqls = r.sqls();
    const lock = sqls.findIndex((x) => /FOR UPDATE/.test(x));
    const freeze = sqls.findIndex((x) => /SET frozen = true/.test(x));
    const hold = sqls.findIndex((x) => /SET status = 'held_frozen'/.test(x));
    expect(lock).toBeLessThan(freeze);
    expect(freeze).toBeLessThan(hold);
    expect(sqls[hold]).toMatch(/status = 'pending'/);
    expect(sqls.some((x) => /payout_wallets SET status = 'blocked'/.test(x))).toBe(true);
  });

  it("freezeNodeCreditAccount reports held payouts", async () => {
    setup([[/SET status = 'held_frozen'/, () => ({ rows: [{ id: "p1" }, { id: "p2" }] })], [/FOR UPDATE/, () => acct("0")]]);
    expect(await freezeNodeCreditAccount("u1")).toEqual({ heldPayouts: 2 });
  });

  it("a held_frozen payout can be reversed by an admin", async () => {
    setup([
      [/FROM node_payouts WHERE id = \$1 FOR UPDATE/, () => payout("held_frozen")],
      [/UPDATE node_payouts/, () => payout("reversed")],
      [/FROM node_credit_accounts WHERE user_id = \$1 FOR UPDATE/, () => acct("0")],
    ]);
    expect((await markPayoutReversed("p1", "admin")).status).toBe("reversed");
  });

  it("reversal re-credits available", async () => {
    const r = setup([
      [/FROM node_payouts WHERE id = \$1 FOR UPDATE/, () => payout("pending")],
      [/UPDATE node_payouts/, () => payout("reversed")],
      [/FROM node_credit_accounts WHERE user_id = \$1 FOR UPDATE/, () => acct("0")],
    ]);
    const p = await markPayoutReversed("p1", "rpc failure");
    expect(p.status).toBe("reversed");
    expect(r.sqls().some((x) => /'withdraw_reversal'/.test(x))).toBe(true);
  });

  it("markPayoutReversedTx runs on the caller's client without its own transaction", async () => {
    const { markPayoutReversedTx } = await import("./payout-repo.js");
    const r = routedClient([
      [/FROM node_payouts WHERE id = \$1 FOR UPDATE/, () => payout("pending")],
      [/UPDATE node_payouts/, () => payout("reversed")],
      [/FROM node_credit_accounts WHERE user_id = \$1 FOR UPDATE/, () => acct("0")],
    ]);
    mockConnect.mockReset();
    const p = await markPayoutReversedTx(r.client as never, "p1", "admin: x");
    expect(p.status).toBe("reversed");
    expect(mockConnect).not.toHaveBeenCalled();
    expect(r.sqls().some((x) => /^(BEGIN|COMMIT)/.test(x))).toBe(false);
    expect(r.sqls().some((x) => /'withdraw_reversal'/.test(x))).toBe(true);
  });

  it("cannot reverse confirmed; confirm is idempotent on same hash", async () => {
    setup([[/FROM node_payouts WHERE id = \$1 FOR UPDATE/, () => payout("confirmed", { tx_hash: H })]]);
    await expect(markPayoutReversed("p1", "x")).rejects.toThrow(/confirmed/);
    expect((await markPayoutConfirmed("p1", H)).status).toBe("confirmed");
  });

  it("refuses to reverse a submitted payout; failed-with-evidence then reverses", async () => {
    let r = setup([[/FROM node_payouts WHERE id = \$1 FOR UPDATE/, () => payout("submitted", { tx_hash: H })]]);
    await expect(markPayoutReversed("p1", "x")).rejects.toThrow(/submitted/);
    expect(r.sqls().some((x) => /UPDATE node_credit_accounts/.test(x))).toBe(false);

    r = setup([
      [/FROM node_payouts WHERE id = \$1 FOR UPDATE/, () => payout("submitted", { tx_hash: H })],
      [/UPDATE node_payouts/, () => payout("failed", { tx_hash: H })],
    ]);
    const f = await markPayoutFailed("p1", { txHash: H, outcome: "dropped" });
    expect(f.status).toBe("failed");
    expect(r.calls.find((c) => /UPDATE node_payouts/.test(c.sql))!.params[2]).toBe("tx dropped");
    await expect(markPayoutFailed("p1", { txHash: "0x" + "c".repeat(64), outcome: "dropped" })).rejects.toThrow(/does not match/);

    r = setup([
      [/FROM node_payouts WHERE id = \$1 FOR UPDATE/, () => payout("failed", { tx_hash: H })],
      [/UPDATE node_payouts/, () => payout("reversed")],
      [/FROM node_credit_accounts WHERE user_id = \$1 FOR UPDATE/, () => acct("0")],
    ]);
    expect((await markPayoutReversed("p1", "dropped")).status).toBe("reversed");
    expect(r.sqls().some((x) => /'withdraw_reversal'/.test(x))).toBe(true);
  });

  it("counts in-flight payouts toward the tax hold threshold", async () => {
    const r = setup(happyRoutes([
      [/SELECT tax_form_status/, () => ({ rows: [{ tax_form_status: "requested", ytd_paid_musd: "0", tax_year: 2026, cur_year: 2026, in_flight_musd: "1999000000" }] })],
    ]));
    await requestWithdraw({ userId: "u1", amountMusd: 2_000_000n, idempotencyKey: "key-split-1" });
    const ins = r.calls.find((c) => /INSERT INTO node_payouts/.test(c.sql))!;
    expect(ins.params[5]).toBe("held_tax");
    expect(r.calls.find((c) => /SELECT tax_form_status/.test(c.sql))!.sql).toMatch(/'pending','held_tax','held_frozen','submitted'/);
  });

  it("listAutoPayoutCandidates returns the remaining tier daily limit, floored at 0, fail-closed without a tier", async () => {
    vi.mocked(dbQuery).mockResolvedValueOnce({ rows: [
      { user_id: "a", available_musd: "60000000", remaining_daily_musd: "50000000" },
      { user_id: "b", available_musd: "60000000", remaining_daily_musd: "-1" },
      { user_id: "c", available_musd: "60000000", remaining_daily_musd: null },
    ] } as never);
    const r = await listAutoPayoutCandidates();
    expect(r.map((x) => x.remainingDailyMusd)).toEqual([50000000n, 0n, 0n]);
    const sqlText = vi.mocked(dbQuery).mock.calls[0]![0] as string;
    expect(sqlText).toMatch(/daily_withdraw_limit_musd/);
    expect(sqlText).toMatch(/status NOT IN \('failed','reversed'\)/);
  });
});
