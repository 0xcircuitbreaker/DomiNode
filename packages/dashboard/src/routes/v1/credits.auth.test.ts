import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";

const findUserByApiKeyHash = vi.fn();
const getCreditSummary = vi.fn();

vi.mock("@dominusnode/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dominusnode/shared")>();
  return {
    ...actual,
    userRepo: { findUserById: vi.fn(), findUserByApiKeyHash: (h: string) => findUserByApiKeyHash(h) },
    agentCreditsRepo: { ...actual.agentCreditsRepo, getCreditSummary: (u: string) => getCreditSummary(u) },
  };
});

import router from "./credits.js";
import { call } from "./test-helpers.js";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/v1", router);
  return a;
}

describe("credits routes auth (real requireAgentPrincipal)", () => {
  beforeEach(() => { findUserByApiKeyHash.mockReset(); getCreditSummary.mockReset(); });

  const routes: [string, string][] = [
    ["GET", "/v1/credits"], ["GET", "/v1/credits/transactions"], ["POST", "/v1/credits/convert"],
    ["GET", "/v1/payout-wallet"], ["PUT", "/v1/payout-wallet"], ["POST", "/v1/credits/withdraw"],
    ["GET", "/v1/payouts"], ["PATCH", "/v1/nodes/22222222-2222-4222-8222-222222222222"],
    ["POST", "/v1/sessions/33333333-3333-4333-8333-333333333333/report"],
  ];

  it.each(routes)("%s %s rejects team API keys", async (method, path) => {
    findUserByApiKeyHash.mockResolvedValue({
      user: { id: "u1", email: "a@b.com", status: "active", wallet_address: null, email_verified: true },
      apiKey: { team_id: "t1" },
    });
    const r = await call(app(), method, path, { headers: { authorization: "Bearer dn_live_team" }, body: method === "GET" ? undefined : {} });
    expect(r.status).toBe(403);
    expect(getCreditSummary).not.toHaveBeenCalled();
  });

  it.each(routes)("%s %s requires auth", async (method, path) => {
    expect((await call(app(), method, path, { body: method === "GET" ? undefined : {} })).status).toBe(401);
  });
});
