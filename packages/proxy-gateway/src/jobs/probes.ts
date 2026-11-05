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
 * reply) is quarantined. Dial errors and timeouts are not tamper evidence.
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
  | { kind: "ok" }
  | { kind: "tamper"; reason: string }
  | { kind: "inconclusive"; reason: string };

function family(ip: string): 4 | 6 | 0 {
  return net.isIPv4(ip) ? 4 : net.isIPv6(ip) ? 6 : 0;
}

function normIp(ip: string): string {
  const v = ip.trim().toLowerCase();
  return v.startsWith("::ffff:") && v.includes(".") ? v.slice(7) : v;
}

/** Judge a raw HTTP response against the nonce and the node's IP (pure). */
export function judgeProbeResponse(raw: string, nonce: string, nodeIp: string): ProbeOutcome {
  const sep = raw.indexOf("\r\n\r\n");
  if (sep < 0) return { kind: "tamper", reason: "malformed response" };
  const statusLine = raw.slice(0, raw.indexOf("\r\n"));
  if (!/^HTTP\/1\.[01] 200 /.test(statusLine)) {
    // A 429 or 5xx from our own API is not node misbehaviour.
    if (/^HTTP\/1\.[01] (429|5\d\d) /.test(statusLine)) return { kind: "inconclusive", reason: "probe endpoint unavailable" };
    return { kind: "tamper", reason: "unexpected status" };
  }
  let body: unknown;
  try {
    body = JSON.parse(raw.slice(sep + 4));
  } catch {
    return { kind: "tamper", reason: "malformed body" };
  }
  if (!body || typeof body !== "object") return { kind: "tamper", reason: "malformed body" };
  const { ip, nonce: echoed } = body as { ip?: unknown; nonce?: unknown };
  if (echoed !== nonce) return { kind: "tamper", reason: "nonce mismatch" };
  if (typeof ip !== "string") return { kind: "tamper", reason: "missing ip" };
  const a = normIp(ip);
  const b = normIp(nodeIp);
  if (a === b) return { kind: "ok" };
  // Dual-stack nodes may egress on another family than their tunnel: not proof of tampering.
  if (family(a) !== family(b)) return { kind: "inconclusive", reason: "egress family differs" };
  return { kind: "tamper", reason: "egress ip mismatch" };
}

/** HTTP/1.1 GET over an already-open stream; resolves with up to 16 KB of the raw response. */
export function exchange(stream: Duplex, target: ProbeTarget, nonce: string, timeoutMs: number): Promise<string> {
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
      else resolve(Buffer.concat(chunks).toString("utf8"));
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
}

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
  for (const node of sample(deps.listNodes(), deps.sampleSize ?? 20)) {
    out.probed++;
    const nonce = mkNonce();
    let raw: string;
    try {
      const stream = await node.openStream(deps.target.host, deps.target.port);
      raw = await ex(stream, deps.target, nonce, deps.timeoutMs ?? 10_000);
    } catch {
      out.errors++;
      continue;
    }
    const verdict = judgeProbeResponse(raw, nonce, node.ip);
    if (verdict.kind === "ok") out.ok++;
    else if (verdict.kind === "inconclusive") out.inconclusive++;
    else {
      out.tampered++;
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

export function start(o: { deps: ProbeDeps; logger: JobLogger; intervalMs?: number }): Job {
  const job = new Job({ name: "probes", intervalMs: o.intervalMs ?? 900_000, lockKey: null, logger: o.logger, run: () => runOnce(o.deps), initialDelayMs: 120_000 });
  job.start();
  return job;
}

export async function stop(job: Job | null): Promise<void> {
  await job?.stop();
}
