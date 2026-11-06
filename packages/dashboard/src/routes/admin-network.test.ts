import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";

const ADMIN = "44444444-4444-4444-8444-444444444444";

const m = vi.hoisted(() => ({
  clientQuery: vi.fn(),
  release: vi.fn(),
  poolQuery: vi.fn(),
  getActivePolicy: vi.fn(),
  publishPolicy: vi.fn(),
  listPricing: vi.fn(),
  getSplit: vi.fn(),
  listTiers: vi.fn(),
  getTier: vi.fn(),
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { userId: "44444444-4444-4444-8444-444444444444", email: "a@x.com" };
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
    getPool: () => ({
      connect: async () => ({ query: m.clientQuery, release: m.release }),
      query: m.poolQuery,
    }),
    policyRepo: {
      getActivePolicy: m.getActivePolicy, publishPolicy: m.publishPolicy,
      publishPolicyTx: actual.policyRepo.publishPolicyTx, listPricing: m.listPricing,
      getSplit: m.getSplit, listTiers: m.listTiers, getTier: m.getTier,
    },
  };
});

import router from "./admin-network.js";
import { call } from "./v1/test-helpers.js";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/admin/network", router);
  return a;
}

/** Default tx client: admin role check passes, other statements echo a row. */
function txClient(role: string | null = "admin", row: Record<string, unknown> = {}) {
  m.clientQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM users")) return { rows: role === null ? [] : [{ admin_role: role }] };
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
    return { rows: [row] };
  });
}

const sqls = () => m.clientQuery.mock.calls.map((c) => String(c[0]));

/** The audit_events insert for `action`, asserting it ran inside the tx (after BEGIN, before COMMIT). */
function auditRow(action: string): unknown[] {
  const calls = m.clientQuery.mock.calls;
  const idx = calls.findIndex((c) => String(c[0]).includes("INSERT INTO audit_events") && (c[1] as unknown[])[1] === action);
  expect(idx).toBeGreaterThan(-1);
  const s = sqls();
  expect(s.indexOf("BEGIN")).toBeLessThan(idx);
  expect(idx).toBeLessThan(s.indexOf("COMMIT"));
  const params = calls[idx][1] as unknown[];
  expect(params[0]).toBe(ADMIN);
  return params;
}
const hasAudit = () => sqls().some((x) => x.includes("INSERT INTO audit_events"));

describe("/api/admin/network", () => {
  beforeEach(() => {
    for (const f of Object.values(m)) f.mockReset();
    txClient();
  });

  describe("policy", () => {
    it("re-checks role and publishes inside one transaction", async () => {
      txClient("admin", { version: 2 });
      m.clientQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM users")) return { rows: [{ admin_role: "admin" }] };
        if (sql.includes("FROM network_policy")) return { rows: [] };
        if (sql.includes("INSERT INTO network_policy")) return { rows: [{ version: 2 }] };
        return { rows: [] };
      });
      const r = await call(app(), "PUT", "/api/admin/network/policy", { body: { attestation: { minVersion: 2, text: "t" } } });
      expect(r.status).toBe(200);
      expect(r.body["version"]).toBe(2);
      expect(r.body["previousVersion"]).toBe(0);
      expect(r.body["attestationRaised"]).toBe(true);
      expect(m.publishPolicy).not.toHaveBeenCalled();
      const s = sqls();
      const iBegin = s.indexOf("BEGIN");
      const iRole = s.findIndex((x) => x.includes("FROM users") && x.includes("FOR UPDATE"));
      const iLock = s.findIndex((x) => x.includes("pg_advisory_xact_lock"));
      const iIns = s.findIndex((x) => x.includes("INSERT INTO network_policy"));
      const iCommit = s.indexOf("COMMIT");
      expect(s.filter((x) => x === "BEGIN")).toHaveLength(1);
      expect(iBegin).toBeLessThan(iRole);
      expect(iRole).toBeLessThan(iLock);
      expect(iLock).toBeLessThan(iIns);
      expect(iIns).toBeLessThan(iCommit);
      const a = auditRow("network_policy_publish");
      expect(a[2]).toBe("network_policy");
      expect(a[3]).toBe("2");
      expect(JSON.parse(String(a[5]))).toMatchObject({ version: 2, previousVersion: 0, attestationRaised: true });
      expect(s.findIndex((x) => x.includes("INSERT INTO audit_events"))).toBeGreaterThan(iIns);
    });

    it("returns 400 with details on validation errors and rolls back", async () => {
      m.clientQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM users")) return { rows: [{ admin_role: "admin" }] };
        return { rows: [] };
      });
      const r = await call(app(), "PUT", "/api/admin/network/policy", { body: { hardDenyPorts: [] } });
      expect(r.status).toBe(400);
      expect(Array.isArray(r.body["details"])).toBe(true);
      expect(sqls()).toContain("ROLLBACK");
      expect(sqls().some((x) => x.includes("INSERT INTO network_policy"))).toBe(false);
      expect(hasAudit()).toBe(false);
    });

    it("403s when role was revoked mid-session", async () => {
      txClient("none");
      const r = await call(app(), "PUT", "/api/admin/network/policy", { body: {} });
      expect(r.status).toBe(403);
      expect(sqls().some((x) => x.includes("network_policy"))).toBe(false);
      expect(sqls()).toContain("ROLLBACK");
    });

    it("GET returns the active policy", async () => {
      m.getActivePolicy.mockResolvedValue({ version: 5, sha256: "b".repeat(64), body: {}, createdAt: null });
      expect((await call(app(), "GET", "/api/admin/network/policy")).body["version"]).toBe(5);
    });
  });

  describe("pricing", () => {
    it("upserts a valid price", async () => {
      txClient("admin", { ip_class: "dc", price_per_gb_musd: "250000", updated_at: new Date() });
      const r = await call(app(), "PUT", "/api/admin/network/pricing", { body: { ipClass: "dc", pricePerGbMusd: 250000 } });
      expect(r.status).toBe(200);
      expect(r.body["pricePerGbMusd"]).toBe("250000");
      const ins = m.clientQuery.mock.calls.find((c) => String(c[0]).includes("network_pricing"));
      expect(ins?.[1]).toEqual(["dc", "250000", ADMIN]);
      expect(String(ins?.[0])).not.toContain("RETURNING *");
      const a = auditRow("network_pricing_update");
      expect(a.slice(2, 4)).toEqual(["network_pricing", "dc"]);
      expect(JSON.parse(String(a[5]))).toEqual({ ipClass: "dc", pricePerGbMusd: "250000" });
    });

    it.each([
      [{ ipClass: "gold", pricePerGbMusd: 250000 }],
      [{ ipClass: "dc", pricePerGbMusd: 999 }],
      [{ ipClass: "dc", pricePerGbMusd: 5000001 }],
      [{ ipClass: "dc", pricePerGbMusd: 1.5 }],
      [{ ipClass: "dc", pricePerGbMusd: "1e6" }],
    ])("rejects %j", async (body) => {
      expect((await call(app(), "PUT", "/api/admin/network/pricing", { body })).status).toBe(400);
      expect(m.clientQuery).not.toHaveBeenCalled();
    });

    it("GET serialises bigint", async () => {
      m.listPricing.mockResolvedValue([{ ipClass: "any", pricePerGbMusd: 200000n, updatedAt: new Date() }]);
      const r = await call(app(), "GET", "/api/admin/network/pricing");
      expect((r.body["pricing"] as Array<Record<string, unknown>>)[0]["pricePerGbMusd"]).toBe("200000");
    });
  });

  describe("split", () => {
    it("appends a new split row", async () => {
      txClient("admin", { id: 9, effective_from: new Date() });
      const r = await call(app(), "POST", "/api/admin/network/split", { body: { nodeShareBps: 3000, maturationHours: 72, note: "q4" } });
      expect(r.status).toBe(201);
      expect(r.body["id"]).toBe(9);
      expect(sqls().some((s) => s.includes("INSERT INTO revenue_split_config"))).toBe(true);
      expect(sqls().some((s) => /UPDATE revenue_split_config|DELETE FROM revenue_split_config/.test(s))).toBe(false);
      const a = auditRow("revenue_split_append");
      expect(a.slice(2, 4)).toEqual(["revenue_split_config", "9"]);
      expect(JSON.parse(String(a[5]))).toMatchObject({ nodeShareBps: 3000, maturationHours: 72, note: "q4" });
    });

    it.each([
      [{ nodeShareBps: 5001, maturationHours: 72 }],
      [{ nodeShareBps: -1, maturationHours: 72 }],
      [{ nodeShareBps: 3000, maturationHours: 9999 }],
      [{ nodeShareBps: 3000, maturationHours: 72, effectiveFrom: "2000-01-01T00:00:00Z" }],
      [{ nodeShareBps: 3000, maturationHours: 72, effectiveFrom: "garbage" }],
      [{ nodeShareBps: 3000, maturationHours: 72, note: "a\u0000b" }],
    ])("rejects %j", async (body) => {
      expect((await call(app(), "POST", "/api/admin/network/split", { body })).status).toBe(400);
    });
  });

  describe("tiers", () => {
    it("updates whitelisted fields only", async () => {
      txClient("admin", { id: 2 });
      m.getTier.mockResolvedValue({ id: 2, name: "bronze", dailyWithdrawLimitMusd: 1n });
      const r = await call(app(), "PUT", "/api/admin/network/tiers/2", { body: { nodeShareBps: 3100, dailyWithdrawLimitMusd: "300000000" } });
      expect(r.status).toBe(200);
      const upd = m.clientQuery.mock.calls.find((c) => String(c[0]).includes("UPDATE node_tiers"));
      expect(String(upd?.[0])).toMatch(/node_share_bps = \$2, daily_withdraw_limit_musd = \$3, updated_by = \$4/);
      expect(upd?.[1]).toEqual([2, 3100, "300000000", ADMIN]);
      const a = auditRow("node_tier_update");
      expect(a.slice(2, 4)).toEqual(["node_tier", "2"]);
      expect(JSON.parse(String(a[5]))).toEqual({ changes: { nodeShareBps: 3100, dailyWithdrawLimitMusd: "300000000" } });
    });

    it.each([
      [{ name: "x" }],
      [{ rank: 0 }],
      [{ nodeShareBps: 6000 }],
      [{ maxNodes: 0 }],
      [{ "__proto__": { a: 1 } }],
      [{}],
    ])("rejects %j", async (body) => {
      expect((await call(app(), "PUT", "/api/admin/network/tiers/2", { body })).status).toBe(400);
    });

    it("404s for an unknown tier", async () => {
      m.clientQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM users")) return { rows: [{ admin_role: "admin" }] };
        return { rows: [] };
      });
      expect((await call(app(), "PUT", "/api/admin/network/tiers/77", { body: { holdDays: 3 } })).status).toBe(404);
      expect(hasAudit()).toBe(false);
    });
  });

  describe("account unfreeze", () => {
    const U = "55555555-5555-4555-8555-555555555555";
    function unfreezeClient(found = true) {
      m.clientQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM users")) return { rows: [{ admin_role: "admin" }] };
        if (sql.includes("SELECT frozen FROM node_credit_accounts")) return { rows: found ? [{ frozen: true }] : [] };
        if (sql.includes("UPDATE node_payouts")) return { rows: [{ id: "p1", amount_musd: "2000000" }] };
        return { rows: [] };
      });
    }

    it("releases held payouts to pending with role check, lock and audit in one tx", async () => {
      unfreezeClient();
      const r = await call(app(), "POST", `/api/admin/network/accounts/${U}/unfreeze`, { body: { payouts: "release" } });
      expect(r.status).toBe(200);
      expect(r.body["payouts"]).toBe(1);
      const s = sqls();
      const iRole = s.findIndex((x) => x.includes("FROM users") && x.includes("FOR UPDATE"));
      const iLock = s.findIndex((x) => x.includes("FROM node_credit_accounts") && x.includes("FOR UPDATE"));
      const iRel = s.findIndex((x) => x.includes("status = 'pending'") && x.includes("held_frozen"));
      const iAudit = s.findIndex((x) => x.includes("INSERT INTO audit_events"));
      expect(iRole).toBeLessThan(iLock);
      expect(iLock).toBeLessThan(iRel);
      expect(iRel).toBeLessThan(iAudit);
      expect(iAudit).toBeLessThan(s.indexOf("COMMIT"));
      expect(s.some((x) => x.includes("withdraw_reversal"))).toBe(false);
    });

    it("reverses held payouts and re-credits available", async () => {
      unfreezeClient();
      const r = await call(app(), "POST", `/api/admin/network/accounts/${U}/unfreeze`, { body: { payouts: "reverse" } });
      expect(r.status).toBe(200);
      expect(r.body["musd"]).toBe("2000000");
      const s = sqls();
      expect(s.some((x) => x.includes("status = 'reversed'"))).toBe(true);
      expect(s.some((x) => x.includes("withdraw_reversal"))).toBe(true);
      expect(s.some((x) => x.includes("available_musd = available_musd + $2"))).toBe(true);
    });

    it("404s and rolls back when no account exists", async () => {
      unfreezeClient(false);
      const r = await call(app(), "POST", `/api/admin/network/accounts/${U}/unfreeze`, { body: { payouts: "release" } });
      expect(r.status).toBe(404);
      expect(sqls()).toContain("ROLLBACK");
      expect(sqls().some((x) => x.includes("audit_events"))).toBe(false);
    });

    it("validates mode and user id; 403 when role revoked", async () => {
      expect((await call(app(), "POST", `/api/admin/network/accounts/${U}/unfreeze`, { body: { payouts: "x" } })).status).toBe(400);
      expect((await call(app(), "POST", "/api/admin/network/accounts/nope/unfreeze", { body: { payouts: "release" } })).status).toBe(400);
      txClient("none");
      const r = await call(app(), "POST", `/api/admin/network/accounts/${U}/unfreeze`, { body: { payouts: "release" } });
      expect(r.status).toBe(403);
      expect(sqls().some((x) => x.includes("node_credit_accounts"))).toBe(false);
    });
  });
});
