/**
 * Operator configuration (DESIGN.md §3). Every option can only TIGHTEN the
 * built-in maxima; nothing here can reach the floor (floor.ts takes no input).
 */
import { FLOOR_PORTS } from "./floor.js";
import type { LimitValues } from "./limits.js";

export const MAXIMA: Readonly<LimitValues & { maxMbps: number }> = Object.freeze({
  maxStreams: 256,
  reqPerSec: 100,
  gbPerDay: 1000,
  maxMbps: 10_000,
});

export const DEFAULTS: Readonly<LimitValues & { maxMbps: number }> = Object.freeze({
  maxStreams: 32,
  reqPerSec: 20,
  gbPerDay: 5,
  maxMbps: 100,
});

export const DEFAULT_API_URL = "https://api.dominusnode.daedalusdevelopmentgroup.com";
export const DEFAULT_GATEWAY_URL = "wss://relay.dominusnode.daedalusdevelopmentgroup.com/v1/tunnel";
const MAX_DENY_DOMAINS = 10_000;

export interface AgentConfig {
  apiUrl: string;
  gatewayUrl: string;
  keyFile: string;
  ports: number[];
  maxStreams: number;
  reqPerSec: number;
  gbPerDay: number;
  maxMbps: number;
  denyDomains: string[];
  /** Extra SPKI pins (base64 SHA-256). Adding pins only makes TLS stricter. */
  spkiPins: string[];
  /** Extra coordinator ed25519 pubkeys (hex). Can only add to the embedded pins. */
  coordPins: string[];
  /** F2: coordinator domain to discover via /.well-known/dominusnode/coordinator.json. */
  coordinator?: string;
  /** Set by applyCoordinator: coordPins replace the embedded official pins instead of adding to them. */
  coordPinsExclusive?: boolean;
  /** F2: confirmed coordinator key fingerprint (sha256:<hex>). */
  trust?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Parse an integer env value; NaN or out-of-range throws (never silently defaults). */
export function parseIntStrict(name: string, raw: string | undefined, min: number, max: number): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  if (!/^\d+$/.test(raw.trim())) throw new ConfigError(`${name} must be an integer`);
  const n = Number.parseInt(raw.trim(), 10);
  if (Number.isNaN(n) || n < min || n > max) throw new ConfigError(`${name} must be between ${min} and ${max}`);
  return n;
}

function parseUrl(name: string, raw: string | undefined, fallback: string, protocols: string[]): string {
  const v = raw?.trim() || fallback;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new ConfigError(`${name} is not a valid URL`);
  }
  if (!protocols.includes(u.protocol)) throw new ConfigError(`${name} must use ${protocols.join(" or ")}`);
  if (u.username || u.password) throw new ConfigError(`${name} must not embed credentials`);
  return u.toString();
}

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

export type FlagMap = Readonly<Record<string, string | undefined>>;

/** Demo mode: plaintext gateway/API allowed. Never on in production. */
export function isDemoMode(env: NodeJS.ProcessEnv): boolean {
  return env["DN_NODE_DEMO"] === "1" && env["NODE_ENV"] === "development";
}

/**
 * Build config from env plus CLI flags (flags win, but both are clamped).
 * Recognised env: DN_NODE_API_URL, DN_NODE_GATEWAY_URL, DN_NODE_KEY_FILE, DN_NODE_PORTS,
 * DN_NODE_MAX_STREAMS, DN_NODE_REQ_PER_SEC, DN_NODE_GB_PER_DAY, DN_NODE_MAX_MBPS,
 * DN_NODE_DENY_DOMAINS, DN_NODE_SPKI_PINS.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, flags: FlagMap = {}): AgentConfig {
  const get = (flag: string, envName: string): string | undefined => flags[flag] ?? env[envName];

  const portsRaw = get("ports", "DN_NODE_PORTS");
  let ports = [...FLOOR_PORTS];
  if (portsRaw !== undefined && portsRaw.trim() !== "") {
    const asked = portsRaw.split(",").map((p, i) => parseIntStrict(`DN_NODE_PORTS[${i}]`, p, 1, 65535));
    // Subset only: ports outside the floor are dropped, never added.
    ports = ports.filter((p) => asked.includes(p));
    if (ports.length === 0) throw new ConfigError("DN_NODE_PORTS leaves no usable port (allowed: 80, 443)");
  }

  const num = (flag: string, envName: string, key: keyof typeof MAXIMA): number => {
    const v = parseIntStrict(envName, get(flag, envName), 1, MAXIMA[key]);
    return Math.min(v ?? DEFAULTS[key], MAXIMA[key]);
  };

  const denyRaw = get("deny-domains", "DN_NODE_DENY_DOMAINS") ?? "";
  const denyDomains = [...new Set(denyRaw.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean))];
  if (denyDomains.length > MAX_DENY_DOMAINS) throw new ConfigError("DN_NODE_DENY_DOMAINS has too many entries");
  for (const d of denyDomains) if (!DOMAIN_RE.test(d)) throw new ConfigError("DN_NODE_DENY_DOMAINS has an invalid domain");

  const pinsRaw = get("spki-pins", "DN_NODE_SPKI_PINS") ?? "";
  const spkiPins = pinsRaw.split(",").map((p) => p.trim()).filter(Boolean);
  for (const p of spkiPins) {
    if (!/^[A-Za-z0-9+/]{43}=$/.test(p)) throw new ConfigError("DN_NODE_SPKI_PINS entries must be base64 SHA-256");
  }

  const coordRaw = get("coord-pins", "DN_NODE_COORD_PINS") ?? "";
  const coordPins = [...new Set(coordRaw.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean))];
  if (coordPins.length > 16) throw new ConfigError("DN_NODE_COORD_PINS has too many entries");
  for (const p of coordPins) {
    if (!/^[0-9a-f]{64}$/.test(p)) throw new ConfigError("DN_NODE_COORD_PINS entries must be 64 hex chars");
  }

  const coordRawDomain = (get("coordinator", "DN_NODE_COORDINATOR") ?? "").trim();
  let coordinator: string | undefined;
  if (coordRawDomain) {
    coordinator = coordRawDomain.toLowerCase().replace(/^https:\/\//, "").replace(/\/+$/, "").replace(/\.$/, "");
    if (!DOMAIN_RE.test(coordinator)) throw new ConfigError("DN_NODE_COORDINATOR must be a domain name");
  }
  const trust = (get("trust", "DN_NODE_TRUST") ?? "").trim() || undefined;

  const keyFile = (get("key-file", "DN_NODE_KEY_FILE") ?? "").trim() || defaultKeyFile(env);

  // Local demo only (docker-compose.demo.yml): plaintext ws/http to a gateway on the
  // same Docker network. Requires BOTH DN_NODE_DEMO=1 and NODE_ENV=development.
  const demo = isDemoMode(env);
  return {
    apiUrl: parseUrl("DN_NODE_API_URL", get("api-url", "DN_NODE_API_URL"), DEFAULT_API_URL, demo ? ["https:", "http:"] : ["https:"]),
    gatewayUrl: parseUrl("DN_NODE_GATEWAY_URL", get("gateway-url", "DN_NODE_GATEWAY_URL"), DEFAULT_GATEWAY_URL, demo ? ["wss:", "ws:"] : ["wss:"]),
    keyFile,
    ports,
    maxStreams: num("max-streams", "DN_NODE_MAX_STREAMS", "maxStreams"),
    reqPerSec: num("req-per-sec", "DN_NODE_REQ_PER_SEC", "reqPerSec"),
    gbPerDay: num("gb-per-day", "DN_NODE_GB_PER_DAY", "gbPerDay"),
    maxMbps: num("max-mbps", "DN_NODE_MAX_MBPS", "maxMbps"),
    denyDomains,
    spkiPins,
    coordPins,
    ...(coordinator ? { coordinator } : {}),
    ...(trust ? { trust } : {}),
  };
}

function defaultKeyFile(env: NodeJS.ProcessEnv): string {
  const home = env["HOME"] || ".";
  return `${home}/.dominusnode/node.json`;
}

/** True if host equals or is a subdomain of any operator deny domain. */
export function isDeniedDomain(host: string, denyDomains: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return denyDomains.some((d) => h === d || h.endsWith(`.${d}`));
}
