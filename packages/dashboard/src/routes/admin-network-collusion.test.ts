import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";

const m = vi.hoisted(() => ({ poolQuery: vi.fn(), clientQuery: vi.fn(), release: vi.fn(), getSettings: vi.fn() }));

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
    collusionRepo: { ...actual.collusionRepo, getSettings: m.getSettings },
  };
});

import router from "./admin-network-collusion.js";
import { call } from "./v1/test-helpers.js";

const BASE = "/api/admin/network";
const OWNER = "55555555-5555-4555-8555-555555555555";

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
  m.poolQuery.mockReset(); m.clientQuery.mockReset(); m.release.mockReset(); m.getSettings.mockReset();
  m.getSettings.mockResolvedValue({
    windowDays: 30, minNodeVolumeMusd: 5_000_000n, concentrationBps: 8000, clusterSize: 3, clusterBps: 9500,
    circularMinMusd: 1_000_000n, autoFreeze: false, freezeBps: 9500, freezeMinVolumeMusd: 50_000_000n, updatedBy: null, updatedAt: null,
  });
});

describe("GET /collusion/flags", () => {
  it("lists open flags by default with money fields and filters", async () => {
    m.poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("COUNT(*)")) return { rows: [{ count: "1" }] };
      return { rows: [{
        id: "7", kind: "concentration", owner_user_id: OWNER, owner_email: "o@example.com", node_id: null, requester_user_id: null,
        requester_email: null, share_bps: 9000, volume_musd: "9000000", total_musd: "10000000", window_days: 30, status: "open",
        auto_frozen: false, frozen: null, resolved_by: null, resolution_note: null, first_seen_at: new Date(0), last_seen_at: new Date(0), resolved_at: null,
      }] };
    });
    const r = await call(app(), "GET", `${BASE}/collusion/flags?kind=concentration&ownerUserId=${OWNER}`);
    expect(r.status).toBe(200);
    const b = r.body as { total: number; items: Array<Record<string, unknown>> };
    expect(b.total).toBe(1);
    expect(b.items[0]).toMatchObject({ id: "7", shareBps: 9000, volume: { musd: "9000000" }, ownerCreditsFrozen: false });
    const [sql, params] = m.poolQuery.mock.calls[0];
    expect(sql).not.toMatch(/SELECT \*/);
    expect(params.slice(0, 3)).toEqual(["open", "concentration", OWNER]);
  });

  it("validates query params", async () => {
    expect((await call(app(), "GET", `${BASE}/collusion/flags?status=bogus`)).status).toBe(400);
    expect((await call(app(), "GET", `${BASE}/collusion/flags?ownerUserId=x`)).status).toBe(400);
  });
});

describe("POST /collusion/flags/:id/(dismiss|confirm)", () => {
  it("resolves an open flag and audits it", async () => {
    tx((sql) => (sql.includes("UPDATE collusion_flags") ? { rows: [{ id: "7", owner_user_id: OWNER }] } : undefined));
    const r = await call(app(), "POST", `${BASE}/collusion/flags/7/dismiss`, { body: { note: "same household, verified" } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: "7", status: "dismissed" });
    expect(txSqls().some((s) => s.includes("INSERT INTO audit_events"))).toBe(true);
  });

  it("404 for a missing/closed flag, 400 for a bad id or note, 403 for non-admins", async () => {
    tx();
    expect((await call(app(), "POST", `${BASE}/collusion/flags/7/confirm`, { body: {} })).status).toBe(404);
    expect((await call(app(), "POST", `${BASE}/collusion/flags/abc/confirm`, { body: {} })).status).toBe(400);
    expect((await call(app(), "POST", `${BASE}/collusion/flags/7/confirm`, { body: { note: "a\nb" } })).status).toBe(400);
    tx(undefined, "viewer");
    expect((await call(app(), "POST", `${BASE}/collusion/flags/7/confirm`, { body: {} })).status).toBe(403);
  });
});

describe("collusion settings", () => {
  it("GET returns settings with auto-freeze off by default", async () => {
    const r = await call(app(), "GET", `${BASE}/collusion/settings`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ autoFreeze: false, concentrationBps: 8000, freezeMinVolume: { musd: "50000000" } });
  });

  it("PUT updates validated fields in an audited admin transaction", async () => {
    tx();
    const r = await call(app(), "PUT", `${BASE}/collusion/settings`, { body: { autoFreeze: true, freezeBps: 9800, freezeMinVolumeMusd: "100000000" } });
    expect(r.status).toBe(200);
    const upd = m.clientQuery.mock.calls.find((c) => String(c[0]).startsWith("UPDATE collusion_settings"))!;
    expect(String(upd[0])).toMatch(/freeze_bps = \$1, freeze_min_volume_musd = \$2::bigint, auto_freeze = \$3, updated_by = \$4/);
    expect(upd[1]).toEqual([9800, "100000000", true, "44444444-4444-4444-8444-444444444444"]);
    expect(txSqls().some((s) => s.includes("INSERT INTO audit_events"))).toBe(true);
  });

  it("PUT rejects unknown fields and out-of-range values", async () => {
    tx();
    for (const body of [{}, { bogus: 1 }, { concentrationBps: 0 }, { windowDays: 91 }, { autoFreeze: "yes" }, { circularMinMusd: 5 }, { freezeMinVolumeMusd: "1".repeat(14) }, { __proto__x: 1 }]) {
      expect((await call(app(), "PUT", `${BASE}/collusion/settings`, { body })).status).toBe(400);
    }
  });
});
