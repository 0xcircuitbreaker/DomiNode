import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";

const m = vi.hoisted(() => ({ poolQuery: vi.fn() }));

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
  return { ...actual, getPool: () => ({ query: m.poolQuery, totalCount: 3, idleCount: 2, waitingCount: 0 }) };
});

import router from "./admin-network-metrics.js";
import { money, gb } from "./admin-network-common.js";
import { call } from "./v1/test-helpers.js";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/admin/network", router);
  return a;
}
const sqls = () => m.poolQuery.mock.calls.map((c) => String(c[0]));
const BASE = "/api/admin/network";

describe("admin network metrics", () => {
  beforeEach(() => {
    m.poolQuery.mockReset();
    m.poolQuery.mockResolvedValue({ rows: [] });
  });

  it("money/gb format µUSD and bytes as exact decimal strings", () => {
    expect(money("1234567")).toEqual({ musd: "1234567", usd: "1.234567" });
    expect(money(null)).toEqual({ musd: "0", usd: "0.000000" });
    expect(money("9007199254740993123")).toEqual({ musd: "9007199254740993123", usd: "9007199254740.993123" });
    expect(gb("1500000000")).toBe("1.500000");
  });

  it("GET /overview aggregates node, traffic, credit and payout metrics", async () => {
    m.poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM nodes n GROUP BY n.status")) return { rows: [{ status: "active", total: "3", online: "2" }, { status: "quarantined", total: "1", online: "0" }] };
      if (sql.includes("COUNT(DISTINCT s.prefix24)")) return { rows: [{ prefixes: "2", asns: "1", nodes: "2" }] };
      if (sql.includes("COUNT(DISTINCT requester_user_id)")) return { rows: [{ d1: "1", d7: "2", d30: "3" }] };
      if (sql.includes("active_owners")) return { rows: [{ owners: "2", active_owners: "1" }] };
      if (sql.includes("all_gross")) return { rows: [{ d1_bytes: "1000000000", d1_gross: "3000000", d1_platform: "2250000", d1_node: "750000", d1_charges: "1", all_gross: "9000000" }] };
      if (sql.includes("FROM node_credit_accounts")) return { rows: [{ pending: "5", available: "7", accounts: "2", frozen: "1", frozen_available: "3" }] };
      if (sql.includes("FROM node_payouts")) return { rows: [{ status: "held_frozen", count: "2", musd: "2000000" }] };
      if (sql.includes("FROM byte_disputes")) return { rows: [{ open: "4", open_nodes: "2" }] };
      return { rows: [] };
    });
    const r = await call(app(), "GET", `${BASE}/overview`);
    expect(r.status).toBe(200);
    const b = r.body as Record<string, any>;
    expect(b.nodes).toMatchObject({ total: 4, online: 2, quarantined: 1, uniquePrefixesOnline: 2, uniqueAsnsOnline: 1 });
    expect(b.nodes.byStatus.revoked).toEqual({ total: 0, online: 0 });
    expect(b.agents).toMatchObject({ requestersActive24h: 1, requestersActive7d: 2, nodeOwners: 2 });
    expect(b.traffic["24h"]).toMatchObject({ gb: "1.000000", gross: { musd: "3000000", usd: "3.000000" }, platform: { usd: "2.250000" } });
    expect(b.traffic.all.gross.usd).toBe("9.000000");
    expect(b.credits).toMatchObject({ frozenAccounts: 1, pending: { musd: "5" }, available: { musd: "7" } });
    expect(b.payouts.heldFrozen).toEqual({ count: 2, amount: { musd: "2000000", usd: "2.000000" } });
    expect(b.payouts.pending.count).toBe(0);
    expect(b.disputes).toEqual({ open: 4, nodesWithOpen: 2 });
    for (const s of sqls()) expect(s).not.toMatch(/SELECT \*|node_key_hash/);
  });

  it("GET /revenue builds a bucketed series by rail and class with totals", async () => {
    m.poolQuery.mockResolvedValue({
      rows: [
        { bucket: new Date("2026-11-01T00:00:00Z"), rail: "x402", ip_class: "residential", gross: "100", platform: "75", node: "25", bytes: "10", charges: "1" },
        { bucket: new Date("2026-11-01T00:00:00Z"), rail: "wallet", ip_class: "dc", gross: "50", platform: "40", node: "10", bytes: "5", charges: "2" },
        { bucket: new Date("2026-11-02T00:00:00Z"), rail: "x402", ip_class: "residential", gross: "1", platform: "1", node: "0", bytes: "1", charges: "1" },
      ],
    });
    const r = await call(app(), "GET", `${BASE}/revenue?bucket=day&from=2026-10-01T00:00:00Z&to=2026-11-03T00:00:00Z`);
    expect(r.status).toBe(200);
    const b = r.body as Record<string, any>;
    expect(b.series).toHaveLength(2);
    expect(b.series[0].t).toBe("2026-11-01T00:00:00.000Z");
    expect(b.series[0].gross.musd).toBe("150");
    expect(b.series[0].byRail.x402.gross.musd).toBe("100");
    expect(b.series[0].byRail.mpp.gross.musd).toBe("0");
    expect(b.series[0].byClass.dc.charges).toBe(2);
    expect(b.totals.gross.musd).toBe("151");
    expect(b.totals.byRail.x402.platform.musd).toBe("76");
    expect(m.poolQuery.mock.calls[0][1]).toEqual(["2026-10-01T00:00:00.000Z", "2026-11-03T00:00:00.000Z", "day"]);
  });

  it("GET /revenue rejects bad bucket, inverted and oversized ranges", async () => {
    expect((await call(app(), "GET", `${BASE}/revenue?bucket=minute`)).status).toBe(400);
    expect((await call(app(), "GET", `${BASE}/revenue?from=2026-11-02T00:00:00Z&to=2026-11-01T00:00:00Z`)).status).toBe(400);
    expect((await call(app(), "GET", `${BASE}/revenue?bucket=hour&from=2026-01-01T00:00:00Z&to=2026-11-01T00:00:00Z`)).status).toBe(400);
    expect(m.poolQuery).not.toHaveBeenCalled();
  });

  it("GET /revenue/top-requesters pages and validates period/limit", async () => {
    m.poolQuery.mockResolvedValue({ rows: [{ user_id: "u1", email: "e", wallet_address: null, gross: "2000000", platform: "1", node: "1", bytes: "0", charges: "3", last_at: null, total: "7" }] });
    const r = await call(app(), "GET", `${BASE}/revenue/top-requesters?period=7d&limit=5&offset=5`);
    expect(r.status).toBe(200);
    expect(r.body["total"]).toBe(7);
    expect((r.body["items"] as any[])[0].gross.usd).toBe("2.000000");
    const params = m.poolQuery.mock.calls[0][1] as unknown[];
    expect(params.slice(1)).toEqual([5, 5]);
    expect((await call(app(), "GET", `${BASE}/revenue/top-requesters?limit=1000`)).status).toBe(400);
    expect((await call(app(), "GET", `${BASE}/revenue/top-node-owners?period=1y`)).status).toBe(400);
  });

  it("GET /revenue/top-node-owners passes null since for period=all", async () => {
    const r = await call(app(), "GET", `${BASE}/revenue/top-node-owners?period=all`);
    expect(r.status).toBe(200);
    expect((m.poolQuery.mock.calls[0][1] as unknown[])[0]).toBeNull();
  });

  it("GET /network/geo merges node counts and traffic by country and ASN", async () => {
    m.poolQuery.mockImplementation(async (sql: string) => {
      const asn = sql.includes("n.asn::text");
      if (sql.includes("FROM nodes n GROUP BY")) return { rows: [{ k: asn ? "123" : "US", nodes: "2", active: "1", online: "1" }] };
      return { rows: [{ k: asn ? "123" : "US", bytes: "1000000000", gross: "3000000", node: "750000" }, { k: asn ? null : "DE", bytes: "5", gross: "1", node: "0" }] };
    });
    const r = await call(app(), "GET", `${BASE}/network/geo`);
    expect(r.status).toBe(200);
    const b = r.body as Record<string, any>;
    expect(b.byCountry[0]).toMatchObject({ country: "US", nodes: 2, onlineNodes: 1, gb: "1.000000", gross: { usd: "3.000000" } });
    expect(b.byCountry[1].country).toBe("DE");
    expect(b.byAsn[0].asn).toBe(123);
    expect(b.byAsn[1].asn).toBeNull();
  });

  it("GET /health reports job heartbeats, staleness, retry queue and pool stats", async () => {
    const old = new Date(Date.now() - 10 * 60_000);
    m.poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM job_runs")) return { rows: [{ job_name: "relay-settle-retry", instance_id: "i", last_started_at: old, last_finished_at: old, last_ok: false, last_error: "x", last_duration_ms: 5, last_success_at: null, run_count: "4", fail_count: "1" }] };
      if (sql.includes("FROM relay_settle_retries")) return { rows: [{ pending: "3", due: "1", dead: "2", oldest: null, max_attempts: 4 }] };
      if (sql.includes("FROM node_ip_slots")) return { rows: [{ instances: "2", nodes: "9", last_hb: null }] };
      return { rows: [] };
    });
    const r = await call(app(), "GET", `${BASE}/health`);
    expect(r.status).toBe(200);
    const b = r.body as Record<string, any>;
    const settle = b.jobs.find((j: any) => j.name === "relay-settle-retry");
    expect(settle).toMatchObject({ lastOk: false, runCount: 4, failCount: 1, stale: true });
    const never = b.jobs.find((j: any) => j.name === "maturity");
    expect(never).toMatchObject({ lastFinishedAt: null, stale: true });
    expect(b.settleRetryQueue).toMatchObject({ pending: 3, due: 1, dead: 2 });
    expect(b.gateway).toMatchObject({ liveInstances: 2, connectedNodes: 9 });
    expect(b.dbPool).toEqual({ total: 3, idle: 2, waiting: 0 });
    expect(sqls().some((s) => s.includes("payload"))).toBe(false);
  });

  it("GET /audit filters to network admin actions", async () => {
    m.poolQuery.mockImplementation(async (sql: string) => sql.includes("COUNT(*)") ? { rows: [{ count: "1" }] } : {
      rows: [{ id: "a", user_id: "u", email: "e", action: "node_revoke", resource: "node", resource_id: "n", ip_address: null, details: {}, created_at: new Date() }],
    });
    const r = await call(app(), "GET", `${BASE}/audit?action=node_revoke`);
    expect(r.status).toBe(200);
    expect(r.body["total"]).toBe(1);
    expect((m.poolQuery.mock.calls[0][1] as unknown[])[0]).toEqual(["node_revoke"]);
    m.poolQuery.mockClear();
    await call(app(), "GET", `${BASE}/audit`);
    expect((m.poolQuery.mock.calls[0][1] as unknown[])[0]).toContain("node_credit_unfreeze");
    expect((await call(app(), "GET", `${BASE}/audit?action=user_login`)).status).toBe(400);
    expect((await call(app(), "GET", `${BASE}/audit?adminUserId=nope`)).status).toBe(400);
  });

  it("GET /audit includes the legacy /api/admin actions", async () => {
    m.poolQuery.mockImplementation(async (sql: string) => sql.includes("COUNT(*)") ? { rows: [{ count: "0" }] } : { rows: [] });
    await call(app(), "GET", `${BASE}/audit`);
    const all = (m.poolQuery.mock.calls[0][1] as unknown[])[0] as string[];
    for (const a of ["user_suspend", "user_activate", "user_delete", "user_plan_set", "admin_role_set", "wallet_credit",
      "team_wallet_credit", "promo_create", "promo_disable", "bug_report_approve", "waitlist_cancel", "commissions_process"]) {
      expect(all).toContain(a);
    }
    expect((await call(app(), "GET", `${BASE}/audit?action=admin_role_set`)).status).toBe(200);
  });

  it("returns 500 without leaking DB errors", async () => {
    m.poolQuery.mockRejectedValue(new Error("relation secret_table does not exist"));
    const r = await call(app(), "GET", `${BASE}/overview`);
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain("secret_table");
  });
});
