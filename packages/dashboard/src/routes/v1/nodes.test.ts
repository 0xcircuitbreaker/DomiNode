import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import * as crypto from "node:crypto";
import { Wallet } from "ethers";

const wallet = Wallet.createRandom();
const WALLET = wallet.address.toLowerCase();
const USER = "11111111-1111-4111-8111-111111111111";
const NODE_ID = "22222222-2222-4222-8222-222222222222";
const POW_ID = "33333333-3333-4333-8333-333333333333";

const principal = { userId: USER, email: "w@wallet.dominusnode.daedalusdevelopmentgroup.com", walletAddress: "" as string | null, via: "wallet_jwt", verified: true };

const m = vi.hoisted(() => ({
  createChallenge: vi.fn(),
  consumeChallenge: vi.fn(),
  registerNode: vi.fn(),
  listForOwner: vi.fn(),
  powCreate: vi.fn(),
  powConsume: vi.fn(),
  powCount: vi.fn(),
  getActivePolicy: vi.fn(),
  getOwnerTier: vi.fn(),
  listTiers: vi.fn(),
  getOwnerTierStats: vi.fn(),
  query: vi.fn(),
}));

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
    query: (...a: unknown[]) => m.query(...a),
    nodeRepo: { createChallenge: m.createChallenge, consumeChallenge: m.consumeChallenge, registerNode: m.registerNode, listForOwner: m.listForOwner },
    powChallengeRepo: { createChallenge: m.powCreate, consumeChallenge: m.powConsume, countActiveChallengesForIp: m.powCount, POW_CHALLENGE_TTL_MS: 300000 },
    policyRepo: { getActivePolicy: m.getActivePolicy },
    tierRepo: { getOwnerTier: m.getOwnerTier, listTiers: m.listTiers, getOwnerTierStats: m.getOwnerTierStats },
  };
});

vi.hoisted(() => { process.env["NODE_POW_DIFFICULTY"] = "10"; });
import router, * as mod from "./nodes.js";
import { call } from "./test-helpers.js";
import { buildAttestationMessage, sha256Hex, verifyPow } from "@dominusnode/shared";
import { DEFAULT_POLICY } from "@dominusnode/shared";


function app() {
  const a = express();
  a.use(express.json());
  a.use("/v1", router);
  return a;
}

const PREFIX = "a".repeat(32);
function solvePow(prefix: string, difficulty: number): string {
  for (let i = 0; ; i++) if (verifyPow(prefix, String(i), difficulty)) return String(i);
}

const tier = (id: number, name: string, rank: number) => ({
  id, name, rank, nodeShareBps: 2500 + rank * 500, minTenureDays: rank * 7, minUptimeBps: 8000, minActiveIps: rank + 1,
  minReputation: 3000 + rank * 1000, noClawbackDays: 0, holdDays: 7, maxNodes: 10, dailyWithdrawLimitMusd: 50000000n,
});

async function registrationBody(opts: { signer?: { signMessage(m: string): Promise<string> }; pubkey?: string | null } = {}) {
  const nonce = crypto.randomBytes(32).toString("hex");
  const pubkey = opts.pubkey === undefined ? "b".repeat(64) : opts.pubkey;
  const message = buildAttestationMessage({
    wallet: WALLET, nonce, attestationVersion: DEFAULT_POLICY.attestation.minVersion,
    attestationText: DEFAULT_POLICY.attestation.text, nodePubkey: pubkey,
  });
  const sig = await (opts.signer ?? wallet).signMessage(message);
  return { nonce, walletSignature: sig, nodePubkey: pubkey ?? undefined, pow: { challengeId: POW_ID, nonce: solvePow(PREFIX, 10) } };
}

describe("/v1 node routes", () => {
  beforeEach(() => {
    for (const f of Object.values(m)) f.mockReset();
    mod.challengeLimiter.reset();
    mod.registerLimiter.reset();
    principal.walletAddress = WALLET;
    principal.verified = true;
    principal.via = "wallet_jwt";
    m.getActivePolicy.mockResolvedValue({ version: 3, sha256: "f".repeat(64), body: DEFAULT_POLICY, createdAt: null });
    m.powConsume.mockResolvedValue({ id: POW_ID, prefix: PREFIX, difficulty: 10, ip_address: "127.0.0.1", created_at: new Date(), consumed: true });
    m.consumeChallenge.mockImplementation(async (u: string, h: string) => ({ nonce_hash: h, user_id: u, expires_at: new Date(Date.now() + 1e5) }));
  });

  describe("POST /v1/nodes/challenge", () => {
    it("returns nonce, attestation, signable message and PoW; stores only the nonce hash", async () => {
      m.powCount.mockResolvedValue(0);
      m.createChallenge.mockImplementation(async (u: string, h: string) => ({ nonce_hash: h, user_id: u, expires_at: new Date(Date.now() + 300000) }));
      m.powCreate.mockResolvedValue({ id: POW_ID, prefix: PREFIX, difficulty: 10, ip_address: "127.0.0.1", created_at: new Date(), consumed: false });
      const r = await call(app(), "POST", "/v1/nodes/challenge", { body: { nodePubkey: "B".repeat(64) } });
      expect(r.status).toBe(200);
      const nonce = r.body["nonce"] as string;
      expect(nonce).toMatch(/^[0-9a-f]{64}$/);
      expect(m.createChallenge).toHaveBeenCalledWith(USER, sha256Hex(nonce));
      expect(r.body["attestationVersion"]).toBe(DEFAULT_POLICY.attestation.minVersion);
      expect(r.body["message"]).toContain(`Wallet: ${WALLET}`);
      expect(r.body["message"]).toContain(`Node pubkey: ${"b".repeat(64)}`);
      expect((r.body["powChallenge"] as Record<string, unknown>)["challengeId"]).toBe(POW_ID);
    });

    it("requires a linked wallet", async () => {
      principal.walletAddress = null;
      const r = await call(app(), "POST", "/v1/nodes/challenge", { body: {} });
      expect(r.status).toBe(400);
      expect(r.body["code"]).toBe("NO_LINKED_WALLET");
    });

    it("rejects an email-unverified API-key principal even with a linked wallet", async () => {
      principal.via = "api_key";
      principal.verified = false;
      const r = await call(app(), "POST", "/v1/nodes/challenge", { body: { nodePubkey: "b".repeat(64) } });
      expect(r.status).toBe(403);
      expect(r.body["code"]).toBe("EMAIL_NOT_VERIFIED");
      expect(m.createChallenge).not.toHaveBeenCalled();
      expect(m.powCreate).not.toHaveBeenCalled();
    });

    it("rate-limits challenge issuance per user", async () => {
      m.powCount.mockResolvedValue(0);
      m.createChallenge.mockResolvedValue(null);
      const a = app();
      let last = 0;
      for (let i = 0; i < 21; i++) last = (await call(a, "POST", "/v1/nodes/challenge", { body: {} })).status;
      expect(last).toBe(429);
    });

    it("caps active PoW challenges per IP", async () => {
      m.powCount.mockResolvedValue(5);
      expect((await call(app(), "POST", "/v1/nodes/challenge", { body: {} })).status).toBe(429);
      expect(m.createChallenge).not.toHaveBeenCalled();
    });
  });

  describe("POST /v1/nodes", () => {
    it("registers with a valid attestation + PoW and returns the node key once", async () => {
      m.registerNode.mockResolvedValue({ ok: true, nodeKey: "dn_node_" + "c".repeat(64), node: { id: NODE_ID, status: "pending", attestation_version: 1 } });
      const body = await registrationBody();
      const r = await call(app(), "POST", "/v1/nodes", { body });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ nodeId: NODE_ID, nodeKey: "dn_node_" + "c".repeat(64), status: "pending" });
      expect(m.consumeChallenge).toHaveBeenCalledWith(USER, sha256Hex(body.nonce));
      expect(m.registerNode).toHaveBeenCalledWith(expect.objectContaining({
        ownerUserId: USER, ownerWallet: WALLET, nodePubkey: "b".repeat(64), attestationVersion: 1, attestationSig: body.walletSignature,
      }));
    });

    it("rejects a signature from another wallet after consuming the challenge", async () => {
      const body = await registrationBody({ signer: Wallet.createRandom() });
      const r = await call(app(), "POST", "/v1/nodes", { body });
      expect(r.status).toBe(400);
      expect(m.consumeChallenge).toHaveBeenCalledTimes(1);
      expect(m.registerNode).not.toHaveBeenCalled();
    });

    it("rejects a signature over a different node pubkey", async () => {
      const body = await registrationBody();
      body.nodePubkey = "d".repeat(64);
      expect((await call(app(), "POST", "/v1/nodes", { body })).status).toBe(400);
      expect(m.registerNode).not.toHaveBeenCalled();
    });

    it("rejects when the attestation text changed since the challenge", async () => {
      m.getActivePolicy.mockResolvedValue({ version: 4, sha256: "e".repeat(64), body: { ...DEFAULT_POLICY, attestation: { minVersion: 2, text: "new terms" } }, createdAt: null });
      const r = await call(app(), "POST", "/v1/nodes", { body: await registrationBody() });
      expect(r.status).toBe(400);
    });

    it("rejects a consumed/expired challenge (replay)", async () => {
      m.consumeChallenge.mockResolvedValue(null);
      const r = await call(app(), "POST", "/v1/nodes", { body: await registrationBody() });
      expect(r.status).toBe(400);
      expect(r.body["code"]).toBe("INVALID_CHALLENGE");
      expect(m.powConsume).not.toHaveBeenCalled();
      expect(m.registerNode).not.toHaveBeenCalled();
    });

    it("rejects an invalid PoW solution", async () => {
      const body = await registrationBody();
      let bad = 0;
      while (verifyPow(PREFIX, String(bad), 10)) bad++;
      body.pow.nonce = String(bad);
      const r = await call(app(), "POST", "/v1/nodes", { body });
      expect(r.status).toBe(400);
      expect(r.body["code"]).toBe("POW_INVALID");
      expect(m.registerNode).not.toHaveBeenCalled();
    });

    it("rejects a PoW challenge issued at lower difficulty", async () => {
      m.powConsume.mockResolvedValue({ id: POW_ID, prefix: PREFIX, difficulty: 1, ip_address: "127.0.0.1", created_at: new Date(), consumed: true });
      expect((await call(app(), "POST", "/v1/nodes", { body: await registrationBody() })).status).toBe(400);
    });

    it("rejects registration from an email-unverified API-key principal", async () => {
      principal.via = "api_key";
      principal.verified = false;
      const r = await call(app(), "POST", "/v1/nodes", { body: { nonce: "a".repeat(64), walletSignature: "0x" + "1".repeat(130) } });
      expect(r.status).toBe(403);
      expect(m.consumeChallenge).not.toHaveBeenCalled();
      expect(m.registerNode).not.toHaveBeenCalled();
    });

    it("maps node cap to 409", async () => {
      m.registerNode.mockResolvedValue({ ok: false, reason: "node_cap_reached", cap: 10 });
      const r = await call(app(), "POST", "/v1/nodes", { body: await registrationBody() });
      expect(r.status).toBe(409);
      expect(r.body["code"]).toBe("NODE_CAP_REACHED");
      expect(r.body["cap"]).toBe(10);
    });

    it("validates input shapes before touching the DB", async () => {
      const body = await registrationBody();
      for (const bad of [
        { ...body, nonce: "zz" },
        { ...body, walletSignature: "0x1234" },
        { ...body, nodePubkey: "xyz" },
        { ...body, pow: { challengeId: "nope", nonce: "1" } },
        { ...body, maxStreams: 5000 },
      ]) {
        expect((await call(app(), "POST", "/v1/nodes", { body: bad })).status).toBe(400);
      }
      expect(m.consumeChallenge).not.toHaveBeenCalled();
    });

    it("rate-limits registration attempts", async () => {
      m.consumeChallenge.mockResolvedValue(null);
      const a = app();
      const body = await registrationBody();
      let last = 0;
      for (let i = 0; i < 11; i++) last = (await call(a, "POST", "/v1/nodes", { body })).status;
      expect(last).toBe(429);
    });

    it("does not leak internal errors", async () => {
      m.registerNode.mockRejectedValue(new Error("duplicate key node_pubkey dn_live_secret"));
      const r = await call(app(), "POST", "/v1/nodes", { body: await registrationBody() });
      expect(r.status).toBe(500);
      expect(JSON.stringify(r.body)).not.toContain("dn_live_");
    });
  });

  describe("GET/DELETE /v1/nodes", () => {
    it("lists own nodes without key hashes", async () => {
      m.listForOwner.mockResolvedValue([{ id: NODE_ID, owner_wallet: WALLET, status: "active", node_key_hash: "x".repeat(64), attestation_sig: "0x" }]);
      const r = await call(app(), "GET", "/v1/nodes?limit=9999");
      expect(r.status).toBe(200);
      expect(m.listForOwner).toHaveBeenCalledWith(USER, { limit: 500, offset: 0 });
      expect(JSON.stringify(r.body)).not.toMatch(/key_hash|attestation_sig/);
    });

    it("revokes only an owned node", async () => {
      m.query.mockResolvedValue({ rows: [{ id: NODE_ID, status: "revoked" }] });
      const r = await call(app(), "DELETE", `/v1/nodes/${NODE_ID}`);
      expect(r.status).toBe(200);
      expect(m.query.mock.calls[0][1]).toEqual([NODE_ID, USER]);
      expect(String(m.query.mock.calls[0][0])).toContain("owner_user_id = $2");
    });

    it("404s for foreign or already-revoked nodes", async () => {
      m.query.mockResolvedValue({ rows: [] });
      expect((await call(app(), "DELETE", `/v1/nodes/${NODE_ID}`)).status).toBe(404);
    });

    it("400s on a malformed id", async () => {
      expect((await call(app(), "DELETE", "/v1/nodes/1;drop")).status).toBe(400);
      expect(m.query).not.toHaveBeenCalled();
    });
  });

  describe("GET /v1/node/tier", () => {
    it("returns tier, progress to next and demotion reason", async () => {
      const tiers = [tier(1, "probation", 0), tier(2, "bronze", 1)];
      m.getOwnerTier.mockResolvedValue(tiers[0]);
      m.listTiers.mockResolvedValue(tiers);
      m.getOwnerTierStats.mockResolvedValue({ tenureDays: 3, uptimeBps: 0, activeIps: 2, reputation: 4500, daysSinceLastClawback: null });
      m.query.mockResolvedValue({ rows: [{ node_tier_changed_at: null, node_tier_grace_until: null, node_tier_demotion_reason: "reputation" }] });
      const r = await call(app(), "GET", "/v1/node/tier");
      expect(r.status).toBe(200);
      expect(r.body["tier"]).toMatchObject({ name: "probation", dailyWithdrawLimitMusd: "50000000" });
      expect(r.body["nextTier"]).toMatchObject({ name: "bronze" });
      expect(r.body["progress"]).toMatchObject({
        tenureDays: { required: 7, current: 3, met: false },
        activeIps: { required: 2, current: 2, met: true },
        reputation: { required: 4000, current: 4500, met: true },
      });
      expect(r.body["demotionReason"]).toBe("reputation");
    });

    it("fails closed when tier lookup fails", async () => {
      m.getOwnerTier.mockRejectedValue(new Error("Tier lookup failed"));
      m.listTiers.mockResolvedValue([]);
      m.getOwnerTierStats.mockResolvedValue({});
      m.query.mockResolvedValue({ rows: [] });
      expect((await call(app(), "GET", "/v1/node/tier")).status).toBe(503);
    });
  });
});
