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

/** Self prefixes (own LAN/global IPv6 subnets, own public IPv4 subnets). Prefix match, add-only. */
interface SelfPrefix { family: 4 | 6; net: bigint; len: number }
const selfPrefixes: SelfPrefix[] = [];
const selfPrefixKeys = new Set<string>();
const MAX_SELF_PREFIXES = 64;

function ipToBigInt(ip: string): { family: 4 | 6; value: bigint } | null {
  const s = normalizeIp(ip);
  const fam = net.isIP(s);
  if (fam === 4) {
    const parts = s.split(".").map(Number);
    return { family: 4, value: parts.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n) };
  }
  if (fam !== 6) return null;
  let str = s;
  // Embedded dotted IPv4 tail (e.g. ::1.2.3.4) -> two hex groups.
  const dot = str.lastIndexOf(":");
  const tail = str.slice(dot + 1);
  if (net.isIP(tail) === 4) {
    const b = tail.split(".").map(Number);
    str = str.slice(0, dot + 1) + ((b[0] << 8) | b[1]).toString(16) + ":" + ((b[2] << 8) | b[3]).toString(16);
  }
  const [head, rest] = str.split("::");
  const h = head ? head.split(":") : [];
  const r = rest !== undefined && rest !== "" ? rest.split(":") : [];
  const groups = rest === undefined ? h : [...h, ...Array(8 - h.length - r.length).fill("0"), ...r];
  if (groups.length !== 8) return null;
  return { family: 6, value: groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n) };
}

function maskOf(family: 4 | 6, len: number): bigint {
  const bits = family === 4 ? 32 : 128;
  return len === 0 ? 0n : ((1n << BigInt(len)) - 1n) << BigInt(bits - len);
}

/**
 * Block a whole subnet the node sits on. IPv6 prefixes are widened to at least /64
 * (a host's other addresses / neighbours live in the same /64). There is no remove.
 */
export function addSelfPrefix(ip: string, prefixLen: number): void {
  const parsed = typeof ip === "string" ? ipToBigInt(ip) : null;
  if (!parsed || !Number.isInteger(prefixLen)) return;
  const bits = parsed.family === 4 ? 32 : 128;
  if (prefixLen < 0 || prefixLen > bits) return;
  // Never accept absurdly wide prefixes (a bogus /0 would just block everything; refuse instead of widening silently).
  const minLen = parsed.family === 4 ? 8 : 16;
  if (prefixLen < minLen) return;
  const len = parsed.family === 6 ? Math.min(prefixLen, 64) : prefixLen;
  const mask = maskOf(parsed.family, len);
  const netv = parsed.value & mask;
  const key = `${parsed.family}/${netv.toString(16)}/${len}`;
  if (selfPrefixKeys.has(key) || selfPrefixes.length >= MAX_SELF_PREFIXES) return;
  selfPrefixKeys.add(key);
  selfPrefixes.push({ family: parsed.family, net: netv, len });
}

function inSelfPrefix(ip: string): boolean {
  if (selfPrefixes.length === 0) return false;
  const parsed = ipToBigInt(ip);
  if (!parsed) return true; // unparseable: fail closed
  for (const p of selfPrefixes) {
    if (p.family === parsed.family && (parsed.value & maskOf(p.family, p.len)) === p.net) return true;
  }
  return false;
}

/**
 * Self-discovery gate: until the agent has enumerated its own interfaces and public
 * address, the floor refuses every IP (all OPENs fail with FLOOR_BLOCKED).
 */
let selfDiscoveryComplete = false;
export function markSelfDiscoveryComplete(): void {
  selfDiscoveryComplete = true;
}
export function isSelfDiscoveryComplete(): boolean {
  return selfDiscoveryComplete;
}
/** Snapshot for diagnostics/tests. */
export function selfBlockSnapshot(): { addresses: string[]; prefixes: string[] } {
  return {
    addresses: [...selfAddresses],
    prefixes: selfPrefixes.map((p) => `${p.family}:${p.net.toString(16)}/${p.len}`),
  };
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
  if (!selfDiscoveryComplete) return false;
  if (!isPublicAddress(ip)) return false;
  if (selfAddresses.has(normalizeIp(ip))) return false;
  return !inSelfPrefix(ip);
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
