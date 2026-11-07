/**
 * Coordinator network policy (DESIGN.md §9 + §15 Revision 1).
 *
 * The policy is admin-editable and published at GET /v1/policy. It can only
 * TIGHTEN behaviour relative to the node floor; it can never touch the floor
 * itself. The validator therefore rejects:
 *   - unknown keys (at every level),
 *   - any floor key (floor*, hardDenyPorts, privateRanges, ssrf*), anywhere,
 *   - ports outside the floor's 80/443 set (and any hard-deny port),
 *   - a sanctionedCountries list that drops a compiled-in OFAC code or a code
 *     present in the currently active policy (grow-only).
 */

import { createHash } from "node:crypto";
import { BLOCKED_COUNTRY_CODES } from "./sanctions.js";

export type PlaintextMode = "deny" | "opt_in" | "allow";
export const PLAINTEXT_MODES: readonly PlaintextMode[] = ["deny", "opt_in", "allow"];

/** Ports the node floor can ever dial (80/443 ∩ policy ∩ local). */
export const FLOOR_ALLOWED_PORTS: readonly number[] = [80, 443];
/** Mirrors node-agent floor HARD_DENY_PORTS (§3). Never overridable. */
export const HARD_DENY_PORTS: readonly number[] = [22, 23, 25, 465, 587, 3389, 6667];

export const MAX_POLICY_BYTES = 262144;
const MAX_DENY_DOMAINS = 10000;
const MAX_DENY_CATEGORIES = 256;
const MAX_ATTESTATION_TEXT = 20000;

export interface NetworkPolicy {
  ports: number[];
  categoriesVersion: number;
  denyCategories: string[];
  denyDomains: string[];
  nodeDefaults: { maxStreams: number; maxGbDay: number };
  requesterLimits: { reqPerSec: number; dailySpendMusd: number };
  sanctionedCountries: string[];
  attestation: { minVersion: number; text: string };
  plaintext: PlaintextMode;
  logRetentionDays: number;
  nodeCapsPerPrefix: { per32: number; per24: number; perAsn: number };
  /** Allow free-plan requesters on the relay network (default false: 402 PAID_PLAN_REQUIRED). */
  freeTierRelay: boolean;
  /** Buyers must contribute (active node with matured paid traffic in the window, or allowlisted). Default false. */
  requireContribution: boolean;
  /** Window for requireContribution, in days. */
  contributionWindowDays: number;
  /** Allow x402/MPP payers without an account. Default true. */
  allowAnonymousPayers: boolean;
}

export const DEFAULT_POLICY: NetworkPolicy = {
  ports: [80, 443],
  categoriesVersion: 1,
  denyCategories: [],
  denyDomains: [],
  nodeDefaults: { maxStreams: 32, maxGbDay: 5 },
  requesterLimits: { reqPerSec: 20, dailySpendMusd: 50_000_000 },
  sanctionedCountries: [...BLOCKED_COUNTRY_CODES].sort(),
  attestation: { minVersion: 1, text: "I operate this node lawfully and accept the DomiNode relay terms." },
  plaintext: "opt_in",
  logRetentionDays: 90,
  nodeCapsPerPrefix: { per32: 2, per24: 8, perAsn: 500 },
  freeTierRelay: false,
  requireContribution: false,
  contributionWindowDays: 30,
  allowAnonymousPayers: true,
};

export class PolicyValidationError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`Invalid policy: ${errors.slice(0, 10).join("; ")}`);
    this.name = "PolicyValidationError";
    this.errors = errors;
  }
}

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** True if a key names a node-floor control that policy must never carry. */
export function isFloorKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[-_]/g, "");
  return (
    k.startsWith("floor") ||
    k.startsWith("ssrf") ||
    k === "harddenyports" ||
    k === "privateranges"
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) &&
    (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}

function scanKeys(v: unknown, path: string, errors: string[], depth = 0): void {
  if (depth > 8) {
    errors.push(`${path || "body"}: nesting too deep`);
    return;
  }
  if (Array.isArray(v)) {
    v.forEach((x, i) => scanKeys(x, `${path}[${i}]`, errors, depth + 1));
    return;
  }
  if (typeof v === "object" && v !== null) {
    for (const key of Object.keys(v)) {
      const p = path ? `${path}.${key}` : key;
      if (DANGEROUS_KEYS.has(key)) errors.push(`${p}: forbidden key`);
      else if (isFloorKey(key)) errors.push(`${p}: floor keys cannot be set by policy`);
      scanKeys((v as Record<string, unknown>)[key], p, errors, depth + 1);
    }
  }
}

function intIn(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
}

function checkObject(
  v: unknown,
  path: string,
  allowed: readonly string[],
  errors: string[],
): v is Record<string, unknown> {
  if (!isPlainObject(v)) {
    errors.push(`${path}: must be an object`);
    return false;
  }
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k) && !isFloorKey(k) && !DANGEROUS_KEYS.has(k)) {
      errors.push(`${path}.${k}: unknown key`);
    }
  }
  return true;
}

function checkInt(o: Record<string, unknown>, key: string, path: string, min: number, max: number, errors: string[]): void {
  if (!intIn(o[key], min, max)) errors.push(`${path}.${key}: must be an integer in [${min}, ${max}]`);
}

const DOMAIN_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const CATEGORY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;

const TOP_KEYS = [
  "ports", "categoriesVersion", "denyCategories", "denyDomains", "nodeDefaults",
  "requesterLimits", "sanctionedCountries", "attestation", "plaintext",
  "logRetentionDays", "nodeCapsPerPrefix", "freeTierRelay",
  "requireContribution", "contributionWindowDays", "allowAnonymousPayers",
] as const;

export interface ValidatePolicyOptions {
  /** Currently active policy; sanctionedCountries must be a superset of it. */
  current?: NetworkPolicy | null;
}

/**
 * Validate and normalise a policy body. Optional keys are filled from
 * DEFAULT_POLICY (plaintext defaults to "opt_in"). Throws PolicyValidationError.
 */
export function validatePolicy(input: unknown, opts: ValidatePolicyOptions = {}): NetworkPolicy {
  const errors: string[] = [];
  if (!isPlainObject(input)) throw new PolicyValidationError(["body: must be a JSON object"]);

  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(input), "utf8");
  } catch {
    throw new PolicyValidationError(["body: not serialisable"]);
  }
  if (size > MAX_POLICY_BYTES) throw new PolicyValidationError([`body: exceeds ${MAX_POLICY_BYTES} bytes`]);

  scanKeys(input, "", errors);
  for (const k of Object.keys(input)) {
    if (!(TOP_KEYS as readonly string[]).includes(k) && !isFloorKey(k) && !DANGEROUS_KEYS.has(k)) {
      errors.push(`${k}: unknown key`);
    }
  }

  const b = input;
  const d = DEFAULT_POLICY;
  const out: NetworkPolicy = structuredClone(d);

  // ports
  if (b.ports !== undefined) {
    if (!Array.isArray(b.ports) || b.ports.length === 0 || b.ports.length > FLOOR_ALLOWED_PORTS.length) {
      errors.push("ports: must be a non-empty array");
    } else {
      const seen = new Set<number>();
      for (const p of b.ports) {
        if (!intIn(p, 1, 65535)) errors.push("ports: entries must be integers in [1, 65535]");
        else if (HARD_DENY_PORTS.includes(p)) errors.push(`ports: ${p} is hard-denied by the node floor`);
        else if (!FLOOR_ALLOWED_PORTS.includes(p)) errors.push(`ports: ${p} is outside the floor (80/443)`);
        else if (seen.has(p)) errors.push(`ports: duplicate ${p}`);
        else seen.add(p);
      }
      out.ports = [...seen].sort((a, c) => a - c);
    }
  }

  if (b.categoriesVersion !== undefined) {
    if (!intIn(b.categoriesVersion, 1, 1_000_000)) errors.push("categoriesVersion: must be an integer in [1, 1000000]");
    else out.categoriesVersion = b.categoriesVersion;
  }

  if (b.denyCategories !== undefined) {
    if (!Array.isArray(b.denyCategories) || b.denyCategories.length > MAX_DENY_CATEGORIES) {
      errors.push(`denyCategories: must be an array of at most ${MAX_DENY_CATEGORIES}`);
    } else {
      const s = new Set<string>();
      for (const c of b.denyCategories) {
        if (typeof c !== "string" || !CATEGORY_RE.test(c)) errors.push("denyCategories: invalid category id");
        else s.add(c);
      }
      out.denyCategories = [...s].sort();
    }
  }

  if (b.denyDomains !== undefined) {
    if (!Array.isArray(b.denyDomains) || b.denyDomains.length > MAX_DENY_DOMAINS) {
      errors.push(`denyDomains: must be an array of at most ${MAX_DENY_DOMAINS}`);
    } else {
      const s = new Set<string>();
      for (const dom of b.denyDomains) {
        const norm = typeof dom === "string" ? dom.trim().toLowerCase().replace(/\.$/, "") : "";
        if (!DOMAIN_RE.test(norm)) errors.push(`denyDomains: invalid domain ${JSON.stringify(String(dom).slice(0, 64))}`);
        else s.add(norm);
      }
      out.denyDomains = [...s].sort();
    }
  }

  if (b.nodeDefaults !== undefined && checkObject(b.nodeDefaults, "nodeDefaults", ["maxStreams", "maxGbDay"], errors)) {
    const o = b.nodeDefaults;
    checkInt(o, "maxStreams", "nodeDefaults", 1, 1024, errors);
    checkInt(o, "maxGbDay", "nodeDefaults", 1, 10000, errors);
    out.nodeDefaults = { maxStreams: o.maxStreams as number, maxGbDay: o.maxGbDay as number };
  }

  if (b.requesterLimits !== undefined && checkObject(b.requesterLimits, "requesterLimits", ["reqPerSec", "dailySpendMusd"], errors)) {
    const o = b.requesterLimits;
    checkInt(o, "reqPerSec", "requesterLimits", 1, 10000, errors);
    checkInt(o, "dailySpendMusd", "requesterLimits", 0, 100_000_000_000, errors);
    out.requesterLimits = { reqPerSec: o.reqPerSec as number, dailySpendMusd: o.dailySpendMusd as number };
  }

  if (b.freeTierRelay !== undefined) {
    if (typeof b.freeTierRelay !== "boolean") errors.push("freeTierRelay: must be a boolean");
    else out.freeTierRelay = b.freeTierRelay;
  }

  for (const k of ["requireContribution", "allowAnonymousPayers"] as const) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== "boolean") errors.push(`${k}: must be a boolean`);
    else out[k] = b[k] as boolean;
  }
  if (b.contributionWindowDays !== undefined) {
    if (!intIn(b.contributionWindowDays, 1, 365)) errors.push("contributionWindowDays: must be an integer in [1, 365]");
    else out.contributionWindowDays = b.contributionWindowDays;
  }

  if (b.nodeCapsPerPrefix !== undefined && checkObject(b.nodeCapsPerPrefix, "nodeCapsPerPrefix", ["per32", "per24", "perAsn"], errors)) {
    const o = b.nodeCapsPerPrefix;
    checkInt(o, "per32", "nodeCapsPerPrefix", 1, 1000, errors);
    checkInt(o, "per24", "nodeCapsPerPrefix", 1, 100000, errors);
    checkInt(o, "perAsn", "nodeCapsPerPrefix", 1, 10_000_000, errors);
    out.nodeCapsPerPrefix = { per32: o.per32 as number, per24: o.per24 as number, perAsn: o.perAsn as number };
    if (intIn(o.per32, 1, 1000) && intIn(o.per24, 1, 100000) && o.per32 > o.per24) {
      errors.push("nodeCapsPerPrefix: per32 cannot exceed per24");
    }
  }

  // sanctions: grow-only vs compiled constant AND current active policy
  if (b.sanctionedCountries !== undefined) {
    if (!Array.isArray(b.sanctionedCountries) || b.sanctionedCountries.length > 250) {
      errors.push("sanctionedCountries: must be an array of at most 250 codes");
    } else {
      const s = new Set<string>();
      for (const c of b.sanctionedCountries) {
        if (typeof c !== "string" || !COUNTRY_RE.test(c)) errors.push("sanctionedCountries: codes must be ISO alpha-2 uppercase");
        else s.add(c);
      }
      out.sanctionedCountries = [...s].sort();
    }
  }
  {
    const have = new Set(out.sanctionedCountries);
    for (const c of BLOCKED_COUNTRY_CODES) {
      if (!have.has(c)) errors.push(`sanctionedCountries: cannot remove compiled-in OFAC code ${c}`);
    }
    for (const c of opts.current?.sanctionedCountries ?? []) {
      if (!have.has(c)) errors.push(`sanctionedCountries: list is grow-only; cannot remove ${c}`);
    }
  }

  if (b.attestation !== undefined && checkObject(b.attestation, "attestation", ["minVersion", "text"], errors)) {
    const o = b.attestation;
    checkInt(o, "minVersion", "attestation", 1, 100000, errors);
    if (typeof o.text !== "string" || o.text.trim().length === 0 || o.text.length > MAX_ATTESTATION_TEXT) {
      errors.push(`attestation.text: must be a non-empty string of at most ${MAX_ATTESTATION_TEXT} chars`);
    } else if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(o.text)) {
      errors.push("attestation.text: control characters not allowed");
    }
    out.attestation = { minVersion: o.minVersion as number, text: o.text as string };
  }
  // §15: checked against the effective value so omitting `attestation` cannot reset it to the default.
  if (opts.current && intIn(out.attestation.minVersion, 1, 100000) &&
      out.attestation.minVersion < opts.current.attestation.minVersion) {
    errors.push("attestation.minVersion: cannot decrease");
  }

  if (b.plaintext !== undefined) {
    if (typeof b.plaintext !== "string" || !(PLAINTEXT_MODES as readonly string[]).includes(b.plaintext)) {
      errors.push("plaintext: must be one of deny, opt_in, allow");
    } else out.plaintext = b.plaintext as PlaintextMode;
  }

  if (b.logRetentionDays !== undefined) {
    if (!intIn(b.logRetentionDays, 1, 3650)) errors.push("logRetentionDays: must be an integer in [1, 3650]");
    else out.logRetentionDays = b.logRetentionDays;
  }

  if (errors.length > 0) throw new PolicyValidationError([...new Set(errors)]);
  return out;
}

/** Deterministic JSON (sorted keys) so the hash is stable across key order. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export function policySha256(policy: NetworkPolicy): string {
  return createHash("sha256").update(canonicalJson(policy), "utf8").digest("hex");
}
