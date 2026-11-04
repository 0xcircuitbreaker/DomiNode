/**
 * Gateway policy enforcement (DESIGN.md §8, §11, §15). Runs after auth and
 * before node selection: ports, category/domain denylist, OFAC destination,
 * plaintext mode, and per-requester req/s + daily spend caps.
 */
import { isIP } from "node:net";
import type { NetworkPolicy } from "@dominusnode/shared";
import { checkSanctionedCountry } from "./geo-check.js";

export const EXIT_VISIBLE_HEADER = "X-DominusNode-Exit-Visible";

export interface EnforceInput {
  userId: string;
  host: string;
  port: number;
  /** Plaintext request (HTTP forward or a tunnel to port 80). */
  plaintext: boolean;
  /** `allowhttp-1` username flag. */
  allowHttp: boolean;
  /** Addresses the gateway DNS pre-check resolved for `host`; each is OFAC geo-checked. */
  resolvedIps?: readonly string[];
}

/** Ports treated as TLS for the plaintext opt-in gate; every other port is plaintext. */
export const TLS_PORTS: ReadonlySet<number> = new Set([443]);

/** Whether a CONNECT/SOCKS5 tunnel to `port` must be treated as exit-visible plaintext. */
export function isPlaintextPort(port: number): boolean {
  return !TLS_PORTS.has(port);
}

export type EnforceResult =
  | { allowed: true; exitVisible: boolean }
  | { allowed: false; status: number; code: string; message: string };

const MAX_TRACKED = 50_000;
const reqLog = new Map<string, number[]>();
const spendLog = new Map<string, { day: number; musd: bigint }>();
const DAY_MS = 86_400_000;

setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of reqLog) {
    const kept = ts.filter((t) => now - t < 1000);
    if (kept.length === 0) reqLog.delete(k); else reqLog.set(k, kept);
  }
  const today = Math.floor(now / DAY_MS);
  for (const [k, v] of spendLog) if (v.day !== today) spendLog.delete(k);
}, 60_000).unref();

/** Exact-or-suffix domain match (v1 category list is a domain list). */
export function isDeniedDomain(host: string, deny: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  for (const d of deny) {
    const x = d.toLowerCase().replace(/^\*?\./, "").replace(/\.$/, "");
    if (!x) continue;
    if (h === x || h.endsWith(`.${x}`)) return true;
  }
  return false;
}

/** Record settled spend (µUSD) for the per-requester daily cap. */
export function recordRequesterSpend(userId: string, musd: bigint, now = Date.now()): void {
  if (musd <= 0n) return;
  const day = Math.floor(now / DAY_MS);
  const e = spendLog.get(userId);
  if (e && e.day === day) { e.musd += musd; return; }
  if (!e && spendLog.size >= MAX_TRACKED) {
    const first = spendLog.keys().next().value;
    if (first !== undefined) spendLog.delete(first);
  }
  spendLog.set(userId, { day, musd });
}

export function getRequesterSpend(userId: string, now = Date.now()): bigint {
  const e = spendLog.get(userId);
  return e && e.day === Math.floor(now / DAY_MS) ? e.musd : 0n;
}

function checkRate(userId: string, limit: number, now: number): boolean {
  let ts = reqLog.get(userId);
  if (!ts) {
    if (reqLog.size >= MAX_TRACKED) {
      const first = reqLog.keys().next().value;
      if (first !== undefined) reqLog.delete(first);
    }
    ts = [];
    reqLog.set(userId, ts);
  }
  while (ts.length > 0 && now - ts[0] >= 1000) ts.shift();
  if (ts.length >= limit) return false;
  ts.push(now);
  return true;
}

export function enforcePolicy(policy: NetworkPolicy, i: EnforceInput, now = Date.now()): EnforceResult {
  if (!policy.ports.includes(i.port)) {
    return { allowed: false, status: 403, code: "PORT_BLOCKED", message: "Destination port not allowed by policy" };
  }
  if (isDeniedDomain(i.host, policy.denyDomains)) {
    return { allowed: false, status: 403, code: "DOMAIN_BLOCKED", message: "Destination blocked by policy" };
  }
  const destIps = [...(isIP(i.host) ? [i.host] : []), ...(i.resolvedIps ?? [])];
  if (destIps.some((ip) => checkSanctionedCountry(ip) !== null)) {
    return { allowed: false, status: 403, code: "SANCTIONED_DESTINATION", message: "Destination is in a sanctioned region" };
  }
  let exitVisible = false;
  if (i.plaintext) {
    if (policy.plaintext === "deny" || (policy.plaintext === "opt_in" && !i.allowHttp)) {
      return {
        allowed: false, status: 400, code: "PLAINTEXT_DISABLED",
        message: policy.plaintext === "deny"
          ? "Plaintext HTTP is disabled; use HTTPS"
          : "Plaintext HTTP is visible to the exit node; add the allowhttp-1 username flag to opt in",
      };
    }
    exitVisible = true;
  }
  if (getRequesterSpend(i.userId, now) >= BigInt(policy.requesterLimits.dailySpendMusd)) {
    return { allowed: false, status: 429, code: "SPEND_CAP_EXCEEDED", message: "Daily spend cap reached" };
  }
  if (!checkRate(i.userId, policy.requesterLimits.reqPerSec, now)) {
    return { allowed: false, status: 429, code: "RATE_LIMITED", message: "Too many requests per second" };
  }
  return { allowed: true, exitVisible };
}

/** Test helper. */
export function _resetPolicyEnforcer(): void {
  reqLog.clear();
  spendLog.clear();
}
