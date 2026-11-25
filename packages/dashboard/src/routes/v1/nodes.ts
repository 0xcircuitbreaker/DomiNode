import { Router } from "express";
import type { Request, Response } from "express";
import * as crypto from "node:crypto";
import {
  createLogger,
  query,
  nodeRepo,
  policyRepo,
  tierRepo,
  powChallengeRepo,
  isExitClass,
  tierWeightBpsFor,
  killSwitches,
  RELAY_BYTES_PER_GB,
  type ExitClass,
} from "@dominusnode/shared";
import { sendKillSwitchBlock } from "../../helpers/kill-switch.js";
import { requireAgentPrincipal, type AgentRequest } from "../../middleware/agent.js";
import { recoverSignerAddress } from "../../helpers/verify-signature.js";
import { buildAttestationMessage, sha256Hex, verifyPow, encodeCursor, decodeCursor } from "@dominusnode/shared";
import { createKeyedLimiter } from "./limiter.js";

const log = createLogger("api:v1:nodes");
const router = Router();

const HEX64 = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIG_RE = /^0x[0-9a-fA-F]{130}$/;

const _pd = parseInt(process.env["NODE_POW_DIFFICULTY"] ?? "20", 10);
export const NODE_POW_DIFFICULTY = Number.isFinite(_pd) && _pd >= 10 && _pd <= 32 ? _pd : 20;

/** Per-user limits on challenge issuance and registration attempts. */
export const challengeLimiter = createKeyedLimiter(20, 60 * 60_000);
export const registerLimiter = createKeyedLimiter(10, 60 * 60_000);

function principal(req: Request): AgentRequest["agent"] {
  return (req as AgentRequest).agent;
}

function optionalInt(v: unknown, min: number, max: number): number | undefined | null {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return null;
  return v;
}

function parsePubkey(v: unknown): string | null | false {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") return false;
  const k = v.toLowerCase();
  return HEX64.test(k) ? k : false;
}

router.use(requireAgentPrincipal);

// POST /v1/nodes/challenge — nonce + attestation text + PoW puzzle
router.post("/nodes/challenge", async (req: Request, res: Response) => {
  const agent = principal(req);
  if (!agent.verified) {
    res.status(403).json({ error: "Email verification required", code: "EMAIL_NOT_VERIFIED" });
    return;
  }
  if (!agent.walletAddress) {
    res.status(400).json({ error: "A linked wallet is required to register nodes", code: "NO_LINKED_WALLET" });
    return;
  }
  const pubkey = parsePubkey(req.body?.nodePubkey);
  if (pubkey === false) {
    res.status(400).json({ error: "nodePubkey must be 64 hex chars", code: "INVALID_NODE_PUBKEY" });
    return;
  }
  if (!challengeLimiter.hit(agent.userId)) {
    res.status(429).json({ error: "Too many challenge requests. Try again later.", code: "RATE_LIMITED" });
    return;
  }
  const clientIp = req.ip;
  if (!clientIp) {
    res.status(400).json({ error: "Unable to determine client IP", code: "CLIENT_IP_UNKNOWN" });
    return;
  }
  try {
    if ((await powChallengeRepo.countActiveChallengesForIp(clientIp)) >= 5) {
      res.status(429).json({ error: "Too many pending challenges. Try again later.", code: "RATE_LIMITED" });
      return;
    }
    const policy = await policyRepo.getActivePolicy();
    const nonce = crypto.randomBytes(32).toString("hex");
    const stored = await nodeRepo.createChallenge(agent.userId, sha256Hex(nonce));
    if (!stored) {
      res.status(429).json({ error: "Too many outstanding challenges", code: "RATE_LIMITED" });
      return;
    }
    const pow = await powChallengeRepo.createChallenge(
      crypto.randomBytes(16).toString("hex"), NODE_POW_DIFFICULTY, clientIp,
    );
    const attestationVersion = policy.body.attestation.minVersion;
    const attestationText = policy.body.attestation.text;
    res.json({
      nonce,
      attestationText,
      attestationVersion,
      policyVersion: policy.version,
      message: buildAttestationMessage({
        wallet: agent.walletAddress, nonce, attestationVersion, attestationText, nodePubkey: pubkey,
      }),
      expiresAt: new Date(stored.expires_at).toISOString(),
      powChallenge: {
        challengeId: pow.id,
        prefix: pow.prefix,
        difficulty: pow.difficulty,
        algorithm: "sha256",
        expiresAt: new Date(pow.created_at.getTime() + powChallengeRepo.POW_CHALLENGE_TTL_MS).toISOString(),
      },
    });
  } catch (err) {
    log.error("node challenge failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to create challenge", code: "INTERNAL_ERROR" });
  }
});

// POST /v1/nodes — register a node; returns the dn_node_ key exactly once
router.post("/nodes", async (req: Request, res: Response) => {
  const agent = principal(req);
  if (!agent.verified) {
    res.status(403).json({ error: "Email verification required", code: "EMAIL_NOT_VERIFIED" });
    return;
  }
  if (!agent.walletAddress) {
    res.status(400).json({ error: "A linked wallet is required to register nodes", code: "NO_LINKED_WALLET" });
    return;
  }
  // Kill switch "api_keys" also covers dn_node_ key issuance. Checked before
  // the challenge or PoW is consumed, so the same attempt works on resume.
  const ks = killSwitches().checkNodeRegistration();
  if (ks) {
    sendKillSwitchBlock(res, ks);
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const nonce = typeof body["nonce"] === "string" ? body["nonce"].toLowerCase() : "";
  const signature = typeof body["walletSignature"] === "string" ? body["walletSignature"] : "";
  const pubkey = parsePubkey(body["nodePubkey"]);
  const pow = (body["pow"] && typeof body["pow"] === "object" ? body["pow"] : {}) as Record<string, unknown>;
  const powId = typeof pow["challengeId"] === "string" ? pow["challengeId"] : "";
  const powNonce = typeof pow["nonce"] === "string" || typeof pow["nonce"] === "number" ? String(pow["nonce"]) : "";
  const maxStreams = optionalInt(body["maxStreams"], 1, 1024);
  const maxGbDay = optionalInt(body["maxGbDay"], 1, 10000);
  // Optional self-declared class: informational only. The effective class is
  // always the gateway-verified one; a downgrade raises a review flag.
  const declaredRaw = body["declaredClass"];
  if (declaredRaw !== undefined && declaredRaw !== null && !isExitClass(declaredRaw)) {
    res.status(400).json({ error: "declaredClass must be residential|mobile|dc|masked", code: "INVALID_DECLARED_CLASS" });
    return;
  }
  const declaredClass: ExitClass | null = isExitClass(declaredRaw) ? declaredRaw : null;

  if (!HEX64.test(nonce)) { res.status(400).json({ error: "Invalid nonce", code: "INVALID_CHALLENGE" }); return; }
  if (!SIG_RE.test(signature)) { res.status(400).json({ error: "Invalid walletSignature", code: "INVALID_SIGNATURE" }); return; }
  if (pubkey === false) { res.status(400).json({ error: "nodePubkey must be 64 hex chars", code: "INVALID_NODE_PUBKEY" }); return; }
  if (!UUID_RE.test(powId) || !powNonce || powNonce.length > 32) {
    res.status(400).json({ error: "Invalid PoW solution", code: "POW_INVALID" });
    return;
  }
  if (maxStreams === null || maxGbDay === null) {
    res.status(400).json({ error: "maxStreams/maxGbDay out of range", code: "INVALID_CAPS" });
    return;
  }
  if (!registerLimiter.hit(agent.userId)) {
    res.status(429).json({ error: "Too many registration attempts. Try again later.", code: "RATE_LIMITED" });
    return;
  }
  const clientIp = req.ip;
  if (!clientIp) {
    res.status(400).json({ error: "Unable to determine client IP", code: "CLIENT_IP_UNKNOWN" });
    return;
  }

  try {
    // Consume both single-use challenges BEFORE verification (no retry on a failed proof).
    const challenge = await nodeRepo.consumeChallenge(agent.userId, sha256Hex(nonce));
    if (!challenge) {
      res.status(400).json({ error: "Invalid or expired challenge", code: "INVALID_CHALLENGE" });
      return;
    }
    const powRow = await powChallengeRepo.consumeChallenge(powId, clientIp);
    if (!powRow || powRow.difficulty < NODE_POW_DIFFICULTY || !verifyPow(powRow.prefix, powNonce, powRow.difficulty)) {
      res.status(400).json({ error: "Invalid or expired PoW solution", code: "POW_INVALID" });
      return;
    }

    const policy = await policyRepo.getActivePolicy();
    const attestationVersion = policy.body.attestation.minVersion;
    const message = buildAttestationMessage({
      wallet: agent.walletAddress,
      nonce,
      attestationVersion,
      attestationText: policy.body.attestation.text,
      nodePubkey: pubkey,
    });
    const signer = recoverSignerAddress(message, signature);
    if (!signer || signer !== agent.walletAddress) {
      res.status(400).json({ error: "Attestation signature does not match your wallet (request a new challenge if the policy changed)", code: "SIGNATURE_MISMATCH" });
      return;
    }

    const result = await nodeRepo.registerNode({
      ownerUserId: agent.userId,
      ownerWallet: agent.walletAddress,
      nodePubkey: pubkey,
      attestationVersion,
      attestationSig: signature,
      maxStreams,
      maxGbDay,
      declaredClass,
    });
    if (!result.ok) {
      switch (result.reason) {
        case "node_cap_reached":
          res.status(409).json({ error: "Node limit reached for your tier", code: "NODE_CAP_REACHED", cap: result.cap });
          return;
        case "owner_penalized":
          res.status(403).json({ error: "A node of yours is quarantined or suspended (or was revoked in that state recently); new nodes cannot be registered until it is resolved", code: "NODE_PENALTY_ACTIVE" });
          return;
        case "tier_not_found":
          res.status(503).json({ error: "Node tiers not configured", code: "TIERS_NOT_CONFIGURED" });
          return;
        default:
          res.status(403).json({ error: "Account is not eligible to register nodes", code: "NOT_ELIGIBLE" });
          return;
      }
    }
    log.info("node registered", { nodeId: result.node.id, userId: agent.userId });
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json({
      nodeId: result.node.id,
      nodeKey: result.nodeKey,
      status: result.node.status,
      attestationVersion: result.node.attestation_version,
    });
  } catch (err) {
    log.error("node registration failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Node registration failed" });
  }
});

type TierWeights = Partial<Record<ExitClass, number>> | null;

/** Tier weight as a decimal (bps / 10000), e.g. 0.25 for masked. */
const weightOf = (cls: string | null, w: TierWeights): number =>
  tierWeightBpsFor((cls ?? "unknown") as ExitClass, w ?? {}) / 10_000;

async function loadTierWeights(): Promise<TierWeights> {
  try {
    return tierRepo.getTierWeights ? await tierRepo.getTierWeights() : null;
  } catch {
    return null; // defaults (tierWeightBpsFor) still apply
  }
}

function publicNode(n: nodeRepo.NodeRecord, weights: TierWeights = null) {
  return {
    id: n.id,
    status: n.status,
    walletAddress: n.owner_wallet,
    nodePubkey: n.node_pubkey,
    attestationVersion: n.attestation_version,
    observedIp: n.observed_ip,
    country: n.country,
    ipClass: n.ip_class,
    /** Gateway-verified exit class (same as ipClass; the effective class). */
    verifiedClass: n.ip_class ?? "unknown",
    declaredClass: n.declared_class ?? null,
    classVerifiedAt: n.class_verified_at ?? null,
    /** Tier-credit weight of the verified class (1.0 residential/mobile ... 0.25 masked). */
    tierWeight: weightOf(n.ip_class, weights),
    maxStreams: n.max_streams,
    maxGbDay: n.max_gb_day,
    reputation: n.reputation,
    agentVersion: n.agent_version,
    lastSeenAt: n.last_seen_at,
    createdAt: n.created_at,
  };
}

// GET /v1/nodes — caller's own nodes
router.get("/nodes", async (req: Request, res: Response) => {
  const agent = principal(req);
  const limit = Math.min(Math.max(parseInt(String(req.query["limit"] ?? "100"), 10) || 100, 1), 500);
  const offset = Math.min(Math.max(parseInt(String(req.query["offset"] ?? "0"), 10) || 0, 0), 1_000_000);
  const cursor = req.query["cursor"] !== undefined ? decodeCursor(req.query["cursor"]) : null;
  if (req.query["cursor"] !== undefined && !cursor) {
    res.status(400).json({ error: "Invalid cursor", code: "INVALID_CURSOR" });
    return;
  }
  try {
    const [page, weights] = await Promise.all([
      nodeRepo.listForOwner(agent.userId, { limit: limit + 1, offset, cursor }),
      loadTierWeights(),
    ]);
    const nodes = page.slice(0, limit);
    const last = nodes[nodes.length - 1];
    const nextCursor = page.length > limit && last ? encodeCursor(new Date(last.created_at), last.id) : null;
    res.json({ nodes: nodes.map((n) => publicNode(n, weights)), limit, offset, nextCursor });
  } catch (err) {
    log.error("list nodes failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to list nodes" });
  }
});

// DELETE /v1/nodes/:id — revoke an owned node (irreversible)
router.delete("/nodes/:id", async (req: Request, res: Response) => {
  const agent = principal(req);
  const id = String(req.params["id"] ?? "");
  if (!UUID_RE.test(id)) {
    res.status(400).json({ error: "Invalid node id" });
    return;
  }
  try {
    // Owner check and status change in one statement (no TOCTOU).
    // Keeps the prior status so a quarantine/suspension survives revocation.
    const revoked = await nodeRepo.revokeOwnedNode(id, agent.userId);
    if (!revoked) {
      res.status(404).json({ error: "Node not found" });
      return;
    }
    // The gateway rejects revoked keys at tunnel auth and on its periodic status sweep.
    log.info("node revoked by owner", { nodeId: id, userId: agent.userId });
    res.json({ id: revoked.id, status: revoked.status });
  } catch (err) {
    log.error("revoke node failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to revoke node" });
  }
});

// GET /v1/node/tier — current tier, progress to next, demotion reason
router.get("/node/tier", async (req: Request, res: Response) => {
  const agent = principal(req);
  try {
    const [current, tiers, stats, state, weights] = await Promise.all([
      tierRepo.getOwnerTier(agent.userId),
      tierRepo.listTiers(),
      tierRepo.getOwnerTierStats(agent.userId, 0),
      query<{ node_tier_changed_at: Date | null; node_tier_grace_until: Date | null; node_tier_demotion_reason: string | null }>(
        `SELECT node_tier_changed_at, node_tier_grace_until, node_tier_demotion_reason
         FROM users WHERE id = $1 AND status = 'active'`,
        [agent.userId],
      ),
      loadTierWeights(),
    ]);
    const st = state.rows[0];
    if (!st) {
      res.status(404).json({ error: "Account not found" });
      return;
    }
    const sorted = [...tiers].sort((a, b) => a.rank - b.rank);
    const next = sorted.find((t) => t.rank > current.rank) ?? null;
    const req1 = (required: number, have: number) => ({ required, current: have, met: have >= required });
    const progress = next
      ? {
          tenureDays: req1(next.minTenureDays, stats.tenureDays),
          activeIps: req1(next.minActiveIps, stats.activeIps),
          reputation: req1(next.minReputation, stats.reputation),
          // Uptime is computed by the daily tier job; not recomputed per request.
          uptimeBps: { required: next.minUptimeBps, current: null, met: null },
          noClawbackDays: next.noClawbackDays > 0
            ? {
                required: next.noClawbackDays,
                current: stats.daysSinceLastClawback,
                met: stats.daysSinceLastClawback === null || stats.daysSinceLastClawback >= next.noClawbackDays,
              }
            : null,
        }
      : null;
    const tierView = (t: typeof current) => ({
      id: t.id, name: t.name, rank: t.rank, nodeShareBps: t.nodeShareBps, holdDays: t.holdDays,
      maxNodes: t.maxNodes, dailyWithdrawLimitMusd: t.dailyWithdrawLimitMusd.toString(),
      buyerDiscountBps: t.buyerDiscountBps ?? 0,
    });
    res.json({
      tier: tierView(current),
      nextTier: next ? tierView(next) : null,
      progress,
      changedAt: st.node_tier_changed_at,
      uptimeGraceUntil: st.node_tier_grace_until,
      demotionReason: st.node_tier_demotion_reason,
      // activeIps above is class-weighted: each qualifying exit IP counts for
      // its verified class's weight (masked 0.25 = four masked IPs per IP).
      tierWeights: Object.fromEntries(
        (["residential", "mobile", "dc", "masked"] as const).map((c) => [c, weightOf(c, weights)]),
      ),
    });
  } catch (err) {
    log.error("tier lookup failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(503).json({ error: "Tier lookup failed" });
  }
});

// ─── Earnings projection ─────────────────────────────────────────────

const PROJECTION_BYTES_PER_GB = BigInt(RELAY_BYTES_PER_GB);
const MAX_SHARE_BPS = 5000n;

export interface ProjectionClassInput {
  ipClass: string;
  /** Gateway-metered bytes for the caller's nodes in the window. */
  bytes: bigint;
}

export interface ProjectionInput {
  windowDays: number;
  traffic: ProjectionClassInput[];
  /** µUSD per GB from network_pricing, by class (missing class -> highest price is NOT used; see priceFor). */
  pricing: Map<string, bigint>;
  shareBps: number;
}

/**
 * Price a class's traffic is projected at: its own network_pricing row, else
 * the 'any' row, else 0 (no projection rather than an invented price).
 * Projections err low; billing (getPricing) errs high.
 */
export function projectionPriceFor(ipClass: string, pricing: Map<string, bigint>): bigint {
  return pricing.get(ipClass) ?? pricing.get("any") ?? 0n;
}

/** Node-share µUSD for `bytes` at `pricePerGb` and `shareBps` (floored, integer). */
export function nodeShareMusd(bytes: bigint, pricePerGbMusd: bigint, shareBps: number): bigint {
  if (bytes <= 0n || pricePerGbMusd <= 0n || shareBps <= 0) return 0n;
  const bps = BigInt(Math.min(Math.max(Math.trunc(shareBps), 0), Number(MAX_SHARE_BPS)));
  return (bytes * pricePerGbMusd * bps) / (PROJECTION_BYTES_PER_GB * 10_000n);
}

/**
 * Projects daily and 30-day node earnings from the window's metered bytes,
 * the configured prices and a tier share. All results are integer µUSD.
 */
export function projectEarnings(input: ProjectionInput) {
  const days = BigInt(Math.max(1, Math.trunc(input.windowDays)));
  let windowMusd = 0n;
  const byClass = input.traffic.map((t) => {
    const price = projectionPriceFor(t.ipClass, input.pricing);
    const musd = nodeShareMusd(t.bytes, price, input.shareBps);
    windowMusd += musd;
    return { ipClass: t.ipClass, bytes: t.bytes, pricePerGbMusd: price, windowMusd: musd, dailyMusd: musd / days, monthlyMusd: (musd * 30n) / days };
  });
  return { windowMusd, dailyMusd: windowMusd / days, monthlyMusd: (windowMusd * 30n) / days, byClass };
}

// GET /v1/nodes/earnings/projection?days=7 — projected node-share earnings
router.get("/nodes/earnings/projection", async (req: Request, res: Response) => {
  const agent = principal(req);
  const rawDays = req.query["days"];
  const windowDays = rawDays === undefined ? 7 : Number(rawDays);
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 30) {
    res.status(400).json({ error: "days must be an integer between 1 and 30" });
    return;
  }
  try {
    const [current, tiers, pricingRows, weights, traffic] = await Promise.all([
      tierRepo.getOwnerTier(agent.userId),
      tierRepo.listTiers(),
      policyRepo.listPricing(),
      loadTierWeights(),
      // Only gateway-metered bytes count (bytes_gateway); node-reported bytes are ignored.
      query<{ ip_class: string | null; bytes: string }>(
        `SELECT n.ip_class, COALESCE(SUM(rc.bytes_gateway), 0)::text AS bytes
         FROM relay_charges rc
         JOIN nodes n ON n.id = rc.node_id
         WHERE rc.node_owner_user_id = $1
           AND n.owner_user_id = $1
           AND rc.created_at >= now() - make_interval(days => $2)
           AND rc.zero_reason IS NULL
           AND NOT rc.disputed
         GROUP BY n.ip_class`,
        [agent.userId, windowDays],
      ),
    ]);
    if (pricingRows.length === 0) {
      res.status(503).json({ error: "Network pricing not configured" });
      return;
    }
    const pricing = new Map<string, bigint>(pricingRows.map((p) => [p.ipClass, p.pricePerGbMusd]));
    const trafficIn = traffic.rows.map((r) => ({ ipClass: r.ip_class ?? "unknown", bytes: BigInt(r.bytes) }));
    const sorted = [...tiers].sort((a, b) => a.rank - b.rank);
    const next = sorted.find((t) => t.rank > current.rank) ?? null;
    const top = sorted[sorted.length - 1] ?? current;
    const view = (t: typeof current) => {
      const p = projectEarnings({ windowDays, traffic: trafficIn, pricing, shareBps: t.nodeShareBps });
      return {
        tier: { id: t.id, name: t.name, nodeShareBps: t.nodeShareBps, holdDays: t.holdDays },
        dailyMusd: p.dailyMusd.toString(),
        monthlyMusd: p.monthlyMusd.toString(),
        windowMusd: p.windowMusd.toString(),
      };
    };
    const cur = projectEarnings({ windowDays, traffic: trafficIn, pricing, shareBps: current.nodeShareBps });
    const totalBytes = trafficIn.reduce((a, t) => a + t.bytes, 0n);
    res.json({
      windowDays,
      meteredBytes: totalBytes.toString(),
      current: view(current),
      nextTier: next ? view(next) : null,
      topTier: view(top),
      byClass: cur.byClass.map((c) => ({
        ipClass: c.ipClass,
        bytes: c.bytes.toString(),
        pricePerGbMusd: c.pricePerGbMusd.toString(),
        tierWeight: weightOf(c.ipClass, weights),
        dailyMusd: c.dailyMusd.toString(),
        monthlyMusd: c.monthlyMusd.toString(),
      })),
      pricing: Object.fromEntries(pricingRows.map((p) => [p.ipClass, p.pricePerGbMusd.toString()])),
      maturity: {
        // Earnings credit at session start but become withdrawable only after the hold.
        holdDays: current.holdDays,
        firstWithdrawableDaysFromNow: current.holdDays,
      },
      note: "Projection from recent gateway-metered traffic at current prices; not a guarantee. Tier weights affect tier progress, not per-GB earnings.",
    });
  } catch (err) {
    log.error("earnings projection failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(503).json({ error: "Earnings projection failed" });
  }
});

export default router;
