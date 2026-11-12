import { describe, it, expect, vi } from "vitest";
import { grantTx, grantPrefix, consumeTx, closeGrantTx, PAID_TOPUP_SQL } from "./starter-credit-repo.js";

const SETTINGS = {
  enabled: true, amount_musd: "500000", daily_budget_musd: "50000000", per_prefix_cap: 1, per_funding_source_cap: 1,
  cap_window_days: 30, expiry_days: 30, seed_nodes_only: true, seed_only_days: 30, require_funding: true, min_topup_cents: 100, updated_by: null, updated_at: null,
};

interface Opts {
  settings?: Partial<typeof SETTINGS>;
  prior?: boolean;
  todayMusd?: string | null;
  prefixN?: number;
  fundingN?: number;
  wallet?: boolean;
  topup?: boolean;
}

function client(o: Opts = {}) {
  const calls: Array<{ sql: string; p: unknown[] }> = [];
  const query = vi.fn(async (sql: string, p: unknown[] = []) => {
    calls.push({ sql, p });
    if (sql.includes("FROM starter_credit_settings")) return { rows: [{ ...SETTINGS, ...o.settings }] };
    if (sql.includes("SELECT 1 AS one FROM starter_credit_grants")) return { rows: o.prior ? [{ one: 1 }] : [] };
    if (sql === PAID_TOPUP_SQL) return { rows: o.topup ? [{ one: 1 }] : [] };
    if (sql.includes("AS today_musd")) {
      return { rows: [{ today_musd: o.todayMusd ?? null, prefix_n: String(o.prefixN ?? 0), funding_n: String(o.fundingN ?? 0) }] };
    }
    if (sql.startsWith("UPDATE wallets SET balance_cents = balance_cents + $2")) return { rows: o.wallet === false ? [] : [{ id: "w1" }] };
    if (sql.includes("INSERT INTO starter_credit_grants")) return { rows: [{ id: "g1", expires_at: new Date("2026-12-07T00:00:00Z") }] };
    return { rows: [] };
  });
  return { c: { query } as never, calls };
}

const INPUT = { userId: "u1", fundingSource: "0xABC", clientIp: "203.0.113.9", onchainTxCount: 1 };

describe("grantTx funding precondition", () => {
  const NOCHAIN = { ...INPUT, onchainTxCount: 0 };
  it("grants with >=1 prior Base transaction without checking top-ups", async () => {
    const { c, calls } = client();
    expect((await grantTx(c, INPUT)).granted).toBe(true);
    expect(calls.some((x) => x.sql === PAID_TOPUP_SQL)).toBe(false);
  });
  it("falls back to a paid top-up of at least min_topup_cents", async () => {
    const { c, calls } = client({ topup: true, settings: { min_topup_cents: 250 } });
    expect((await grantTx(c, NOCHAIN)).granted).toBe(true);
    expect(calls.find((x) => x.sql === PAID_TOPUP_SQL)?.p).toEqual(["u1", 250]);
    expect(PAID_TOPUP_SQL).toContain("payment_provider <> 'node_credits'");
  });
  it("fails closed: no nonce (RPC unavailable) and no top-up means no grant", async () => {
    expect(await grantTx(client().c, NOCHAIN)).toEqual({ granted: false, reason: "unfunded" });
    expect(await grantTx(client().c, { ...INPUT, onchainTxCount: null })).toEqual({ granted: false, reason: "unfunded" });
    expect(await grantTx(client().c, { ...INPUT, onchainTxCount: undefined })).toEqual({ granted: false, reason: "unfunded" });
  });
  it("is skipped when the admin turns the requirement off", async () => {
    expect((await grantTx(client({ settings: { require_funding: false } }).c, NOCHAIN)).granted).toBe(true);
  });
});

describe("grantPrefix", () => {
  it("maps IPv4 to /24 and IPv6 to /48", () => {
    expect(grantPrefix("203.0.113.9")).toBe("203.0.113.0/24");
    expect(grantPrefix("::ffff:203.0.113.9")).toBe("203.0.113.0/24");
    expect(grantPrefix("2001:db8:abcd:12::1")).toBe("2001:db8:abcd::/48");
    expect(grantPrefix("2001:db8::1")).toBe("2001:db8:0::/48");
    expect(grantPrefix("nope")).toBeNull();
    expect(grantPrefix(null)).toBeNull();
  });
});

describe("grantTx abuse caps", () => {
  it("grants once: credits whole cents, writes grant + ledger under an advisory lock", async () => {
    const { c, calls } = client();
    const r = await grantTx(c, INPUT, new Date("2026-11-07T12:00:00Z"));
    expect(r).toMatchObject({ granted: true, grantId: "g1", amountMusd: 500000n });
    expect(calls[0].sql).toContain("pg_advisory_xact_lock");
    const credit = calls.find((x) => x.sql.startsWith("UPDATE wallets"));
    expect(credit?.p).toEqual(["u1", "50"]);
    const ins = calls.find((x) => x.sql.includes("INSERT INTO starter_credit_grants"));
    expect(ins?.p).toContain("0xabc"); // funding source lowercased
    expect(ins?.p).toContain("203.0.113.0/24");
    expect(calls.some((x) => x.sql.includes("INSERT INTO starter_credit_ledger"))).toBe(true);
    expect(calls.some((x) => /RETURNING \*/.test(x.sql))).toBe(false);
  });

  it("refuses when disabled, already granted, or over the daily budget", async () => {
    expect(await grantTx(client({ settings: { enabled: false } }).c, INPUT)).toEqual({ granted: false, reason: "disabled" });
    expect(await grantTx(client({ prior: true }).c, INPUT)).toEqual({ granted: false, reason: "already_granted" });
    expect(await grantTx(client({ todayMusd: "49600000" }).c, INPUT)).toEqual({ granted: false, reason: "budget_exhausted" });
    expect((await grantTx(client({ todayMusd: "49500000" }).c, INPUT)).granted).toBe(true);
    expect(await grantTx(client({ settings: { daily_budget_musd: "0" } }).c, INPUT)).toEqual({ granted: false, reason: "budget_exhausted" });
  });

  it("enforces the per-/24 and per-funding-source caps", async () => {
    expect(await grantTx(client({ prefixN: 1 }).c, INPUT)).toEqual({ granted: false, reason: "prefix_cap" });
    expect(await grantTx(client({ fundingN: 1 }).c, INPUT)).toEqual({ granted: false, reason: "funding_source_cap" });
    expect((await grantTx(client({ prefixN: 1, settings: { per_prefix_cap: 2 } }).c, INPUT)).granted).toBe(true);
  });

  it("refuses without a client IP (cap cannot be checked) and on a wallet at its ceiling", async () => {
    expect(await grantTx(client().c, { ...INPUT, clientIp: null })).toEqual({ granted: false, reason: "prefix_cap" });
    expect(await grantTx(client({ wallet: false }).c, INPUT)).toEqual({ granted: false, reason: "no_wallet" });
    expect(await grantTx(client().c, { ...INPUT, fundingSource: " " })).toEqual({ granted: false, reason: "invalid" });
  });
});

describe("consumeTx / closeGrantTx", () => {
  it("draws at most the remaining grant and stamps the relay charge", async () => {
    const calls: Array<{ sql: string; p: unknown[] }> = [];
    const c = { query: vi.fn(async (sql: string, p: unknown[] = []) => {
      calls.push({ sql, p });
      if (sql.includes("FROM starter_credit_grants")) return { rows: [{ id: "g1", remaining_musd: "30000" }] };
      return { rows: [] };
    }) } as never;
    expect(await consumeTx(c, "u1", 50000n, "rc1")).toBe(30000n);
    expect(calls.find((x) => x.sql.startsWith("UPDATE relay_charges SET starter_musd"))?.p).toEqual(["rc1", "30000"]);
  });

  it("returns 0 when there is no active grant", async () => {
    const c = { query: vi.fn(async () => ({ rows: [] })) } as never;
    expect(await consumeTx(c, "u1", 50000n, "rc1")).toBe(0n);
  });

  it("expiry removes the remainder from the wallet but never below zero", async () => {
    const calls: Array<{ sql: string; p: unknown[] }> = [];
    const c = { query: vi.fn(async (sql: string, p: unknown[] = []) => {
      calls.push({ sql, p });
      if (sql.includes("FROM starter_credit_grants")) return { rows: [{ id: "g1", user_id: "u1", remaining_musd: "400000" }] };
      if (sql.includes("FROM wallets")) return { rows: [{ id: "w1", balance_cents: 25 }] };
      return { rows: [] };
    }) } as never;
    expect(await closeGrantTx(c, "g1", "expired", null)).toEqual({ removedCents: 25n });
    expect(calls.find((x) => x.sql.startsWith("UPDATE wallets"))?.p).toEqual(["w1", "25"]);
    expect(calls.find((x) => x.sql.includes("INSERT INTO starter_credit_ledger"))?.p).toEqual(["g1", "expire", "250000", null]);
  });
});
