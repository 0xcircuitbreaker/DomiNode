import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";

const USER = "11111111-1111-4111-8111-111111111111";
const TID = "22222222-2222-4222-8222-222222222222";
let principal = { userId: USER, email: "w@wallet.example.org", walletAddress: null, via: "api_key", verified: true };

const m = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), revoke: vi.fn() }));

vi.mock("../../middleware/agent.js", () => ({
  requireAgentPrincipal: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { agent: typeof principal }).agent = { ...principal };
    next();
  },
}));

vi.mock("@dominusnode/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dominusnode/shared")>();
  return {
    ...actual,
    proxyTokenRepo: { ...actual.proxyTokenRepo, createProxyToken: m.create, listProxyTokens: m.list, revokeProxyToken: m.revoke },
  };
});

import router, { createLimiter, revokeLimiter, listLimiter, MAX_ACTIVE_PROXY_TOKENS } from "./proxy-tokens.js";
import { call } from "./test-helpers.js";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/v1", router);
  return a;
}

const record = {
  id: TID, userId: USER, label: "ci", expiresAt: new Date(Date.now() + 3_600_000), maxBytes: 1000n, maxSpendMusd: null,
  bytesUsed: 10n, spendUsedMusd: 0n, revokedAt: null, createdAt: new Date(),
};
const SECRET = "dn_proxy_" + "B".repeat(43);

beforeEach(() => {
  vi.resetAllMocks();
  createLimiter.reset(); revokeLimiter.reset(); listLimiter.reset();
  principal = { ...principal, verified: true };
});

describe("POST /v1/proxy-tokens", () => {
  it("creates a token and returns the secret once", async () => {
    m.create.mockResolvedValue({ token: SECRET, record });
    const r = await call(app(), "POST", "/v1/proxy-tokens", { body: { label: "ci", ttlSeconds: 3600, maxBytes: "1000", maxSpendMusd: 5000 } });
    expect(r.status).toBe(201);
    expect(r.body["token"]).toBe(SECRET);
    expect(r.body["maxBytes"]).toBe("1000");
    expect(r.body["status"]).toBe("active");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(m.create).toHaveBeenCalledWith(USER, { label: "ci", ttlMs: 3_600_000, maxBytes: 1000n, maxSpendMusd: 5000n }, MAX_ACTIVE_PROXY_TOKENS);
  });
  it("rejects bad input", async () => {
    for (const body of [{ maxBytes: -1 }, { maxSpendMusd: "1.5" }, { ttlSeconds: 1 }, { ttlSeconds: 10 ** 9 }, { label: 5 }]) {
      const r = await call(app(), "POST", "/v1/proxy-tokens", { body });
      expect(r.status).toBe(400);
    }
    expect(m.create).not.toHaveBeenCalled();
  });
  it("returns 409 at the active-token cap", async () => {
    m.create.mockResolvedValue(null);
    expect((await call(app(), "POST", "/v1/proxy-tokens", { body: {} })).status).toBe(409);
  });
  it("requires a verified principal", async () => {
    principal = { ...principal, verified: false };
    expect((await call(app(), "POST", "/v1/proxy-tokens", { body: {} })).status).toBe(403);
  });
  it("rate limits creation", async () => {
    m.create.mockResolvedValue({ token: SECRET, record });
    for (let i = 0; i < 20; i++) createLimiter.hit(USER);
    expect((await call(app(), "POST", "/v1/proxy-tokens", { body: {} })).status).toBe(429);
  });
  it("does not leak internal errors", async () => {
    m.create.mockRejectedValue(new Error("pg: secret detail"));
    const r = await call(app(), "POST", "/v1/proxy-tokens", { body: {} });
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain("secret detail");
  });
});

describe("GET /v1/proxy-tokens", () => {
  it("lists metadata without secrets", async () => {
    m.list.mockResolvedValue([record, { ...record, revokedAt: new Date() }]);
    const r = await call(app(), "GET", "/v1/proxy-tokens");
    expect(r.status).toBe(200);
    const tokens = r.body["tokens"] as Array<Record<string, unknown>>;
    expect(tokens).toHaveLength(2);
    expect(tokens[1]["status"]).toBe("revoked");
    expect(JSON.stringify(r.body)).not.toMatch(/dn_proxy_|token_hash|tokenHash/);
  });
});

describe("DELETE /v1/proxy-tokens/:id", () => {
  it("revokes", async () => {
    m.revoke.mockResolvedValue(true);
    const r = await call(app(), "DELETE", `/v1/proxy-tokens/${TID}`);
    expect(r.status).toBe(200);
    expect(m.revoke).toHaveBeenCalledWith(USER, TID);
  });
  it("404 when not found, 400 on a bad id", async () => {
    m.revoke.mockResolvedValue(false);
    expect((await call(app(), "DELETE", `/v1/proxy-tokens/${TID}`)).status).toBe(404);
    expect((await call(app(), "DELETE", "/v1/proxy-tokens/nope")).status).toBe(400);
  });
});
