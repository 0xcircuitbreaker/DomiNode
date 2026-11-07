import { describe, it, expect, vi, beforeEach } from "vitest";
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
  return {
    ...actual,
    getPool: () => ({ query: m.poolQuery, connect: async () => ({ query: m.clientQuery, release: m.release }) }),
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

beforeEach(() => {
  m.poolQuery.mockReset(); m.clientQuery.mockReset(); m.release.mockReset();
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
