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
  type ExitClass,
} from "@dominusnode/shared";
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
    const r = await query<{ id: string; status: string }>(
      `UPDATE nodes SET status = 'revoked'
       WHERE id = $1 AND owner_user_id = $2 AND status <> 'revoked'
       RETURNING id, status`,
      [id, agent.userId],
    );
    if (!r.rows[0]) {
      res.status(404).json({ error: "Node not found" });
      return;
    }
    // The gateway rejects revoked keys at tunnel auth and on its periodic status sweep.
    log.info("node revoked by owner", { nodeId: id, userId: agent.userId });
    res.json({ id: r.rows[0].id, status: r.rows[0].status });
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

export default router;
