/**
 * Tunnel ingress (DESIGN.md §2.1): real peer address + pre-auth DoS limits.
 *
 * Peer IP: taken from the raw TCP socket, or from a PROXY protocol v2 header
 * ONLY when the TCP peer is in TUNNEL_TRUSTED_PROXY_IPS (header then mandatory).
 * X-Forwarded-For is never consulted.
 */
import * as fs from "node:fs";
import { isIP, type Socket } from "node:net";

export const PROXY_V2_SIG = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);
const PROXY_HEADER_TIMEOUT_MS = 5_000;
const MAX_TRUSTED_PROXIES = 64;

export function normalizePeerIp(ip: string | undefined | null): string {
  if (!ip) return "";
  let s = ip;
  const z = s.indexOf("%");
  if (z !== -1) s = s.slice(0, z);
  return s.startsWith("::ffff:") && isIP(s.slice(7)) === 4 ? s.slice(7) : s;
}

/** Parse + validate TUNNEL_TRUSTED_PROXY_IPS (comma-separated IP literals). Throws on bad input. */
export function parseTrustedProxyIps(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  if (raw === undefined || raw.trim() === "") return out;
  for (const part of raw.split(",")) {
    const ip = normalizePeerIp(part.trim());
    if (isIP(ip) === 0) throw new Error("TUNNEL_TRUSTED_PROXY_IPS must be a comma-separated list of IP addresses");
    out.add(ip);
  }
  if (out.size > MAX_TRUSTED_PROXIES) throw new Error("TUNNEL_TRUSTED_PROXY_IPS: too many entries");
  return out;
}

/** Load TUNNEL_TLS_CERT_FILE / TUNNEL_TLS_KEY_FILE; both or neither. */
export function loadTunnelTls(env: NodeJS.ProcessEnv): { cert: Buffer; key: Buffer } | null {
  const c = env["TUNNEL_TLS_CERT_FILE"];
  const k = env["TUNNEL_TLS_KEY_FILE"];
  if (!c && !k) return null;
  if (!c || !k) throw new Error("TUNNEL_TLS_CERT_FILE and TUNNEL_TLS_KEY_FILE must be set together");
  return { cert: fs.readFileSync(c), key: fs.readFileSync(k) };
}

export type ProxyV2Result =
  | { kind: "incomplete" }
  | { kind: "invalid" }
  | { kind: "local"; length: number }
  | { kind: "proxy"; length: number; srcIp: string };

/** Parse a PROXY protocol v2 header at the start of buf. */
export function parseProxyV2(buf: Buffer): ProxyV2Result {
  const sigLen = Math.min(buf.length, PROXY_V2_SIG.length);
  if (!buf.subarray(0, sigLen).equals(PROXY_V2_SIG.subarray(0, sigLen))) return { kind: "invalid" };
  if (buf.length < 16) return { kind: "incomplete" };
  const verCmd = buf[12];
  if (verCmd >> 4 !== 2) return { kind: "invalid" };
  const cmd = verCmd & 0x0f;
  const fam = buf[13];
  const len = buf.readUInt16BE(14);
  if (len > 1024) return { kind: "invalid" };
  const total = 16 + len;
  if (buf.length < total) return { kind: "incomplete" };
  if (cmd === 0x0) return { kind: "local", length: total };
  if (cmd !== 0x1) return { kind: "invalid" };
  if (fam === 0x11) {
    if (len < 12) return { kind: "invalid" };
    const a = buf.subarray(16, 20);
    return { kind: "proxy", length: total, srcIp: `${a[0]}.${a[1]}.${a[2]}.${a[3]}` };
  }
  if (fam === 0x21) {
    if (len < 36) return { kind: "invalid" };
    const g: string[] = [];
    for (let i = 0; i < 8; i++) g.push(buf.readUInt16BE(16 + i * 2).toString(16));
    return { kind: "proxy", length: total, srcIp: normalizePeerIp(g.join(":")) };
  }
  return { kind: "invalid" };
}

/**
 * Consume a PROXY v2 header from a trusted-proxy socket. Resolves the client IP
 * (or the socket's own address for LOCAL health checks); rejects on any malformation.
 * Bytes after the header are unshifted back onto the socket.
 */
export function readProxyV2(socket: Socket, timeoutMs = PROXY_HEADER_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const done = (err: Error | null, ip?: string): void => {
      clearTimeout(t);
      socket.off("data", onData);
      socket.off("end", onEnd);
      if (err) reject(err);
      else resolve(ip!);
    };
    const onEnd = (): void => done(new Error("PROXY header: connection closed"));
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const r = parseProxyV2(buf);
      if (r.kind === "incomplete") {
        if (buf.length > 16 + 1024) done(new Error("PROXY header too large"));
        return;
      }
      if (r.kind === "invalid") return done(new Error("invalid PROXY v2 header"));
      socket.pause();
      const rest = buf.subarray(r.length);
      if (rest.length > 0) socket.unshift(rest);
      if (r.kind === "local") return done(null, normalizePeerIp(socket.remoteAddress));
      done(null, r.srcIp);
    };
    const t = setTimeout(() => done(new Error("PROXY header timeout")), timeoutMs);
    t.unref?.();
    socket.on("data", onData);
    socket.once("end", onEnd);
  });
}

export interface PreAuthLimiterOptions {
  /** Token-bucket burst per source IP. */
  burst?: number;
  /** Tokens per second per source IP. */
  refillPerSec?: number;
  /** Max upgrade lookups in flight across all sources. */
  maxConcurrent?: number;
  /** Negative lookup cache TTL. */
  negativeTtlMs?: number;
  maxTrackedIps?: number;
  maxNegative?: number;
  now?: () => number;
}

/** Per-IP token bucket + global in-flight cap + negative key cache. All maps capped and swept. */
export class PreAuthLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private negative = new Map<string, number>();
  private inflight = 0;
  private sweepTimer: NodeJS.Timeout | null = null;
  readonly burst: number;
  readonly refillPerSec: number;
  readonly maxConcurrent: number;
  readonly negativeTtlMs: number;
  private readonly maxTrackedIps: number;
  private readonly maxNegative: number;
  private readonly now: () => number;

  constructor(o: PreAuthLimiterOptions = {}) {
    this.burst = o.burst ?? 10;
    this.refillPerSec = o.refillPerSec ?? 0.5;
    this.maxConcurrent = o.maxConcurrent ?? 128;
    this.negativeTtlMs = o.negativeTtlMs ?? 15_000;
    this.maxTrackedIps = o.maxTrackedIps ?? 50_000;
    this.maxNegative = o.maxNegative ?? 50_000;
    this.now = o.now ?? Date.now;
  }

  /** Consume one token for ip; false = rate limited. */
  allowIp(ip: string): boolean {
    const now = this.now();
    let b = this.buckets.get(ip);
    if (!b) {
      if (this.buckets.size >= this.maxTrackedIps) this.sweep();
      if (this.buckets.size >= this.maxTrackedIps) return false; // fail closed under flood
      b = { tokens: this.burst, at: now };
      this.buckets.set(ip, b);
    }
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.refillPerSec);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  tryAcquire(): boolean {
    if (this.inflight >= this.maxConcurrent) return false;
    this.inflight++;
    return true;
  }

  release(): void {
    if (this.inflight > 0) this.inflight--;
  }

  get inFlight(): number {
    return this.inflight;
  }

  isNegative(keyHash: string): boolean {
    const exp = this.negative.get(keyHash);
    if (exp === undefined) return false;
    if (exp <= this.now()) {
      this.negative.delete(keyHash);
      return false;
    }
    return true;
  }

  addNegative(keyHash: string): void {
    if (this.negative.size >= this.maxNegative) this.sweep();
    if (this.negative.size >= this.maxNegative) {
      const oldest = this.negative.keys().next().value;
      if (oldest !== undefined) this.negative.delete(oldest);
    }
    this.negative.set(keyHash, this.now() + this.negativeTtlMs);
  }

  sweep(): void {
    const now = this.now();
    for (const [ip, b] of this.buckets) {
      if (Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.refillPerSec) >= this.burst) this.buckets.delete(ip);
    }
    for (const [k, exp] of this.negative) if (exp <= now) this.negative.delete(k);
  }

  get trackedIps(): number {
    return this.buckets.size;
  }

  start(intervalMs = 60_000): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), intervalMs);
    this.sweepTimer.unref?.();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }
}
