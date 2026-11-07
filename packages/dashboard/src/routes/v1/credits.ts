import { Router } from "express";
import type { Request, Response } from "express";
import * as crypto from "node:crypto";
import {
  createLogger,
  nodeCreditRepo,
  payoutRepo,
  tierRepo,
  policyRepo,
  agentCreditsRepo,
  loadSdnFile,
  sha256Hex,
} from "@dominusnode/shared";
import { requireAgentPrincipal, type AgentRequest } from "../../middleware/agent.js";
import { recoverSignerAddress } from "../../helpers/verify-signature.js";
import { createKeyedLimiter } from "./limiter.js";

/**
 * Agent self-service: credits, payout wallet, withdrawals, payouts, node caps
 * and burn reports. Request/response shapes: docs/agent-network/AGENT_API.md.
 */
const log = createLogger("api:v1:credits");
const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64 = /^[0-9a-f]{64}$/;
const SIG_RE = /^0x[0-9a-fA-F]{130}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const IDEM_RE = /^[A-Za-z0-9_-]{8,120}$/;
const MUSD_RE = /^[1-9][0-9]{0,15}$/;

export const MIN_CONVERT_MUSD = 10_000n; // 1 cent
export const MAX_CONVERT_MUSD = 10_000_000_000n; // $10,000 (wallet balance cap)
export const MAX_WITHDRAW_MUSD = 100_000_000_000n; // $100,000 (repo bound)

export const readLimiter = createKeyedLimiter(120, 60_000);
export const mutationLimiter = createKeyedLimiter(30, 60 * 60_000);
export const signChallengeLimiter = createKeyedLimiter(30, 60 * 60_000);
export const reportLimiter = createKeyedLimiter(60, 60 * 60_000);

/** Money as exact µUSD string plus a 6-decimal USD string. */
export function money(musd: bigint): { musd: string; usd: string } {
  const neg = musd < 0n;
  const a = neg ? -musd : musd;
  const whole = a / 1_000_000n;
  const frac = (a % 1_000_000n).toString().padStart(6, "0");
  return { musd: musd.toString(), usd: `${neg ? "-" : ""}${whole}.${frac}` };
}

function principal(req: Request): AgentRequest["agent"] {
  return (req as AgentRequest).agent;
}

function parseMusd(v: unknown): bigint | null {
  if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) return BigInt(v);
  if (typeof v === "string" && MUSD_RE.test(v)) return BigInt(v);
  return null;
}

function requireVerified(req: Request, res: Response): boolean {
  if (!principal(req).verified) {
    res.status(403).json({ error: "Email verification required", code: "EMAIL_NOT_VERIFIED" });
    return false;
  }
  return true;
}

function limit(l: { hit(k: string): boolean }, req: Request, res: Response): boolean {
  if (!l.hit(principal(req).userId)) {
    res.status(429).json({ error: "Too many requests. Try again later.", code: "RATE_LIMITED" });
    return false;
  }
  return true;
}

function payoutsDisabled(res: Response): void {
  res.status(503).json({
    error: "Payouts are currently disabled. Earnings keep accruing and can be converted to your requester wallet with POST /v1/credits/convert.",
    code: "PAYOUTS_DISABLED",
  });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── Signed messages (EIP-191, signed by the account's linked wallet) ───

export function payoutWalletMessage(i: { userId: string; wallet: string; address: string; chain: string; nonce: string }): string {
  return [
    "DominusNode payout wallet",
    "Action: payout_wallet_set",
    `User: ${i.userId}`,
    `Account wallet: ${i.wallet}`,
    `Payout address: ${i.address}`,
    `Chain: ${i.chain}`,
    `Nonce: ${i.nonce}`,
  ].join("\n");
}

export function withdrawMessage(i: { userId: string; wallet: string; amountMusd: bigint; idempotencyKey: string; nonce: string }): string {
  return [
    "DominusNode withdrawal",
    "Action: withdraw",
    `User: ${i.userId}`,
    `Account wallet: ${i.wallet}`,
    `Amount (µUSD): ${i.amountMusd.toString()}`,
    `Idempotency key: ${i.idempotencyKey}`,
    `Nonce: ${i.nonce}`,
  ].join("\n");
}

// ─── OFAC SDN screening (PAYOUT_SDN_FILE; cached, fail closed) ──────────

let sdnCache: { at: number; set: Set<string> } | null = null;
const SDN_TTL_MS = 10 * 60_000;
export function resetSdnCache(): void { sdnCache = null; }
async function sdnHit(address: string): Promise<boolean> {
  if (!sdnCache || Date.now() - sdnCache.at > SDN_TTL_MS) {
    sdnCache = { at: Date.now(), set: await loadSdnFile(process.env["PAYOUT_SDN_FILE"]) };
  }
  return sdnCache.set.has(address.toLowerCase());
}

router.use(requireAgentPrincipal);

// GET /v1/credits
router.get("/credits", async (req: Request, res: Response) => {
  const agent = principal(req);
  if (!limit(readLimiter, req, res)) return;
  try {
    const [s, tier, buyer] = await Promise.all([
      agentCreditsRepo.getCreditSummary(agent.userId),
      tierRepo.getOwnerTier(agent.userId),
      tierRepo.getBuyerDiscount(agent.userId),
    ]);
    res.json({
      pending: money(s.pendingMusd),
      available: money(s.availableMusd),
      frozen: s.frozen,
      autoConvertPct: s.autoConvertPct,
      tier: { id: tier.id, name: tier.name, rank: tier.rank, holdDays: tier.holdDays, dailyWithdrawLimit: money(tier.dailyWithdrawLimitMusd) },
      taxFormStatus: s.taxFormStatus,
      ytdPaid: money(s.ytdPaidMusd),
      payoutsEnabled: payoutRepo.payoutsEnabled(),
      minWithdraw: money(payoutRepo.MIN_WITHDRAW_MUSD),
      // Discount on relay purchases from your owner tier (0 unless you run a node).
      buyerDiscountBps: buyer.buyerDiscountBps,
    });
  } catch (err) {
    log.error("credits summary failed", { error: errMsg(err) });
    res.status(500).json({ error: "Failed to load credits" });
  }
});

const API_TYPE: Record<string, string> = { convert_to_wallet: "convert" };
const DB_TYPE: Record<string, agentCreditsRepo.LedgerType> = {
  earn: "earn", mature: "mature", clawback: "clawback", convert: "convert_to_wallet",
  withdraw: "withdraw", withdraw_reversal: "withdraw_reversal",
};

// GET /v1/credits/transactions?limit=&cursor=&type=
router.get("/credits/transactions", async (req: Request, res: Response) => {
  const agent = principal(req);
  if (!limit(readLimiter, req, res)) return;
  const lim = Math.min(Math.max(parseInt(String(req.query["limit"] ?? "50"), 10) || 50, 1), 200);
  const cursorRaw = req.query["cursor"];
  let before: bigint | undefined;
  if (cursorRaw !== undefined) {
    if (typeof cursorRaw !== "string" || !/^[1-9][0-9]{0,18}$/.test(cursorRaw)) {
      res.status(400).json({ error: "Invalid cursor" });
      return;
    }
    before = BigInt(cursorRaw);
  }
  const typeRaw = req.query["type"];
  let type: agentCreditsRepo.LedgerType | undefined;
  if (typeRaw !== undefined) {
    type = typeof typeRaw === "string" && Object.prototype.hasOwnProperty.call(DB_TYPE, typeRaw) ? DB_TYPE[typeRaw] : undefined;
    if (!type) {
      res.status(400).json({ error: "Invalid type" });
      return;
    }
  }
  try {
    const rows = await agentCreditsRepo.listTransactions(agent.userId, { limit: lim, before, type });
    res.json({
      transactions: rows.map((t) => ({
        id: t.id.toString(),
        type: API_TYPE[t.type] ?? t.type,
        amount: money(t.amountMusd),
        relayChargeId: t.relayChargeId,
        reference: t.externalRef,
        createdAt: t.createdAt,
      })),
      nextCursor: rows.length === lim ? rows[rows.length - 1].id.toString() : null,
    });
  } catch (err) {
    log.error("credit transactions failed", { error: errMsg(err) });
    res.status(500).json({ error: "Failed to load transactions" });
  }
});

// POST /v1/credits/convert {amountMusd}  (Idempotency-Key header)
router.post("/credits/convert", async (req: Request, res: Response) => {
  const agent = principal(req);
  if (!requireVerified(req, res)) return;
  const idem = req.headers["idempotency-key"];
  if (typeof idem !== "string" || !IDEM_RE.test(idem)) {
    res.status(400).json({ error: "Idempotency-Key header required (8-120 chars of A-Z a-z 0-9 _ -)" });
    return;
  }
  const amount = parseMusd(req.body?.amountMusd);
  if (amount === null || amount < MIN_CONVERT_MUSD || amount > MAX_CONVERT_MUSD) {
    res.status(400).json({ error: `amountMusd must be an integer between ${MIN_CONVERT_MUSD} and ${MAX_CONVERT_MUSD}` });
    return;
  }
  if (!limit(mutationLimiter, req, res)) return;
  try {
    const r = await nodeCreditRepo.convertToWallet(agent.userId, amount, idem);
    res.json({ converted: money(r.convertedMusd), convertedCents: r.convertedCents, duplicate: r.duplicate === true });
  } catch (err) {
    const m = errMsg(err);
    if (m.includes("frozen")) { res.status(403).json({ error: "Credit account is frozen", code: "ACCOUNT_FROZEN" }); return; }
    if (m.includes("Insufficient")) { res.status(409).json({ error: "Insufficient available credit", code: "INSUFFICIENT_CREDIT" }); return; }
    if (m.includes("balance cap")) { res.status(409).json({ error: "Conversion would exceed the wallet balance cap", code: "WALLET_CAP" }); return; }
    if (m.includes("Wallet not found")) { res.status(409).json({ error: "Requester wallet not found", code: "NO_WALLET" }); return; }
    if (m.includes("below one cent")) { res.status(400).json({ error: "Amount below one cent" }); return; }
    log.error("credit convert failed", { error: m });
    res.status(500).json({ error: "Conversion failed" });
  }
});

/**
 * base-sepolia payout wallets are for staging smoke tests: allowed when
 * NODE_ENV !== "production", or when PAYOUT_ALLOW_TESTNET=true. Never in
 * production by default.
 */
export function testnetPayoutsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["NODE_ENV"] !== "production" || env["PAYOUT_ALLOW_TESTNET"] === "true";
}

export function normChain(v: unknown, env: NodeJS.ProcessEnv = process.env): "base" | "base-sepolia" | null {
  if (v === undefined || v === "base") return "base";
  if (v === "base-sepolia" && testnetPayoutsAllowed(env)) return "base-sepolia";
  return null;
}

function chainError(): string {
  return testnetPayoutsAllowed()
    ? "address must be a 0x EVM address and chain must be 'base' or 'base-sepolia'"
    : "address must be a 0x EVM address and chain must be 'base'";
}

// GET /v1/payout-wallet
router.get("/payout-wallet", async (req: Request, res: Response) => {
  const agent = principal(req);
  if (!limit(readLimiter, req, res)) return;
  try {
    const w = await payoutRepo.getLivePayoutWallet(agent.userId);
    const cooling = !!w && w.status === "pending" && new Date(w.activeFrom).getTime() > Date.now();
    res.json({
      payoutWallet: w ? { address: w.address, chain: w.chain, status: cooling ? "pending" : "active", activeFrom: w.activeFrom } : null,
      cooldownHours: payoutRepo.PAYOUT_WALLET_COOLDOWN_HOURS,
    });
  } catch (err) {
    log.error("payout wallet lookup failed", { error: errMsg(err) });
    res.status(500).json({ error: "Failed to load payout wallet" });
  }
});

// POST /v1/payout-wallet/challenge {address, chain}
router.post("/payout-wallet/challenge", async (req: Request, res: Response) => {
  const agent = principal(req);
  if (!requireVerified(req, res)) return;
  if (!agent.walletAddress) {
    res.status(400).json({ error: "A linked wallet is required to manage payouts", code: "NO_LINKED_WALLET" });
    return;
  }
  const address = typeof req.body?.address === "string" && ADDRESS_RE.test(req.body.address) ? req.body.address.toLowerCase() : null;
  const chain = normChain(req.body?.chain);
  if (!address || !chain) {
    res.status(400).json({ error: chainError() });
    return;
  }
  if (!limit(signChallengeLimiter, req, res)) return;
  try {
    const current = await payoutRepo.getLivePayoutWallet(agent.userId);
    const nonce = crypto.randomBytes(32).toString("hex");
    const message = payoutWalletMessage({ userId: agent.userId, wallet: agent.walletAddress, address, chain, nonce });
    const stored = await agentCreditsRepo.createSignChallenge(agent.userId, "payout_wallet_set", sha256Hex(nonce), message);
    if (!stored) {
      res.status(429).json({ error: "Too many outstanding challenges", code: "RATE_LIMITED" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({
      nonce, message, expiresAt: stored.expiresAt,
      signer: agent.walletAddress,
      oldWalletSignatureRequired: !!current && current.address !== agent.walletAddress,
      oldWalletAddress: current ? current.address : null,
    });
  } catch (err) {
    log.error("payout wallet challenge failed", { error: errMsg(err) });
    res.status(500).json({ error: "Failed to create challenge" });
  }
});

// PUT /v1/payout-wallet {address, chain, nonce, signature, oldWalletSignature?}
router.put("/payout-wallet", async (req: Request, res: Response) => {
  const agent = principal(req);
  if (!requireVerified(req, res)) return;
  if (!agent.walletAddress) {
    res.status(400).json({ error: "A linked wallet is required to manage payouts", code: "NO_LINKED_WALLET" });
    return;
  }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const address = typeof b["address"] === "string" && ADDRESS_RE.test(b["address"]) ? b["address"].toLowerCase() : null;
  const chain = normChain(b["chain"]);
  const nonce = typeof b["nonce"] === "string" ? b["nonce"].toLowerCase() : "";
  const sig = typeof b["signature"] === "string" ? b["signature"] : "";
  const oldSig = b["oldWalletSignature"];
  if (!address || !chain) { res.status(400).json({ error: chainError() }); return; }
  if (!HEX64.test(nonce)) { res.status(400).json({ error: "Invalid nonce" }); return; }
  if (!SIG_RE.test(sig)) { res.status(400).json({ error: "Invalid signature" }); return; }
  if (oldSig !== undefined && (typeof oldSig !== "string" || !SIG_RE.test(oldSig))) {
    res.status(400).json({ error: "Invalid oldWalletSignature" });
    return;
  }
  if (!limit(mutationLimiter, req, res)) return;
  try {
    // Consume BEFORE verification: a failed signature burns the challenge (no replay, no brute force).
    const stored = await agentCreditsRepo.consumeSignChallenge(agent.userId, "payout_wallet_set", sha256Hex(nonce));
    const message = payoutWalletMessage({ userId: agent.userId, wallet: agent.walletAddress, address, chain, nonce });
    if (!stored || stored !== message) {
      res.status(400).json({ error: "Invalid or expired challenge", code: "INVALID_CHALLENGE" });
      return;
    }
    if (recoverSignerAddress(message, sig) !== agent.walletAddress) {
      res.status(400).json({ error: "Signature does not match your linked wallet", code: "BAD_SIGNATURE" });
      return;
    }
    let screened: boolean;
    try {
      screened = !(await sdnHit(address));
    } catch {
      res.status(503).json({ error: "Sanctions screening unavailable. Try again later.", code: "SCREENING_UNAVAILABLE" });
      return;
    }
    if (!screened) {
      log.warn("payout wallet failed SDN screening", { userId: agent.userId });
      res.status(403).json({ error: "Payout address failed sanctions screening", code: "SANCTIONED" });
      return;
    }
    const current = await payoutRepo.getLivePayoutWallet(agent.userId);
    let w: payoutRepo.PayoutWallet;
    if (!current) {
      w = await payoutRepo.registerPayoutWallet(agent.userId, address, { ofacCleared: true, chain });
    } else {
      // Change: the OLD payout wallet must sign the same message (§3.7).
      const changeSig = current.address === agent.walletAddress ? sig : (typeof oldSig === "string" ? oldSig : "");
      if (!changeSig || recoverSignerAddress(message, changeSig) !== current.address) {
        res.status(400).json({ error: "Changing the payout wallet requires a signature from the current payout wallet", code: "OLD_WALLET_SIGNATURE_REQUIRED" });
        return;
      }
      w = await payoutRepo.changePayoutWallet(agent.userId, address, changeSig, { ofacCleared: true, chain });
    }
    log.info("payout wallet set", { userId: agent.userId, status: w.status });
    res.json({
      payoutWallet: { address: w.address, chain: w.chain, status: w.status, activeFrom: w.activeFrom },
      changed: !!current,
      cooldownHours: current ? payoutRepo.PAYOUT_WALLET_COOLDOWN_HOURS : 0,
    });
  } catch (err) {
    const m = errMsg(err);
    if (m.includes("cooling down")) { res.status(409).json({ error: "A payout wallet change is already cooling down", code: "COOLDOWN_ACTIVE" }); return; }
    if (m.includes("equals current")) { res.status(409).json({ error: "New address equals the current payout address", code: "SAME_ADDRESS" }); return; }
    if (m.includes("already registered")) { res.status(409).json({ error: "Payout wallet already registered", code: "ALREADY_REGISTERED" }); return; }
    log.error("payout wallet set failed", { error: m });
    res.status(500).json({ error: "Failed to set payout wallet" });
  }
});

// POST /v1/credits/withdraw/challenge {amountMusd, idempotencyKey}
router.post("/credits/withdraw/challenge", async (req: Request, res: Response) => {
  const agent = principal(req);
  if (!payoutRepo.payoutsEnabled()) { payoutsDisabled(res); return; }
  if (!requireVerified(req, res)) return;
  if (!agent.walletAddress) {
    res.status(400).json({ error: "A linked wallet is required to withdraw", code: "NO_LINKED_WALLET" });
    return;
  }
  const amount = parseMusd(req.body?.amountMusd);
  const idem = req.body?.idempotencyKey;
  if (amount === null || amount < payoutRepo.MIN_WITHDRAW_MUSD || amount > MAX_WITHDRAW_MUSD) {
    res.status(400).json({ error: "Minimum withdrawal is $1 (amountMusd >= 1000000)", code: "AMOUNT_OUT_OF_RANGE" });
    return;
  }
  if (typeof idem !== "string" || !IDEM_RE.test(idem)) { res.status(400).json({ error: "Invalid idempotencyKey" }); return; }
  if (!limit(signChallengeLimiter, req, res)) return;
  try {
    const nonce = crypto.randomBytes(32).toString("hex");
    const message = withdrawMessage({ userId: agent.userId, wallet: agent.walletAddress, amountMusd: amount, idempotencyKey: idem, nonce });
    const stored = await agentCreditsRepo.createSignChallenge(agent.userId, "withdraw", sha256Hex(nonce), message);
    if (!stored) { res.status(429).json({ error: "Too many outstanding challenges", code: "RATE_LIMITED" }); return; }
    res.setHeader("Cache-Control", "no-store");
    res.json({ nonce, message, expiresAt: stored.expiresAt, signer: agent.walletAddress });
  } catch (err) {
    log.error("withdraw challenge failed", { error: errMsg(err) });
    res.status(500).json({ error: "Failed to create challenge" });
  }
});

function publicPayout(p: { id: string; amountMusd: bigint; trigger: string; status: string; txHash: string | null; createdAt: Date }) {
  return { id: p.id, amount: money(p.amountMusd), trigger: p.trigger, status: p.status, txHash: p.txHash, createdAt: p.createdAt };
}

// POST /v1/credits/withdraw {amountMusd, idempotencyKey, nonce, signature}
router.post("/credits/withdraw", async (req: Request, res: Response) => {
  const agent = principal(req);
  if (!payoutRepo.payoutsEnabled()) { payoutsDisabled(res); return; }
  if (!requireVerified(req, res)) return;
  if (!agent.walletAddress) {
    res.status(400).json({ error: "A linked wallet is required to withdraw", code: "NO_LINKED_WALLET" });
    return;
  }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const amount = parseMusd(b["amountMusd"]);
  const idem = b["idempotencyKey"];
  const nonce = typeof b["nonce"] === "string" ? b["nonce"].toLowerCase() : "";
  const sig = typeof b["signature"] === "string" ? b["signature"] : "";
  if (amount === null || amount < payoutRepo.MIN_WITHDRAW_MUSD || amount > MAX_WITHDRAW_MUSD) {
    res.status(400).json({ error: "Minimum withdrawal is $1 (amountMusd >= 1000000)", code: "AMOUNT_OUT_OF_RANGE" });
    return;
  }
  if (typeof idem !== "string" || !IDEM_RE.test(idem)) { res.status(400).json({ error: "Invalid idempotencyKey" }); return; }
  if (!HEX64.test(nonce)) { res.status(400).json({ error: "Invalid nonce" }); return; }
  if (!SIG_RE.test(sig)) { res.status(400).json({ error: "Invalid signature" }); return; }
  if (!limit(mutationLimiter, req, res)) return;
  try {
    const stored = await agentCreditsRepo.consumeSignChallenge(agent.userId, "withdraw", sha256Hex(nonce));
    const message = withdrawMessage({ userId: agent.userId, wallet: agent.walletAddress, amountMusd: amount, idempotencyKey: idem, nonce });
    if (!stored || stored !== message) {
      res.status(400).json({ error: "Invalid or expired challenge", code: "INVALID_CHALLENGE" });
      return;
    }
    if (recoverSignerAddress(message, sig) !== agent.walletAddress) {
      res.status(400).json({ error: "Signature does not match your linked wallet", code: "BAD_SIGNATURE" });
      return;
    }
    const s = await agentCreditsRepo.getCreditSummary(agent.userId);
    if (s.frozen) { res.status(403).json({ error: "Credit account is frozen", code: "ACCOUNT_FROZEN" }); return; }
    const r = await payoutRepo.requestWithdraw({ userId: agent.userId, amountMusd: amount, idempotencyKey: idem, trigger: "on_demand" });
    log.info("withdraw requested", { userId: agent.userId, payoutId: r.payout.id, duplicate: r.duplicate });
    res.status(r.duplicate ? 200 : 201).json({ payout: publicPayout(r.payout), duplicate: r.duplicate });
  } catch (err) {
    if (err instanceof payoutRepo.PayoutsDisabledError) { payoutsDisabled(res); return; }
    const m = errMsg(err);
    const map: [string, number, string][] = [
      ["frozen", 403, "ACCOUNT_FROZEN"],
      ["Insufficient", 409, "INSUFFICIENT_CREDIT"],
      ["No payout wallet", 409, "NO_PAYOUT_WALLET"],
      ["cooling down", 409, "PAYOUT_WALLET_COOLDOWN"],
      ["Daily withdrawal limit", 409, "DAILY_LIMIT_EXCEEDED"],
      ["at least $1", 400, "AMOUNT_OUT_OF_RANGE"],
    ];
    const hit = map.find(([k]) => m.includes(k));
    if (hit) { res.status(hit[1]).json({ error: m, code: hit[2] }); return; }
    log.error("withdraw failed", { error: m });
    res.status(500).json({ error: "Withdrawal failed" });
  }
});

// GET /v1/payouts?limit=&offset=
router.get("/payouts", async (req: Request, res: Response) => {
  const agent = principal(req);
  if (!limit(readLimiter, req, res)) return;
  const lim = Math.min(Math.max(parseInt(String(req.query["limit"] ?? "50"), 10) || 50, 1), 200);
  const offset = Math.min(Math.max(parseInt(String(req.query["offset"] ?? "0"), 10) || 0, 0), 1_000_000);
  try {
    const rows = await agentCreditsRepo.listOwnPayouts(agent.userId, { limit: lim, offset });
    res.json({
      payouts: rows.map((p) => ({
        id: p.id, amount: money(p.amountMusd), trigger: p.trigger, status: p.status, txHash: p.txHash,
        failureReason: p.failureReason, address: p.address, chain: p.chain, createdAt: p.createdAt, updatedAt: p.updatedAt,
      })),
      limit: lim, offset,
    });
  } catch (err) {
    log.error("list payouts failed", { error: errMsg(err) });
    res.status(500).json({ error: "Failed to list payouts" });
  }
});

// PATCH /v1/nodes/:id {maxStreams?, gbPerDay?, reqPerSec?} — lower caps only
router.patch("/nodes/:id", async (req: Request, res: Response) => {
  const agent = principal(req);
  const id = String(req.params["id"] ?? "");
  if (!UUID_RE.test(id)) { res.status(400).json({ error: "Invalid node id" }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const allowed = new Set(["maxStreams", "gbPerDay", "reqPerSec"]);
  const keys = Object.keys(b);
  if (keys.length === 0 || keys.some((k) => !allowed.has(k))) {
    res.status(400).json({ error: "Body may contain only maxStreams, gbPerDay, reqPerSec (at least one)" });
    return;
  }
  if (!limit(mutationLimiter, req, res)) return;
  try {
    const policy = await policyRepo.getActivePolicy();
    const max = {
      maxStreams: policy.body.nodeDefaults.maxStreams,
      gbPerDay: policy.body.nodeDefaults.maxGbDay,
      reqPerSec: policy.body.requesterLimits.reqPerSec * 10,
    };
    const vals: Record<string, number> = {};
    for (const k of keys) {
      const v = b[k];
      const cap = max[k as keyof typeof max];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
        res.status(400).json({ error: `${k} must be a positive integer` });
        return;
      }
      if (v > cap) {
        res.status(400).json({ error: `${k} cannot exceed the policy default (${cap}); caps can only be lowered`, code: "CAP_ABOVE_DEFAULT", max: cap });
        return;
      }
      vals[k] = v;
    }
    const n = await agentCreditsRepo.updateNodeCaps(agent.userId, id, {
      maxStreams: vals["maxStreams"], maxGbDay: vals["gbPerDay"], maxReqPerSec: vals["reqPerSec"],
    });
    if (!n) { res.status(404).json({ error: "Node not found" }); return; }
    log.info("node caps updated", { nodeId: id, userId: agent.userId });
    res.json({
      id: n.id, status: n.status,
      caps: { maxStreams: n.maxStreams, gbPerDay: n.maxGbDay, reqPerSec: n.maxReqPerSec },
      effective: {
        maxStreams: Math.min(n.maxStreams, max.maxStreams),
        gbPerDay: Math.min(n.maxGbDay, max.gbPerDay),
        reqPerSec: n.maxReqPerSec ? Math.min(n.maxReqPerSec, max.reqPerSec) : max.reqPerSec,
      },
      appliesOn: "next_tunnel_connect",
    });
  } catch (err) {
    log.error("node caps update failed", { error: errMsg(err) });
    res.status(500).json({ error: "Failed to update node" });
  }
});

// POST /v1/sessions/:id/report {reason}
router.post("/sessions/:id/report", async (req: Request, res: Response) => {
  const agent = principal(req);
  const id = String(req.params["id"] ?? "");
  if (!UUID_RE.test(id)) { res.status(400).json({ error: "Invalid session id" }); return; }
  const reason = req.body?.reason;
  if (typeof reason !== "string" || !(agentCreditsRepo.REPORT_REASONS as readonly string[]).includes(reason)) {
    res.status(400).json({ error: `reason must be one of ${agentCreditsRepo.REPORT_REASONS.join(", ")}` });
    return;
  }
  if (!limit(reportLimiter, req, res)) return;
  try {
    const r = await agentCreditsRepo.reportSession(agent.userId, id, reason as agentCreditsRepo.ReportReason);
    if (!r.ok) {
      switch (r.reason) {
        case "not_found": res.status(404).json({ error: "Session not found" }); return;
        case "not_relay": res.status(400).json({ error: "Session did not use a relay node", code: "NOT_RELAY_SESSION" }); return;
        case "too_old": res.status(400).json({ error: `Sessions older than ${agentCreditsRepo.REPORT_WINDOW_DAYS} days cannot be reported`, code: "SESSION_TOO_OLD" }); return;
        case "duplicate": res.status(409).json({ error: "Session already reported", code: "ALREADY_REPORTED" }); return;
        default: res.status(429).json({ error: `At most ${agentCreditsRepo.MAX_REPORTS_PER_NODE_PER_DAY} reports per node per day`, code: "REPORT_LIMIT" }); return;
      }
    }
    // The node id is deliberately not returned (upstream infra detail).
    res.status(201).json({ reportId: r.reportId, reportsToday: r.reportsToday, limitPerDay: agentCreditsRepo.MAX_REPORTS_PER_NODE_PER_DAY });
  } catch (err) {
    log.error("session report failed", { error: errMsg(err) });
    res.status(500).json({ error: "Failed to record report" });
  }
});

export default router;
