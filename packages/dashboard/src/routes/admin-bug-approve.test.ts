import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import http from "http";

const mockClientQuery = vi.fn();
const mockRelease = vi.fn();
const mockCreditWallet = vi.fn();

vi.mock("@dominusnode/shared", () => ({
  adminRepo: {}, userRepo: {}, refreshTokenRepo: {}, waitlistRepo: {}, teamRepo: {}, planRepo: {}, referralRepo: {},
  walletRepo: { creditWallet: (...a: unknown[]) => mockCreditWallet(...a) },
  sendWaitlistApprovalEmail: vi.fn(), sanitizeString: (s: string) => s, hasMinRole: () => true, query: vi.fn(),
  getPool: () => ({ connect: async () => ({ query: mockClientQuery, release: mockRelease }) }),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _r: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: object }).user = { userId: "admin-1", adminRole: "root_admin", isAdmin: true };
    next();
  },
}));
vi.mock("../middleware/admin.js", () => {
  const pt = (_q: unknown, _s: unknown, n: () => void) => n();
  return { requireAdmin: pt, requireCybersecurityAdmin: pt, requireRootAdmin: pt };
});

import adminRouter from "./admin.js";

const ID = "11111111-1111-4111-8111-111111111111";

function post(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminRouter);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const data = JSON.stringify(body);
      const r = http.request({ hostname: "127.0.0.1", port, path: `/api/admin/bug-reports/${ID}/approve`, method: "POST",
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

function sqlCalls(): string[] {
  return mockClientQuery.mock.calls.map((c) => String(c[0]));
}

describe("POST /bug-reports/:id/approve", () => {
  beforeEach(() => { mockClientQuery.mockReset(); mockRelease.mockReset(); mockCreditWallet.mockReset(); });

  it("credits and marks credited in one transaction", async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM bug_reports")) return { rows: [{ id: ID, user_id: "u1", status: "pending" }] };
      if (sql.includes("FROM wallets")) return { rows: [{ id: "w1", balance_cents: 100 }] };
      return { rows: [] };
    });
    const res = await post({ creditAmountCents: 500 });
    expect(res.status).toBe(200);
    const calls = sqlCalls();
    expect(calls[0]).toBe("BEGIN");
    expect(calls.some((s) => s.includes("FOR UPDATE") && s.includes("bug_reports"))).toBe(true);
    expect(calls.some((s) => s.includes("INSERT INTO wallet_transactions"))).toBe(true);
    const upd = mockClientQuery.mock.calls.find((c) => String(c[0]).includes("UPDATE bug_reports"));
    expect(upd?.[1]?.[0]).toBe("credited");
    expect(calls[calls.length - 1]).toBe("COMMIT");
    expect(calls).not.toContain("ROLLBACK");
    expect(mockCreditWallet).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalled();
  });

  it("rolls back on credit failure so report stays pending", async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM bug_reports")) return { rows: [{ id: ID, user_id: "u1", status: "pending" }] };
      if (sql.includes("FROM wallets")) return { rows: [{ id: "w1", balance_cents: 100 }] };
      if (sql.includes("INSERT INTO wallet_transactions")) throw new Error("lock timeout");
      return { rows: [] };
    });
    const res = await post({ creditAmountCents: 500 });
    expect(res.status).toBe(500);
    const calls = sqlCalls();
    expect(calls).toContain("ROLLBACK");
    expect(calls).not.toContain("COMMIT");
    expect(calls.some((s) => s.includes("UPDATE bug_reports"))).toBe(false);
    expect(mockRelease).toHaveBeenCalled();
  });

  it("rejects over balance ceiling without changing the report", async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM bug_reports")) return { rows: [{ id: ID, user_id: "u1", status: "pending" }] };
      if (sql.includes("FROM wallets")) return { rows: [{ id: "w1", balance_cents: 999_900 }] };
      return { rows: [] };
    });
    const res = await post({ creditAmountCents: 500 });
    expect(res.status).toBe(400);
    expect(sqlCalls()).toContain("ROLLBACK");
    expect(sqlCalls().some((s) => s.includes("UPDATE bug_reports"))).toBe(false);
  });

  it("returns 400 when report not pending", async () => {
    mockClientQuery.mockImplementation(async (sql: string) =>
      sql.includes("FROM bug_reports") ? { rows: [{ id: ID, user_id: "u1", status: "approved" }] } : { rows: [] });
    const res = await post({});
    expect(res.status).toBe(400);
    expect(sqlCalls()).toContain("ROLLBACK");
  });
});
