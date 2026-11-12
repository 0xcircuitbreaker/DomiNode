import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import http from "http";

const order: string[] = [];
const clientQuery = vi.fn(async (sql: string) => {
  order.push(sql);
  return { rows: [{ wallet_address: null }], rowCount: 0 };
});
const erase = vi.fn(async () => {
  order.push("ERASE_RELAY");
});

vi.mock("@dominusnode/shared", () => ({
  query: vi.fn(async () => ({ rows: [{ email: "0xabc@wallet.dominusnode.com" }] })),
  getPool: vi.fn(() => ({ connect: async () => ({ query: clientQuery, release: vi.fn() }) })),
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  userRepo: { findUserForAuth: vi.fn(), findUserById: vi.fn() },
  relayErasureRepo: { eraseRelayPersonalDataTx: (...a: unknown[]) => erase(...(a as [])) },
  verifyPassword: vi.fn(),
  isWalletEmail: vi.fn(() => true),
  getProxyInternalPort: vi.fn(() => 1),
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: { userId: string } }).user = { userId: String(req.headers["x-test-user"] ?? "u1") };
    next();
  },
}));
vi.mock("../helpers/cookies.js", () => ({ clearAuthCookies: vi.fn() }));

import accountRouter from "./account.js";

function del(app: express.Express, user = "u1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("no addr"));
      const req = http.request({ hostname: "127.0.0.1", port: addr.port, path: "/api/account", method: "DELETE", headers: { "x-test-user": user } }, (res) => {
        res.resume();
        res.on("end", () => { server.close(); resolve(res.statusCode ?? 0); });
      });
      req.on("error", (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

describe("DELETE /api/account relay-network erasure", () => {
  beforeEach(() => {
    order.length = 0;
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
  });

  it("erases relay personal data inside the deletion transaction", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/account", accountRouter);
    expect(await del(app)).toBe(200);
    expect(erase).toHaveBeenCalledWith(expect.objectContaining({ query: clientQuery }), "u1");
    const b = order.indexOf("BEGIN");
    const e = order.indexOf("ERASE_RELAY");
    const c = order.indexOf("COMMIT");
    expect(b).toBeGreaterThanOrEqual(0);
    expect(e).toBeGreaterThan(b);
    expect(c).toBeGreaterThan(e);
  });

  it("returns 409 and rolls back while a payout is in flight", async () => {
    erase.mockImplementationOnce(async () => {
      const err = new Error("in flight");
      err.name = "PayoutInFlightError";
      throw err;
    });
    const app = express();
    app.use(express.json());
    app.use("/api/account", accountRouter);
    expect(await del(app, "u2")).toBe(409);
    expect(order).toContain("ROLLBACK");
    expect(order).not.toContain("COMMIT");
  });
});
