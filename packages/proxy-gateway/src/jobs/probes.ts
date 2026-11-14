import * as crypto from "node:crypto";
import * as net from "node:net";
import * as tls from "node:tls";
import type { Duplex } from "node:stream";
import { Job, type JobLogger } from "./runner.js";

/**
 * Canary probes (DESIGN.md §13 commit 26, minimal). The gateway opens a
 * stream through a node to the coordinator's GET /v1/probe/echo and checks
 * that the response echoes our random nonce and the node's egress IP. A node
 * that alters the response (wrong nonce, wrong same-family IP, malformed
 * reply) is quarantined. Dial errors and timeouts are not tamper evidence, and
 * a response is only judged when it is provably complete (Content-Length met
 * or chunked body terminated); truncated replies are inconclusive. Quarantine
 * needs TAMPER_STRIKES_REQUIRED tamper verdicts from separate runs.
 * Runs per gateway instance: each instance probes the nodes connected to it.
 */

export const MAX_PROBE_RESPONSE_BYTES = 16 * 1024;

export interface ProbeTarget {
  host: string;
  port: number;
  path: string;
  tls: boolean;
}

/** Parse PROBE_URL; only http(s) with a hostname, no credentials, query or fragment. */
export function parseProbeUrl(raw: string | undefined): ProbeTarget | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("PROBE_URL is not a valid URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("PROBE_URL must be http(s)");
  if (u.username || u.password || u.search || u.hash) throw new Error("PROBE_URL must not carry credentials, query or fragment");
  const isTls = u.protocol === "https:";
  return { host: u.hostname, port: u.port ? Number(u.port) : isTls ? 443 : 80, path: u.pathname || "/", tls: isTls };
}

export type ProbeOutcome =
  | { kind: "ok"; egressIp?: string }
  | { kind: "tamper"; reason: string }
  | { kind: "inconclusive"; reason: string; egressIp?: string };

function family(ip: string): 4 | 6 | 0 {
  return net.isIPv4(ip) ? 4 : net.isIPv6(ip) ? 6 : 0;
}

function normIp(ip: string): string {
  const v = ip.trim().toLowerCase();
  return v.startsWith("::ffff:") && v.includes(".") ? v.slice(7) : v;
}

/**
 * Extract the body only if the response is provably complete: Content-Length
 * satisfied, or a chunked body ending in the zero-size chunk. Otherwise null.
 */
export function completeBody(head: string, rest: Buffer): string | null {
  const headers = head.split("\r\n").slice(1);
  let cl: number | null = null;
  let chunked = false;
  for (const h of headers) {
    const i = h.indexOf(":");
    if (i < 0) continue;
    const name = h.slice(0, i).trim().toLowerCase();
    const val = h.slice(i + 1).trim();
    if (name === "content-length") {
      if (!/^\d{1,9}$/.test(val)) return null;
      const n = Number(val);
      if (cl !== null && cl !== n) return null;
      cl = n;
    } else if (name === "transfer-encoding" && /(^|,)\s*chunked\s*$/i.test(val)) {
      chunked = true;
    }
  }
  if (chunked) {
    const parts: Buffer[] = [];
    let off = 0;
    for (;;) {
      const eol = rest.indexOf("\r\n", off);
      if (eol < 0) return null;
      const sizeStr = rest.subarray(off, eol).toString("latin1").split(";")[0]!.trim();
      if (!/^[0-9a-fA-F]{1,8}$/.test(sizeStr)) return null;
      const size = parseInt(sizeStr, 16);
      off = eol + 2;
      if (size === 0) return Buffer.concat(parts).toString("utf8");
      if (rest.length < off + size + 2) return null;
      parts.push(rest.subarray(off, off + size));
      off += size + 2;
    }
  }
  if (cl === null || rest.length < cl) return null;
  return rest.subarray(0, cl).toString("utf8");
}

/** Judge a raw HTTP response against the nonce and the node's IP (pure). */
export function judgeProbeResponse(raw: string | Buffer, nonce: string, nodeIp: string): ProbeOutcome {
  const buf = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
  const sepB = buf.indexOf("\r\n\r\n");
  // Headers never fully arrived: truncation (stream cut, node restart) is not proof of tampering.
  if (sepB < 0) return { kind: "inconclusive", reason: "incomplete response" };
  const head = buf.subarray(0, sepB).toString("latin1");
  const statusLine = head.split("\r\n")[0]!;
  if (!/^HTTP\/1\.[01] 200 /.test(statusLine)) {
    // A 429 or 5xx from our own API is not node misbehaviour.
    if (/^HTTP\/1\.[01] (429|5\d\d) /.test(statusLine)) return { kind: "inconclusive", reason: "probe endpoint unavailable" };
    return { kind: "tamper", reason: "unexpected status" };
  }
  const text = completeBody(head, buf.subarray(sepB + 4));
  if (text === null) return { kind: "inconclusive", reason: "incomplete body" };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { kind: "tamper", reason: "malformed body" };
  }
  if (!body || typeof body !== "object") return { kind: "tamper", reason: "malformed body" };
  const { ip, nonce: echoed } = body as { ip?: unknown; nonce?: unknown };
  if (echoed !== nonce) return { kind: "tamper", reason: "nonce mismatch" };
  if (typeof ip !== "string") return { kind: "tamper", reason: "missing ip" };
  const a = normIp(ip);
  const b = normIp(nodeIp);
  if (a === b) return { kind: "ok", egressIp: a };
  // Dual-stack nodes may egress on another family than their tunnel: not proof of
  // tampering, but the echoed egress IP is still classified (egress verification).
  if (family(a) !== family(b)) {
    return family(a) === 0 ? { kind: "tamper", reason: "invalid egress ip" } : { kind: "inconclusive", reason: "egress family differs", egressIp: a };
  }
  return { kind: "tamper", reason: "egress ip mismatch" };
}

/**
 * Parse PROBE_URL as a comma-separated list of echo URLs (up to 32). Several
 * unpublished hostnames (CDN fronts, random subdomains on a separate domain)
 * make probes harder to tell apart from customer traffic; one is picked at
 * random per probe.
 */
export function parseProbeUrls(raw: string | undefined): ProbeTarget[] {
  if (!raw || !raw.trim()) return [];
  const parts = raw.split(",").map((x) => x.trim()).filter(Boolean);
  if (parts.length > 32) throw new Error("PROBE_URL lists more than 32 URLs");
  return parts.map((x) => parseProbeUrl(x)!);
}

/** HTTP/1.1 GET over an already-open stream; resolves with up to 16 KB of the raw response. */
export function exchange(stream: Duplex, target: ProbeTarget, nonce: string, timeoutMs: number): Promise<string | Buffer> {
  return new Promise((resolve, reject) => {
    let io: Duplex = stream;
    if (target.tls) io = tls.connect({ socket: stream as net.Socket, servername: target.host, rejectUnauthorized: true });
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (err: Error | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      io.destroy();
      if (io !== stream) stream.destroy();
      if (err) reject(err);
      else resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(() => finish(new Error("probe timeout")), timeoutMs);
    io.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_PROBE_RESPONSE_BYTES) return finish(new Error("probe response too large"));
      chunks.push(c);
    });
    io.on("end", () => finish(null));
    io.on("close", () => finish(null));
    io.on("error", (e: Error) => finish(e));
    const hostHeader = target.port === (target.tls ? 443 : 80) ? target.host : `${target.host}:${target.port}`;
    io.write(`GET ${target.path}?nonce=${nonce} HTTP/1.1\r\nHost: ${hostHeader}\r\nAccept: application/json\r\n${probeAuthHeader(nonce)}Connection: close\r\n\r\n`);
  });
}

export interface ProbeNode {
  nodeId: string;
  ip: string;
  /** Egress not yet verified by a probe on this gateway: sampled first. */
  unverified?: boolean;
  /**
   * True while the node is connected and still waits for its first classifying
   * probe (not selectable). Pending nodes are retried with backoff and probed
   * in full by the periodic job, never left to the random sample.
   */
  isPending?(): boolean;
  openStream(host: string, port: number): Promise<Duplex>;
}

export interface ProbeDeps {
  /** Single echo target (legacy); `targets` takes precedence when non-empty. */
  target?: ProbeTarget;
  /** Echo targets; one is chosen at random per probe. */
  targets?: ProbeTarget[];
  listNodes(): ProbeNode[];
  quarantine(nodeId: string, reason: string): Promise<unknown>;
  sampleSize?: number;
  timeoutMs?: number;
  nonce?: () => string;
  exchange?: typeof exchange;
  logger?: JobLogger;
  /**
   * Egress verification: called with the coordinator-echoed egress IP (seen by
   * our own API, never node-reported) for ok and other-family verdicts.
   */
  onEgress?(nodeId: string, egressIp: string): Promise<unknown> | void;
  /** Tamper strike memory across runs (defaults to a module-level instance). */
  strikes?: TamperStrikes;
  /**
   * Gateway-side health of the echo targets (ProbeHealth.healthy). While false
   * no probe runs: a broken echo host (bad TLS, 404, API down) is our fault and
   * must never yield tamper verdicts or keep nodes pending.
   */
  isHealthy?(): boolean;
  /** Concurrent probes of pending nodes in a periodic run (default 8). */
  pendingConcurrency?: number;
}

export const TAMPER_STRIKES_REQUIRED = 2;
const MAX_STRIKE_NODES = 10_000;

/** Per-node tamper verdicts from distinct runs. An ok verdict clears a node. Size-capped. */
export class TamperStrikes {
  private m = new Map<string, { count: number; lastRun: number }>();
  /** Record a tamper verdict in run `runId`; returns the strike count (one per run). */
  hit(nodeId: string, runId: number): number {
    let e = this.m.get(nodeId);
    if (!e) {
      if (this.m.size >= MAX_STRIKE_NODES) {
        const oldest = this.m.keys().next().value;
        if (oldest !== undefined) this.m.delete(oldest);
      }
      e = { count: 0, lastRun: -1 };
      this.m.set(nodeId, e);
    }
    if (e.lastRun !== runId) {
      e.count++;
      e.lastRun = runId;
    }
    return e.count;
  }
  clear(nodeId: string): void {
    this.m.delete(nodeId);
  }
  /** Forget nodes no longer connected. */
  retain(live: ReadonlySet<string>): void {
    for (const k of this.m.keys()) if (!live.has(k)) this.m.delete(k);
  }
  get size(): number {
    return this.m.size;
  }
}
const defaultStrikes = new TamperStrikes();
let runCounter = 0;

export interface ProbeRunResult {
  probed: number;
  ok: number;
  tampered: number;
  inconclusive: number;
  errors: number;
}

function sample<T>(items: T[], n: number): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, n);
}

function pickTarget(deps: ProbeDeps): ProbeTarget {
  const list = deps.targets && deps.targets.length > 0 ? deps.targets : deps.target ? [deps.target] : [];
  if (list.length === 0) throw new Error("no probe target configured");
  return list[list.length === 1 ? 0 : crypto.randomInt(list.length)]!;
}

type ProbeVerdict = "ok" | "tamper" | "inconclusive" | "error";

/** Probe one node once (shared by the periodic job and the connect queue). */
export async function probeOne(deps: ProbeDeps, node: ProbeNode, runId: number, strikes: TamperStrikes = deps.strikes ?? defaultStrikes): Promise<ProbeVerdict> {
  const ex = deps.exchange ?? exchange;
  const mkNonce = deps.nonce ?? (() => crypto.randomBytes(18).toString("base64url"));
  const nonce = mkNonce();
  let raw: string | Buffer;
  try {
    const target = pickTarget(deps);
    const stream = await node.openStream(target.host, target.port);
    raw = await ex(stream, target, nonce, deps.timeoutMs ?? 10_000);
  } catch {
    return "error";
  }
  const verdict = judgeProbeResponse(raw, nonce, node.ip);
  if (verdict.kind !== "tamper" && verdict.egressIp && deps.onEgress) {
    try {
      await deps.onEgress(node.nodeId, verdict.egressIp);
    } catch {
      /* retried on a later probe */
    }
  }
  if (verdict.kind === "ok") {
    strikes.clear(node.nodeId);
    return "ok";
  }
  if (verdict.kind === "inconclusive") return "inconclusive";
  const n = strikes.hit(node.nodeId, runId);
  if (n < TAMPER_STRIKES_REQUIRED) {
    deps.logger?.warn("canary probe tamper verdict, awaiting confirmation", { nodeId: node.nodeId, reason: verdict.reason, strikes: n });
    return "tamper";
  }
  deps.logger?.warn("canary probe detected tampering, quarantining node", { nodeId: node.nodeId, reason: verdict.reason });
  try {
    await deps.quarantine(node.nodeId, verdict.reason);
  } catch {
    /* retried on the next probe */
  }
  return "tamper";
}

export async function runOnce(deps: ProbeDeps): Promise<ProbeRunResult> {
  const out: ProbeRunResult = { probed: 0, ok: 0, tampered: 0, inconclusive: 0, errors: 0 };
  const strikes = deps.strikes ?? defaultStrikes;
  const runId = ++runCounter;
  const nodes = deps.listNodes();
  strikes.retain(new Set(nodes.map((n) => n.nodeId)));
  if (deps.isHealthy && !deps.isHealthy()) return out;
  const count = (v: ProbeVerdict) => {
    out.probed++;
    if (v === "ok") out.ok++;
    else if (v === "inconclusive") out.inconclusive++;
    else if (v === "tamper") out.tampered++;
    else out.errors++;
  };
  // Pending nodes (serving nothing until classified) are all probed, with their
  // own concurrency cap, so recovery never waits on the random sample.
  const pending = nodes.filter((x) => x.isPending?.() === true);
  const conc = Math.max(1, deps.pendingConcurrency ?? 8);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(conc, pending.length) }, async () => {
    while (next < pending.length) {
      const node = pending[next++]!;
      count(await probeOne(deps, node, runId, strikes).catch((): ProbeVerdict => "error"));
    }
  }));
  // Bounded load for the rest: at most sampleSize probes; other unverified
  // nodes first, then a random sample.
  const others = nodes.filter((x) => x.isPending?.() !== true);
  const n = deps.sampleSize ?? 20;
  const fresh = sample(others.filter((x) => x.unverified), n);
  const rest = sample(others.filter((x) => !x.unverified), Math.max(0, n - fresh.length));
  for (const node of [...fresh, ...rest]) count(await probeOne(deps, node, runId, strikes));
  return out;
}

export interface ConnectProbeQueueOptions {
  /** Concurrent connect probes (default 4). */
  concurrency?: number;
  /** Max queued nodes; extras wait for the periodic job (default 1000). */
  maxQueued?: number;
  /** Min ms between connect probes of the same node (default 60 s). */
  minIntervalMs?: number;
  /** Delay before probing a fresh connect, ms (default 2 s). */
  delayMs?: number;
  /**
   * Uniform random extra delay 0..jitterMs before a connect probe (default
   * 30 s), so a node cannot predict which early stream is the probe.
   */
  jitterMs?: number;
  /**
   * Backoff before re-probing a node that is still pending after a probe that
   * did not classify it (error, inconclusive without an egress IP, skipped
   * while unhealthy). The last value repeats. Default 30 s, 1 m, 2 m, 5 m.
   */
  retryDelaysMs?: number[];
  now?: () => number;
}

/**
 * Per-connect egress verification. Every ready tunnel is queued for one probe
 * with its own concurrency cap and timeout, independent of the sampled
 * periodic job. A node is "unknown" (no class-* selection, lowest tier
 * weight) until verified, so reconnecting never buys a better class; the
 * per-node minimum interval and the queue cap bound the load a reconnect
 * flood can cause (overflow falls back to the periodic job, which probes
 * unverified nodes first).
 */
export class ConnectProbeQueue {
  private queue: ProbeNode[] = [];
  private queued = new Set<string>();
  private lastProbe = new Map<string, number>();
  private active = 0;
  private stopped = false;
  private timers = new Set<NodeJS.Timeout>();
  private readonly concurrency: number;
  private readonly maxQueued: number;
  private readonly minIntervalMs: number;
  private readonly delayMs: number;
  private readonly jitterMs: number;
  private readonly retryDelaysMs: number[];
  /** Pending nodes waiting on a backoff timer because the queue was full. */
  private overflow = new Set<string>();
  private dropped = 0;
  private attempts = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly deps: ProbeDeps, o: ConnectProbeQueueOptions = {}) {
    this.concurrency = Math.max(1, o.concurrency ?? 4);
    this.maxQueued = Math.max(1, o.maxQueued ?? 1000);
    this.minIntervalMs = Math.max(0, o.minIntervalMs ?? 60_000);
    this.delayMs = Math.max(0, o.delayMs ?? 2_000);
    this.jitterMs = Math.max(0, o.jitterMs ?? 30_000);
    const rd = (o.retryDelaysMs ?? [30_000, 60_000, 120_000, 300_000]).map((x) => Math.max(0, x));
    this.retryDelaysMs = rd.length > 0 ? rd : [300_000];
    this.now = o.now ?? Date.now;
  }

  /** Queue a connect probe; false when deduplicated, rate-limited or full. */
  enqueue(node: ProbeNode): boolean {
    if (this.stopped || this.queued.has(node.nodeId)) return false;
    const last = this.lastProbe.get(node.nodeId);
    const t = this.now();
    // The min interval bounds reconnect floods of verified nodes; a pending
    // node serves nothing until probed, so it is never rate-limited here.
    if (last !== undefined && t - last < this.minIntervalMs && node.isPending?.() !== true) return false;
    if (this.queue.length >= this.maxQueued) {
      // A pending node serves nothing until probed: never drop it, back off
      // (bounded, jittered) until the queue drains. Verified nodes are dropped.
      if (node.isPending?.() === true && !this.overflow.has(node.nodeId)) {
        this.overflow.add(node.nodeId);
        this.scheduleRetry(node);
        return true;
      }
      this.dropped++;
      return false;
    }
    if (this.lastProbe.size >= 100_000) {
      for (const [k, v] of this.lastProbe) if (t - v >= this.minIntervalMs) this.lastProbe.delete(k);
      if (this.lastProbe.size >= 100_000) return false;
    }
    this.lastProbe.set(node.nodeId, t);
    this.queued.add(node.nodeId);
    this.queue.push(node);
    if (this.delayMs > 0 || this.jitterMs > 0) {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.pump();
      }, this.delayMs + (this.jitterMs > 0 ? crypto.randomInt(this.jitterMs + 1) : 0));
      timer.unref?.();
      this.timers.add(timer);
    } else this.pump();
    return true;
  }

  get pending(): number {
    return this.queue.length + this.active;
  }

  /** Backlog metric: queued, in flight, overflow (pending nodes backing off), dropped (verified, queue full). */
  stats(): { queued: number; active: number; overflow: number; dropped: number } {
    return { queued: this.queue.length, active: this.active, overflow: this.overflow.size, dropped: this.dropped };
  }

  /** Drain without the start delay (tests). */
  pump(): void {
    while (!this.stopped && this.active < this.concurrency && this.queue.length > 0) {
      // Fair order: pending nodes (serving nothing) before re-verification of
      // already classified ones, FIFO within each group.
      const pi = this.queue.findIndex((n) => n.isPending?.() === true);
      const node = this.queue.splice(pi >= 0 ? pi : 0, 1)[0]!;
      this.active++;
      const run = this.deps.isHealthy && !this.deps.isHealthy()
        ? Promise.resolve<ProbeVerdict>("error")
        : probeOne(this.deps, node, ++runCounter);
      void run
        .catch((): ProbeVerdict => "error")
        .finally(() => {
          this.active--;
          this.queued.delete(node.nodeId);
          this.scheduleRetry(node);
          this.pump();
        });
    }
  }

  /** Re-probe a node that is still pending, with bounded backoff. */
  private scheduleRetry(node: ProbeNode): void {
    if (this.stopped) return;
    if (node.isPending?.() !== true) {
      this.attempts.delete(node.nodeId);
      this.overflow.delete(node.nodeId);
      return;
    }
    const n = this.attempts.get(node.nodeId) ?? 0;
    if (!this.attempts.has(node.nodeId) && this.attempts.size >= 100_000) return; // periodic job still covers it
    this.attempts.set(node.nodeId, n + 1);
    const baseDelay = this.retryDelaysMs[Math.min(n, this.retryDelaysMs.length - 1)]!;
    // +/-25% jitter: retries of a reconnect wave spread out and are not predictable.
    const spread = Math.floor(baseDelay / 4);
    const delay = spread > 0 ? baseDelay - spread + crypto.randomInt(2 * spread + 1) : baseDelay;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.stopped) return;
      if (node.isPending?.() !== true) {
        this.attempts.delete(node.nodeId);
        this.overflow.delete(node.nodeId);
        return;
      }
      if (this.queued.has(node.nodeId)) return;
      if (this.queue.length >= this.maxQueued) return this.scheduleRetry(node);
      this.overflow.delete(node.nodeId);
      this.queued.add(node.nodeId);
      this.lastProbe.set(node.nodeId, this.now());
      this.queue.push(node);
      this.pump();
    }, delay);
    timer.unref?.();
    this.timers.add(timer);
  }

  stop(): void {
    this.stopped = true;
    this.attempts.clear();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.queue = [];
    this.queued.clear();
    this.overflow.clear();
  }
}

export function start(o: { deps: ProbeDeps; logger: JobLogger; intervalMs?: number; jitterMs?: number; initialDelayMs?: number }): Job {
  const job = new Job({ name: "probes", intervalMs: o.intervalMs ?? 900_000, jitterMs: o.jitterMs, lockKey: null, logger: o.logger, run: () => runOnce(o.deps), initialDelayMs: o.initialDelayMs ?? 30_000 });
  job.start();
  return job;
}

export async function stop(job: Job | null): Promise<void> {
  await job?.stop();
}

/**
 * X-DN-Probe-Auth header line (HMAC-SHA256 of the nonce with PROBE_AUTH_SECRET)
 * so the API gives gateway probes their own rate budget; empty when unset.
 * Sent inside the TLS session to the API, never readable by the exit node.
 */
export function probeAuthHeader(nonce: string, secret = process.env["PROBE_AUTH_SECRET"]): string {
  if (!secret || secret.length < 32) return "";
  return `X-DN-Probe-Auth: ${crypto.createHmac("sha256", secret).update(nonce).digest("hex")}\r\n`;
}

// ─── Gateway-side self-check of the echo targets ──────────────────────

export interface SelfCheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * Fetch an echo target directly from the gateway (no node) and require a 200
 * that echoes our nonce. Failure means the probe setup itself is broken (TLS
 * not publicly trusted, 404 from a host without the API, API down), so node
 * probes against it prove nothing about nodes.
 */
export async function selfCheckTarget(
  target: ProbeTarget,
  timeoutMs = 10_000,
  connect: (host: string, port: number) => Promise<Duplex> = dialDirect,
  ex: typeof exchange = exchange,
): Promise<SelfCheckResult> {
  const nonce = crypto.randomBytes(18).toString("base64url");
  let raw: string | Buffer;
  try {
    raw = await ex(await connect(target.host, target.port), target, nonce, timeoutMs);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message.slice(0, 200) : "error" };
  }
  const buf = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
  const sep = buf.indexOf("\r\n\r\n");
  if (sep < 0) return { ok: false, reason: "incomplete response" };
  const head = buf.subarray(0, sep).toString("latin1");
  const status = head.split("\r\n")[0]!;
  if (!/^HTTP\/1\.[01] 200 /.test(status)) return { ok: false, reason: `status ${status.slice(9, 12)}` };
  const text = completeBody(head, buf.subarray(sep + 4));
  try {
    const body = text === null ? null : (JSON.parse(text) as { nonce?: unknown } | null);
    if (!body || body.nonce !== nonce) return { ok: false, reason: "nonce not echoed" };
  } catch {
    return { ok: false, reason: "malformed body" };
  }
  return { ok: true };
}

function dialDirect(host: string, port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    s.once("connect", () => {
      s.removeListener("error", reject);
      resolve(s);
    });
    s.once("error", reject);
  });
}

/**
 * Tracks which echo targets pass the gateway self-check. `live` is the array
 * handed to ProbeDeps.targets (mutated in place), so failing targets are never
 * picked; `healthy` is false when none passes (probes then pause and nodes are
 * not held pending).
 */
export class ProbeHealth {
  readonly live: ProbeTarget[] = [];
  constructor(
    private readonly all: ProbeTarget[],
    private readonly check: (t: ProbeTarget) => Promise<SelfCheckResult> = (t) => selfCheckTarget(t),
  ) {}
  get healthy(): boolean {
    return this.live.length > 0;
  }
  /** Re-check every target; returns the failures. */
  async refresh(): Promise<{ target: string; reason: string }[]> {
    const res = await Promise.all(this.all.map(async (t) => ({ t, r: await this.check(t).catch((): SelfCheckResult => ({ ok: false, reason: "error" })) })));
    this.live.length = 0;
    const failed: { target: string; reason: string }[] = [];
    for (const { t, r } of res) {
      if (r.ok) this.live.push(t);
      else failed.push({ target: `${t.host}:${t.port}${t.path}`, reason: r.reason ?? "failed" });
    }
    return failed;
  }
}
