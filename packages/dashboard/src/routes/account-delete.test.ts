import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import http from "http";

const order: string[] = [];
const clientQuery = vi.fn(async (sql: string) => {
  order.push(sql);
  return { rows: [{ wallet_address: null }], rowCount: 0 };
});
const payoutInFlight = { value: false };
const erase = vi.fn(async () => {
  order.push("ERASE_RELAY");
});
const WALLET = "0x" + "ab".repeat(20);
const NONCE = "c".repeat(64);
const SIG = "0x" + "1".repeat(130);
const challenge = { stored: null as string | null, signer: WALLET };
const consume = vi.fn(async () => challenge.stored);

vi.mock("@dominusnode/shared", () => ({
  query: vi.fn(async (sql: string) => {
    if (sql.includes("FROM node_payouts")) return { rows: payoutInFlight.value ? [{ id: "p1" }] : [] };
    return { rows: [{ email: "0xabc@wallet.dominusnode.com", wallet_address: WALLET }] };
  }),
  getPool: vi.fn(() => ({ connect: async () => ({ query: clientQuery, release: vi.fn() }) })),
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  userRepo: { findUserForAuth: vi.fn(), findUserById: vi.fn() },
  adminRepo: { deleteUser: (...a: unknown[]) => erase(...(a as [])) },
  agentCreditsRepo: {
    consumeSignChallenge: (...a: unknown[]) => consume(...(a as [])),
    createSignChallenge: vi.fn(async () => ({ expiresAt: new Date() })),
  },
  relayErasureRepo: {
    PAYOUT_IN_FLIGHT_SQL: "SELECT id FROM node_payouts WHERE user_id = $1 LIMIT 1 FOR UPDATE",
    eraseRelayPersonalDataTx: (...a: unknown[]) => erase(...(a as [])) },
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
vi.mock("../helpers/verify-signature.js", () => ({ recoverSignerAddress: () => challenge.signer }));
vi.mock("../helpers/cookies.js", () => ({ clearAuthCookies: vi.fn() }));

import accountRouter, { accountDeleteMessage } from "./account.js";

function del(app: express.Express, user = "u1", body: Record<string, unknown> | null = null): Promise<number> {
  const payload = JSON.stringify(body ?? { nonce: NONCE, signature: SIG });
  challenge.stored = challenge.stored ?? accountDeleteMessage({ userId: user, wallet: WALLET, nonce: NONCE });
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("no addr"));
      const req = http.request({ hostname: "127.0.0.1", port: addr.port, path: "/api/account", method: "DELETE", headers: { "x-test-user": user, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, (res) => {
        res.resume();
        res.on("end", () => { server.close(); resolve(res.statusCode ?? 0); });
      });
      req.on("error", (e) => { server.close(); reject(e); });
      req.end(payload);
    });
  });
}

describe("DELETE /api/account relay-network erasure", () => {
  beforeEach(() => {
    order.length = 0;
    payoutInFlight.value = false;
    challenge.stored = null;
    challenge.signer = WALLET;
    consume.mockClear();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
  });

  it("erases relay personal data inside the deletion transaction", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/account", accountRouter);
    expect(await del(app)).toBe(200);
    expect(erase).toHaveBeenCalledWith("u1", expect.objectContaining({ query: clientQuery }));
    expect(consume).toHaveBeenCalledWith("u1", "account_delete", expect.any(String));
    const b = order.indexOf("BEGIN");
    const e = order.indexOf("ERASE_RELAY");
    const c = order.indexOf("COMMIT");
    expect(b).toBeGreaterThanOrEqual(0);
    expect(e).toBeGreaterThan(b);
    expect(c).toBeGreaterThan(e);
  });

  it("terminates live proxy sessions before the erasure transaction begins", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { order.push(`FETCH ${url}`); return { ok: true }; }));
    const app = express();
    app.use(express.json());
    app.use("/api/account", accountRouter);
    expect(await del(app, "u3")).toBe(200);
    const t = order.findIndex((x) => x.startsWith("FETCH") && x.includes("/internal/terminate-sessions/u3"));
    expect(t).toBeGreaterThanOrEqual(0);
    expect(t).toBeLessThan(order.indexOf("BEGIN"));
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

  it("does not terminate sessions when a payout is already in flight", async () => {
    payoutInFlight.value = true;
    const f = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("fetch", f);
    const app = express();
    app.use(express.json());
    app.use("/api/account", accountRouter);
    expect(await del(app, "u4")).toBe(409);
    expect(f).not.toHaveBeenCalled();
    expect(order).not.toContain("BEGIN");
  });

  it("wallet account: refuses deletion without a wallet signature (API-key JWT alone)", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/account", accountRouter);
    expect(await del(app, "u5", {})).toBe(400);
    expect(order).not.toContain("BEGIN");
    expect(erase).not.toHaveBeenCalledWith("u5", expect.anything());
  });

  it("wallet account: refuses a signature from another wallet", async () => {
    challenge.signer = "0x" + "99".repeat(20);
    const app = express();
    app.use(express.json());
    app.use("/api/account", accountRouter);
    expect(await del(app, "u6")).toBe(403);
    expect(order).not.toContain("BEGIN");
  });

  it("wallet account: refuses an unknown or expired challenge", async () => {
    challenge.stored = "";
    const app = express();
    app.use(express.json());
    app.use("/api/account", accountRouter);
    expect(await del(app, "u7")).toBe(400);
    expect(order).not.toContain("BEGIN");
  });
});
