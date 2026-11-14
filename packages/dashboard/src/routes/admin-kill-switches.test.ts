import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";

const m = vi.hoisted(() => ({ poolQuery: vi.fn(), clientQuery: vi.fn(), release: vi.fn() }));

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
  return { ...actual, getPool: () => ({ query: m.poolQuery, connect: async () => ({ query: m.clientQuery, release: m.release }) }) };
});

import router from "./admin-kill-switches.js";
import { call } from "./v1/test-helpers.js";
import { KillSwitchCache, configureKillSwitches, type KillSwitchKey } from "@dominusnode/shared";
import { refusedBySwitch, refusedByRail } from "../helpers/kill-switch.js";

const BASE = "/api/admin/network";
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
beforeEach(() => { m.poolQuery.mockReset(); m.clientQuery.mockReset(); m.release.mockReset(); });

describe("GET /kill-switches", () => {
  it("lists every switch (missing rows read as off) and drained nodes", async () => {
    m.poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM kill_switches")) return { rows: [{ key: "relay_dc", engaged: true, reason: "abuse wave", updated_by: null, updated_at: new Date(0) }] };
      if (sql.includes("COUNT(*)")) return { rows: [{ n: "1" }] };
      return { rows: [{ node_id: NODE, reason: "maintenance", created_by: null, created_at: new Date(0), status: "active", ip_class: "dc", country: "DE" }] };
    });
    const r = await call(app(), "GET", `${BASE}/kill-switches`);
    expect(r.status).toBe(200);
    const b = r.body as { switches: Array<{ key: string; engaged: boolean }>; drainedNodes: { total: number; items: Array<{ nodeId: string }> }; pollIntervalMs: number };
    expect(b.switches).toHaveLength(12);
    expect(b.switches.find((s) => s.key === "relay_dc")?.engaged).toBe(true);
    expect(b.switches.find((s) => s.key === "relay")?.engaged).toBe(false);
    expect(b.drainedNodes.total).toBe(1);
    expect(b.drainedNodes.items[0]!.nodeId).toBe(NODE);
    expect(b.pollIntervalMs).toBe(5000);
    for (const c of m.poolQuery.mock.calls) expect(String(c[0])).not.toMatch(/SELECT \*|RETURNING \*/);
  });
});

describe("PUT /kill-switches/:key", () => {
  it("validates key, engaged and reason", async () => {
    tx();
    expect((await call(app(), "PUT", `${BASE}/kill-switches/bogus`, { body: { engaged: true, reason: "test" } })).status).toBe(404);
    expect((await call(app(), "PUT", `${BASE}/kill-switches/relay`, { body: { engaged: "yes", reason: "test" } })).status).toBe(400);
    expect((await call(app(), "PUT", `${BASE}/kill-switches/relay`, { body: { engaged: true } })).status).toBe(400);
    expect(m.clientQuery).not.toHaveBeenCalled();
  });

  it("engages a switch and writes an audit row in the same transaction", async () => {
    tx((sql) => {
      if (sql.includes("SELECT engaged FROM kill_switches")) return { rows: [{ engaged: false }] };
      if (sql.includes("INSERT INTO kill_switches")) return { rows: [{ key: "rail_x402", engaged: true, reason: "facilitator outage", updated_by: "u", updated_at: new Date(0) }] };
      return undefined;
    });
    const r = await call(app(), "PUT", `${BASE}/kill-switches/rail_x402`, { body: { engaged: true, reason: "facilitator outage" } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ key: "rail_x402", engaged: true, previous: false, changed: true });
    const sqls = txSqls();
    expect(sqls.some((s) => s.includes("FOR UPDATE"))).toBe(true);
    const auditCall = m.clientQuery.mock.calls.find((c) => String(c[0]).includes("INSERT INTO audit_events"));
    expect(auditCall?.[1]).toEqual(expect.arrayContaining(["kill_switch_set", "kill_switch", "rail_x402"]));
    expect(sqls.at(-1)).toMatch(/COMMIT/);
  });

  it("403 and rollback when the caller lost the admin role", async () => {
    tx(() => undefined, "none");
    const r = await call(app(), "PUT", `${BASE}/kill-switches/relay`, { body: { engaged: true, reason: "test" } });
    expect(r.status).toBe(403);
    expect(txSqls()).toContain("ROLLBACK");
  });
});

describe("node drain", () => {
  it("drains an existing node once, audited", async () => {
    tx((sql) => {
      if (sql.includes("FROM nodes")) return { rows: [{ id: NODE }] };
      if (sql.includes("INSERT INTO node_drains")) return { rows: [{ node_id: NODE }] };
      return undefined;
    });
    const r = await call(app(), "POST", `${BASE}/nodes/${NODE}/drain`, { body: { reason: "upgrade" } });
    expect(r.body).toMatchObject({ nodeId: NODE, drained: true, changed: true });
    expect(txSqls().some((s) => s.includes("INSERT INTO audit_events"))).toBe(true);
  });

  it("404 for an unknown node, 400 for a bad id or missing reason", async () => {
    tx(() => undefined);
    expect((await call(app(), "POST", `${BASE}/nodes/${NODE}/drain`, { body: { reason: "upgrade" } })).status).toBe(404);
    expect((await call(app(), "POST", `${BASE}/nodes/not-a-uuid/drain`, { body: { reason: "upgrade" } })).status).toBe(400);
    expect((await call(app(), "POST", `${BASE}/nodes/${NODE}/drain`, { body: {} })).status).toBe(400);
  });

  it("undrain removes the row and audits; no-op when not drained", async () => {
    tx((sql) => (sql.includes("DELETE FROM node_drains") ? { rows: [{ node_id: NODE, reason: "upgrade" }] } : undefined));
    const r = await call(app(), "POST", `${BASE}/nodes/${NODE}/undrain`, { body: { reason: "done" } });
    expect(r.body).toMatchObject({ drained: false, changed: true });
    expect(txSqls().some((s) => s.includes("INSERT INTO audit_events"))).toBe(true);
    m.clientQuery.mockReset(); tx();
    const r2 = await call(app(), "POST", `${BASE}/nodes/${NODE}/undrain`, { body: { reason: "done" } });
    expect(r2.body).toMatchObject({ changed: false });
    expect(txSqls().some((s) => s.includes("INSERT INTO audit_events"))).toBe(false);
  });
});

describe("agent-facing refusals", () => {
  afterEach(() => configureKillSwitches(null));
  async function install(keys: KillSwitchKey[] | "fail") {
    const c = new KillSwitchCache({ load: async () => { if (keys === "fail") throw new Error("down"); return { engaged: new Set(keys), drainedNodeIds: new Set() }; } });
    await c.refresh();
    configureKillSwitches(c);
  }
  function gated() {
    const a = express();
    a.post("/keys", (_req, res) => { if (refusedBySwitch(res, "api_keys")) return; res.json({ ok: true }); });
    a.post("/signup", (_req, res) => { if (refusedBySwitch(res, "signups")) return; res.json({ ok: true }); });
    a.post("/withdraw", (_req, res) => { if (refusedBySwitch(res, "payouts")) return; res.json({ ok: true }); });
    a.post("/topup/tempo", (_req, res) => { if (refusedByRail(res, "tempo")) return; res.json({ ok: true }); });
    return a;
  }
  it("returns 503 with code, Retry-After and X-DominusNode-Error when engaged", async () => {
    await install(["api_keys", "rail_tempo"]);
    const r = await call(gated(), "POST", "/keys");
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ code: "API_KEYS_PAUSED" });
    expect(r.headers.get("x-dominusnode-error")).toBe("API_KEYS_PAUSED");
    expect(r.headers.get("retry-after")).toBe("300");
    expect((await call(gated(), "POST", "/topup/tempo")).body).toMatchObject({ code: "PAYMENT_RAIL_PAUSED" });
    expect((await call(gated(), "POST", "/signup")).status).toBe(200);
  });
  it("fails closed when the state cannot be read", async () => {
    await install("fail");
    for (const p of ["/keys", "/signup", "/withdraw", "/topup/tempo"]) {
      const r = await call(gated(), "POST", p);
      expect(r.status).toBe(503);
      expect(r.body).toMatchObject({ code: "KILL_SWITCH_UNAVAILABLE" });
    }
  });
});
