import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";

const m = vi.hoisted(() => ({ poolQuery: vi.fn(), clientQuery: vi.fn(), release: vi.fn(), starterSettings: vi.fn() }));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { userId: "44444444-4444-4444-8444-444444444444" };
    next();
  },
}));
vi.mock("../middleware/admin.js", () => ({
  requireAdmin: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));
vi.mock("@dominusnode/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dominusnode/shared")>();
  return {
    ...actual,
    getPool: () => ({ query: m.poolQuery, connect: async () => ({ query: m.clientQuery, release: m.release }) }),
    starterCreditRepo: { ...actual.starterCreditRepo, getSettings: m.starterSettings },
    genesisRepo: { ...actual.genesisRepo, getSettings: async () => actual.genesisRepo.DEFAULT_GENESIS_SETTINGS },
  };
});

import router from "./admin-network-launch.js";
import { call } from "./v1/test-helpers.js";

export const BASE = "/api/admin/network";
const NODE = "55555555-5555-4555-8555-555555555555";

function app() {
  const a = express();
  a.use(express.json());
  a.use(BASE, router);
  return a;
}
const txSqls = () => m.clientQuery.mock.calls.map((c) => String(c[0]));
function tx(handler: (sql: string, p: unknown[]) => { rows: unknown[] } | undefined = () => undefined, role = "admin") {
  m.clientQuery.mockImplementation(async (sql: string, p: unknown[] = []) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
    if (sql.includes("SELECT admin_role FROM users")) return { rows: [{ admin_role: role }] };
    return handler(sql, p) ?? { rows: [] };
  });
}

beforeEach(async () => {
  m.poolQuery.mockReset(); m.clientQuery.mockReset(); m.release.mockReset();
  const actual = await vi.importActual<typeof import("@dominusnode/shared")>("@dominusnode/shared");
  m.starterSettings.mockReset().mockImplementation(async () => {
    const r = await m.poolQuery("SELECT FROM starter_credit_settings");
    const row = r?.rows?.[0];
    return row && "amount_musd" in row
      ? { ...actual.starterCreditRepo.DEFAULT_STARTER_SETTINGS, enabled: row.enabled, amountMusd: BigInt(row.amount_musd) }
      : actual.starterCreditRepo.DEFAULT_STARTER_SETTINGS;
  });
});

const SETTINGS_ROW = {
  enabled: false, amount_musd: "500000", daily_budget_musd: "50000000", per_prefix_cap: 1, per_funding_source_cap: 1,
  cap_window_days: 30, expiry_days: 30, seed_nodes_only: true, seed_only_days: 30, updated_by: null, updated_at: null,
};

describe("starter credits admin", () => {
  it("GET settings returns defaults ($0.50, $50/day, caps 1, 30 days) and today's usage", async () => {
    m.poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM starter_credit_settings")) return { rows: [SETTINGS_ROW] };
      return { rows: [{ musd: "1000000", n: "2" }] };
    });
    const r = await call(app(), "GET", `${BASE}/starter-credits/settings`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      enabled: false, amount: { musd: "500000" }, dailyBudget: { musd: "50000000" }, perPrefixCap: 1,
      perFundingSourceCap: 1, expiryDays: 30, seedNodesOnly: true, grantedToday: { count: 2, amount: { musd: "1000000" } },
    });
  });

  it("PUT settings validates fields, whole cents, and audits", async () => {
    m.poolQuery.mockResolvedValue({ rows: [{ ...SETTINGS_ROW, enabled: true }] });
    tx();
    expect((await call(app(), "PUT", `${BASE}/starter-credits/settings`, { body: { bogus: 1 } })).status).toBe(400);
    expect((await call(app(), "PUT", `${BASE}/starter-credits/settings`, { body: { amountMusd: "500001" } })).status).toBe(400);
    expect((await call(app(), "PUT", `${BASE}/starter-credits/settings`, { body: { perPrefixCap: -1 } })).status).toBe(400);
    expect((await call(app(), "PUT", `${BASE}/starter-credits/settings`, { body: { enabled: "true" } })).status).toBe(400);
    const r = await call(app(), "PUT", `${BASE}/starter-credits/settings`, { body: { enabled: true, dailyBudgetMusd: "10000000" } });
    expect(r.status).toBe(200);
    const upd = m.clientQuery.mock.calls.find((c) => String(c[0]).startsWith("UPDATE starter_credit_settings"));
    expect(upd?.[1]).toEqual([true, "10000000", "44444444-4444-4444-8444-444444444444"]);
    expect(txSqls().some((s) => s.includes("INSERT INTO audit_events"))).toBe(true);
  });

  it("revoke requires a reason and 404s inactive grants", async () => {
    tx();
    expect((await call(app(), "POST", `${BASE}/starter-credits/grants/${NODE}/revoke`, { body: {} })).status).toBe(400);
    expect((await call(app(), "POST", `${BASE}/starter-credits/grants/${NODE}/revoke`, { body: { reason: "sybil" } })).status).toBe(404);
  });
});

describe("genesis + buyer discount admin", () => {
  it("validates and audits genesis settings; bonus capped at 5000 bps", async () => {
    tx();
    m.poolQuery.mockResolvedValue({ rows: [] });
    expect((await call(app(), "PUT", `${BASE}/genesis/settings`, { body: { bonusBps: 5001 } })).status).toBe(400);
    expect((await call(app(), "PUT", `${BASE}/genesis/settings`, { body: { creditMusd: 5 } })).status).toBe(400);
    const r = await call(app(), "PUT", `${BASE}/genesis/settings`, { body: { maxOwners: 250, bonusBps: 600, creditMusd: "4000000" } });
    expect(r.status).toBe(200);
    expect(txSqls().some((s) => s.startsWith("UPDATE genesis_settings"))).toBe(true);
    expect(txSqls().some((s) => s.includes("INSERT INTO audit_events"))).toBe(true);
  });

  it("clawback needs a reason and a held credit", async () => {
    tx();
    expect((await call(app(), "POST", `${BASE}/genesis/members/${NODE}/clawback`, { body: {} })).status).toBe(400);
    expect((await call(app(), "POST", `${BASE}/genesis/members/${NODE}/clawback`, { body: { reason: "fraud" } })).status).toBe(404);
  });

  it("margin floor is 0..10000 bps", async () => {
    tx();
    expect((await call(app(), "PUT", `${BASE}/buyer-discounts/settings`, { body: { minPlatformMarginBps: 10001 } })).status).toBe(400);
    expect((await call(app(), "PUT", `${BASE}/buyer-discounts/settings`, { body: { minPlatformMarginBps: 3000 } })).status).toBe(200);
    m.poolQuery.mockResolvedValue({ rows: [{ enabled: true, min_platform_margin_bps: 3000, updated_by: null, updated_at: null }] });
    expect((await call(app(), "GET", `${BASE}/buyer-discounts/settings`)).body).toMatchObject({ minPlatformMarginBps: 3000 });
  });
});

describe("contribution allowlist admin", () => {
  it("adds an active agent with an audit row; 404 for unknown users", async () => {
    tx((sql) => (sql.includes("SELECT id FROM users") ? { rows: [{ id: NODE }] } : undefined));
    const r = await call(app(), "POST", `${BASE}/contribution-allowlist`, { body: { userId: NODE, note: "launch partner" } });
    expect(r.status).toBe(201);
    expect(txSqls().some((s) => s.includes("INSERT INTO contribution_allowlist"))).toBe(true);
    tx();
    expect((await call(app(), "POST", `${BASE}/contribution-allowlist`, { body: { userId: NODE } })).status).toBe(404);
    expect((await call(app(), "POST", `${BASE}/contribution-allowlist`, { body: { userId: "x" } })).status).toBe(400);
    expect((await call(app(), "DELETE", `${BASE}/contribution-allowlist/${NODE}`)).status).toBe(404);
  });
});

describe("seed nodes", () => {
  it("sets operator_run with an audit row", async () => {
    tx((sql) => (sql.includes("UPDATE nodes n SET operator_run") ? { rows: [{ id: NODE, prev: false }] } : undefined));
    const r = await call(app(), "POST", `${BASE}/nodes/${NODE}/operator-run`, { body: { operatorRun: true, reason: "seed fleet" } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ nodeId: NODE, operatorRun: true, previous: false });
    expect(txSqls().some((s) => s.includes("INSERT INTO audit_events"))).toBe(true);
  });

  it("validates input and 404s unknown nodes", async () => {
    tx();
    expect((await call(app(), "POST", `${BASE}/nodes/x/operator-run`, { body: { operatorRun: true } })).status).toBe(400);
    expect((await call(app(), "POST", `${BASE}/nodes/${NODE}/operator-run`, { body: { operatorRun: "yes" } })).status).toBe(400);
    expect((await call(app(), "POST", `${BASE}/nodes/${NODE}/operator-run`, { body: { operatorRun: true } })).status).toBe(404);
    tx(undefined, "viewer");
    expect((await call(app(), "POST", `${BASE}/nodes/${NODE}/operator-run`, { body: { operatorRun: true } })).status).toBe(403);
  });

  it("summarises seed vs community counts and traffic", async () => {
    m.poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM relay_charges")) return { rows: [{ operator_run: true, bytes_24h: "100", gross_24h: "50", bytes_30d: "900", gross_30d: "450" }] };
      return { rows: [
        { operator_run: true, total: "4", online: "3", countries: "2", asns: "2" },
        { operator_run: false, total: "6", online: "5", countries: "3", asns: "4" },
      ] };
    });
    const r = await call(app(), "GET", `${BASE}/seed-summary`);
    expect(r.status).toBe(200);
    expect(r.body["seed"]).toMatchObject({ total: 4, online: 3, paidBytes24h: "100", paid30d: { musd: "450" } });
    expect(r.body["community"]).toMatchObject({ total: 6, online: 5, paidBytes24h: "0" });
    for (const c of m.poolQuery.mock.calls) expect(String(c[0])).not.toMatch(/SELECT \*|observed_ip/);
  });
});
