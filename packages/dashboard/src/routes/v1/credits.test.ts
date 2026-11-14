import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Wallet } from "ethers";

const wallet = Wallet.createRandom();
const WALLET = wallet.address.toLowerCase();
const payoutSigner = Wallet.createRandom();
const PAYOUT = payoutSigner.address.toLowerCase();
const NEW_ADDR = Wallet.createRandom().address.toLowerCase();
const USER = "11111111-1111-4111-8111-111111111111";
const NODE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";

const base = { userId: USER, email: "w@wallet.dominusnode.com", walletAddress: WALLET as string | null, via: "wallet_jwt", verified: true };
let principal = { ...base };

const m = vi.hoisted(() => ({
  summary: vi.fn(), listTx: vi.fn(), listPayouts: vi.fn(), updateCaps: vi.fn(), report: vi.fn(),
  createCh: vi.fn(), consumeCh: vi.fn(), convert: vi.fn(), getLive: vi.fn(), register: vi.fn(), change: vi.fn(),
  withdraw: vi.fn(), getOwnerTier: vi.fn(), getActivePolicy: vi.fn(), getWallet: vi.fn(),
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
    agentCreditsRepo: {
      ...actual.agentCreditsRepo,
      getCreditSummary: m.summary, listTransactions: m.listTx, listOwnPayouts: m.listPayouts,
      updateNodeCaps: m.updateCaps, reportSession: m.report, createSignChallenge: m.createCh, consumeSignChallenge: m.consumeCh,
    },
    nodeCreditRepo: { ...actual.nodeCreditRepo, convertToWallet: m.convert },
    payoutRepo: {
      ...actual.payoutRepo,
      getLivePayoutWallet: m.getLive, registerPayoutWallet: m.register, changePayoutWallet: m.change, requestWithdraw: m.withdraw,
    },
    tierRepo: { getOwnerTier: m.getOwnerTier, getBuyerDiscount: async () => ({ buyerTierId: 2, buyerDiscountBps: 500, minPlatformMarginBps: 2500 }) },
    policyRepo: { getActivePolicy: m.getActivePolicy },
    walletRepo: { ...actual.walletRepo, getWallet: m.getWallet },
  };
});

import router, * as mod from "./credits.js";
import { call } from "./test-helpers.js";
import { DEFAULT_POLICY, sha256Hex } from "@dominusnode/shared";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/v1", router);
  return a;
}

/** Simulates agent_sign_challenges: create stores, consume deletes once. */
function fakeChallenges() {
  const store = new Map<string, { action: string; message: string }>();
  m.createCh.mockImplementation(async (_u: string, action: string, h: string, message: string) => {
    store.set(h, { action, message });
    return { expiresAt: new Date(Date.now() + 600_000) };
  });
  m.consumeCh.mockImplementation(async (_u: string, action: string, h: string) => {
    const v = store.get(h);
    if (!v || v.action !== action) return null;
    store.delete(h);
    return v.message;
  });
}

let tmp: string;
beforeEach(() => {
  vi.resetAllMocks();
  principal = { ...base };
  for (const l of [mod.readLimiter, mod.mutationLimiter, mod.signChallengeLimiter, mod.reportLimiter]) l.reset();
  mod.resetSdnCache();
  fakeChallenges();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sdn-"));
  const f = path.join(tmp, "sdn.txt");
  fs.writeFileSync(f, "0x" + "9".repeat(40) + "\n");
  process.env["PAYOUT_SDN_FILE"] = f;
  process.env["PAYOUTS_ENABLED"] = "true";
  m.getActivePolicy.mockResolvedValue({ version: 1, body: structuredClone(DEFAULT_POLICY) });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env["PAYOUT_SDN_FILE"];
  delete process.env["PAYOUTS_ENABLED"];
});

describe("money()", () => {
  it("formats µUSD exactly", () => {
    expect(mod.money(1_234_567n)).toEqual({ musd: "1234567", usd: "1.234567" });
    expect(mod.money(5n)).toEqual({ musd: "5", usd: "0.000005" });
  });
});

describe("GET /v1/credits", () => {
  it("returns balances, tier, tax and payout flags", async () => {
    process.env["PAYOUTS_ENABLED"] = "false";
    m.summary.mockResolvedValue({ pendingMusd: 2_000_000n, availableMusd: 1_500_000n, frozen: false, autoConvertPct: 0, taxFormStatus: "not_required", ytdPaidMusd: 0n });
    m.getOwnerTier.mockResolvedValue({ id: 1, name: "probation", rank: 0, holdDays: 14, dailyWithdrawLimitMusd: 50_000_000n });
    const r = await call(app(), "GET", "/v1/credits");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      pending: { musd: "2000000", usd: "2.000000" }, available: { musd: "1500000", usd: "1.500000" },
      frozen: false, tier: { name: "probation", holdDays: 14 }, taxFormStatus: "not_required",
      ytdPaid: { musd: "0" }, payoutsEnabled: false, buyerDiscountBps: 500,
    });
    expect(m.summary).toHaveBeenCalledWith(USER);
  });
});

describe("GET /v1/wallet", () => {
  it("returns the caller's prepaid balance", async () => {
    m.getWallet.mockResolvedValue({ balance_cents: 1234, currency: "usd", last_topped_up: null });
    const r = await call(app(), "GET", "/v1/wallet");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ balanceCents: 1234, currency: "usd", lastToppedUp: null });
    expect(m.getWallet).toHaveBeenCalledWith(USER);
  });
  it("404s when the user has no wallet", async () => {
    m.getWallet.mockResolvedValue(null);
    expect((await call(app(), "GET", "/v1/wallet")).status).toBe(404);
  });
});

describe("GET /v1/credits/transactions", () => {
  it("paginates with a cursor and maps convert_to_wallet to convert", async () => {
    m.listTx.mockResolvedValue([
      { id: 9n, type: "convert_to_wallet", amountMusd: 10_000n, relayChargeId: null, externalRef: "convert:abc", createdAt: new Date() },
      { id: 8n, type: "earn", amountMusd: 5n, relayChargeId: "x", externalRef: null, createdAt: new Date() },
    ]);
    const r = await call(app(), "GET", "/v1/credits/transactions?limit=2&cursor=10&type=convert");
    expect(r.status).toBe(200);
    expect(m.listTx).toHaveBeenCalledWith(USER, { limit: 2, before: 10n, type: "convert_to_wallet" });
    const tx = r.body["transactions"] as Array<Record<string, unknown>>;
    expect(tx[0]).toMatchObject({ id: "9", type: "convert", amount: { musd: "10000" } });
    expect(r.body["nextCursor"]).toBe("8");
  });
  it("rejects bad cursor and type", async () => {
    expect((await call(app(), "GET", "/v1/credits/transactions?cursor=-1")).status).toBe(400);
    expect((await call(app(), "GET", "/v1/credits/transactions?type=__proto__")).status).toBe(400);
  });
});

describe("POST /v1/credits/convert", () => {
  const h = { "idempotency-key": "conv-key-0001" };
  async function signed(amountMusd: string) {
    const ch = await call(app(), "POST", "/v1/credits/convert/challenge", { body: { amountMusd }, headers: h });
    expect(ch.status).toBe(200);
    const c = ch.body as { nonce: string; message: string };
    return { amountMusd, nonce: c.nonce, signature: await wallet.signMessage(c.message) };
  }
  it("refuses an unsigned conversion (a leaked API key alone cannot move credit)", async () => {
    const r = await call(app(), "POST", "/v1/credits/convert", { body: { amountMusd: "1500000" }, headers: h });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: "SIGNATURE_REQUIRED" });
    expect(m.convert).not.toHaveBeenCalled();
  });
  it("converts with a fresh signature from the linked wallet", async () => {
    m.convert.mockResolvedValue({ convertedCents: 150, convertedMusd: 1_500_000n });
    const r = await call(app(), "POST", "/v1/credits/convert", { body: await signed("1500000"), headers: h });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ converted: { musd: "1500000" }, convertedCents: 150, duplicate: false });
    expect(m.convert).toHaveBeenCalledWith(USER, 1_500_000n, "conv-key-0001");
  });
  it("rejects replay, a changed amount, another key and another signer", async () => {
    m.convert.mockResolvedValue({ convertedCents: 150, convertedMusd: 1_500_000n });
    const b = await signed("1500000");
    expect((await call(app(), "POST", "/v1/credits/convert", { body: { ...b, amountMusd: "1500001" }, headers: h })).body).toMatchObject({ code: "INVALID_CHALLENGE" });
    const b2 = await signed("1500000");
    expect((await call(app(), "POST", "/v1/credits/convert", { body: b2, headers: { "idempotency-key": "conv-key-0002" } })).body).toMatchObject({ code: "INVALID_CHALLENGE" });
    const ch = await call(app(), "POST", "/v1/credits/convert/challenge", { body: { amountMusd: "1500000" }, headers: h });
    const other = await Wallet.createRandom().signMessage((ch.body as { message: string }).message);
    expect((await call(app(), "POST", "/v1/credits/convert", { body: { amountMusd: "1500000", nonce: (ch.body as { nonce: string }).nonce, signature: other }, headers: h })).body).toMatchObject({ code: "BAD_SIGNATURE" });
    const ok = await signed("1500000");
    expect((await call(app(), "POST", "/v1/credits/convert", { body: ok, headers: h })).status).toBe(200);
    expect((await call(app(), "POST", "/v1/credits/convert", { body: ok, headers: h })).body).toMatchObject({ code: "INVALID_CHALLENGE" });
    expect(m.convert).toHaveBeenCalledTimes(1);
  });
  it("requires a linked wallet, the header, amount bounds and verification", async () => {
    expect((await call(app(), "POST", "/v1/credits/convert/challenge", { body: { amountMusd: "1500000" } })).status).toBe(400);
    expect((await call(app(), "POST", "/v1/credits/convert/challenge", { body: { amountMusd: "9999" }, headers: h })).status).toBe(400);
    expect((await call(app(), "POST", "/v1/credits/convert/challenge", { body: { amountMusd: "10000000001" }, headers: h })).status).toBe(400);
    expect((await call(app(), "POST", "/v1/credits/convert/challenge", { body: { amountMusd: 1.5 }, headers: h })).status).toBe(400);
    principal = { ...base, walletAddress: null };
    expect((await call(app(), "POST", "/v1/credits/convert/challenge", { body: { amountMusd: "1500000" }, headers: h })).body).toMatchObject({ code: "NO_LINKED_WALLET" });
    principal = { ...base, verified: false };
    expect((await call(app(), "POST", "/v1/credits/convert", { body: { amountMusd: "1500000" }, headers: h })).status).toBe(403);
    expect(m.convert).not.toHaveBeenCalled();
  });
  it("maps frozen and insufficient", async () => {
    m.convert.mockRejectedValueOnce(new Error("Node credit account is frozen"));
    expect((await call(app(), "POST", "/v1/credits/convert", { body: await signed("10000"), headers: h })).status).toBe(403);
    m.convert.mockRejectedValueOnce(new Error("Insufficient available credit"));
    expect((await call(app(), "POST", "/v1/credits/convert", { body: await signed("10000"), headers: h })).status).toBe(409);
  });
});

async function payoutChallenge(address: string) {
  const r = await call(app(), "POST", "/v1/payout-wallet/challenge", { body: { address, chain: "base" } });
  expect(r.status).toBe(200);
  return r.body as { nonce: string; message: string; oldWalletSignatureRequired: boolean };
}

describe("payout wallet", () => {
  it("GET returns null when none is registered", async () => {
    m.getLive.mockResolvedValue(null);
    const r = await call(app(), "GET", "/v1/payout-wallet");
    expect(r.body).toMatchObject({ payoutWallet: null, cooldownHours: 72 });
  });

  it("registers the first wallet with a linked-wallet signature over a bound challenge", async () => {
    m.getLive.mockResolvedValue(null);
    const ch = await payoutChallenge(PAYOUT);
    expect(ch.message).toContain(`User: ${USER}`);
    expect(ch.message).toContain(`Payout address: ${PAYOUT}`);
    m.register.mockResolvedValue({ address: PAYOUT, chain: "base", status: "active", activeFrom: new Date() });
    const signature = await wallet.signMessage(ch.message);
    const r = await call(app(), "PUT", "/v1/payout-wallet", { body: { address: PAYOUT, chain: "base", nonce: ch.nonce, signature } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ changed: false, payoutWallet: { address: PAYOUT, status: "active" } });
    expect(m.register).toHaveBeenCalledWith(USER, PAYOUT, { ofacCleared: true, chain: "base" });
    expect(m.consumeCh).toHaveBeenCalledWith(USER, "payout_wallet_set", sha256Hex(ch.nonce));
  });

  it("rejects replaying a consumed challenge", async () => {
    m.getLive.mockResolvedValue(null);
    m.register.mockResolvedValue({ address: PAYOUT, chain: "base", status: "active", activeFrom: new Date() });
    const ch = await payoutChallenge(PAYOUT);
    const body = { address: PAYOUT, chain: "base", nonce: ch.nonce, signature: await wallet.signMessage(ch.message) };
    expect((await call(app(), "PUT", "/v1/payout-wallet", { body })).status).toBe(200);
    const again = await call(app(), "PUT", "/v1/payout-wallet", { body });
    expect(again.status).toBe(400);
    expect(again.body["code"]).toBe("INVALID_CHALLENGE");
    expect(m.register).toHaveBeenCalledTimes(1);
  });

  it("rejects a challenge issued for a different address (binding)", async () => {
    m.getLive.mockResolvedValue(null);
    const ch = await payoutChallenge(PAYOUT);
    const r = await call(app(), "PUT", "/v1/payout-wallet", {
      body: { address: NEW_ADDR, chain: "base", nonce: ch.nonce, signature: await wallet.signMessage(ch.message) },
    });
    expect(r.status).toBe(400);
    expect(m.register).not.toHaveBeenCalled();
  });

  it("rejects a signature from another wallet and burns the challenge", async () => {
    m.getLive.mockResolvedValue(null);
    const ch = await payoutChallenge(PAYOUT);
    const r = await call(app(), "PUT", "/v1/payout-wallet", {
      body: { address: PAYOUT, chain: "base", nonce: ch.nonce, signature: await Wallet.createRandom().signMessage(ch.message) },
    });
    expect(r.body["code"]).toBe("BAD_SIGNATURE");
    const retry = await call(app(), "PUT", "/v1/payout-wallet", {
      body: { address: PAYOUT, chain: "base", nonce: ch.nonce, signature: await wallet.signMessage(ch.message) },
    });
    expect(retry.body["code"]).toBe("INVALID_CHALLENGE");
  });

  it("refuses SDN-listed addresses and fails closed without a list", async () => {
    const bad = "0x" + "9".repeat(40);
    m.getLive.mockResolvedValue(null);
    let ch = await payoutChallenge(bad);
    let r = await call(app(), "PUT", "/v1/payout-wallet", { body: { address: bad, nonce: ch.nonce, signature: await wallet.signMessage(ch.message) } });
    expect(r.status).toBe(403);
    delete process.env["PAYOUT_SDN_FILE"];
    mod.resetSdnCache();
    ch = await payoutChallenge(PAYOUT);
    r = await call(app(), "PUT", "/v1/payout-wallet", { body: { address: PAYOUT, nonce: ch.nonce, signature: await wallet.signMessage(ch.message) } });
    expect(r.status).toBe(503);
    expect(m.register).not.toHaveBeenCalled();
  });

  it("change requires the OLD payout wallet's signature, then cools down 72h", async () => {
    m.getLive.mockResolvedValue({ address: PAYOUT, chain: "base", status: "active", activeFrom: new Date(0) });
    const ch = await payoutChallenge(NEW_ADDR);
    expect(ch.oldWalletSignatureRequired).toBe(true);
    const signature = await wallet.signMessage(ch.message);
    const noOld = await call(app(), "PUT", "/v1/payout-wallet", { body: { address: NEW_ADDR, nonce: ch.nonce, signature } });
    expect(noOld.body["code"]).toBe("OLD_WALLET_SIGNATURE_REQUIRED");
    expect(m.change).not.toHaveBeenCalled();

    const ch2 = await payoutChallenge(NEW_ADDR);
    const activeFrom = new Date(Date.now() + 72 * 3600_000);
    m.change.mockResolvedValue({ address: NEW_ADDR, chain: "base", status: "pending", activeFrom });
    const r = await call(app(), "PUT", "/v1/payout-wallet", {
      body: { address: NEW_ADDR, nonce: ch2.nonce, signature: await wallet.signMessage(ch2.message), oldWalletSignature: await payoutSigner.signMessage(ch2.message) },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ changed: true, cooldownHours: 72, payoutWallet: { status: "pending" } });
    expect(m.change.mock.calls[0][1]).toBe(NEW_ADDR);
  });

  it("maps a change during an active cooldown to 409", async () => {
    m.getLive.mockResolvedValue({ address: WALLET, chain: "base", status: "active", activeFrom: new Date(0) });
    m.change.mockRejectedValue(new Error("A payout wallet change is already cooling down"));
    const ch = await payoutChallenge(NEW_ADDR);
    const r = await call(app(), "PUT", "/v1/payout-wallet", { body: { address: NEW_ADDR, nonce: ch.nonce, signature: await wallet.signMessage(ch.message) } });
    expect(r.status).toBe(409);
    expect(r.body["code"]).toBe("COOLDOWN_ACTIVE");
  });

  it("requires a linked wallet", async () => {
    principal = { ...base, walletAddress: null };
    const r = await call(app(), "POST", "/v1/payout-wallet/challenge", { body: { address: PAYOUT } });
    expect(r.status).toBe(400);
  });
});

describe("POST /v1/credits/withdraw", () => {
  const IDEM = "withdraw-0001";
  async function challenge(amountMusd = "2000000") {
    const r = await call(app(), "POST", "/v1/credits/withdraw/challenge", { body: { amountMusd, idempotencyKey: IDEM } });
    expect(r.status).toBe(200);
    return r.body as { nonce: string; message: string };
  }
  const notFrozen = { pendingMusd: 0n, availableMusd: 5_000_000n, frozen: false, autoConvertPct: 0, taxFormStatus: "not_required", ytdPaidMusd: 0n };

  it("returns 503 PAYOUTS_DISABLED when payouts are off", async () => {
    process.env["PAYOUTS_ENABLED"] = "false";
    const r = await call(app(), "POST", "/v1/credits/withdraw", { body: { amountMusd: "2000000", idempotencyKey: IDEM, nonce: "a".repeat(64), signature: "0x" + "1".repeat(130) } });
    expect(r.status).toBe(503);
    expect(r.body["code"]).toBe("PAYOUTS_DISABLED");
    expect(String(r.body["error"])).toMatch(/disabled/);
    const c = await call(app(), "POST", "/v1/credits/withdraw/challenge", { body: { amountMusd: "2000000", idempotencyKey: IDEM } });
    expect(c.status).toBe(503);
  });

  it("queues a payout with a fresh signature", async () => {
    m.summary.mockResolvedValue(notFrozen);
    m.withdraw.mockResolvedValue({ payout: { id: "p1", amountMusd: 2_000_000n, trigger: "on_demand", status: "pending", txHash: null, createdAt: new Date() }, duplicate: false });
    const ch = await challenge();
    expect(ch.message).toContain("Amount (µUSD): 2000000");
    const r = await call(app(), "POST", "/v1/credits/withdraw", {
      body: { amountMusd: "2000000", idempotencyKey: IDEM, nonce: ch.nonce, signature: await wallet.signMessage(ch.message) },
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ payout: { id: "p1", amount: { musd: "2000000" }, status: "pending" }, duplicate: false });
    expect(m.withdraw).toHaveBeenCalledWith({ userId: USER, amountMusd: 2_000_000n, idempotencyKey: IDEM, trigger: "on_demand" });
  });

  it("rejects signature replay and an amount not bound by the challenge", async () => {
    m.summary.mockResolvedValue(notFrozen);
    m.withdraw.mockResolvedValue({ payout: { id: "p1", amountMusd: 2_000_000n, trigger: "on_demand", status: "pending", txHash: null, createdAt: new Date() }, duplicate: false });
    const ch = await challenge();
    const sig = await wallet.signMessage(ch.message);
    const tampered = await call(app(), "POST", "/v1/credits/withdraw", { body: { amountMusd: "3000000", idempotencyKey: IDEM, nonce: ch.nonce, signature: sig } });
    expect(tampered.body["code"]).toBe("INVALID_CHALLENGE");
    const ch2 = await challenge();
    const body = { amountMusd: "2000000", idempotencyKey: IDEM, nonce: ch2.nonce, signature: await wallet.signMessage(ch2.message) };
    expect((await call(app(), "POST", "/v1/credits/withdraw", { body })).status).toBe(201);
    const replay = await call(app(), "POST", "/v1/credits/withdraw", { body });
    expect(replay.body["code"]).toBe("INVALID_CHALLENGE");
    expect(m.withdraw).toHaveBeenCalledTimes(1);
  });

  it("enforces minimum $1", async () => {
    const r = await call(app(), "POST", "/v1/credits/withdraw/challenge", { body: { amountMusd: "999999", idempotencyKey: IDEM } });
    expect(r.status).toBe(400);
  });

  it("refuses frozen accounts", async () => {
    m.summary.mockResolvedValue({ ...notFrozen, frozen: true });
    const ch = await challenge();
    const r = await call(app(), "POST", "/v1/credits/withdraw", {
      body: { amountMusd: "2000000", idempotencyKey: IDEM, nonce: ch.nonce, signature: await wallet.signMessage(ch.message) },
    });
    expect(r.status).toBe(403);
    expect(r.body["code"]).toBe("ACCOUNT_FROZEN");
    expect(m.withdraw).not.toHaveBeenCalled();
  });

  it("maps tier daily limit and wallet cooldown", async () => {
    m.summary.mockResolvedValue(notFrozen);
    for (const [msg, code] of [["Daily withdrawal limit exceeded", "DAILY_LIMIT_EXCEEDED"], ["Payout wallet change is cooling down", "PAYOUT_WALLET_COOLDOWN"]]) {
      m.withdraw.mockRejectedValueOnce(new Error(msg));
      const ch = await challenge();
      const r = await call(app(), "POST", "/v1/credits/withdraw", {
        body: { amountMusd: "2000000", idempotencyKey: IDEM, nonce: ch.nonce, signature: await wallet.signMessage(ch.message) },
      });
      expect(r.status).toBe(409);
      expect(r.body["code"]).toBe(code);
    }
  });

  it("requires verification", async () => {
    principal = { ...base, verified: false };
    const r = await call(app(), "POST", "/v1/credits/withdraw/challenge", { body: { amountMusd: "2000000", idempotencyKey: IDEM } });
    expect(r.status).toBe(403);
  });
});

describe("GET /v1/payouts", () => {
  it("lists only the caller's payouts", async () => {
    m.listPayouts.mockResolvedValue([{ id: "p1", amountMusd: 1_000_000n, trigger: "auto", status: "confirmed", txHash: "0x" + "a".repeat(64), failureReason: null, address: PAYOUT, chain: "base", createdAt: new Date(), updatedAt: new Date() }]);
    const r = await call(app(), "GET", "/v1/payouts?limit=10");
    expect(r.status).toBe(200);
    expect(m.listPayouts).toHaveBeenCalledWith(USER, { limit: 11, offset: 0, cursor: null });
    expect((r.body["payouts"] as unknown[])[0]).toMatchObject({ status: "confirmed", txHash: "0x" + "a".repeat(64) });
    expect(r.body["nextCursor"]).toBeNull();
  });
  it("returns nextCursor when more rows exist and accepts it back", async () => {
    const mk = (i: number) => ({ id: `00000000-0000-4000-8000-00000000000${i}`, amountMusd: 1n, trigger: "auto", status: "confirmed", txHash: null, failureReason: null, address: PAYOUT, chain: "base", createdAt: new Date(Date.UTC(2026, 0, 10 - i)), updatedAt: new Date() });
    m.listPayouts.mockResolvedValueOnce([mk(1), mk(2), mk(3)]);
    const r = await call(app(), "GET", "/v1/payouts?limit=2");
    expect((r.body["payouts"] as unknown[]).length).toBe(2);
    const next = r.body["nextCursor"] as string;
    expect(typeof next).toBe("string");
    m.listPayouts.mockResolvedValueOnce([mk(3)]);
    const r2 = await call(app(), "GET", `/v1/payouts?limit=2&cursor=${next}`);
    expect(r2.status).toBe(200);
    expect(m.listPayouts).toHaveBeenLastCalledWith(USER, { limit: 3, offset: 0, cursor: { createdAt: mk(2).createdAt, id: mk(2).id } });
    expect(r2.body["nextCursor"]).toBeNull();
  });
  it("400 INVALID_CURSOR for a malformed cursor", async () => {
    const r = await call(app(), "GET", "/v1/payouts?cursor=not*valid");
    expect(r.status).toBe(400);
    expect(r.body["code"]).toBe("INVALID_CURSOR");
  });
});

describe("PATCH /v1/nodes/:id", () => {
  it("lowers caps on an owned node", async () => {
    m.updateCaps.mockResolvedValue({ id: NODE_ID, status: "active", maxStreams: 8, maxGbDay: 5, maxReqPerSec: 20 });
    const r = await call(app(), "PATCH", `/v1/nodes/${NODE_ID}`, { body: { maxStreams: 8, reqPerSec: 20 } });
    expect(r.status).toBe(200);
    expect(m.updateCaps).toHaveBeenCalledWith(USER, NODE_ID, { maxStreams: 8, maxGbDay: undefined, maxReqPerSec: 20 });
    expect(r.body).toMatchObject({ caps: { maxStreams: 8, reqPerSec: 20 }, effective: { maxStreams: 8 } });
  });
  it("refuses raising above the policy default", async () => {
    const r = await call(app(), "PATCH", `/v1/nodes/${NODE_ID}`, { body: { maxStreams: DEFAULT_POLICY.nodeDefaults.maxStreams + 1 } });
    expect(r.status).toBe(400);
    expect(r.body["code"]).toBe("CAP_ABOVE_DEFAULT");
    expect(m.updateCaps).not.toHaveBeenCalled();
  });
  it("rejects unknown fields and empty bodies", async () => {
    expect((await call(app(), "PATCH", `/v1/nodes/${NODE_ID}`, { body: { status: "active" } })).status).toBe(400);
    expect((await call(app(), "PATCH", `/v1/nodes/${NODE_ID}`, { body: {} })).status).toBe(400);
  });
  it("returns 404 for another user's node (IDOR)", async () => {
    m.updateCaps.mockResolvedValue(null);
    const r = await call(app(), "PATCH", `/v1/nodes/${NODE_ID}`, { body: { gbPerDay: 1 } });
    expect(r.status).toBe(404);
    expect(m.updateCaps.mock.calls[0][0]).toBe(USER);
  });
});

describe("POST /v1/sessions/:id/report", () => {
  it("records a report without exposing the node id", async () => {
    m.report.mockResolvedValue({ ok: true, reportId: "7", nodeId: NODE_ID, reportsToday: 1 });
    const r = await call(app(), "POST", `/v1/sessions/${SESSION_ID}/report`, { body: { reason: "captcha" } });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ reportId: "7", reportsToday: 1, limitPerDay: 5 });
    expect(m.report).toHaveBeenCalledWith(USER, SESSION_ID, "captcha");
  });
  it("404s for another requester's session (IDOR)", async () => {
    m.report.mockResolvedValue({ ok: false, reason: "not_found" });
    expect((await call(app(), "POST", `/v1/sessions/${SESSION_ID}/report`, { body: { reason: "blocked" } })).status).toBe(404);
  });
  it("409 REPORT_LIMIT past 5 per node per day (not 429: retrying cannot help) and 409s on duplicates", async () => {
    m.report.mockResolvedValueOnce({ ok: false, reason: "rate_limited" });
    const lim = await call(app(), "POST", `/v1/sessions/${SESSION_ID}/report`, { body: { reason: "blocked" } });
    expect(lim.status).toBe(409);
    expect((lim.body as Record<string, unknown>)["code"]).toBe("REPORT_LIMIT");
    m.report.mockResolvedValueOnce({ ok: false, reason: "duplicate" });
    expect((await call(app(), "POST", `/v1/sessions/${SESSION_ID}/report`, { body: { reason: "blocked" } })).status).toBe(409);
  });
  it("validates reason", async () => {
    expect((await call(app(), "POST", `/v1/sessions/${SESSION_ID}/report`, { body: { reason: "meh" } })).status).toBe(400);
  });
});

describe("payout wallet testnet gating", () => {
  const prev = { env: process.env["NODE_ENV"], allow: process.env["PAYOUT_ALLOW_TESTNET"] };
  afterEach(() => {
    if (prev.env === undefined) delete process.env["NODE_ENV"]; else process.env["NODE_ENV"] = prev.env;
    if (prev.allow === undefined) delete process.env["PAYOUT_ALLOW_TESTNET"]; else process.env["PAYOUT_ALLOW_TESTNET"] = prev.allow;
  });

  it("testnetPayoutsAllowed: off in production unless PAYOUT_ALLOW_TESTNET=true", () => {
    expect(mod.testnetPayoutsAllowed({ NODE_ENV: "production" })).toBe(false);
    expect(mod.testnetPayoutsAllowed({ NODE_ENV: "production", PAYOUT_ALLOW_TESTNET: "1" })).toBe(false);
    expect(mod.testnetPayoutsAllowed({ NODE_ENV: "production", PAYOUT_ALLOW_TESTNET: "true" })).toBe(true);
    expect(mod.testnetPayoutsAllowed({ NODE_ENV: "staging" })).toBe(true);
    expect(mod.testnetPayoutsAllowed({})).toBe(true);
  });

  it("normChain accepts base always and base-sepolia only when allowed", () => {
    expect(mod.normChain(undefined, { NODE_ENV: "production" })).toBe("base");
    expect(mod.normChain("base", { NODE_ENV: "production" })).toBe("base");
    expect(mod.normChain("base-sepolia", { NODE_ENV: "production" })).toBeNull();
    expect(mod.normChain("base-sepolia", { NODE_ENV: "test" })).toBe("base-sepolia");
    expect(mod.normChain("ethereum", { NODE_ENV: "test" })).toBeNull();
  });

  it("production refuses a base-sepolia challenge", async () => {
    process.env["NODE_ENV"] = "production";
    delete process.env["PAYOUT_ALLOW_TESTNET"];
    m.getLive.mockResolvedValue(null);
    const r = await call(app(), "POST", "/v1/payout-wallet/challenge", { body: { address: PAYOUT, chain: "base-sepolia" } });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain("base-sepolia");
  });

  it("registers a base-sepolia wallet when PAYOUT_ALLOW_TESTNET=true in production", async () => {
    process.env["NODE_ENV"] = "production";
    process.env["PAYOUT_ALLOW_TESTNET"] = "true";
    m.getLive.mockResolvedValue(null);
    const c = await call(app(), "POST", "/v1/payout-wallet/challenge", { body: { address: PAYOUT, chain: "base-sepolia" } });
    expect(c.status).toBe(200);
    const ch = c.body as { nonce: string; message: string };
    expect(ch.message).toContain("Chain: base-sepolia");
    m.register.mockResolvedValue({ address: PAYOUT, chain: "base-sepolia", status: "active", activeFrom: new Date() });
    const r = await call(app(), "PUT", "/v1/payout-wallet", {
      body: { address: PAYOUT, chain: "base-sepolia", nonce: ch.nonce, signature: await wallet.signMessage(ch.message) },
    });
    expect(r.status).toBe(200);
    expect(m.register).toHaveBeenCalledWith(USER, PAYOUT, { ofacCleared: true, chain: "base-sepolia" });
  });
});
