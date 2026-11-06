/**
 * Self-address discovery for the node floor (DESIGN.md §11 row 4).
 *
 * At startup (and periodically) the agent blocks:
 *   - every local interface address,
 *   - every global IPv6 interface prefix (real prefix length, widened to >= /64),
 *   - every public IPv4 interface subnet,
 *   - its public egress IPv4 as seen by the API (GET /v1/probe/echo),
 *   - the default gateway(s), where determinable (/proc/net/route, /proc/net/ipv6_route).
 * The floor refuses every IP until the first discovery succeeds.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as net from "node:net";
import { randomBytes } from "node:crypto";
import { addSelfAddress, addSelfPrefix, markSelfDiscoveryComplete } from "./floor.js";
import { isPublicAddress } from "./shared.js";

export const REDISCOVERY_INTERVAL_MS = 10 * 60_000;
export const RETRY_INTERVAL_MS = 30_000;
const ECHO_TIMEOUT_MS = 10_000;
const MAX_ECHO_BYTES = 4096;

type Ifaces = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

export function blockInterfaceAddresses(ifaces: Ifaces = os.networkInterfaces()): number {
  let n = 0;
  for (const list of Object.values(ifaces)) {
    for (const info of list ?? []) {
      if (!info || typeof info.address !== "string") continue;
      addSelfAddress(info.address);
      n++;
      const len = cidrLen(info.cidr);
      if (len === null) continue;
      // Global v6 prefixes: neighbours / other host addresses share them. Public v4 subnets likewise.
      // Private/link-local ranges are already blocked by net-guard.
      if (isPublicAddress(info.address)) addSelfPrefix(info.address, len);
    }
  }
  return n;
}

function cidrLen(cidr: string | null | undefined): number | null {
  if (typeof cidr !== "string") return null;
  const i = cidr.lastIndexOf("/");
  if (i === -1) return null;
  const n = Number(cidr.slice(i + 1));
  return Number.isInteger(n) ? n : null;
}

/** Parse default gateways from Linux /proc files. Returns [] when unavailable. */
export function parseDefaultGateways(route4: string | null, route6: string | null): string[] {
  const out: string[] = [];
  if (route4) {
    for (const line of route4.split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 3 || f[1] !== "00000000" || !/^[0-9A-Fa-f]{8}$/.test(f[2])) continue;
      const v = parseInt(f[2], 16); // little-endian
      const ip = [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff].join(".");
      if (ip !== "0.0.0.0") out.push(ip);
    }
  }
  if (route6) {
    for (const line of route6.split("\n")) {
      const f = line.trim().split(/\s+/);
      // dest destlen src srclen nexthop ...
      if (f.length < 5 || f[0] !== "0".repeat(32) || f[1] !== "00") continue;
      const nh = f[4];
      if (!/^[0-9a-f]{32}$/i.test(nh) || /^0+$/.test(nh)) continue;
      const ip = nh.match(/.{4}/g)!.join(":");
      if (net.isIP(ip) === 6) out.push(ip);
    }
  }
  return out;
}

function readOrNull(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

export function blockDefaultGateways(
  read: (p: string) => string | null = readOrNull,
): string[] {
  const gws = parseDefaultGateways(read("/proc/net/route"), read("/proc/net/ipv6_route"));
  for (const g of gws) addSelfAddress(g);
  return gws;
}

/** Ask the API what our egress IP is. Throws on any failure. */
export async function discoverPublicIp(apiUrl: string, fetchFn: typeof fetch = fetch): Promise<string> {
  const base = apiUrl.replace(/\/+$/, "");
  const nonce = randomBytes(16).toString("hex");
  const res = await fetchFn(`${base}/v1/probe/echo?nonce=${nonce}`, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(ECHO_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`probe echo HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_ECHO_BYTES) throw new Error("probe echo response too large");
  const body = JSON.parse(text) as { ip?: unknown; nonce?: unknown };
  if (!body || body.nonce !== nonce || typeof body.ip !== "string" || net.isIP(body.ip) === 0) {
    throw new Error("probe echo response invalid");
  }
  return body.ip;
}

export interface SelfDiscoveryOptions {
  apiUrl: string;
  fetchFn?: typeof fetch;
  ifaces?: () => Ifaces;
  readFile?: (p: string) => string | null;
  intervalMs?: number;
  retryMs?: number;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

/** One discovery pass. Resolves true when the public IP was learned (floor may open). */
export async function runSelfDiscovery(opts: SelfDiscoveryOptions): Promise<boolean> {
  blockInterfaceAddresses(opts.ifaces ? opts.ifaces() : os.networkInterfaces());
  blockDefaultGateways(opts.readFile ?? readOrNull);
  try {
    const ip = await discoverPublicIp(opts.apiUrl, opts.fetchFn ?? fetch);
    addSelfAddress(ip);
    markSelfDiscoveryComplete();
    return true;
  } catch (err) {
    opts.log?.("self-discovery: public IP lookup failed; floor stays closed until it succeeds", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Start discovery and periodic re-discovery. Returns a stop function. */
export function startSelfDiscovery(opts: SelfDiscoveryOptions): { ready: Promise<boolean>; stop: () => void } {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let firstOk = false;
  const interval = opts.intervalMs ?? REDISCOVERY_INTERVAL_MS;
  const retry = opts.retryMs ?? RETRY_INTERVAL_MS;
  const schedule = (ms: number): void => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), ms);
    timer.unref?.();
  };
  const tick = async (): Promise<boolean> => {
    const ok = await runSelfDiscovery(opts);
    if (ok) firstOk = true;
    schedule(firstOk ? interval : retry);
    return ok;
  };
  const ready = tick();
  return {
    ready,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
