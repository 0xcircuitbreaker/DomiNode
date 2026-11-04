/**
 * Node floor (DESIGN.md §3, §11 rows 2 and 4). NON-DISABLEABLE.
 *
 * This module deliberately takes NO configuration input: no env, no flags, no
 * policy. Everything that comes from outside (policy ports, operator ports) can
 * only be intersected with the floor here; nothing can widen it.
 */
import { createHash } from "node:crypto";
import * as net from "node:net";
import { FLOOR_ALLOWED_PORTS, HARD_DENY_PORTS, isPublicAddress, isValidHostname, isValidPort } from "./shared.js";

// Copied into module-private, frozen arrays so later mutation of shared exports cannot widen the floor.
export const FLOOR_PORTS: readonly number[] = Object.freeze([...FLOOR_ALLOWED_PORTS]);
export const FLOOR_HARD_DENY_PORTS: readonly number[] = Object.freeze([...HARD_DENY_PORTS]);
const floorPortSet = new Set<number>(FLOOR_PORTS);
const hardDenySet = new Set<number>(FLOOR_HARD_DENY_PORTS);

/** Addresses discovered at startup (own public IP, LAN gateway). Add-only. */
const selfAddresses = new Set<string>();
const MAX_SELF_ADDRESSES = 64;

function normalizeIp(ip: string): string {
  let s = ip.trim().toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const z = s.indexOf("%");
  if (z !== -1) s = s.slice(0, z);
  if (s.startsWith("::ffff:") && net.isIP(s.slice(7)) === 4) s = s.slice(7);
  return s;
}

/** Block an address discovered at startup. There is intentionally no remove. */
export function addSelfAddress(ip: string): void {
  if (typeof ip !== "string" || net.isIP(normalizeIp(ip)) === 0) return;
  if (selfAddresses.size >= MAX_SELF_ADDRESSES) return;
  selfAddresses.add(normalizeIp(ip));
}

export function floorAllowsPort(port: number): boolean {
  return isValidPort(port) && floorPortSet.has(port) && !hardDenySet.has(port);
}

/** Effective ports = FLOOR_PORTS ∩ policy ∩ local, minus hard-deny. Sorted. */
export function effectivePorts(policyPorts: readonly unknown[], localPorts: readonly unknown[]): number[] {
  const pol = new Set(policyPorts.filter((p): p is number => typeof p === "number"));
  const loc = new Set(localPorts.filter((p): p is number => typeof p === "number"));
  return [...floorPortSet].filter((p) => floorAllowsPort(p) && pol.has(p) && loc.has(p)).sort((a, b) => a - b);
}

/** Syntactic host check before DNS: valid name, no special TLDs, no numeric forms, public IP literals only. */
export function floorAllowsHost(host: string): boolean {
  if (typeof host !== "string" || host.length === 0 || host.length > 253) return false;
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (net.isIP(bare) !== 0) return floorAllowsIp(bare);
  return isValidHostname(bare);
}

/** Resolved/connected address check: public per net-guard and not this node itself. Fail-closed. */
export function floorAllowsIp(ip: string): boolean {
  if (typeof ip !== "string") return false;
  if (!isPublicAddress(ip)) return false;
  return !selfAddresses.has(normalizeIp(ip));
}

/** Advisory floor hash (§2.6): SHA-256 of floor constants plus agent version. */
export function floorHash(agentVersion: string): string {
  return createHash("sha256")
    .update(JSON.stringify({
      v: 1,
      ports: [...floorPortSet].sort((a, b) => a - b),
      hardDeny: [...hardDenySet].sort((a, b) => a - b),
      agentVersion,
    }))
    .digest("hex");
}
