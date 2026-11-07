import { withTx, earnTx, MUSD_PER_CENT } from "./node-credit-repo.js";
import { settleSessionTx, accrueCarryTx } from "./wallet-repo.js";
import { settleTeamSessionTx, accrueTeamCarryTx } from "./team-repo.js";
import { endSessionTx, createUsageRecordTx } from "./usage-repo.js";
import type { ChargeSnapshot } from "./tier-repo.js";
import { consumeTx as consumeStarterTx } from "./starter-credit-repo.js";

/** settleRelayCharge — DESIGN.md §6.3 + §15 (single transaction). */

export type RelayRail = "wallet" | "team" | "agentic_wallet" | "x402" | "mpp" | "free";
export type ZeroReason = "self_dealing" | "quarantined" | "collusion_hold" | "free_tier";

const MAX_BYTES = 1_099_511_627_776n;
const MAX_INT = 2_147_483_647;

export interface SettleRelayChargeInput {
  sessionId: string;
  requesterUserId: string;
  requesterWallet?: string | null;
  requesterTeamId?: string | null;
  rail: RelayRail;
  reservedCents: number;
  nodeId: string;
  bytesGateway: bigint;
  bytesNode?: bigint | null;
  bytesIn: number;
  bytesOut: number;
  pricePerGbMusd: bigint;
  snapshot: ChargeSnapshot;
  destHost: string;
  destPort: number;
  /** usage_records.target_host; "" unless the requester opted in to host logging. Defaults to destHost. */
  usageTargetHost?: string;
  zeroReason?: Exclude<ZeroReason, "self_dealing"> | null;
  sessionStatus?: "completed" | "error";
  /**
   * x402/mpp only: the µUSD actually paid up front. gross is the paid amount
   * (DESIGN.md §7: unused bytes are not refunded in v1), split by the locked bps.
   */
  prepaidGrossMusd?: bigint;
}

export interface SettleRelayChargeResult {
  status: "settled" | "duplicate";
  relayChargeId: string | null;
  paidInFull: boolean;
  grossMusd: bigint;
  nodeMusd: bigint;
  platformMusd: bigint;
  debitCents: number;
  zeroReason: ZeroReason | null;
  disputed: boolean;
}

/** Byte-report dispute threshold: mismatch > 10% of gateway bytes AND > 1 MiB. */
export const DISPUTE_MIN_BYTES = 1_048_576n;
export function isByteDispute(gateway: bigint, node: bigint | null | undefined): boolean {
  if (node == null) return false;
  const diff = gateway > node ? gateway - node : node - gateway;
  return diff > DISPUTE_MIN_BYTES && diff * 10n > gateway;
}

/**
 * Pure charge math. gross is the true charge, ceil'd to 1 µUSD only; cent
 * rounding happens per payer via the carry (accrueCarryTx), never per session.
 * `debitCents` is the standalone ceil-to-cent figure (no carry), kept for
 * rails that cannot carry (agentic_wallet reservations).
 */
export function computeSplit(bytes: bigint, pricePerGbMusd: bigint, nodeShareBps: number, _rail: RelayRail) {
  const raw = (bytes * pricePerGbMusd + 999_999_999n) / 1_000_000_000n;
  const debitCents = (raw + MUSD_PER_CENT - 1n) / MUSD_PER_CENT;
  const node = (raw * BigInt(nodeShareBps)) / 10_000n;
  return { rawMusd: raw, grossMusd: raw, nodeMusd: node, platformMusd: raw - node, debitCents };
}

function validate(i: SettleRelayChargeInput): void {
  if (i.bytesGateway < 0n || i.bytesGateway > MAX_BYTES) throw new Error("bytesGateway out of range");
  if (i.bytesNode != null && (i.bytesNode < 0n || i.bytesNode > MAX_BYTES)) throw new Error("bytesNode out of range");
  if (i.pricePerGbMusd < 1000n || i.pricePerGbMusd > 5_000_000n) throw new Error("price out of range");
  const s = i.snapshot;
  if (!Number.isInteger(s.nodeShareBps) || s.nodeShareBps < 0 || s.nodeShareBps > 5000) throw new Error("nodeShareBps out of range");
  if (!Number.isInteger(s.holdDays) || s.holdDays < 0 || s.holdDays > 90) throw new Error("holdDays out of range");
  if (!Number.isInteger(i.reservedCents) || i.reservedCents < 0 || i.reservedCents > MAX_INT) throw new Error("reservedCents out of range");
  if (!Number.isInteger(i.destPort) || i.destPort < 1 || i.destPort > 65535) throw new Error("destPort out of range");
  // Host only: reject anything that looks like a path, query, userinfo or port.
  if (typeof i.destHost !== "string" || i.destHost.length < 1 || i.destHost.length > 253 || /[/?#@\s:]/.test(i.destHost.replace(/^\[.*\]$/, "h"))) {
    throw new Error("destHost must be a bare hostname");
  }
  if (i.rail === "team" && !i.requesterTeamId) throw new Error("team rail requires requesterTeamId");
  if (i.prepaidGrossMusd !== undefined) {
    if (i.rail !== "x402" && i.rail !== "mpp") throw new Error("prepaidGrossMusd is only valid for x402/mpp rails");
    if (typeof i.prepaidGrossMusd !== "bigint" || i.prepaidGrossMusd < 1n || i.prepaidGrossMusd > 10_000_000_000n) {
      throw new Error("prepaidGrossMusd out of range");
    }
  }
}

export async function settleRelayCharge(i: SettleRelayChargeInput): Promise<SettleRelayChargeResult> {
  validate(i);
  return withTx(async (client) => {
    // Serialize concurrent settles of one session, then idempotency check.
    const sess = await client.query<{ id: string; user_id: string; status: string }>(
      `SELECT id, user_id, status FROM sessions WHERE id = $1 FOR UPDATE`,
      [i.sessionId],
    );
    const session = sess.rows[0];
    if (!session) throw new Error("Session not found");
    if (session.user_id !== i.requesterUserId) throw new Error("Session does not belong to requester");
    const existing = await client.query<{ id: string; gross_musd: string; node_musd: string; platform_musd: string; zero_reason: ZeroReason | null }>(
      `SELECT id, gross_musd, node_musd, platform_musd, zero_reason FROM relay_charges WHERE session_id = $1`,
      [i.sessionId],
    );
    if (existing.rows[0]) {
      const e = existing.rows[0];
      return {
        status: "duplicate", relayChargeId: e.id, paidInFull: true,
        grossMusd: BigInt(e.gross_musd), nodeMusd: BigInt(e.node_musd), platformMusd: BigInt(e.platform_musd),
        debitCents: 0, zeroReason: e.zero_reason, disputed: false,
      };
    }

    if (session.status !== "active") throw new Error("Session already ended");

    const split = i.prepaidGrossMusd !== undefined
      ? (() => {
          const g = i.prepaidGrossMusd as bigint;
          const n = (g * BigInt(i.snapshot.nodeShareBps)) / 10_000n;
          return { rawMusd: g, grossMusd: g, nodeMusd: n, platformMusd: g - n, debitCents: 0n };
        })()
      : computeSplit(i.bytesGateway, i.pricePerGbMusd, i.snapshot.nodeShareBps, i.rail);
    if (split.grossMusd > BigInt(MAX_INT) * MUSD_PER_CENT) throw new Error("charge exceeds maximum");
    let debitCents = 0;

    // Requester settle: whole cents due after adding gross to the payer's
    // sub-cent carry (same row lock as the balance update).
    let paidInFull = true;
    if (i.rail === "wallet") {
      const c = await accrueCarryTx(client, i.requesterUserId, split.grossMusd);
      if (!c) throw new Error("Requester wallet not found");
      if (c.cents > BigInt(MAX_INT)) throw new Error("charge exceeds maximum");
      debitCents = Number(c.cents);
      const r = await settleSessionTx(client, i.requesterUserId, i.reservedCents, debitCents, i.sessionId);
      if (r === "no_wallet") throw new Error("Requester wallet not found");
      paidInFull = r === "ok";
    } else if (i.rail === "team") {
      const c = await accrueTeamCarryTx(client, i.requesterTeamId as string, split.grossMusd);
      if (!c) throw new Error("Team settlement failed");
      if (c.cents > BigInt(MAX_INT)) throw new Error("charge exceeds maximum");
      debitCents = Number(c.cents);
      const r = await settleTeamSessionTx(client, i.requesterTeamId as string, i.reservedCents, debitCents, i.sessionId);
      if (r === "no_wallet" || r === "invalid") throw new Error("Team settlement failed");
      paidInFull = r === "ok";
    }
    // agentic_wallet/x402/mpp were prepaid upstream; recorded only.

    // Re-check self-dealing against the node owner.
    const n = await client.query<{ owner_user_id: string; owner_wallet: string; status: string }>(
      `SELECT owner_user_id, owner_wallet, status FROM nodes WHERE id = $1 FOR SHARE`,
      [i.nodeId],
    );
    const node = n.rows[0];
    if (!node) throw new Error("Node not found");
    let selfDealing =
      node.owner_user_id === i.requesterUserId ||
      (!!i.requesterWallet && node.owner_wallet.toLowerCase() === i.requesterWallet.toLowerCase());
    if (!selfDealing && i.requesterWallet && !i.requesterWallet.startsWith("0x")) {
      // Non-EVM payer (Solana x402): self-dealing if that payer identity belongs to the node owner.
      const pi = await client.query<{ one: number }>(
        `SELECT 1 AS one FROM payer_identities WHERE address = $1 AND user_id = $2`,
        [i.requesterWallet, node.owner_user_id],
      );
      selfDealing = pi.rows.length > 0;
    }
    if (!selfDealing && i.requesterTeamId) {
      const tm = await client.query<{ one: number }>(
        `SELECT 1 AS one FROM team_members WHERE team_id = $1 AND user_id = $2`,
        [i.requesterTeamId, node.owner_user_id],
      );
      selfDealing = tm.rows.length > 0;
    }
    if (!selfDealing) {
      // Any shared team affiliation counts, whatever the payment rail.
      const shared = await client.query<{ one: number }>(
        `SELECT 1 AS one FROM team_members a JOIN team_members b ON b.team_id = a.team_id
         WHERE a.user_id = $1 AND b.user_id = $2 LIMIT 1`,
        [i.requesterUserId, node.owner_user_id],
      );
      selfDealing = shared.rows.length > 0;
    }

    let zeroReason: ZeroReason | null = null;
    if (i.rail === "free") zeroReason = "free_tier";
    else if (selfDealing) zeroReason = "self_dealing";
    else if (node.status === "quarantined") zeroReason = "quarantined";
    else if (i.zeroReason) zeroReason = i.zeroReason;
    // Underpaid session: the node's share is not backed by collected funds. Hold it for review.
    else if (!paidInFull) zeroReason = "collusion_hold";

    const grossMusd = i.rail === "free" ? 0n : split.grossMusd;
    const nodeMusd = zeroReason ? 0n : split.nodeMusd;
    const platformMusd = grossMusd - nodeMusd;

    const disputed = isByteDispute(i.bytesGateway, i.bytesNode);
    const ins = await client.query<{ id: string }>(
      `INSERT INTO relay_charges (session_id, requester_user_id, node_id, node_owner_user_id, payment_rail,
         bytes_gateway, bytes_node, price_per_gb_musd, gross_musd, node_musd, platform_musd,
         split_config_id, tier_id, node_share_bps, zero_reason, matures_at, disputed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now() + make_interval(days => $16), $17)
       RETURNING id`,
      [
        i.sessionId, i.requesterUserId, i.nodeId, node.owner_user_id, i.rail,
        i.bytesGateway.toString(), i.bytesNode == null ? null : i.bytesNode.toString(),
        i.pricePerGbMusd.toString(), grossMusd.toString(), nodeMusd.toString(), platformMusd.toString(),
        i.snapshot.splitConfigId, i.snapshot.tierId, i.snapshot.nodeShareBps, zeroReason, i.snapshot.holdDays,
        disputed,
      ],
    );
    const relayChargeId = ins.rows[0].id;

    if (disputed) {
      await client.query(
        `INSERT INTO byte_disputes (relay_charge_id, node_id, bytes_gateway, bytes_node) VALUES ($1, $2, $3, $4)`,
        [relayChargeId, i.nodeId, i.bytesGateway.toString(), (i.bytesNode as bigint).toString()],
      );
      await client.query(
        `UPDATE nodes SET byte_disputes = LEAST(byte_disputes + 1, 1000000) WHERE id = $1`,
        [i.nodeId],
      );
    }

    // Starter credit: attribute the whole cents charged to an active grant (not a tier input).
    if (i.rail === "wallet" && debitCents > 0) {
      await consumeStarterTx(client, i.requesterUserId, BigInt(debitCents) * MUSD_PER_CENT, relayChargeId);
    }

    if (nodeMusd > 0n) await earnTx(client, node.owner_user_id, nodeMusd, relayChargeId);

    // Metadata only: host, port, byte count. No path/query/payload.
    await client.query(
      `INSERT INTO relay_abuse_log (session_id, requester_user_id, node_id, dest_host, dest_port, bytes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [i.sessionId, i.requesterUserId, i.nodeId, i.destHost.toLowerCase(), i.destPort, i.bytesGateway.toString()],
    );

    const bytesTotal = i.bytesIn + i.bytesOut;
    await endSessionTx(client, i.sessionId, bytesTotal, i.sessionStatus ?? "completed");
    await createUsageRecordTx(client, {
      user_id: i.requesterUserId, session_id: i.sessionId, bytes_in: i.bytesIn, bytes_out: i.bytesOut,
      cost_cents: debitCents, proxy_type: "relay", target_host: (i.usageTargetHost ?? i.destHost).toLowerCase(),
    });

    return { status: "settled", relayChargeId, paidInFull, grossMusd, nodeMusd, platformMusd, debitCents, zeroReason, disputed };
  });
}
