import crypto from "node:crypto";
import { query, getPool } from "../db.js";
import { NODE_IP_CLASSES, isClassDowngrade, isExitClass, type NodeIpClass, type ExitClass } from "../exit-classes.js";

export type { NodeIpClass };

// ─── Types ─────────────────────────────────────────────────────────────

export type NodeStatus = "pending" | "active" | "cooldown" | "quarantined" | "suspended" | "revoked";

export const NODE_STATUSES: readonly NodeStatus[] = [
  "pending", "active", "cooldown", "quarantined", "suspended", "revoked",
];
const IP_CLASSES: readonly NodeIpClass[] = NODE_IP_CLASSES;

/** Fallback caps per §15 if the owner has no tier row (fail closed to Probation). */
export const NODE_CAP_BY_TIER: Readonly<Record<string, number>> = {
  probation: 10,
  bronze: 25,
  silver: 100,
  gold: 500,
  platinum: 2000,
  partner: 2000,
};
export const DEFAULT_NODE_TIER_ID = 1; // probation
export const NODE_KEY_PREFIX = "dn_node_";
export const NODE_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const MAX_CHALLENGES_PER_USER = 10;
export const FLUSH_HEALTH_LIMIT = 1000;

/** Public node view — never includes node_key_hash. */
export interface NodeRecord {
  id: string;
  owner_user_id: string;
  owner_wallet: string;
  node_pubkey: string | null;
  status: NodeStatus;
  attestation_version: number;
  observed_ip: string | null;
  ip_prefix24: string | null;
  asn: string | null;
  country: string | null;
  /** Verified exit class (gateway-classified egress IP); the effective class. */
  ip_class: NodeIpClass | null;
  /** Owner-declared class at registration (informational; never used for routing or pricing). */
  declared_class: ExitClass | null;
  class_verified_at: Date | null;
  max_streams: number;
  max_gb_day: number;
  /** Owner-lowered req/s cap; null = policy default. */
  max_req_per_sec: number | null;
  reputation: number;
  byte_disputes: number;
  agent_version: string | null;
  floor_hash: string | null;
  last_seen_at: Date | null;
  created_at: Date;
}

const NODE_COLUMNS = `id, owner_user_id, owner_wallet, node_pubkey, status, attestation_version,
  host(observed_ip) AS observed_ip, ip_prefix24::text AS ip_prefix24, asn::text AS asn, country, ip_class,
  declared_class, class_verified_at,
  max_streams, max_gb_day, max_req_per_sec, reputation, byte_disputes, agent_version, floor_hash, last_seen_at, created_at`;

/** Node joined with owner state for tunnel authentication. */
export interface TunnelAuthNode {
  id: string;
  owner_user_id: string;
  owner_wallet: string;
  owner_team_id: string | null;
  node_pubkey: string | null;
  status: NodeStatus;
  attestation_version: number;
  max_streams: number;
  max_gb_day: number;
  max_req_per_sec?: number | null;
  reputation: number;
  /** Burn-report penalty (report-reputation job); effective = reputation - report_penalty. */
  report_penalty?: number;
  /** Admin-set: operator-run seed node (DESIGN.md §11), reported separately. */
  operator_run?: boolean;
  /** Owner-declared class (compared against the verified class only). */
  declared_class?: ExitClass | null;
  /** Last persisted egress-probe verdict (gateway-observed); null = never probed. */
  probe_class?: NodeIpClass | null;
}

export interface NodeChallenge {
  nonce_hash: string;
  user_id: string;
  expires_at: Date;
}

export interface RegisterNodeInput {
  ownerUserId: string;
  ownerWallet: string;
  nodePubkey?: string | null;
  attestationVersion: number;
  attestationSig: string;
  maxStreams?: number;
  maxGbDay?: number;
  /** Optional self-declared class; the effective class is always the verified one. */
  declaredClass?: ExitClass | null;
}

export type RegisterNodeResult =
  | { ok: true; node: NodeRecord; nodeKey: string }
  | { ok: false; reason: "owner_not_found" | "owner_inactive" | "tier_not_found" | "node_cap_reached" | "owner_penalized"; cap?: number };

export interface HealthUpdate {
  nodeId: string;
  bytes?: number;
  streams?: number;
  failures?: number;
  burns?: number;
  reputation?: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────

const HEX64 = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WALLET_RE = /^0x[0-9a-f]{40}$/;

function assertUuid(v: string, name: string): void {
  if (typeof v !== "string" || !UUID_RE.test(v)) throw new Error(`Invalid ${name}`);
}

function intInRange(v: number | undefined, min: number, max: number): number {
  if (v === undefined) return 0;
  if (!Number.isFinite(v) || !Number.isInteger(v) || v < min || v > max) {
    throw new Error("Value out of range");
  }
  return v;
}

function clampLimit(v: number | undefined, def: number, max: number): number {
  if (v === undefined || !Number.isFinite(v)) return def;
  return Math.min(Math.max(Math.trunc(v), 1), max);
}

function clampOffset(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v)) return 0;
  return Math.min(Math.max(Math.trunc(v), 0), 1_000_000);
}

/** SHA-256 hex of a node key (stored in nodes.node_key_hash). */
export function hashNodeKey(nodeKey: string): string {
  return crypto.createHash("sha256").update(nodeKey).digest("hex");
}

/** Generate a fresh `dn_node_` key (plaintext; shown to the owner once). */
export function generateNodeKey(): string {
  return NODE_KEY_PREFIX + crypto.randomBytes(32).toString("hex");
}

// ─── Challenges ────────────────────────────────────────────────────────

/**
 * Store a registration challenge (nonce hash only). Expired challenges for the
 * user are purged and outstanding challenges are capped per user.
 */
export async function createChallenge(
  userId: string,
  nonceHash: string,
  ttlMs: number = NODE_CHALLENGE_TTL_MS,
): Promise<NodeChallenge | null> {
  assertUuid(userId, "userId");
  if (!HEX64.test(nonceHash)) throw new Error("Invalid nonce hash");
  if (!Number.isFinite(ttlMs) || ttlMs < 1000 || ttlMs > 3_600_000) throw new Error("Invalid TTL");

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Serialize challenge issuance per user via the owner row lock.
    const owner = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE id = $1 AND status = 'active' FOR UPDATE`,
      [userId],
    );
    if (owner.rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(
      `DELETE FROM node_challenges WHERE user_id = $1 AND expires_at <= now()`,
      [userId],
    );
    const count = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM node_challenges WHERE user_id = $1`,
      [userId],
    );
    if (parseInt(count.rows[0]?.count ?? "0", 10) >= MAX_CHALLENGES_PER_USER) {
      await client.query("ROLLBACK");
      return null;
    }
    const res = await client.query<NodeChallenge>(
      `INSERT INTO node_challenges (nonce_hash, user_id, expires_at)
       VALUES ($1, $2, now() + ($3::int * interval '1 millisecond'))
       RETURNING nonce_hash, user_id, expires_at`,
      [nonceHash, userId, Math.trunc(ttlMs)],
    );
    await client.query("COMMIT");
    return res.rows[0] ?? null;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Atomically consume a challenge (single use). Returns null if missing/expired/foreign. */
export async function consumeChallenge(
  userId: string,
  nonceHash: string,
): Promise<NodeChallenge | null> {
  assertUuid(userId, "userId");
  if (!HEX64.test(nonceHash)) return null;
  const res = await query<NodeChallenge>(
    `DELETE FROM node_challenges
     WHERE nonce_hash = $1 AND user_id = $2 AND expires_at > now()
     RETURNING nonce_hash, user_id, expires_at`,
    [nonceHash, userId],
  );
  return res.rows[0] ?? null;
}

// ─── Registration ──────────────────────────────────────────────────────

/** Days a node revoked while quarantined/suspended keeps blocking new registrations. */
export const NODE_PENALTY_WINDOW_DAYS = 30;

/**
 * Revoke an owned node (irreversible), remembering the status it had so a
 * quarantine or suspension is not shed by revoke + re-register.
 */
export async function revokeOwnedNode(nodeId: string, ownerUserId: string): Promise<{ id: string; status: string } | null> {
  assertUuid(nodeId, "nodeId");
  assertUuid(ownerUserId, "ownerUserId");
  const r = await query<{ id: string; status: string }>(
    `UPDATE nodes SET status = 'revoked', revoked_from_status = status, revoked_at = now()
     WHERE id = $1 AND owner_user_id = $2 AND status <> 'revoked'
     RETURNING id, status`,
    [nodeId, ownerUserId],
  );
  return r.rows[0] ?? null;
}

/**
 * Probe verdicts recorded in the last 30 days for any of this owner's nodes
 * (revoked ones included) last seen on the same /24 (IPv4) or /48 (IPv6).
 * The tunnel server tightens a new connection's class with these, so a probe
 * downgrade is bound to owner + prefix, not only to the node id.
 */
export async function getOwnerPrefixProbeClasses(ownerUserId: string, prefix: string, excludeNodeId: string): Promise<NodeIpClass[]> {
  assertUuid(ownerUserId, "ownerUserId");
  assertUuid(excludeNodeId, "excludeNodeId");
  if (typeof prefix !== "string" || prefix.length > 64 || !/^[0-9a-fA-F:.]+\/(24|48)$/.test(prefix)) return [];
  const r = await query<{ probe_class: NodeIpClass }>(
    `SELECT DISTINCT probe_class FROM nodes
     WHERE owner_user_id = $1 AND ip_prefix24 = $2::cidr AND id <> $3
       AND probe_class IS NOT NULL AND probe_class <> 'unknown'
       AND probe_class_at > now() - interval '30 days'
     LIMIT 10`,
    [ownerUserId, prefix, excludeNodeId],
  );
  return r.rows.map((x) => x.probe_class).filter((c) => IP_CLASSES.includes(c));
}

/**
 * Register a node. The per-owner cap scales by the owner's tier (§15) and is
 * enforced inside a transaction holding FOR UPDATE on the owner row, so
 * concurrent registrations cannot exceed it. Revoked nodes do not count.
 */
export async function registerNode(input: RegisterNodeInput): Promise<RegisterNodeResult> {
  assertUuid(input.ownerUserId, "ownerUserId");
  const wallet = typeof input.ownerWallet === "string" ? input.ownerWallet.toLowerCase() : "";
  if (!WALLET_RE.test(wallet)) throw new Error("Invalid owner wallet");
  const pubkey = input.nodePubkey ?? null;
  if (pubkey !== null && !HEX64.test(pubkey)) throw new Error("Invalid node pubkey");
  intInRange(input.attestationVersion, 1, 100000);
  if (typeof input.attestationSig !== "string" || input.attestationSig.length < 132 || input.attestationSig.length > 200) {
    throw new Error("Invalid attestation signature");
  }
  const maxStreams = input.maxStreams === undefined ? 32 : intInRange(input.maxStreams, 1, 1024);
  const maxGbDay = input.maxGbDay === undefined ? 5 : intInRange(input.maxGbDay, 1, 10000);
  const declared = input.declaredClass ?? null;
  if (declared !== null && !isExitClass(declared)) throw new Error("Invalid declared class");

  const nodeKey = generateNodeKey();
  const keyHash = hashNodeKey(nodeKey);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const owner = await client.query<{ status: string; tier_name: string | null; max_nodes: number | null }>(
      `SELECT u.status, t.name AS tier_name, t.max_nodes
       FROM users u
       LEFT JOIN node_tiers t ON t.id = COALESCE(u.node_tier_id, $2)
       WHERE u.id = $1
       FOR UPDATE OF u`,
      [input.ownerUserId, DEFAULT_NODE_TIER_ID],
    );
    const row = owner.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "owner_not_found" };
    }
    if (row.status !== "active") {
      await client.query("ROLLBACK");
      return { ok: false, reason: "owner_inactive" };
    }
    // Fail closed: a missing tier row means no registration.
    if (row.max_nodes === null || row.max_nodes === undefined) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "tier_not_found" };
    }
    const cap = Number(row.max_nodes);

    const countRes = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM nodes WHERE owner_user_id = $1 AND status <> 'revoked'`,
      [input.ownerUserId],
    );
    const count = parseInt(countRes.rows[0]?.count ?? "0", 10);
    if (!Number.isFinite(cap) || count >= cap) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "node_cap_reached", cap };
    }

    // Penalties are not shed by revoking: while any of the owner's nodes is
    // quarantined or suspended, or was revoked in that state within the
    // window, no new node can be registered.
    const pen = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM nodes
       WHERE owner_user_id = $1
         AND (status IN ('quarantined','suspended')
              OR (status = 'revoked' AND revoked_from_status IN ('quarantined','suspended')
                  AND revoked_at > now() - make_interval(days => $2)))`,
      [input.ownerUserId, NODE_PENALTY_WINDOW_DAYS],
    );
    if (parseInt(pen.rows[0]?.n ?? "0", 10) > 0) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "owner_penalized" };
    }

    const ins = await client.query<NodeRecord>(
      `INSERT INTO nodes (owner_user_id, owner_wallet, node_key_hash, node_pubkey,
                          attestation_version, attestation_sig, max_streams, max_gb_day, declared_class)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${NODE_COLUMNS}`,
      [input.ownerUserId, wallet, keyHash, pubkey, input.attestationVersion,
        input.attestationSig, maxStreams, maxGbDay, declared],
    );
    await client.query("COMMIT");
    return { ok: true, node: ins.rows[0], nodeKey };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ─── Tunnel auth ───────────────────────────────────────────────────────

/** Look up a node for tunnel HELLO by key hash. Excludes revoked nodes and inactive owners. */
export async function getNodeForTunnelAuth(keyHash: string): Promise<TunnelAuthNode | null> {
  if (typeof keyHash !== "string" || !HEX64.test(keyHash)) return null;
  const res = await query<TunnelAuthNode>(
    `SELECT n.id, n.owner_user_id, n.owner_wallet,
            (SELECT tm.team_id FROM team_members tm WHERE tm.user_id = n.owner_user_id
              ORDER BY tm.team_id LIMIT 1) AS owner_team_id,
            n.node_pubkey, n.status, n.attestation_version,
            n.max_streams, n.max_gb_day, n.max_req_per_sec, n.reputation, n.report_penalty, n.operator_run, n.declared_class,
            -- Own verdict decays like the owner+prefix one (30 days).
            CASE WHEN n.probe_class_at > now() - interval '30 days' THEN n.probe_class END AS probe_class
     FROM nodes n
     JOIN users u ON u.id = n.owner_user_id
     WHERE n.node_key_hash = $1
       AND n.status <> 'revoked'
       AND u.status = 'active'`,
    [keyHash],
  );
  return res.rows[0] ?? null;
}

// ─── Liveness ──────────────────────────────────────────────────────────

/** Record an established tunnel: observed IP, /24 (IPv4) or /48 (IPv6) prefix, geo. */
export async function markOnline(
  nodeId: string,
  ip: string,
  country: string | null,
  asn: number | null,
  ipClass: NodeIpClass | null = null,
): Promise<boolean> {
  assertUuid(nodeId, "nodeId");
  if (typeof ip !== "string" || ip.length === 0 || ip.length > 45) throw new Error("Invalid ip");
  const cc = country === null ? null : country.toUpperCase();
  if (cc !== null && !/^[A-Z]{2}$/.test(cc)) throw new Error("Invalid country");
  if (asn !== null) intInRange(asn, 0, 4294967295);
  if (ipClass !== null && !IP_CLASSES.includes(ipClass)) throw new Error("Invalid ip class");
  const res = await query(
    `UPDATE nodes
     SET observed_ip = $2::inet,
         ip_prefix24 = network(set_masklen($2::inet, CASE WHEN family($2::inet) = 4 THEN 24 ELSE 48 END)),
         country = $3, asn = $4, ip_class = COALESCE($5, ip_class),
         class_verified_at = CASE WHEN $5::text IS NULL THEN class_verified_at ELSE now() END,
         last_seen_at = now()
     WHERE id = $1 AND status <> 'revoked'`,
    [nodeId, ip, cc, asn, ipClass],
  );
  return (res.rowCount ?? 0) > 0;
}

export interface VerifiedClassResult {
  updated: boolean;
  previousClass: NodeIpClass | null;
  declaredClass: ExitClass | null;
  /** Verified class is less trusted than the declared one; a review flag was raised. */
  flagged: boolean;
}

/**
 * Record a gateway-verified exit class (connect or egress probe). The verified
 * class always becomes the node's effective class. When it is less trusted
 * than the owner's declared class (e.g. declared residential, exits via a VPN)
 * an 'egress_mismatch' review flag is opened (or refreshed) in collusion_flags
 * for the existing abuse/collusion review queue. Node-reported data is never
 * an input here.
 */
export interface VerifiedClassOptions {
  /** Raw class from this egress probe; persisted as probe_class so a reconnect cannot shed it. */
  probeClass?: NodeIpClass;
  /** Connect-time class (tunnel peer IP); a verified class below it also raises the flag. */
  connectClass?: NodeIpClass | null;
}

export async function recordVerifiedClass(nodeId: string, verified: NodeIpClass, opts: VerifiedClassOptions = {}): Promise<VerifiedClassResult> {
  assertUuid(nodeId, "nodeId");
  if (!IP_CLASSES.includes(verified)) throw new Error("Invalid ip class");
  if (opts.probeClass !== undefined && !IP_CLASSES.includes(opts.probeClass)) throw new Error("Invalid ip class");
  if (opts.connectClass != null && !IP_CLASSES.includes(opts.connectClass)) throw new Error("Invalid ip class");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query<{ owner_user_id: string; ip_class: NodeIpClass | null; declared_class: ExitClass | null }>(
      `SELECT owner_user_id, ip_class, declared_class FROM nodes WHERE id = $1 AND status <> 'revoked' FOR UPDATE`,
      [nodeId],
    );
    const row = cur.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { updated: false, previousClass: null, declaredClass: null, flagged: false };
    }
    await client.query(
      `UPDATE nodes SET ip_class = $2, class_verified_at = now(),
              probe_class = COALESCE($3, probe_class),
              probe_class_at = CASE WHEN $3::text IS NULL THEN probe_class_at ELSE now() END
       WHERE id = $1`,
      [nodeId, verified, opts.probeClass ?? null],
    );
    // Flag when the verified class is below the declared class OR below the
    // connect-time class (catches nodes that never declared a class).
    const flagged = isClassDowngrade(row.declared_class, verified) || isClassDowngrade(opts.connectClass ?? null, verified);
    if (flagged) {
      await client.query(
        `INSERT INTO collusion_flags (kind, owner_user_id, node_id, share_bps, volume_musd, total_musd, window_days)
         VALUES ('egress_mismatch', $1, $2, 0, 0, 0, 1)
         ON CONFLICT (kind, owner_user_id,
           COALESCE(node_id, '00000000-0000-0000-0000-000000000000'::uuid),
           COALESCE(requester_user_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE status = 'open'
         DO UPDATE SET last_seen_at = now()`,
        [row.owner_user_id, nodeId],
      );
    }
    await client.query("COMMIT");
    return { updated: true, previousClass: row.ip_class, declaredClass: row.declared_class, flagged };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Record tunnel close. */
export async function markOffline(nodeId: string): Promise<boolean> {
  assertUuid(nodeId, "nodeId");
  const res = await query(`UPDATE nodes SET last_seen_at = now() WHERE id = $1 AND status <> 'revoked'`, [nodeId]);
  return (res.rowCount ?? 0) > 0;
}

/**
 * Flush in-memory health counters to node_daily_stats (today) and reputation.
 * At most FLUSH_HEALTH_LIMIT entries are processed per call; returns the count
 * processed so the caller can re-queue the remainder.
 */
const MAX_BYTES = 1_000_000_000_000_000;
const MAX_COUNT = 2_000_000_000;

export async function flushHealth(batch: HealthUpdate[]): Promise<number> {
  const items = batch.slice(0, FLUSH_HEALTH_LIMIT);
  if (items.length === 0) return 0;

  // Merge duplicate nodeIds in JS (capped sums) so the INSERT path never
  // exceeds column CHECK limits; reputation: last value wins.
  const merged = new Map<string, { bytes: number; streams: number; failures: number; burns: number }>();
  const repMap = new Map<string, number>();
  for (const h of items) {
    assertUuid(h.nodeId, "nodeId");
    const b = intInRange(h.bytes, 0, MAX_BYTES);
    const s = intInRange(h.streams, 0, MAX_COUNT);
    const f = intInRange(h.failures, 0, MAX_COUNT);
    const u = intInRange(h.burns, 0, MAX_COUNT);
    const prev = merged.get(h.nodeId);
    if (prev) {
      prev.bytes = Math.min(prev.bytes + b, MAX_BYTES);
      prev.streams = Math.min(prev.streams + s, MAX_COUNT);
      prev.failures = Math.min(prev.failures + f, MAX_COUNT);
      prev.burns = Math.min(prev.burns + u, MAX_COUNT);
    } else {
      merged.set(h.nodeId, { bytes: b, streams: s, failures: f, burns: u });
    }
    if (h.reputation !== undefined) {
      repMap.delete(h.nodeId);
      repMap.set(h.nodeId, intInRange(h.reputation, 0, 10000));
    }
  }
  const ids: string[] = [];
  const bytes: number[] = [];
  const streams: number[] = [];
  const failures: number[] = [];
  const burns: number[] = [];
  for (const [id, v] of merged) {
    ids.push(id);
    bytes.push(v.bytes);
    streams.push(v.streams);
    failures.push(v.failures);
    burns.push(v.burns);
  }
  const repIds = [...repMap.keys()];
  const reps = [...repMap.values()];

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO node_daily_stats (node_id, day, bytes, streams, failures, burns)
       SELECT v.node_id, CURRENT_DATE,
              LEAST(SUM(v.bytes), 1000000000000000), LEAST(SUM(v.streams), 2000000000),
              LEAST(SUM(v.failures), 2000000000), LEAST(SUM(v.burns), 2000000000)
       FROM unnest($1::uuid[], $2::bigint[], $3::int[], $4::int[], $5::int[])
            AS v(node_id, bytes, streams, failures, burns)
       JOIN nodes n ON n.id = v.node_id
       GROUP BY v.node_id
       ON CONFLICT (node_id, day) DO UPDATE SET
         bytes    = LEAST(node_daily_stats.bytes + EXCLUDED.bytes, 1000000000000000),
         streams  = LEAST(node_daily_stats.streams + EXCLUDED.streams, 2000000000),
         failures = LEAST(node_daily_stats.failures + EXCLUDED.failures, 2000000000),
         burns    = LEAST(node_daily_stats.burns + EXCLUDED.burns, 2000000000)`,
      [ids, bytes, streams, failures, burns],
    );
    if (repIds.length > 0) {
      await client.query(
        `UPDATE nodes n SET reputation = v.reputation
         FROM unnest($1::uuid[], $2::int[]) AS v(node_id, reputation)
         WHERE n.id = v.node_id AND n.status <> 'revoked'`,
        [repIds, reps],
      );
    }
    await client.query("COMMIT");
    return items.length;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ─── Status / listing ──────────────────────────────────────────────────

/**
 * Set a node's status. Revoked is terminal: a revoked node never changes again.
 * Optionally restrict to an expected current status set (compare-and-set).
 */
export async function setStatus(
  nodeId: string,
  status: NodeStatus,
  expectedFrom?: NodeStatus[],
): Promise<NodeRecord | null> {
  assertUuid(nodeId, "nodeId");
  if (!NODE_STATUSES.includes(status)) throw new Error("Invalid status");
  if (expectedFrom && expectedFrom.some((s) => !NODE_STATUSES.includes(s))) throw new Error("Invalid status");
  const res = await query<NodeRecord>(
    `UPDATE nodes SET status = $2
     WHERE id = $1 AND status <> 'revoked'
       AND ($3::text[] IS NULL OR status = ANY($3::text[]))
     RETURNING ${NODE_COLUMNS}`,
    [nodeId, status, expectedFrom && expectedFrom.length > 0 ? expectedFrom : null],
  );
  return res.rows[0] ?? null;
}

/** Owner's nodes, newest first. With `cursor` (keyset), `offset` is ignored. */
export async function listForOwner(
  ownerUserId: string,
  opts: { limit?: number; offset?: number; cursor?: { createdAt: Date; id: string } | null } = {},
): Promise<NodeRecord[]> {
  assertUuid(ownerUserId, "ownerUserId");
  const c = opts.cursor ?? null;
  const res = await query<NodeRecord>(
    `SELECT ${NODE_COLUMNS} FROM nodes
     WHERE owner_user_id = $1
       AND ($4::timestamptz IS NULL OR (date_trunc('milliseconds', created_at), id) < ($4::timestamptz, $5::uuid))
     ORDER BY date_trunc('milliseconds', created_at) DESC, id DESC
     LIMIT $2 OFFSET $3`,
    [ownerUserId, clampLimit(opts.limit, 100, 2000), c ? 0 : clampOffset(opts.offset), c ? c.createdAt : null, c ? c.id : null],
  );
  return res.rows;
}

export interface ListAdminOpts {
  status?: NodeStatus;
  country?: string;
  ownerUserId?: string;
  limit?: number;
  offset?: number;
}

export async function listAdmin(opts: ListAdminOpts = {}): Promise<{ nodes: NodeRecord[]; total: number }> {
  if (opts.status !== undefined && !NODE_STATUSES.includes(opts.status)) throw new Error("Invalid status");
  const country = opts.country === undefined ? null : opts.country.toUpperCase();
  if (country !== null && !/^[A-Z]{2}$/.test(country)) throw new Error("Invalid country");
  if (opts.ownerUserId !== undefined) assertUuid(opts.ownerUserId, "ownerUserId");
  const params = [opts.status ?? null, country, opts.ownerUserId ?? null];
  const where = `WHERE ($1::text IS NULL OR status = $1)
       AND ($2::text IS NULL OR country = $2)
       AND ($3::uuid IS NULL OR owner_user_id = $3)`;
  const [rows, total] = await Promise.all([
    query<NodeRecord>(
      `SELECT ${NODE_COLUMNS} FROM nodes ${where}
       ORDER BY created_at DESC
       LIMIT $4 OFFSET $5`,
      [...params, clampLimit(opts.limit, 50, 500), clampOffset(opts.offset)],
    ),
    query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM nodes ${where}`, params),
  ]);
  return { nodes: rows.rows, total: parseInt(total.rows[0]?.count ?? "0", 10) };
}
