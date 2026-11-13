import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";

const m = vi.hoisted(() => ({
  poolQuery: vi.fn(), clientQuery: vi.fn(), release: vi.fn(),
  markPayoutReversedTx: vi.fn(), freezeAccountTx: vi.fn(), getActivePolicy: vi.fn(),
}));

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
    payoutRepo: { ...actual.payoutRepo, markPayoutReversedTx: m.markPayoutReversedTx, freezeAccountTx: m.freezeAccountTx },
    policyRepo: { ...actual.policyRepo, getActivePolicy: m.getActivePolicy },
  };
});

import router from "./admin-network-ops.js";
import { call } from "./v1/test-helpers.js";

const BASE = "/api/admin/network";
const NODE = "66666666-6666-4666-8666-666666666666";
const USER = "55555555-5555-4555-8555-555555555555";
const PAYOUT = "88888888-8888-4888-8888-888888888888";

function app() {
  const a = express();
  a.use(express.json());
  a.use(BASE, router);
  return a;
}
const poolSqls = () => m.poolQuery.mock.calls.map((c) => String(c[0]));
const txSqls = () => m.clientQuery.mock.calls.map((c) => String(c[0]));

/** Tx client: admin role check passes; handler(sql, params) answers the rest. */
function tx(handler: (sql: string, p: unknown[]) => { rows: unknown[] } | undefined = () => undefined, role = "admin") {
  m.clientQuery.mockImplementation(async (sql: string, p: unknown[] = []) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
    if (sql.includes("SELECT admin_role FROM users")) return { rows: [{ admin_role: role }] };
    return handler(sql, p) ?? { rows: [] };
  });
}

const nodeRow = (o: Record<string, unknown> = {}) => ({
  id: NODE, owner_user_id: USER, owner_wallet: "0x" + "b".repeat(40), node_pubkey: null, status: "active",
  attestation_version: 1, observed_ip: "1.2.3.4", ip_prefix24: "1.2.3.0/24", asn: "123", country: "US", ip_class: "residential",
  max_streams: 32, max_gb_day: 5, reputation: 3000, byte_disputes: 0, agent_version: "1.0", last_seen_at: null,
  created_at: new Date(), online: true, ...o,
});

describe("admin network ops", () => {
  beforeEach(() => {
    for (const f of Object.values(m)) f.mockReset();
    m.poolQuery.mockResolvedValue({ rows: [] });
    tx();
  });

  describe("GET /nodes", () => {
    it("filters, sorts and pages without exposing key hashes", async () => {
      m.poolQuery.mockImplementation(async (sql: string) => sql.startsWith("SELECT COUNT(*)")
        ? { rows: [{ count: "12" }] }
        : { rows: [{ ...nodeRow(), node_key_hash: "h".repeat(64), owner_email: "o@x", bytes_24h: "1000000000", bytes_30d: "2000000000", open_disputes: "1" }] });
      const r = await call(app(), "GET", `${BASE}/nodes?status=active&country=us&asn=123&ip_class=residential&owner=${USER}&online=true&quarantined=false&search=1.2_&sort=bytes&order=asc&limit=10&offset=10`);
      expect(r.status).toBe(200);
      expect(r.body["total"]).toBe(12);
      const item = (r.body["items"] as any[])[0];
      expect(item).toMatchObject({ id: NODE, asn: 123, gbToday: "1.000000", gb30d: "2.000000", openDisputes: 1, online: true });
      expect(JSON.stringify(r.body)).not.toContain("hhhh");
      const [sql, params] = m.poolQuery.mock.calls.find((c) => !String(c[0]).startsWith("SELECT COUNT"))!;
      expect(sql).not.toMatch(/node_key_hash|floor_hash|SELECT \*/);
      expect(sql).toContain("ORDER BY COALESCE(st.bytes_30d, 0) ASC");
      expect(params).toEqual(["active", "US", 123, "residential", USER, true, false, "%1.2\\_%", 10, 10]);
    });

    it("shows verified vs declared class and open egress-mismatch flags; accepts ip_class=masked", async () => {
      m.poolQuery.mockImplementation(async (sql: string) => sql.startsWith("SELECT COUNT(*)")
        ? { rows: [{ count: "1" }] }
        : { rows: [nodeRow({ ip_class: "masked", declared_class: "residential", class_verified_at: new Date(0), egress_flags: 1 })] });
      const r = await call(app(), "GET", `${BASE}/nodes?ip_class=masked`);
      expect(r.status).toBe(200);
      expect((r.body["items"] as any[])[0]).toMatchObject({ verifiedClass: "masked", declaredClass: "residential", openEgressMismatchFlags: 1 });
      const [sql] = m.poolQuery.mock.calls.find((c) => !String(c[0]).startsWith("SELECT COUNT"))!;
      expect(sql).toContain("egress_mismatch");
    });

    it("rejects invalid filters", async () => {
      for (const qs of ["status=bogus", "country=USA", "asn=-1", "owner=x", "online=yes", "sort=email", "limit=0", "offset=-1", "limit=201"]) {
        expect((await call(app(), "GET", `${BASE}/nodes?${qs}`)).status, qs).toBe(400);
      }
      expect(m.poolQuery).not.toHaveBeenCalled();
    });
  });

  describe("GET /nodes/:id", () => {
    it("returns detail sections", async () => {
      m.poolQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("owner_tier")) return { rows: [{ ...nodeRow(), owner_email: "o", owner_status: "active", owner_tier: "bronze" }] };
        if (sql.includes("FROM node_daily_stats")) return { rows: [{ day: "2026-11-06", bytes: "1000000000", streams: 1, failures: 0, burns: 0 }] };
        if (sql.includes("FROM byte_disputes")) return { rows: [{ id: "1", relay_charge_id: null, bytes_gateway: "10", bytes_node: "5", status: "open", created_at: new Date(), resolved_at: null }] };
        if (sql.includes("GROUP BY 1 ORDER BY 1 DESC")) return { rows: [{ day: "2026-11-06", gross: "3000000", node: "750000", platform: "2250000", bytes: "1", charges: "1", requesters: "1" }] };
        return { rows: [] };
      });
      const r = await call(app(), "GET", `${BASE}/nodes/${NODE}`);
      expect(r.status).toBe(200);
      const b = r.body as Record<string, any>;
      expect(b.node.ownerTier).toBe("bronze");
      expect(b.dailyStats[0].gb).toBe("1.000000");
      expect(b.disputes).toHaveLength(1);
      expect(b.chargesDaily[0].node.usd).toBe("0.750000");
      for (const s of poolSqls()) expect(s).not.toMatch(/node_key_hash|SELECT \*/);
    });

    it("404s and 400s", async () => {
      expect((await call(app(), "GET", `${BASE}/nodes/${NODE}`)).status).toBe(404);
      expect((await call(app(), "GET", `${BASE}/nodes/abc`)).status).toBe(400);
    });
  });

  describe("node actions", () => {
    it("quarantines in one admin tx with FOR UPDATE and an audit row", async () => {
      tx((sql) => sql.includes("FROM nodes n") ? { rows: [{ status: "active", owner_status: "active" }] } : undefined);
      const r = await call(app(), "POST", `${BASE}/nodes/${NODE}/quarantine`, { body: { reason: "probe failures" } });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ previousStatus: "active", status: "quarantined", changed: true });
      const s = txSqls();
      const iRole = s.findIndex((x) => x.includes("admin_role"));
      const iLock = s.findIndex((x) => x.includes("FOR UPDATE OF n"));
      const iUpd = s.findIndex((x) => x.startsWith("UPDATE nodes SET status"));
      const iAudit = s.findIndex((x) => x.includes("INSERT INTO audit_events"));
      expect(s[0]).toBe("BEGIN");
      expect(iRole).toBeLessThan(iLock);
      expect(iLock).toBeLessThan(iUpd);
      expect(iUpd).toBeLessThan(iAudit);
      expect(s[s.length - 1]).toBe("COMMIT");
      const auditParams = m.clientQuery.mock.calls[iAudit][1] as unknown[];
      expect(auditParams[1]).toBe("node_quarantine");
      expect(JSON.parse(String(auditParams[5]))).toMatchObject({ from: "active", to: "quarantined", reason: "probe failures" });
    });

    it("requires a reason for quarantine/revoke", async () => {
      expect((await call(app(), "POST", `${BASE}/nodes/${NODE}/revoke`, { body: {} })).status).toBe(400);
      expect((await call(app(), "POST", `${BASE}/nodes/${NODE}/quarantine`, { body: { reason: "a\nb" } })).status).toBe(400);
    });

    it("409s on invalid transitions and rolls back", async () => {
      tx((sql) => sql.includes("FROM nodes n") ? { rows: [{ status: "revoked", owner_status: "active" }] } : undefined);
      const r = await call(app(), "POST", `${BASE}/nodes/${NODE}/activate`, { body: {} });
      expect(r.status).toBe(409);
      expect(txSqls()).toContain("ROLLBACK");
      expect(txSqls().some((x) => x.startsWith("UPDATE nodes"))).toBe(false);
    });

    it("clear-penalty: lifts a revoked-while-quarantined penalty with an audit row", async () => {
      tx((sql) => sql.includes("FROM nodes WHERE id") ? { rows: [{ status: "revoked", revoked_from_status: "quarantined" }] } : undefined);
      const r = await call(app(), "POST", `${BASE}/nodes/${NODE}/clear-penalty`, { body: { reason: "false-positive probe quarantine" } });
      expect(r.status).toBe(200);
      const s = txSqls();
      expect(s.some((x) => x.includes("SET revoked_from_status = NULL"))).toBe(true);
      const iAudit = s.findIndex((x) => x.includes("audit_events"));
      expect((m.clientQuery.mock.calls[iAudit][1] as unknown[])[1]).toBe("node_penalty_clear");
    });

    it("clear-penalty: 409 without a penalty, 400 without a reason", async () => {
      tx((sql) => sql.includes("FROM nodes WHERE id") ? { rows: [{ status: "revoked", revoked_from_status: "active" }] } : undefined);
      expect((await call(app(), "POST", `${BASE}/nodes/${NODE}/clear-penalty`, { body: { reason: "x" } })).status).toBe(409);
      expect((await call(app(), "POST", `${BASE}/nodes/${NODE}/clear-penalty`, { body: {} })).status).toBe(400);
    });

    it("refuses to activate a node whose owner is suspended", async () => {
      tx((sql) => sql.includes("FROM nodes n") ? { rows: [{ status: "quarantined", owner_status: "suspended" }] } : undefined);
      expect((await call(app(), "POST", `${BASE}/nodes/${NODE}/activate`, { body: {} })).status).toBe(409);
    });

    it("is a no-op when already in the target status", async () => {
      tx((sql) => sql.includes("FROM nodes n") ? { rows: [{ status: "revoked", owner_status: "active" }] } : undefined);
      const r = await call(app(), "POST", `${BASE}/nodes/${NODE}/revoke`, { body: { reason: "x" } });
      expect(r.status).toBe(200);
      expect(r.body["changed"]).toBe(false);
      expect(txSqls().some((x) => x.includes("audit_events"))).toBe(false);
    });

    it("403s when the role was revoked and 404s unknown nodes", async () => {
      tx(undefined, "none");
      expect((await call(app(), "POST", `${BASE}/nodes/${NODE}/revoke`, { body: { reason: "x" } })).status).toBe(403);
      tx();
      expect((await call(app(), "POST", `${BASE}/nodes/${NODE}/revoke`, { body: { reason: "x" } })).status).toBe(404);
    });
  });

  describe("agents", () => {
    const agentRow = { id: USER, email: "b@x", wallet_address: null, status: "active", created_at: new Date(), tier: "silver", node_tier_id: 3,
      spend_total: "0", spend_30d: "0", bytes_total: "0", last_request_at: null, earn_total: "2500000", earn_30d: "1000000",
      nodes: 2, active_nodes: 1, online_nodes: 1, credit_pending: "1", credit_available: "2", frozen: true, wallet_cents: 150 };

    it("GET /agents lists with money fields and role filter", async () => {
      m.poolQuery.mockResolvedValue({ rows: [{ ...agentRow, total: "1" }] });
      const r = await call(app(), "GET", `${BASE}/agents?role=node_owner&frozen=true&sort=earnings&search=b%40`);
      expect(r.status).toBe(200);
      const a = (r.body["items"] as any[])[0];
      expect(a).toMatchObject({ isNodeOwner: true, isRequester: false, tier: "silver", earnings: { usd: "2.500000" }, walletBalance: { musd: "1500000", usd: "1.500000" } });
      expect(a.credits.frozen).toBe(true);
      const params = m.poolQuery.mock.calls[0][1] as unknown[];
      expect(params.slice(0, 5)).toEqual(["node_owner", true, null, null, "%b@%"]);
      expect(String(m.poolQuery.mock.calls[0][0])).not.toMatch(/password_hash|key_hash|SELECT \*/);
    });

    it("GET /agents/:id returns detail or 404", async () => {
      expect((await call(app(), "GET", `${BASE}/agents/${USER}`)).status).toBe(404);
      m.poolQuery.mockImplementation(async (sql: string) => sql.includes("WITH ids") ? { rows: [agentRow] } : { rows: [] });
      const r = await call(app(), "GET", `${BASE}/agents/${USER}`);
      expect(r.status).toBe(200);
      expect(r.body["creditAccount"]).toBeNull();
      expect((r.body["agent"] as any).userId).toBe(USER);
    });
  });

  describe("credits and payouts", () => {
    it("GET /credits/accounts filters frozen", async () => {
      m.poolQuery.mockImplementation(async (sql: string) => sql.startsWith("SELECT COUNT") ? { rows: [{ count: "1" }] } : {
        rows: [{ user_id: USER, email: "e", wallet_address: null, pending_musd: "10", available_musd: "20", frozen: true, auto_convert_pct: 0, tax_form_status: "not_required", ytd_paid_musd: "0", updated_at: new Date(), held_payouts: "5" }],
      });
      const r = await call(app(), "GET", `${BASE}/credits/accounts?frozen=true`);
      expect(r.status).toBe(200);
      expect((r.body["items"] as any[])[0]).toMatchObject({ frozen: true, available: { musd: "20" }, heldPayouts: { musd: "5" } });
      expect((m.poolQuery.mock.calls[0][1] as unknown[])[0]).toBe(true);
    });

    it("GET /payouts never selects signer data", async () => {
      m.poolQuery.mockImplementation(async (sql: string) => sql.startsWith("SELECT COUNT") ? { rows: [{ count: "1", musd: "1000000" }] } : {
        rows: [{ id: PAYOUT, user_id: USER, email: "e", amount_musd: "1000000", trigger: "auto", status: "held_tax", batch_id: null, tx_hash: null, failure_reason: null, created_at: new Date(), updated_at: new Date(), wallet_address: "0x" + "a".repeat(40), chain: "base", wallet_status: "active" }],
      });
      const r = await call(app(), "GET", `${BASE}/payouts?status=held_tax`);
      expect(r.status).toBe(200);
      expect(r.body["totalAmount"]).toEqual({ musd: "1000000", usd: "1.000000" });
      expect((r.body["items"] as any[])[0].payoutWallet.chain).toBe("base");
      for (const s of poolSqls()) expect(s).not.toMatch(/change_sig|idempotency_key|SELECT \*/);
      expect((await call(app(), "GET", `${BASE}/payouts?status=sent`)).status).toBe(400);
    });

    it("POST /payouts/:id/reverse calls the repo and audits in the admin tx", async () => {
      m.markPayoutReversedTx.mockResolvedValue({ id: PAYOUT, userId: USER, amountMusd: 1_000_000n, status: "reversed", txHash: null });
      const r = await call(app(), "POST", `${BASE}/payouts/${PAYOUT}/reverse`, { body: { reason: "wrong wallet" } });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ status: "reversed", amount: { usd: "1.000000" } });
      // Runs on the admin tx client (not its own withTx), so role check + reversal + audit commit together.
      const [client, id, why] = m.markPayoutReversedTx.mock.calls[0];
      expect((client as { query: unknown }).query).toBe(m.clientQuery);
      expect([id, why]).toEqual([PAYOUT, "admin: wrong wallet"]);
      expect(txSqls().some((s) => s.includes("INSERT INTO audit_events"))).toBe(true);
      expect(txSqls()).toContain("COMMIT");
    });

    it("POST /payouts/:id/reverse maps repo errors to 404/409 and rolls back the audit", async () => {
      m.markPayoutReversedTx.mockRejectedValueOnce(new Error("Cannot reverse a confirmed payout"));
      const r = await call(app(), "POST", `${BASE}/payouts/${PAYOUT}/reverse`, { body: { reason: "x" } });
      expect(r.status).toBe(409);
      expect(txSqls()).toContain("ROLLBACK");
      expect(txSqls().some((s) => s.includes("audit_events"))).toBe(false);
      m.markPayoutReversedTx.mockRejectedValueOnce(new Error("Payout not found"));
      expect((await call(app(), "POST", `${BASE}/payouts/${PAYOUT}/reverse`, { body: { reason: "x" } })).status).toBe(404);
      expect((await call(app(), "POST", `${BASE}/payouts/${PAYOUT}/reverse`, { body: {} })).status).toBe(400);
    });

    it("POST /accounts/:userId/freeze uses freezeAccountTx in the admin tx", async () => {
      tx((sql) => sql.includes("SELECT id FROM users") ? { rows: [{ id: USER }] } : undefined);
      m.freezeAccountTx.mockResolvedValue(2);
      const r = await call(app(), "POST", `${BASE}/accounts/${USER}/freeze`, { body: { reason: "fraud review" } });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ frozen: true, heldPayouts: 2, wasFrozen: false });
      expect(m.freezeAccountTx).toHaveBeenCalledTimes(1);
      expect(txSqls().some((s) => s.includes("INSERT INTO audit_events"))).toBe(true);
    });

    it("freeze 404s unknown users and requires a reason", async () => {
      expect((await call(app(), "POST", `${BASE}/accounts/${USER}/freeze`, { body: { reason: "x" } })).status).toBe(404);
      expect(m.freezeAccountTx).not.toHaveBeenCalled();
      expect((await call(app(), "POST", `${BASE}/accounts/${USER}/freeze`, { body: {} })).status).toBe(400);
    });
  });

  describe("disputes", () => {
    it("GET /disputes computes diff", async () => {
      m.poolQuery.mockImplementation(async (sql: string) => sql.startsWith("SELECT COUNT") ? { rows: [{ count: "1" }] } : {
        rows: [{ id: "1", relay_charge_id: "c", node_id: NODE, owner_user_id: USER, bytes_gateway: "2000", bytes_node: "1000", status: "open", created_at: new Date(), resolved_at: null, gross_musd: "6", node_musd: "1", payment_rail: "x402", requester_user_id: null }],
      });
      const r = await call(app(), "GET", `${BASE}/disputes?status=open`);
      expect((r.body["items"] as any[])[0]).toMatchObject({ bytesDiff: "1000", diffBps: 5000, gross: { musd: "6" } });
    });

    it("resolve releases the charge when the gateway count is upheld", async () => {
      tx((sql) => {
        if (sql.includes("FROM byte_disputes WHERE id")) return { rows: [{ status: "open", relay_charge_id: "c1", node_id: NODE }] };
        if (sql.includes("COUNT(*)")) return { rows: [{ n: "0" }] };
        return undefined;
      });
      const r = await call(app(), "POST", `${BASE}/disputes/1/resolve`, { body: { resolution: "resolved_gateway" } });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ status: "resolved_gateway", chargeReleased: true });
      expect(txSqls().some((s) => s.includes("UPDATE relay_charges SET disputed = false"))).toBe(true);
      expect(txSqls().some((s) => s.includes("FOR UPDATE"))).toBe(true);
    });

    it("resolved_node keeps the charge held", async () => {
      tx((sql) => sql.includes("FROM byte_disputes WHERE id") ? { rows: [{ status: "open", relay_charge_id: "c1", node_id: NODE }] } : undefined);
      const r = await call(app(), "POST", `${BASE}/disputes/1/resolve`, { body: { resolution: "resolved_node" } });
      expect(r.body["chargeReleased"]).toBe(false);
      expect(txSqls().some((s) => s.includes("UPDATE relay_charges"))).toBe(false);
    });

    it("validates and 409s on already-resolved disputes", async () => {
      expect((await call(app(), "POST", `${BASE}/disputes/1/resolve`, { body: { resolution: "open" } })).status).toBe(400);
      expect((await call(app(), "POST", `${BASE}/disputes/x/resolve`, { body: { resolution: "dismissed" } })).status).toBe(400);
      tx((sql) => sql.includes("FROM byte_disputes WHERE id") ? { rows: [{ status: "dismissed", relay_charge_id: null, node_id: null }] } : undefined);
      expect((await call(app(), "POST", `${BASE}/disputes/1/resolve`, { body: { resolution: "dismissed" } })).status).toBe(409);
    });
  });

  describe("abuse log", () => {
    it("audits each access, applies retention and returns metadata only", async () => {
      m.getActivePolicy.mockResolvedValue({ body: { logRetentionDays: 30 } });
      tx((sql) => {
        if (sql.includes("COUNT(*)")) return { rows: [{ count: "1" }] };
        if (sql.includes("FROM relay_abuse_log")) return { rows: [{ id: "1", ts: new Date(), session_id: "s", requester_user_id: USER, node_id: NODE, dest_host: "example.com", dest_port: 443, bytes: "10" }] };
        return undefined;
      });
      const r = await call(app(), "GET", `${BASE}/abuse-log?nodeId=${NODE}&host=Example.com`);
      expect(r.status).toBe(200);
      expect(r.body["retentionDays"]).toBe(30);
      expect(Object.keys((r.body["items"] as any[])[0]).sort()).toEqual(["bytes", "destHost", "destPort", "id", "nodeId", "requesterUserId", "sessionId", "ts"]);
      const s = txSqls();
      const iAudit = s.findIndex((x) => x.includes("INSERT INTO audit_events"));
      const iRead = s.findIndex((x) => x.includes("FROM relay_abuse_log l") && !x.includes("COUNT"));
      expect(iAudit).toBeGreaterThan(-1);
      expect(iAudit).toBeLessThan(iRead);
      const params = m.clientQuery.mock.calls[iRead][1] as unknown[];
      expect(params.slice(2, 6)).toEqual([30, NODE, null, "example.com"]);
    });

    it("caps the window at 31 days and validates host", async () => {
      expect((await call(app(), "GET", `${BASE}/abuse-log?from=2026-01-01T00:00:00Z&to=2026-03-01T00:00:00Z`)).status).toBe(400);
      expect((await call(app(), "GET", `${BASE}/abuse-log?host=a%20b`)).status).toBe(400);
      expect(m.clientQuery).not.toHaveBeenCalled();
    });
  });
});
