import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";

const findUserById = vi.fn();
const findUserByApiKeyHash = vi.fn();
const verifyJwt = vi.fn();

vi.mock("@dominusnode/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dominusnode/shared")>();
  return {
    ...actual,
    verifyJwt: (t: string) => verifyJwt(t),
    userRepo: { findUserById: (id: string) => findUserById(id), findUserByApiKeyHash: (h: string) => findUserByApiKeyHash(h) },
  };
});

import { requireAgentPrincipal, type AgentRequest } from "./agent.js";
import { call } from "../routes/v1/test-helpers.js";

const WALLET = "0x" + "ab".repeat(20);

function app() {
  const a = express();
  a.get("/x", requireAgentPrincipal, (req, res) => { res.json((req as AgentRequest).agent); });
  return a;
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe("requireAgentPrincipal", () => {
  beforeEach(() => {
    findUserById.mockReset();
    findUserByApiKeyHash.mockReset();
    verifyJwt.mockReset();
  });

  it("rejects missing auth", async () => {
    expect((await call(app(), "GET", "/x")).status).toBe(401);
  });

  it("ignores cookies (Bearer only)", async () => {
    const r = await call(app(), "GET", "/x", { headers: { cookie: "dominusnode_access=abc" } });
    expect(r.status).toBe(401);
  });

  it("rejects dn_node_ keys without a DB lookup", async () => {
    const r = await call(app(), "GET", "/x", { headers: bearer("dn_node_" + "a".repeat(64)) });
    expect(r.status).toBe(401);
    expect(findUserByApiKeyHash).not.toHaveBeenCalled();
    expect(verifyJwt).not.toHaveBeenCalled();
  });

  it("accepts an API key and marks wallet users verified", async () => {
    findUserByApiKeyHash.mockResolvedValue({
      user: { id: "u1", email: "x@wallet.dominusnode.daedalusdevelopmentgroup.com", status: "active", wallet_address: WALLET.toUpperCase().replace("0X", "0x"), email_verified: false },
      apiKey: {},
    });
    const r = await call(app(), "GET", "/x", { headers: bearer("dn_live_abc") });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ userId: "u1", via: "api_key", verified: true, walletAddress: WALLET });
    expect(findUserByApiKeyHash.mock.calls[0][0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("API key of an unverified email user is not verified", async () => {
    findUserByApiKeyHash.mockResolvedValue({
      user: { id: "u2", email: "a@b.com", status: "active", wallet_address: null, email_verified: false },
      apiKey: {},
    });
    const r = await call(app(), "GET", "/x", { headers: bearer("dn_live_abc") });
    expect(r.body).toMatchObject({ verified: false, walletAddress: null });
  });

  it("rejects team API keys with 403 (never acts as the creator)", async () => {
    findUserByApiKeyHash.mockResolvedValue({
      user: { id: "creator", email: "c@b.com", status: "active", wallet_address: null, email_verified: true },
      apiKey: { team_id: "team-1" },
    });
    const r = await call(app(), "GET", "/x", { headers: bearer("dn_live_team") });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "Team keys cannot be used for agent endpoints" });
  });

  it("rejects unknown API keys", async () => {
    findUserByApiKeyHash.mockResolvedValue(null);
    expect((await call(app(), "GET", "/x", { headers: bearer("dn_live_nope") })).status).toBe(401);
  });

  it("accepts wallet JWT users", async () => {
    verifyJwt.mockReturnValue({ userId: "u3", email: "w@wallet.dominusnode.daedalusdevelopmentgroup.com" });
    findUserById.mockResolvedValue({ id: "u3", email: "w@wallet.dominusnode.daedalusdevelopmentgroup.com", status: "active", wallet_address: WALLET });
    const r = await call(app(), "GET", "/x", { headers: bearer("jwt") });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ via: "wallet_jwt", verified: true });
  });

  it("rejects human (email/password) JWT users", async () => {
    verifyJwt.mockReturnValue({ userId: "u4", email: "h@example.com" });
    findUserById.mockResolvedValue({ id: "u4", email: "h@example.com", status: "active", wallet_address: null });
    expect((await call(app(), "GET", "/x", { headers: bearer("jwt") })).status).toBe(403);
  });

  it("rejects suspended users", async () => {
    verifyJwt.mockReturnValue({ userId: "u5", email: "w@wallet.dominusnode.daedalusdevelopmentgroup.com" });
    findUserById.mockResolvedValue({ id: "u5", email: "w@wallet.dominusnode.daedalusdevelopmentgroup.com", status: "suspended", wallet_address: WALLET });
    expect((await call(app(), "GET", "/x", { headers: bearer("jwt") })).status).toBe(401);
  });

  it("rejects invalid JWT", async () => {
    verifyJwt.mockReturnValue(null);
    expect((await call(app(), "GET", "/x", { headers: bearer("bad") })).status).toBe(401);
  });
});
