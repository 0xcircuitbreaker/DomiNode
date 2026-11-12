import { describe, it, expect, vi, beforeEach } from "vitest";
import { routedClient, type Route } from "./relay-net-test-helpers.js";

const mockConnect = vi.fn();
vi.mock("../db.js", () => ({ query: vi.fn(), getPool: () => ({ connect: () => mockConnect() }) }));
import { matureDue, clawback, convertToWallet, earnTx } from "./node-credit-repo.js";

const acct = (p: string, a: string, frozen = false) => ({ rows: [{ user_id: "o1", pending_musd: p, available_musd: a, auto_convert_pct: 0, frozen }] });
function setup(routes: Route[]) { const r = routedClient(routes); mockConnect.mockResolvedValue(r.client); return r; }

describe("node-credit-repo", () => {
  beforeEach(() => vi.clearAllMocks());

  it("earnTx upserts pending and writes earn tx", async () => {
    const r = routedClient([]);
    await earnTx(r.client, "o1", 500n, "rc1");
    expect(r.sqls()[0]).toMatch(/ON CONFLICT \(user_id\) DO UPDATE/);
    expect(r.calls[1].params).toEqual(["o1", "500", "rc1"]);
    await expect(earnTx(r.client, "o1", 0n, "rc1")).rejects.toThrow();
  });

  it("matureDue uses SKIP LOCKED LIMIT and moves pending to available", async () => {
    const r = setup([
      [/FROM relay_charges/, () => ({ rows: [{ id: "rc1", node_owner_user_id: "o1", node_musd: "700" }] })],
      [/FOR UPDATE$|FROM node_credit_accounts WHERE user_id = \$1 FOR UPDATE/, () => acct("1000", "0")],
    ]);
    const res = await matureDue();
    expect(res).toMatchObject({ scanned: 1, matured: 1, movedMusd: 700n });
    const sel = r.calls.find((c) => /FROM relay_charges/.test(c.sql))!;
    expect(sel.sql).toMatch(/FOR UPDATE OF rc SKIP LOCKED/);
    expect(sel.params).toEqual([1000]);
    // Frozen owners are excluded from the selection itself, so they cannot
    // occupy the oldest-1000 window and stall maturity for everyone else.
    expect(sel.sql).toMatch(/LEFT JOIN node_credit_accounts/);
    expect(sel.sql).toMatch(/NOT COALESCE\(a\.frozen, false\)/);
    expect(sel.sql).toMatch(/FOR UPDATE OF rc SKIP LOCKED/);
    expect(r.sqls().some((s) => /'mature'/.test(s))).toBe(true);
    expect(r.sqls()).toContain("COMMIT");
  });

  it("matureDue locks accounts once each in sorted owner order before moving", async () => {
    const r = setup([
      [/FROM relay_charges/, () => ({ rows: [
        { id: "rc1", node_owner_user_id: "o3", node_musd: "100" },
        { id: "rc2", node_owner_user_id: "o1", node_musd: "100" },
        { id: "rc3", node_owner_user_id: "o3", node_musd: "100" },
        { id: "rc4", node_owner_user_id: "o2", node_musd: "100" },
      ] })],
      [/FROM node_credit_accounts WHERE user_id = \$1 FOR UPDATE/, () => acct("150", "0")],
    ]);
    const res = await matureDue();
    const locks = r.calls.filter((c) => /FROM node_credit_accounts WHERE user_id = \$1 FOR UPDATE/.test(c.sql)).map((c) => c.params[0]);
    expect(locks).toEqual(["o1", "o2", "o3"]);
    const firstUpdate = r.calls.findIndex((c) => /SET pending_musd = pending_musd -/.test(c.sql));
    const lastLock = r.calls.map((c) => /FOR UPDATE$|node_credit_accounts WHERE user_id = \$1 FOR UPDATE/.test(c.sql)).lastIndexOf(true);
    expect(lastLock).toBeLessThan(firstUpdate);
    // o3 has 150 pending: second o3 charge moves only the remaining 50.
    expect(res.movedMusd).toBe(350n);
    expect(res.matured).toBe(4);
  });

  it("matureDue skips frozen accounts", async () => {
    const r = setup([
      [/FROM relay_charges/, () => ({ rows: [{ id: "rc1", node_owner_user_id: "o1", node_musd: "700" }] })],
      [/FROM node_credit_accounts WHERE user_id = \$1 FOR UPDATE/, () => acct("1000", "0", true)],
    ]);
    const res = await matureDue();
    expect(res.skippedFrozen).toBe(1);
    expect(r.sqls().some((s) => /SET matured = true/.test(s))).toBe(false);
  });

  it("clawback takes pending first then available, floored", async () => {
    setup([[/FOR UPDATE/, () => acct("300", "200")]]);
    const res = await clawback("o1", 1000n, "admin");
    expect(res).toEqual({ fromPendingMusd: 300n, fromAvailableMusd: 200n });
  });

  it("convertToWallet converts whole cents only", async () => {
    const r = setup([
      [/FROM node_credit_accounts WHERE user_id = \$1 FOR UPDATE/, () => acct("0", "25500")],
      [/FROM wallets WHERE user_id/, () => ({ rows: [{ id: "w1", balance_cents: 0 }] })],
    ]);
    const res = await convertToWallet("o1");
    expect(res).toEqual({ convertedCents: 2, convertedMusd: 20000n });
    expect(r.sqls().some((s) => /'convert_to_wallet'/.test(s))).toBe(true);
  });

  it("convertToWallet locks the wallet before node_credit_accounts (same order as settle)", async () => {
    const r = setup([
      [/FROM node_credit_accounts WHERE user_id = \$1 FOR UPDATE/, () => acct("0", "25500")],
      [/FROM wallets WHERE user_id/, () => ({ rows: [{ id: "w1", balance_cents: 0 }] })],
    ]);
    await convertToWallet("o1");
    const sqls = r.sqls();
    const w = sqls.findIndex((s) => /FROM wallets WHERE user_id = \$1 FOR UPDATE/.test(s));
    const a = sqls.findIndex((s) => /FROM node_credit_accounts WHERE user_id = \$1 FOR UPDATE/.test(s));
    expect(w).toBeGreaterThanOrEqual(0);
    expect(a).toBeGreaterThan(w);
  });

  it("convertToWallet refuses frozen and rolls back", async () => {
    const r = setup([[/FOR UPDATE/, () => acct("0", "25500", true)]]);
    await expect(convertToWallet("o1")).rejects.toThrow(/frozen/);
    expect(r.sqls()).toContain("ROLLBACK");
  });
});
