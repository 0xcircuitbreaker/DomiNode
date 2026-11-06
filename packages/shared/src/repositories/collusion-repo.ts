import { query, getPool } from "../db.js";
import { freezeAccountTx } from "./payout-repo.js";

/**
 * Collusion detector (DESIGN.md §13 commit 33). Flags requester <-> node-owner
 * pairs with suspicious concentration of paid relay traffic, and owners who
 * buy from each other (circular flows). Flags are advisory and admin-visible;
 * an optional automatic node-credit freeze applies above a high threshold
 * (collusion_settings.auto_freeze, default off).
 *
 * Counted traffic: relay_charges in the window, gross > 0, not disputed,
 * requester present and not the node owner (self-traffic earns nothing).
 */

export const COLLUSION_PAGE_LIMIT = 1000;
export const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

export interface CollusionSettings {
  windowDays: number;
  minNodeVolumeMusd: bigint;
  concentrationBps: number;
  clusterSize: number;
  clusterBps: number;
  circularMinMusd: bigint;
  autoFreeze: boolean;
  freezeBps: number;
  freezeMinVolumeMusd: bigint;
}

export const DEFAULT_COLLUSION_SETTINGS: CollusionSettings = {
  windowDays: 30,
  minNodeVolumeMusd: 5_000_000n,
  concentrationBps: 8000,
  clusterSize: 3,
  clusterBps: 9500,
  circularMinMusd: 1_000_000n,
  autoFreeze: false,
  freezeBps: 9500,
  freezeMinVolumeMusd: 50_000_000n,
};

const SETTINGS_COLS = `window_days, min_node_volume_musd::text AS min_node_volume_musd, concentration_bps, cluster_size,
  cluster_bps, circular_min_musd::text AS circular_min_musd, auto_freeze, freeze_bps,
  freeze_min_volume_musd::text AS freeze_min_volume_musd, updated_by, updated_at`;

interface SettingsRow {
  window_days: number; min_node_volume_musd: string; concentration_bps: number; cluster_size: number; cluster_bps: number;
  circular_min_musd: string; auto_freeze: boolean; freeze_bps: number; freeze_min_volume_musd: string;
  updated_by: string | null; updated_at: Date;
}

export function mapSettings(r: SettingsRow): CollusionSettings {
  return {
    windowDays: r.window_days, minNodeVolumeMusd: BigInt(r.min_node_volume_musd), concentrationBps: r.concentration_bps,
    clusterSize: r.cluster_size, clusterBps: r.cluster_bps, circularMinMusd: BigInt(r.circular_min_musd),
    autoFreeze: r.auto_freeze, freezeBps: r.freeze_bps, freezeMinVolumeMusd: BigInt(r.freeze_min_volume_musd),
  };
}

/** Current settings; falls back to defaults (auto_freeze off) when the row is missing. */
export async function getSettings(): Promise<CollusionSettings & { updatedBy: string | null; updatedAt: Date | null }> {
  const r = await query<SettingsRow>(`SELECT ${SETTINGS_COLS} FROM collusion_settings WHERE id = 1`);
  const row = r.rows[0];
  if (!row) return { ...DEFAULT_COLLUSION_SETTINGS, updatedBy: null, updatedAt: null };
  return { ...mapSettings(row), updatedBy: row.updated_by, updatedAt: row.updated_at };
}

// ─── Detection inputs ───────────────────────────────────────────────

export interface NodeConcentration {
  nodeId: string;
  ownerUserId: string;
  /** Counted paid volume on this node in the window. */
  totalMusd: bigint;
  requesters: number;
  topRequesterUserId: string | null;
  topMusd: bigint;
  /** Volume from the top `clusterSize` requesters. */
  topKMusd: bigint;
}

/** One page of nodes (keyset by id) with their requester concentration. */
export async function listNodeConcentration(
  afterNodeId: string | null, limit: number, windowDays: number, clusterSize: number,
): Promise<NodeConcentration[]> {
  const lim = Math.max(1, Math.min(COLLUSION_PAGE_LIMIT, Math.floor(limit)));
  const r = await query<{
    node_id: string; owner_user_id: string; total_musd: string | null; requesters: string | null;
    top_requester: string | null; top_musd: string | null; topk_musd: string | null;
  }>(
    `WITH page AS (
       SELECT n.id, n.owner_user_id FROM nodes n
       WHERE ($1::uuid IS NULL OR n.id > $1::uuid)
       ORDER BY n.id LIMIT $2
     ), per AS (
       SELECT rc.node_id, rc.requester_user_id, SUM(rc.gross_musd) AS musd
       FROM relay_charges rc JOIN page p ON p.id = rc.node_id
       WHERE rc.created_at > now() - make_interval(days => $3)
         AND NOT rc.disputed AND rc.gross_musd > 0
         AND rc.requester_user_id IS NOT NULL
         AND rc.requester_user_id IS DISTINCT FROM p.owner_user_id
       GROUP BY rc.node_id, rc.requester_user_id
     ), ranked AS (
       SELECT node_id, requester_user_id, musd,
              ROW_NUMBER() OVER (PARTITION BY node_id ORDER BY musd DESC, requester_user_id) AS rn,
              SUM(musd) OVER (PARTITION BY node_id) AS total,
              COUNT(*) OVER (PARTITION BY node_id) AS requesters
       FROM per
     ), topk AS (
       SELECT node_id, SUM(musd) AS topk FROM ranked WHERE rn <= $4 GROUP BY node_id
     )
     SELECT p.id AS node_id, p.owner_user_id, r.total::text AS total_musd, r.requesters::text AS requesters,
            r.requester_user_id AS top_requester, r.musd::text AS top_musd, k.topk::text AS topk_musd
     FROM page p
     LEFT JOIN ranked r ON r.node_id = p.id AND r.rn = 1
     LEFT JOIN topk k ON k.node_id = p.id
     ORDER BY p.id`,
    [afterNodeId, lim, windowDays, clusterSize],
  );
  return r.rows.map((x) => ({
    nodeId: x.node_id, ownerUserId: x.owner_user_id,
    totalMusd: BigInt(x.total_musd ?? "0"), requesters: Number(x.requesters ?? 0),
    topRequesterUserId: x.top_requester, topMusd: BigInt(x.top_musd ?? "0"), topKMusd: BigInt(x.topk_musd ?? "0"),
  }));
}

export interface CircularPair {
  /** a < b (uuid order). */
  a: string;
  b: string;
  aToBMusd: bigint;
  bToAMusd: bigint;
}

/** Owner pairs that each bought at least minMusd from the other's nodes. Keyset by (a, b). */
export async function listCircularPairs(
  after: { a: string; b: string } | null, limit: number, windowDays: number, minMusd: bigint,
): Promise<CircularPair[]> {
  const lim = Math.max(1, Math.min(COLLUSION_PAGE_LIMIT, Math.floor(limit)));
  const r = await query<{ a: string; b: string; a_to_b: string; b_to_a: string }>(
    `WITH flows AS (
       SELECT rc.requester_user_id AS buyer, rc.node_owner_user_id AS seller, SUM(rc.gross_musd) AS musd
       FROM relay_charges rc
       WHERE rc.created_at > now() - make_interval(days => $3)
         AND NOT rc.disputed AND rc.gross_musd > 0
         AND rc.requester_user_id IS NOT NULL AND rc.node_owner_user_id IS NOT NULL
         AND rc.requester_user_id <> rc.node_owner_user_id
       GROUP BY rc.requester_user_id, rc.node_owner_user_id
       HAVING SUM(rc.gross_musd) >= $4::bigint
     )
     SELECT f1.buyer AS a, f1.seller AS b, f1.musd::text AS a_to_b, f2.musd::text AS b_to_a
     FROM flows f1 JOIN flows f2 ON f2.buyer = f1.seller AND f2.seller = f1.buyer
     WHERE f1.buyer < f1.seller
       AND ($1::uuid IS NULL OR (f1.buyer, f1.seller) > ($1::uuid, $2::uuid))
     ORDER BY f1.buyer, f1.seller
     LIMIT $5`,
    [after?.a ?? null, after?.b ?? null, windowDays, minMusd.toString(), lim],
  );
  return r.rows.map((x) => ({ a: x.a, b: x.b, aToBMusd: BigInt(x.a_to_b), bToAMusd: BigInt(x.b_to_a) }));
}

// ─── Pure decision ──────────────────────────────────────────────────

export type CollusionKind = "concentration" | "cluster" | "circular";

export interface CollusionFinding {
  kind: CollusionKind;
  ownerUserId: string;
  nodeId: string | null;
  requesterUserId: string | null;
  shareBps: number;
  volumeMusd: bigint;
  totalMusd: bigint;
  /** True when this finding crosses the auto-freeze threshold (and auto_freeze is on). */
  freeze: boolean;
}

function bps(part: bigint, total: bigint): number {
  if (total <= 0n) return 0;
  const v = Number((part * 10_000n) / total);
  return Math.max(0, Math.min(10_000, v));
}

/** Node-level findings: single-requester concentration, else small-cluster concentration. */
export function evaluateNode(n: NodeConcentration, s: CollusionSettings): CollusionFinding | null {
  if (n.totalMusd <= 0n || n.totalMusd < s.minNodeVolumeMusd) return null;
  const topShare = bps(n.topMusd, n.totalMusd);
  const freezeOk = (share: number) => s.autoFreeze && share >= s.freezeBps && n.totalMusd >= s.freezeMinVolumeMusd;
  if (n.topRequesterUserId && topShare >= s.concentrationBps) {
    return {
      kind: "concentration", ownerUserId: n.ownerUserId, nodeId: n.nodeId, requesterUserId: n.topRequesterUserId,
      shareBps: topShare, volumeMusd: n.topMusd, totalMusd: n.totalMusd, freeze: freezeOk(topShare),
    };
  }
  const kShare = bps(n.topKMusd, n.totalMusd);
  if (n.requesters <= s.clusterSize && n.requesters >= 2 && kShare >= s.clusterBps) {
    return {
      kind: "cluster", ownerUserId: n.ownerUserId, nodeId: n.nodeId, requesterUserId: n.topRequesterUserId,
      shareBps: kShare, volumeMusd: n.topKMusd, totalMusd: n.totalMusd, freeze: freezeOk(kShare),
    };
  }
  return null;
}

/** Circular pair -> one finding per owner (each is flagged with the other as requester). */
export function evaluateCircular(p: CircularPair, s: CollusionSettings): CollusionFinding[] {
  if (p.aToBMusd < s.circularMinMusd || p.bToAMusd < s.circularMinMusd) return [];
  const small = p.aToBMusd < p.bToAMusd ? p.aToBMusd : p.bToAMusd;
  const total = p.aToBMusd + p.bToAMusd;
  // Symmetry: 10000 = perfectly balanced round-tripping.
  const share = bps(small * 2n, total);
  const freeze = s.autoFreeze && share >= s.freezeBps && small >= s.freezeMinVolumeMusd;
  return [
    { kind: "circular", ownerUserId: p.b, nodeId: null, requesterUserId: p.a, shareBps: share, volumeMusd: p.aToBMusd, totalMusd: total, freeze },
    { kind: "circular", ownerUserId: p.a, nodeId: null, requesterUserId: p.b, shareBps: share, volumeMusd: p.bToAMusd, totalMusd: total, freeze },
  ];
}

// ─── Persistence ────────────────────────────────────────────────────

/**
 * Upsert one finding as an open flag (refreshing an existing open flag), unless an
 * admin dismissed the same flag within the window. When `finding.freeze`, also
 * freezes the owner's node-credit account in the same transaction and audits it.
 * Returns what happened.
 */
export async function recordFinding(f: CollusionFinding, windowDays: number): Promise<{ flagged: boolean; frozen: boolean }> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`collusion:${f.kind}:${f.ownerUserId}:${f.nodeId ?? ""}:${f.requesterUserId ?? ""}`]);
    const keyParams = [f.kind, f.ownerUserId, f.nodeId ?? ZERO_UUID, f.requesterUserId ?? ZERO_UUID];
    const dismissed = await client.query(
      `SELECT 1 FROM collusion_flags
       WHERE kind = $1 AND owner_user_id = $2
         AND COALESCE(node_id, '${ZERO_UUID}'::uuid) = $3::uuid
         AND COALESCE(requester_user_id, '${ZERO_UUID}'::uuid) = $4::uuid
         AND status = 'dismissed' AND resolved_at > now() - make_interval(days => $5)
       LIMIT 1`,
      [...keyParams, windowDays],
    );
    if (dismissed.rows.length > 0) {
      await client.query("COMMIT");
      return { flagged: false, frozen: false };
    }
    const ins = await client.query<{ id: string; auto_frozen: boolean }>(
      `INSERT INTO collusion_flags (kind, owner_user_id, node_id, requester_user_id, share_bps, volume_musd, total_musd, window_days)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (kind, owner_user_id,
                    COALESCE(node_id, '${ZERO_UUID}'::uuid),
                    COALESCE(requester_user_id, '${ZERO_UUID}'::uuid)) WHERE status = 'open'
       DO UPDATE SET share_bps = EXCLUDED.share_bps, volume_musd = EXCLUDED.volume_musd,
                     total_musd = EXCLUDED.total_musd, window_days = EXCLUDED.window_days, last_seen_at = now()
       RETURNING id, auto_frozen`,
      [f.kind, f.ownerUserId, f.nodeId, f.requesterUserId, f.shareBps, f.volumeMusd.toString(), f.totalMusd.toString(), windowDays],
    );
    const flag = ins.rows[0]!;
    let frozen = false;
    if (f.freeze && !flag.auto_frozen) {
      // freezeAccountTx creates the account row when absent, so future earnings are held too.
      const held = await freezeAccountTx(client as unknown as Parameters<typeof freezeAccountTx>[0], f.ownerUserId);
      await client.query(`UPDATE collusion_flags SET auto_frozen = true WHERE id = $1`, [flag.id]);
      await client.query(
        `INSERT INTO audit_events (user_id, action, resource, resource_id, details)
         VALUES (NULL, 'node_credit_auto_freeze', 'node_credit_account', $1, $2)`,
        [f.ownerUserId, JSON.stringify({ flagId: String(flag.id), kind: f.kind, shareBps: f.shareBps, heldPayouts: held })],
      );
      frozen = true;
    }
    await client.query("COMMIT");
    return { flagged: true, frozen };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
