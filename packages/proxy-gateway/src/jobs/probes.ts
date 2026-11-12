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
    io.write(`GET ${target.path}?nonce=${nonce} HTTP/1.1\r\nHost: ${hostHeader}\r\nAccept: application/json\r\nConnection: close\r\n\r\n`);
  });
}

export interface ProbeNode {
  nodeId: string;
  ip: string;
  /** Egress not yet verified by a probe on this gateway: sampled first. */
  unverified?: boolean;
  openStream(host: string, port: number): Promise<Duplex>;
}

export interface ProbeDeps {
  target: ProbeTarget;
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

export async function runOnce(deps: ProbeDeps): Promise<ProbeRunResult> {
  const out: ProbeRunResult = { probed: 0, ok: 0, tampered: 0, inconclusive: 0, errors: 0 };
  const ex = deps.exchange ?? exchange;
  const mkNonce = deps.nonce ?? (() => crypto.randomBytes(18).toString("base64url"));
  const strikes = deps.strikes ?? defaultStrikes;
  const runId = ++runCounter;
  const nodes = deps.listNodes();
  strikes.retain(new Set(nodes.map((n) => n.nodeId)));
  // Bounded load: at most sampleSize probes per run; nodes whose egress has not
  // been verified yet (fresh connects) go first, the rest are a random sample.
  const n = deps.sampleSize ?? 20;
  const fresh = sample(nodes.filter((x) => x.unverified), n);
  const rest = sample(nodes.filter((x) => !x.unverified), Math.max(0, n - fresh.length));
  for (const node of [...fresh, ...rest]) {
    out.probed++;
    const nonce = mkNonce();
    let raw: string | Buffer;
    try {
      const stream = await node.openStream(deps.target.host, deps.target.port);
      raw = await ex(stream, deps.target, nonce, deps.timeoutMs ?? 10_000);
    } catch {
      out.errors++;
      continue;
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
      out.ok++;
      strikes.clear(node.nodeId);
    } else if (verdict.kind === "inconclusive") out.inconclusive++;
    else {
      out.tampered++;
      const n = strikes.hit(node.nodeId, runId);
      if (n < TAMPER_STRIKES_REQUIRED) {
        deps.logger?.warn("canary probe tamper verdict, awaiting confirmation", { nodeId: node.nodeId, reason: verdict.reason, strikes: n });
        continue;
      }
      deps.logger?.warn("canary probe detected tampering, quarantining node", { nodeId: node.nodeId, reason: verdict.reason });
      try {
        await deps.quarantine(node.nodeId, verdict.reason);
      } catch {
        /* retried on the next probe */
      }
    }
  }
  return out;
}

export function start(o: { deps: ProbeDeps; logger: JobLogger; intervalMs?: number; jitterMs?: number }): Job {
  const job = new Job({ name: "probes", intervalMs: o.intervalMs ?? 900_000, jitterMs: o.jitterMs, lockKey: null, logger: o.logger, run: () => runOnce(o.deps), initialDelayMs: 120_000 });
  job.start();
  return job;
}

export async function stop(job: Job | null): Promise<void> {
  await job?.stop();
}
