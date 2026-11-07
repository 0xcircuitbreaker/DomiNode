/**
 * Requester access decisions taken once per session start, before node
 * selection (LAUNCH_PLAN §5.2, ECONOMICS.md "Contribution requirement"):
 *
 *  - seedOnly: requesters spending starter credit in its first month are kept
 *    on operator-run seed nodes so community nodes never carry free traffic.
 *  - contribution: with policy.requireContribution, an API-key principal may
 *    only buy bandwidth if it runs an active node with recent matured paid
 *    traffic, or is on the admin allowlist (403 CONTRIBUTION_REQUIRED).
 *
 * Lookups are cached briefly per user in a size-capped map. Failures close:
 * contribution check errors refuse the session (503), seedOnly errors keep the
 * requester on seed nodes.
 */
import type { NetworkPolicy } from "@dominusnode/shared";

export interface AccessGateDeps {
  isSeedOnly(userId: string): Promise<boolean>;
  hasContribution(userId: string, windowDays: number): Promise<boolean>;
  now?: () => number;
}

export type AccessDecision =
  | { allowed: true; seedOnly: boolean }
  | { allowed: false; status: number; code: string; message: string };

const TTL_MS = 30_000;
const MAX_ENTRIES = 50_000;

let deps: AccessGateDeps | null = null;
const seedCache = new Map<string, { at: number; v: boolean }>();
const contribCache = new Map<string, { at: number; v: boolean; days: number }>();

export function configureAccessGate(d: AccessGateDeps | null): void {
  deps = d;
  seedCache.clear();
  contribCache.clear();
}

function put<V>(m: Map<string, V>, k: string, v: V): void {
  if (!m.has(k) && m.size >= MAX_ENTRIES) {
    const first = m.keys().next().value;
    if (first !== undefined) m.delete(first);
  }
  m.set(k, v);
}

/** Periodic sweep so the caches never hold stale users forever. */
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of seedCache) if (now - v.at > TTL_MS) seedCache.delete(k);
  for (const [k, v] of contribCache) if (now - v.at > TTL_MS) contribCache.delete(k);
}, 60_000).unref();

export const CONTRIBUTION_REQUIRED_MESSAGE =
  "This network currently requires buyers to contribute: run a node with recent paid traffic (or ask an admin for an allowlist entry).";

/**
 * Decide access for an API-key principal (not x402/MPP payers; see
 * checkAnonymousPayer). `policy` is the active network policy.
 */
export async function checkRequesterAccess(policy: NetworkPolicy, userId: string): Promise<AccessDecision> {
  if (!deps) return { allowed: true, seedOnly: false };
  const now = (deps.now ?? Date.now)();

  if (policy.requireContribution === true) {
    const days = policy.contributionWindowDays;
    let c = contribCache.get(userId);
    if (!c || now - c.at > TTL_MS || c.days !== days) {
      try {
        c = { at: now, v: await deps.hasContribution(userId, days), days };
      } catch {
        return { allowed: false, status: 503, code: "SERVICE_UNAVAILABLE", message: "Contribution check unavailable, retry later" };
      }
      put(contribCache, userId, c);
    }
    if (!c.v) return { allowed: false, status: 403, code: "CONTRIBUTION_REQUIRED", message: CONTRIBUTION_REQUIRED_MESSAGE };
  }

  let s = seedCache.get(userId);
  if (!s || now - s.at > TTL_MS) {
    let v: boolean;
    try {
      v = await deps.isSeedOnly(userId);
    } catch {
      v = true; // fail toward seed nodes, never toward community nodes
    }
    s = { at: now, v };
    put(seedCache, userId, s);
  }
  return { allowed: true, seedOnly: s.v };
}

/** x402/MPP payers have no account: governed only by policy.allowAnonymousPayers. */
export function checkAnonymousPayer(policy: NetworkPolicy): AccessDecision {
  if (policy.allowAnonymousPayers === false) {
    return { allowed: false, status: 403, code: "ANONYMOUS_PAYERS_DISABLED", message: "Per-request payments without an account are disabled by network policy" };
  }
  return { allowed: true, seedOnly: false };
}
