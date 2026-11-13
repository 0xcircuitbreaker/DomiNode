/**
 * Live node registry (DESIGN.md §4): capped Map<nodeId, LiveNode>, a country
 * index, and a periodic sweep. In-memory only; DB is the source of truth for
 * status and is refreshed on tunnel auth.
 */
import type { Duplex } from "node:stream";
import { isIP } from "node:net";
import { expandIPv6, type NodeIpClass, type NodeStatus } from "@dominusnode/shared";

export const MAX_LIVE_NODES = 100_000;
export const SWEEP_INTERVAL_MS = 60_000;
const DAY_MS = 86_400_000;
const MAX_COOLDOWNS_PER_NODE = 1000;

// ─── Reputation & burn (DESIGN.md §4, commit 21) ───────────────────
export const REPUTATION_MAX = 10_000;
export const QUARANTINE_BELOW = 1000;
/** +1 reputation per this many paid bytes. */
export const REP_BYTES_PER_POINT = 100 * 1024 * 1024;
/** First paid session of the day from a distinct requester. */
export const REP_DISTINCT_REQUESTER_BONUS = 5;
/** Paid bytes a session must carry before its requester counts toward the distinct-requester bonus. */
export const REP_BONUS_MIN_BYTES = 1024 * 1024;
export const REP_DISPUTE_PENALTY = 200;
export const REP_FAILURE_PENALTY = 5;
export const REP_BURN_PENALTY = 100;
export const BURN_COOLDOWN_MS = 6 * 3_600_000;
export const MAX_REPORTS_PER_REQUESTER_NODE_DAY = 5;
const MAX_REQUESTERS_PER_NODE_DAY = 10_000;
const MAX_ETLD_COUNTERS_PER_NODE = 1000;
const MAX_REPORT_KEYS = 100_000;

/** Unflushed deltas since the last drainCounters() (flushed every 60 s by the job). */
export interface NodeCounters {
  bytes: number;
  streams: number;
  failures: number;
  burns: number;
  disputes: number;
  /** Seconds the node's tunnel was open since the last drain (gateway-measured uptime). */
  onlineSeconds?: number;
  /** eTLD+1 -> ok/burn deltas. */
  etld: Map<string, { ok: number; burn: number }>;
}

export interface CounterFlush {
  nodeId: string;
  day: number;
  reputation: number;
  /** Base reputation (excluding the burn-report penalty) is below the threshold. */
  quarantine: boolean;
  /**
   * The burn-report penalty alone pushes the node below the threshold. Reports never
   * auto-quarantine (griefing); this raises an admin review flag instead.
   */
  reviewFlag: boolean;
  reportPenalty: number;
  counters: NodeCounters;
}

function emptyCounters(): NodeCounters {
  return { bytes: 0, streams: 0, failures: 0, burns: 0, disputes: 0, onlineSeconds: 0, etld: new Map() };
}

function clampRep(v: number): number {
  return Math.max(0, Math.min(REPUTATION_MAX, Math.round(v)));
}

/** Reputation after the spend-weighted burn-report penalty. */
export function effectiveReputation(n: Pick<LiveNode, "reputation" | "reportPenalty">): number {
  return clampRep(n.reputation - (n.reportPenalty ?? 0));
}

export interface NodeTunnelHandle {
  openStream(host: string, port: number): Promise<Duplex>;
  readonly openStreams: number;
  readonly isOpen: boolean;
  close(reason?: string): void;
}

export interface LiveNode {
  nodeId: string;
  tunnel: NodeTunnelHandle;
  /** Becomes true once AUTH_OK has been sent and markOnline succeeded. */
  ready: boolean;
  status: NodeStatus;
  ip: string;
  prefix24: string;
  asn: number | null;
  country: string | null;
  ipClass: NodeIpClass;
  ownerUserId: string;
  ownerWallet: string;
  ownerTeamId: string | null;
  /** 0..1 EWMA (RTT/probe/failure driven). */
  health: number;
  /** 0..10000 integer. */
  reputation: number;
  /** Burn-report penalty from the DB (report-reputation job), 0..10000. */
  reportPenalty?: number;
  maxStreams: number;
  maxGbDay: number;
  /** Owner-lowered OPENs/s cap from the DB row (PATCH /v1/nodes/:id); null/absent = policy default. */
  maxReqPerSec?: number | null;
  ports: number[];
  bytesToday: number;
  earningsTodayMusd: number;
  day: number;
  /** Timestamps (ms) of recent OPENs, pruned to the last second. */
  recentOpens: number[];
  /** Node-level cooldown until (ms epoch), 0 = none. */
  cooldownUntil: number;
  /** eTLD+1 -> burn cooldown until (ms epoch). */
  cooldowns: Map<string, number>;
  floorHashKnown: boolean;
  connectedAt: number;
  /** Operator-run seed node (admin flag); starter-credit traffic may be limited to these. */
  operatorRun?: boolean;
  /** ms epoch of the last probe-confirmed egress classification (unset = not yet probed). */
  egressVerifiedAt?: number;
  /**
   * Connect-time class: tunnel peer IP classification tightened by the last
   * persisted probe verdict. While egress probes are enabled the effective
   * ipClass stays "unknown" until a probe on this connection confirms it.
   */
  peerClass?: NodeIpClass;
}

/** /24 for IPv4, /48 for IPv6 (matches nodes.ip_prefix24). */
export function ipPrefix(ip: string): string {
  let a = ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  if (isIP(a) === 4) {
    const p = a.split(".");
    return `${p[0]}.${p[1]}.${p[2]}.0/24`;
  }
  if (isIP(a) === 6) {
    const full = expandIPv6(a);
    if (full) {
      a = full.split(":").slice(0, 3).map((h) => h.replace(/^0+(?=.)/, "")).join(":");
      return `${a}::/48`;
    }
  }
  return ip;
}

export function dayOf(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

export class NodeRegistry {
  private nodes = new Map<string, LiveNode>();
  private counters = new Map<string, NodeCounters>();
  private lastDrainAt: number | null = null;
  private repBytesCarry = new Map<string, number>();
  /** nodeId -> requester keys that paid today (bounded per node). */
  private requestersToday = new Map<string, Set<string>>();
  /** `${day}|${nodeId}|${requester}` -> reports filed (bounded, swept daily). */
  private reports = new Map<string, number>();
  private countersDay = -1;
  private byCountry = new Map<string, Set<string>>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly cap = MAX_LIVE_NODES, private readonly now: () => number = Date.now) {}

  get size(): number {
    return this.nodes.size;
  }

  get(nodeId: string): LiveNode | undefined {
    return this.nodes.get(nodeId);
  }

  all(): IterableIterator<LiveNode> {
    return this.nodes.values();
  }

  /** Nodes in a country (upper-case ISO code). */
  inCountry(country: string): LiveNode[] {
    const ids = this.byCountry.get(country.toUpperCase());
    if (!ids) return [];
    const out: LiveNode[] = [];
    for (const id of ids) {
      const n = this.nodes.get(id);
      if (n) out.push(n);
    }
    return out;
  }

  /**
   * Add or replace a node. Returns the replaced entry (caller closes its tunnel),
   * or throws when the registry is full.
   */
  add(node: LiveNode): LiveNode | null {
    const prev = this.nodes.get(node.nodeId) ?? null;
    if (!prev && this.nodes.size >= this.cap) throw new Error("registry full");
    if (prev) this.unindex(prev);
    this.nodes.set(node.nodeId, node);
    if (node.country) {
      const cc = node.country.toUpperCase();
      let set = this.byCountry.get(cc);
      if (!set) this.byCountry.set(cc, (set = new Set()));
      set.add(node.nodeId);
    }
    return prev;
  }

  /** Remove a node; when `tunnel` is given, only if it is still the registered one. */
  remove(nodeId: string, tunnel?: NodeTunnelHandle): boolean {
    const n = this.nodes.get(nodeId);
    if (!n || (tunnel && n.tunnel !== tunnel)) return false;
    this.unindex(n);
    this.nodes.delete(nodeId);
    this.repBytesCarry.delete(nodeId);
    this.requestersToday.delete(nodeId);
    // Unflushed counters stay until drainCounters() so nothing is lost on disconnect.
    return true;
  }

  private unindex(n: LiveNode): void {
    if (!n.country) return;
    const cc = n.country.toUpperCase();
    const set = this.byCountry.get(cc);
    set?.delete(n.nodeId);
    if (set && set.size === 0) this.byCountry.delete(cc);
  }

  /** Sybil-cap counts for a peer, excluding `exceptNodeId`. */
  countPeers(ip: string, prefix24: string, asn: number | null, exceptNodeId?: string): { per32: number; per24: number; perAsn: number } {
    let per32 = 0, per24 = 0, perAsn = 0;
    for (const n of this.nodes.values()) {
      if (n.nodeId === exceptNodeId) continue;
      if (n.ip === ip) per32++;
      if (n.prefix24 === prefix24) per24++;
      // asn === null counts other unknown-ASN peers (one shared bucket).
      if (n.asn === asn) perAsn++;
    }
    return { per32, per24, perAsn };
  }

  setBurnCooldown(nodeId: string, etld1: string, untilMs: number): void {
    const n = this.nodes.get(nodeId);
    if (!n) return;
    if (!n.cooldowns.has(etld1) && n.cooldowns.size >= MAX_COOLDOWNS_PER_NODE) {
      const oldest = n.cooldowns.keys().next().value;
      if (oldest !== undefined) n.cooldowns.delete(oldest);
    }
    n.cooldowns.set(etld1.toLowerCase(), untilMs);
  }

  private countersFor(nodeId: string): NodeCounters | null {
    if (!this.nodes.has(nodeId)) return null;
    let c = this.counters.get(nodeId);
    if (!c) this.counters.set(nodeId, (c = emptyCounters()));
    return c;
  }

  private etldCounter(c: NodeCounters, etld1: string): { ok: number; burn: number } | null {
    const k = etld1.toLowerCase().slice(0, 253);
    if (!k) return null;
    let e = c.etld.get(k);
    if (!e) {
      if (c.etld.size >= MAX_ETLD_COUNTERS_PER_NODE) return null;
      c.etld.set(k, (e = { ok: 0, burn: 0 }));
    }
    return e;
  }

  private adjustReputation(nodeId: string, delta: number): number | null {
    const n = this.nodes.get(nodeId);
    if (!n) return null;
    n.reputation = clampRep(n.reputation + delta);
    return n.reputation;
  }

  private rollDay(): void {
    const today = dayOf(this.now());
    if (today === this.countersDay) return;
    this.countersDay = today;
    this.requestersToday.clear();
    this.reports.clear();
  }

  /**
   * Gateway-measured paid bytes settled for `requesterKey` on this node. Raises
   * reputation per REP_BYTES_PER_POINT, plus a bonus for each distinct requester today.
   */
  recordPaidBytes(nodeId: string, requesterKey: string, bytes: number, etld1?: string): void {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) return;
    const c = this.countersFor(nodeId);
    if (!c) return;
    this.rollDay();
    c.bytes += bytes;
    c.streams += 1;
    if (etld1) {
      const e = this.etldCounter(c, etld1);
      if (e) e.ok++;
    }
    const carry = (this.repBytesCarry.get(nodeId) ?? 0) + bytes;
    const points = Math.floor(carry / REP_BYTES_PER_POINT);
    this.repBytesCarry.set(nodeId, carry % REP_BYTES_PER_POINT);
    let bonus = 0;
    let set = this.requestersToday.get(nodeId);
    if (!set) this.requestersToday.set(nodeId, (set = new Set()));
    if (bytes >= REP_BONUS_MIN_BYTES && !set.has(requesterKey) && set.size < MAX_REQUESTERS_PER_NODE_DAY) {
      set.add(requesterKey);
      bonus = REP_DISTINCT_REQUESTER_BONUS;
    }
    if (points + bonus > 0) this.adjustReputation(nodeId, points + bonus);
  }

  /** Probe/dial failure attributable to the node. */
  recordFailure(nodeId: string): void {
    const c = this.countersFor(nodeId);
    if (!c) return;
    c.failures++;
    this.adjustReputation(nodeId, -REP_FAILURE_PENALTY);
  }

  /** A byte dispute (node CLOSE report mismatch over threshold). */
  recordDispute(nodeId: string): void {
    const c = this.countersFor(nodeId);
    if (!c) return;
    c.disputes++;
    this.adjustReputation(nodeId, -REP_DISPUTE_PENALTY);
  }

  /**
   * Burn signal for (node, eTLD+1): 403/429/captcha seen by the gateway, or an
   * accepted requester report. `weight` in [0,1] scales the penalty (reports are
   * weighted by requester 30-day spend). Sets the per-target burn cooldown.
   */
  recordBurn(nodeId: string, etld1: string, weight = 1, cooldownMs = BURN_COOLDOWN_MS): void {
    const c = this.countersFor(nodeId);
    if (!c) return;
    const w = Number.isFinite(weight) ? Math.max(0, Math.min(1, weight)) : 0;
    c.burns++;
    const e = this.etldCounter(c, etld1);
    if (e) e.burn++;
    this.adjustReputation(nodeId, -REP_BURN_PENALTY * w);
    if (Number.isFinite(cooldownMs) && cooldownMs > 0) this.setBurnCooldown(nodeId, etld1, this.now() + Math.min(cooldownMs, 7 * DAY_MS));
  }

  /**
   * Requester burn report (POST /v1/sessions/:id/report lives in dashboard).
   * Capped at MAX_REPORTS_PER_REQUESTER_NODE_DAY per requester per node per day.
   * Returns false when the cap (or the bounded key space) rejects it.
   */
  recordReport(nodeId: string, requesterKey: string, etld1: string, weight: number): boolean {
    if (!this.nodes.has(nodeId)) return false;
    this.rollDay();
    const key = `${this.countersDay}|${nodeId}|${requesterKey}`;
    const used = this.reports.get(key) ?? 0;
    if (used >= MAX_REPORTS_PER_REQUESTER_NODE_DAY) return false;
    if (used === 0 && this.reports.size >= MAX_REPORT_KEYS) return false;
    this.reports.set(key, used + 1);
    this.recordBurn(nodeId, etld1, weight);
    return true;
  }

  /**
   * True once the base reputation (gateway-observed failures/disputes/burns) has fallen
   * below the quarantine threshold. The burn-report penalty is excluded: reports alone
   * only raise an admin review flag (see needsReportReview).
   */
  shouldQuarantine(nodeId: string): boolean {
    const n = this.nodes.get(nodeId);
    return !!n && clampRep(n.reputation) < QUARANTINE_BELOW;
  }

  /** The report penalty alone drops the node below the threshold: admin review, not quarantine. */
  needsReportReview(nodeId: string): boolean {
    const n = this.nodes.get(nodeId);
    return !!n && !this.shouldQuarantine(nodeId) && effectiveReputation(n) < QUARANTINE_BELOW;
  }

  /** Apply DB burn-report penalties to live nodes (ids absent from the map reset to 0). */
  setReportPenalties(nodeIds: string[], penalties: Map<string, number>): void {
    for (const id of nodeIds) {
      const n = this.nodes.get(id);
      if (!n) continue;
      const p = penalties.get(id) ?? 0;
      n.reportPenalty = Number.isFinite(p) ? Math.max(0, Math.min(REPUTATION_MAX, Math.round(p))) : 0;
    }
  }

  /** Take and reset all unflushed counters (for the 60 s flush to node_daily_stats/node_reputation). */
  drainCounters(): CounterFlush[] {
    const out: CounterFlush[] = [];
    const now = this.now();
    const day = dayOf(now);
    // Uptime is measured here from tunnel liveness (ECONOMICS.md rule 3),
    // never from node reports: every open tunnel accrues the time since the
    // previous drain (or since it connected, if later).
    if (this.lastDrainAt !== null) {
      const elapsed = Math.max(0, now - this.lastDrainAt);
      for (const n of this.nodes.values()) {
        if (!n.tunnel.isOpen) continue;
        const ms = Math.min(elapsed, Math.max(0, now - n.connectedAt));
        const secs = Math.floor(ms / 1000);
        if (secs <= 0) continue;
        const c = this.countersFor(n.nodeId);
        if (c) c.onlineSeconds = (c.onlineSeconds ?? 0) + secs;
      }
    }
    this.lastDrainAt = now;
    for (const [nodeId, c] of this.counters) {
      const n = this.nodes.get(nodeId);
      // reputation stays the base value (persisted). Quarantine uses the base value only;
      // a drop caused by the report penalty becomes an admin review flag.
      const quarantine = !!n && clampRep(n.reputation) < QUARANTINE_BELOW;
      const reviewFlag = !!n && !quarantine && effectiveReputation(n) < QUARANTINE_BELOW;
      out.push({ nodeId, day, reputation: n?.reputation ?? 0, quarantine, reviewFlag, reportPenalty: n?.reportPenalty ?? 0, counters: c });
    }
    this.counters = new Map();
    return out;
  }

  /** Drop dead tunnels, expire cooldowns, roll daily counters. */
  sweep(): number {
    const now = this.now();
    const today = dayOf(now);
    this.rollDay();
    let removed = 0;
    // Without a flush job, never let counters of departed nodes accumulate unbounded.
    if (this.counters.size > this.cap) {
      for (const id of [...this.counters.keys()]) if (!this.nodes.has(id)) this.counters.delete(id);
    }
    for (const n of [...this.nodes.values()]) {
      if (!n.tunnel.isOpen) {
        this.remove(n.nodeId, n.tunnel);
        removed++;
        continue;
      }
      for (const [k, until] of n.cooldowns) if (until <= now) n.cooldowns.delete(k);
      if (n.cooldownUntil && n.cooldownUntil <= now) n.cooldownUntil = 0;
      if (n.day !== today) {
        n.day = today;
        n.bytesToday = 0;
        n.earningsTodayMusd = 0;
      }
      n.recentOpens = n.recentOpens.filter((t) => now - t < 1000);
    }
    return removed;
  }

  startSweep(intervalMs = SWEEP_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), intervalMs);
    this.timer.unref?.();
  }

  stopSweep(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
