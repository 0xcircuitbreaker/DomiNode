import { withTx, earnTx, MUSD_PER_CENT } from "./node-credit-repo.js";
import { settleSessionTx } from "./wallet-repo.js";
import { settleTeamSessionTx } from "./team-repo.js";
import { endSessionTx, createUsageRecordTx } from "./usage-repo.js";
import type { ChargeSnapshot } from "./tier-repo.js";

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
}

/** Pure charge math (mirrors metering/relay.ts). */
export function computeSplit(bytes: bigint, pricePerGbMusd: bigint, nodeShareBps: number, rail: RelayRail) {
  const raw = (bytes * pricePerGbMusd + 999_999_999n) / 1_000_000_000n;
  const debitCents = (raw + MUSD_PER_CENT - 1n) / MUSD_PER_CENT;
  const prepaidInCents = rail === "wallet" || rail === "team" || rail === "agentic_wallet";
  const gross = prepaidInCents ? debitCents * MUSD_PER_CENT : raw;
  const node = (raw * BigInt(nodeShareBps)) / 10_000n; // on un-rounded gross
  return { rawMusd: raw, grossMusd: gross, nodeMusd: node, platformMusd: gross - node, debitCents };
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
        debitCents: 0, zeroReason: e.zero_reason,
      };
    }

    if (session.status !== "active") throw new Error("Session already ended");

    const split = computeSplit(i.bytesGateway, i.pricePerGbMusd, i.snapshot.nodeShareBps, i.rail);
    if (split.debitCents > BigInt(MAX_INT)) throw new Error("charge exceeds maximum");
    const debitCents = i.rail === "free" ? 0 : Number(split.debitCents);

    // Requester settle
    let paidInFull = true;
    if (i.rail === "wallet") {
      const r = await settleSessionTx(client, i.requesterUserId, i.reservedCents, debitCents, i.sessionId);
      if (r === "no_wallet") throw new Error("Requester wallet not found");
      paidInFull = r === "ok";
    } else if (i.rail === "team") {
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

    const ins = await client.query<{ id: string }>(
      `INSERT INTO relay_charges (session_id, requester_user_id, node_id, node_owner_user_id, payment_rail,
         bytes_gateway, bytes_node, price_per_gb_musd, gross_musd, node_musd, platform_musd,
         split_config_id, tier_id, node_share_bps, zero_reason, matures_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now() + make_interval(days => $16))
       RETURNING id`,
      [
        i.sessionId, i.requesterUserId, i.nodeId, node.owner_user_id, i.rail,
        i.bytesGateway.toString(), i.bytesNode == null ? null : i.bytesNode.toString(),
        i.pricePerGbMusd.toString(), grossMusd.toString(), nodeMusd.toString(), platformMusd.toString(),
        i.snapshot.splitConfigId, i.snapshot.tierId, i.snapshot.nodeShareBps, zeroReason, i.snapshot.holdDays,
      ],
    );
    const relayChargeId = ins.rows[0].id;

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

    return { status: "settled", relayChargeId, paidInFull, grossMusd, nodeMusd, platformMusd, debitCents, zeroReason };
  });
}
