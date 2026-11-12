/**
 * Every mutating legacy /api/admin route requires a reason (3..500 chars) and
 * writes an audit_events row on the same transaction client as the change.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import http from "http";

const ADMIN = "99999999-9999-4999-8999-999999999999";
const T = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const { clientQuery, release, client, m, f } = vi.hoisted(() => {
  const clientQuery = vi.fn();
  const release = vi.fn();
  const client = { query: clientQuery, release };
  const m = {
    suspendUser: vi.fn(), reactivateUser: vi.fn(), deleteUser: vi.fn(), setAdminRole: vi.fn(),
    findUserById: vi.fn(), revokeAllApiKeys: vi.fn(), revokeAllForUser: vi.fn(),
    findById: vi.fn(), markNotified: vi.fn(), getPendingEmails: vi.fn(), bulkNotify: vi.fn(), cancelEntry: vi.fn(),
    setUserPlan: vi.fn(), creditWallet: vi.fn(), adminCreditTeamWallet: vi.fn(),
    createPromoCode: vi.fn(), disablePromoCode: vi.fn(),
    creditPendingLoyaltyRewards: vi.fn(), creditPendingCommissions: vi.fn(), calculateAndRecordMonthlyReward: vi.fn(),
    dbQuery: vi.fn(),
  };
  const f = (k: keyof typeof m) => (...a: unknown[]) => m[k](...a);
  return { clientQuery, release, client, m, f };
});

vi.mock("@dominusnode/shared", () => ({
  adminRepo: {
    suspendUser: f("suspendUser"), reactivateUser: f("reactivateUser"), deleteUser: f("deleteUser"),
    setAdminRole: f("setAdminRole"), isRootAdmin: (u: { admin_role?: string } | null) => u?.admin_role === "root_admin",
  },
  userRepo: { findUserById: f("findUserById"), revokeAllApiKeys: f("revokeAllApiKeys") },
  refreshTokenRepo: { revokeAllForUser: f("revokeAllForUser") },
  waitlistRepo: {
    findById: f("findById"), markNotified: f("markNotified"), getPendingEmails: f("getPendingEmails"),
    bulkNotify: f("bulkNotify"), cancelEntry: f("cancelEntry"),
  },
  planRepo: { setUserPlan: f("setUserPlan") },
  walletRepo: { creditWallet: f("creditWallet") },
  teamRepo: { adminCreditTeamWallet: f("adminCreditTeamWallet") },
  referralRepo: {
    createPromoCode: f("createPromoCode"), disablePromoCode: f("disablePromoCode"),
    creditPendingLoyaltyRewards: f("creditPendingLoyaltyRewards"), creditPendingCommissions: f("creditPendingCommissions"),
    calculateAndRecordMonthlyReward: f("calculateAndRecordMonthlyReward"),
  },
  sendWaitlistApprovalEmail: vi.fn(async () => undefined),
  sanitizeString: (s: string, n: number) => s.slice(0, n),
  hasMinRole: (u: string, r: string) => {
    const k: Record<string, number> = { none: 0, admin: 1, cybersecurity_admin: 2, root_admin: 3 };
    return (k[u] ?? 0) >= (k[r] ?? 0);
  },
  getProxyInternalPort: () => { throw new Error("no proxy in tests"); },
  query: f("dbQuery"),
  getPool: () => ({ connect: async () => client }),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  PolicyValidationError: class extends Error { errors: string[] = []; },
}));
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _r: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: object }).user = { userId: ADMIN, adminRole: "root_admin", isAdmin: true };
    next();
  },
}));
vi.mock("../middleware/admin.js", () => {
  const pt = (_q: unknown, _s: unknown, n: () => void) => n();
  return { requireAdmin: pt, requireCybersecurityAdmin: pt, requireRootAdmin: pt };
});

import adminRouter from "./admin.js";

function call(method: string, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminRouter);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const data = body === undefined ? "" : JSON.stringify(body);
      const r = http.request({ hostname: "127.0.0.1", port, path, method,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => { server.close(); resolve({ status: res.statusCode!, body: out ? JSON.parse(out) : {} }); });
      });
      r.on("error", (e) => { server.close(); reject(e); });
      r.end(data);
    });
  });
}

function auditRows(): Array<{ action: string; resource: string; resourceId: string; details: Record<string, unknown> }> {
  return clientQuery.mock.calls
    .filter((c) => String(c[0]).includes("INSERT INTO audit_events"))
    .map((c) => {
      const p = c[1] as unknown[];
      expect(p[0]).toBe(ADMIN);
      return { action: p[1] as string, resource: p[2] as string, resourceId: p[3] as string, details: JSON.parse(p[5] as string) };
    });
}

function sql(): string[] {
  return clientQuery.mock.calls.map((c) => String(c[0]));
}

const REASON = "ticket #1234 abuse";

interface Case {
  name: string; method: string; path: string; body: Record<string, unknown>;
  mutation: keyof typeof m; action: string; resourceId: string; extra?: Record<string, unknown>;
}

const cases: Case[] = [
  { name: "suspend", method: "PUT", path: `/api/admin/users/${T}/suspend`, body: {}, mutation: "suspendUser", action: "user_suspend", resourceId: T, extra: { previousStatus: "active", newStatus: "suspended" } },
  { name: "activate", method: "PUT", path: `/api/admin/users/${T}/activate`, body: {}, mutation: "reactivateUser", action: "user_activate", resourceId: T, extra: { previousStatus: "suspended", newStatus: "active" } },
  { name: "delete", method: "DELETE", path: `/api/admin/users/${T}`, body: {}, mutation: "deleteUser", action: "user_delete", resourceId: T },
  { name: "plan", method: "PUT", path: `/api/admin/users/${T}/plan`, body: { planId: "pro" }, mutation: "setUserPlan", action: "user_plan_set", resourceId: T, extra: { previousPlanId: "free", newPlanId: "pro" } },
  { name: "credit user wallet", method: "POST", path: "/api/admin/credit-wallet", body: { targetUserId: T, amountCents: 500 }, mutation: "creditWallet", action: "wallet_credit", resourceId: T, extra: { amountCents: 500 } },
  { name: "credit team wallet", method: "POST", path: "/api/admin/credit-wallet", body: { teamId: T, amountCents: 700 }, mutation: "adminCreditTeamWallet", action: "team_wallet_credit", resourceId: T, extra: { amountCents: 700 } },
  { name: "waitlist approve", method: "POST", path: `/api/admin/waitlist/${T}/approve`, body: {}, mutation: "markNotified", action: "waitlist_approve", resourceId: T },
  { name: "waitlist bulk approve", method: "POST", path: "/api/admin/waitlist/bulk-approve", body: { count: 2 }, mutation: "bulkNotify", action: "waitlist_bulk_approve", resourceId: "bulk", extra: { approved: 2 } },
  { name: "waitlist cancel", method: "DELETE", path: `/api/admin/waitlist/${T}`, body: {}, mutation: "cancelEntry", action: "waitlist_cancel", resourceId: T },
  { name: "promo create", method: "POST", path: "/api/admin/promo", body: { code: "SPRING2026", creditCents: 100 }, mutation: "createPromoCode", action: "promo_create", resourceId: "promo-1", extra: { prefix: "SPRI" } },
  { name: "promo disable", method: "DELETE", path: `/api/admin/promo/${T}`, body: {}, mutation: "disablePromoCode", action: "promo_disable", resourceId: T },
  { name: "role change", method: "PUT", path: `/api/admin/roles/${T}`, body: { role: "cybersecurity_admin" }, mutation: "setAdminRole", action: "admin_role_set", resourceId: T, extra: { previousRole: "none", newRole: "cybersecurity_admin" } },
];

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  clientQuery.mockReset();
  release.mockReset();
  clientQuery.mockImplementation(async (s: string) => {
    if (s.includes("SELECT admin_role FROM users")) return { rows: [{ admin_role: "root_admin" }] };
    if (s.includes("SELECT plan_id FROM users")) return { rows: [{ plan_id: "free" }] };
    return { rows: [], rowCount: 1 };
  });
  m.findUserById.mockImplementation(async () => ({ id: T, email: "user@example.com", status: "active", is_admin: false, admin_role: "none" }));
  m.suspendUser.mockResolvedValue(true);
  m.reactivateUser.mockResolvedValue(true);
  m.deleteUser.mockResolvedValue(undefined);
  m.revokeAllApiKeys.mockResolvedValue(1);
  m.revokeAllForUser.mockResolvedValue(1);
  m.findById.mockResolvedValue({ id: T, email: "w@example.com", status: "pending" });
  m.markNotified.mockResolvedValue(true);
  m.getPendingEmails.mockResolvedValue([{ id: T, email: "a@example.com" }, { id: ADMIN, email: "b@example.com" }]);
  m.bulkNotify.mockResolvedValue(2);
  m.cancelEntry.mockResolvedValue(true);
  m.setUserPlan.mockResolvedValue(undefined);
  m.creditWallet.mockResolvedValue({ id: "tx-1" });
  m.adminCreditTeamWallet.mockResolvedValue(undefined);
  m.createPromoCode.mockResolvedValue({ id: "promo-1", code_prefix: "SPRI", credit_cents: 100, max_uses: 0, expires_at: null });
  m.disablePromoCode.mockResolvedValue(true);
  m.setAdminRole.mockResolvedValue(true);
});

describe("legacy /api/admin mutations: reason + audit_events", () => {
  for (const c of cases) {
    describe(c.name, () => {
      it("rejects a missing reason with 400 and changes nothing", async () => {
        if (c.name === "activate") m.findUserById.mockImplementation(async () => ({ id: T, status: "suspended", is_admin: false, admin_role: "none" }));
        const res = await call(c.method, c.path, c.body);
        expect(res.status).toBe(400);
        expect(String(res.body.error)).toMatch(/reason/);
        expect(m[c.mutation]).not.toHaveBeenCalled();
        expect(auditRows()).toHaveLength(0);
      });

      it("rejects a too-short and a too-long reason", async () => {
        if (c.name === "activate") m.findUserById.mockImplementation(async () => ({ id: T, status: "suspended", is_admin: false, admin_role: "none" }));
        expect((await call(c.method, c.path, { ...c.body, reason: "  x " })).status).toBe(400);
        expect((await call(c.method, c.path, { ...c.body, reason: "y".repeat(501) })).status).toBe(400);
        expect(m[c.mutation]).not.toHaveBeenCalled();
      });

      it("writes the audit row on the same transaction client as the mutation", async () => {
        if (c.name === "activate") m.findUserById.mockImplementation(async () => ({ id: T, status: "suspended", is_admin: false, admin_role: "none" }));
        const res = await call(c.method, c.path, { ...c.body, reason: `  ${REASON}  ` });
        expect(res.status).toBeLessThan(300);
        expect(m[c.mutation]).toHaveBeenCalledTimes(1);
        // Repository mutation received the admin transaction client
        expect(m[c.mutation].mock.calls[0]).toContain(client);
        const rows = auditRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ action: c.action, resourceId: c.resourceId });
        expect(rows[0].details).toMatchObject({ reason: REASON, ...(c.extra ?? {}) });
        const s = sql();
        expect(s[0]).toBe("BEGIN");
        expect(s.indexOf("COMMIT")).toBeGreaterThan(s.findIndex((q) => q.includes("INSERT INTO audit_events")));
        expect(s).not.toContain("ROLLBACK");
      });
    });
  }

  it("rolls back the mutation when the audit insert fails", async () => {
    clientQuery.mockImplementation(async (s: string) => {
      if (s.includes("SELECT admin_role FROM users")) return { rows: [{ admin_role: "root_admin" }] };
      if (s.includes("INSERT INTO audit_events")) throw new Error("audit down");
      return { rows: [], rowCount: 1 };
    });
    const res = await call("PUT", `/api/admin/roles/${T}`, { role: "admin", reason: REASON });
    expect(res.status).toBe(500);
    expect(sql()).toContain("ROLLBACK");
    expect(sql()).not.toContain("COMMIT");
  });

  it("does not store the plaintext promo code in the audit row", async () => {
    await call("POST", "/api/admin/promo", { code: "SPRING2026", creditCents: 100, reason: REASON });
    expect(JSON.stringify(auditRows())).not.toContain("SPRING2026");
  });

  it("bug report reject requires a reason and audits in the same tx", async () => {
    expect((await call("POST", `/api/admin/bug-reports/${T}/reject`, {})).status).toBe(400);
    clientQuery.mockImplementation(async (s: string) => {
      if (s.includes("SELECT admin_role FROM users")) return { rows: [{ admin_role: "root_admin" }] };
      if (s.includes("UPDATE bug_reports")) return { rows: [{ id: T }] };
      return { rows: [], rowCount: 1 };
    });
    const res = await call("POST", `/api/admin/bug-reports/${T}/reject`, { reason: REASON });
    expect(res.status).toBe(200);
    expect(auditRows()).toMatchObject([{ action: "bug_report_reject", resourceId: T, details: { reason: REASON } }]);
  });

  it("bug report approve requires a reason and audits before COMMIT", async () => {
    expect((await call("POST", `/api/admin/bug-reports/${T}/approve`, {})).status).toBe(400);
    clientQuery.mockImplementation(async (s: string) => {
      if (s.includes("FROM bug_reports")) return { rows: [{ id: T, user_id: "u1", status: "pending" }] };
      return { rows: [], rowCount: 1 };
    });
    const res = await call("POST", `/api/admin/bug-reports/${T}/approve`, { reason: REASON });
    expect(res.status).toBe(200);
    expect(auditRows()).toMatchObject([{ action: "bug_report_approve", details: { reason: REASON, newStatus: "approved" } }]);
    const s = sql();
    expect(s.indexOf("COMMIT")).toBeGreaterThan(s.findIndex((q) => q.includes("INSERT INTO audit_events")));
  });

  // Both routes have a once-per-hour limiter, so each gets one request here.
  it("loyalty run requires a reason", async () => {
    const res = await call("POST", "/api/admin/loyalty/process", {});
    expect(res.status).toBe(400);
    expect(m.creditPendingLoyaltyRewards).not.toHaveBeenCalled();
  });

  it("commission run leaves an audit row with the reason", async () => {
    m.dbQuery.mockResolvedValue({ rows: [{ referrer_id: "r1" }] });
    m.creditPendingCommissions.mockResolvedValue(250);
    const res = await call("POST", "/api/admin/commissions/process", { reason: REASON });
    expect(res.status).toBe(200);
    expect(auditRows()).toMatchObject([{ action: "commissions_process", details: { reason: REASON, processed: 1, totalCreditedCents: 250 } }]);
  });
});
