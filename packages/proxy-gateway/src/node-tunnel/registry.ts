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
  maxStreams: number;
  maxGbDay: number;
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

  /** Drop dead tunnels, expire cooldowns, roll daily counters. */
  sweep(): number {
    const now = this.now();
    const today = dayOf(now);
    let removed = 0;
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
