import { DEFAULT_API_BASE, DEFAULT_GATEWAY_HOST, DEFAULT_GATEWAY_PORT, SANCTIONED_COUNTRIES } from "./constants.js";
import { isPlainObject } from "./json.js";

export type IpClass = "residential" | "dc" | "mobile";
export const IP_CLASSES: readonly IpClass[] = ["residential", "dc", "mobile"];

export interface Settings {
  /** Route this profile through the gateway. */
  enabled: boolean;
  apiBase: string;
  gatewayHost: string;
  gatewayPort: number;
  /** ISO 3166-1 alpha-2 exit country, or null for any. */
  country: string | null;
  /** Relay node class, or null for any. */
  ipClass: IpClass | null;
  /** Keep the same exit across requests (session-<id>). */
  sticky: boolean;
  sessionId: string | null;
  /** Auto-rotate the sticky session every N minutes (0 = off). */
  rotateMinutes: number;
  /** allowhttp-1: plaintext HTTP through the exit (exit can read it). Off by default. */
  plaintext: boolean;
  /** Stop proxying and block traffic once this run spent this many cents (null = no cap). */
  spendCapCents: number | null;
  /** Extension IDs allowed to use chrome.runtime.sendMessage(<this id>, ...). */
  controlExtensionIds: string[];
  /** Page origins whose pages get the window.postMessage control bridge. Empty = disabled. */
  controlPageOrigins: string[];
  /** Optional URL (fetched through the proxy) returning JSON with a country/ip, for "current exit". */
  exitCheckUrl: string | null;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: false,
  apiBase: DEFAULT_API_BASE,
  gatewayHost: DEFAULT_GATEWAY_HOST,
  gatewayPort: DEFAULT_GATEWAY_PORT,
  country: null,
  ipClass: null,
  sticky: false,
  sessionId: null,
  rotateMinutes: 0,
  plaintext: false,
  spendCapCents: null,
  controlExtensionIds: [],
  controlPageOrigins: [],
  exitCheckUrl: null,
};

/** Who is changing settings. Control channels get a narrow, routing-only subset. */
export type PatchScope = "operator" | "control";

/** Keys an automation driver may change at runtime. Never the gateway, API base, key or allowlists. */
export const CONTROL_KEYS = new Set<keyof Settings>([
  "enabled", "country", "ipClass", "sticky", "sessionId", "rotateMinutes", "plaintext",
]);

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

const HOST_RE = /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,62}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,62}[a-zA-Z0-9])?)*$/;
const SESSION_RE = /^[a-zA-Z0-9]{1,64}$/;
const EXT_ID_RE = /^[a-p]{32}$/;
export const API_KEY_RE = /^dn_(?:live|test)_[A-Za-z0-9_-]{8,200}$/;
const MAX_LIST = 32;
/** amountCents upper bound (int32). */
const MAX_CENTS = 2_147_483_647;

function isLocalHost(h: string): boolean {
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
}

export function validateApiBase(v: unknown): string {
  if (typeof v !== "string" || v.length > 300) throw new ValidationError("apiBase must be a URL string");
  let u: URL;
  try { u = new URL(v); } catch { throw new ValidationError("apiBase is not a valid URL"); }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocalHost(u.hostname))) {
    throw new ValidationError("apiBase must use https (http only for localhost)");
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) {
    throw new ValidationError("apiBase must be a bare origin");
  }
  return u.origin;
}

export function validateOrigin(v: unknown): string {
  if (typeof v !== "string" || v.length > 300) throw new ValidationError("origin must be a string");
  let u: URL;
  try { u = new URL(v); } catch { throw new ValidationError(`invalid origin: ${v}`); }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocalHost(u.hostname))) {
    throw new ValidationError("control origins must be https (http only for localhost)");
  }
  if (!/^[a-z0-9.-]+$/.test(u.hostname) && u.hostname !== "[::1]") throw new ValidationError("control origin host must be a plain hostname (no wildcards)");
  if (u.origin !== v.replace(/\/$/, "")) throw new ValidationError("control origin must be a bare origin (no path, no wildcard)");
  return u.origin;
}

function validateCountry(v: unknown): string | null {
  if (v === null || v === "") return null;
  if (typeof v !== "string" || !/^[A-Za-z]{2}$/.test(v)) throw new ValidationError("country must be a 2-letter code");
  const c = v.toUpperCase();
  if (SANCTIONED_COUNTRIES.has(c)) throw new ValidationError("country is sanctioned (OFAC) and cannot be used");
  return c;
}

function bool(k: string, v: unknown): boolean {
  if (typeof v !== "boolean") throw new ValidationError(`${k} must be a boolean`);
  return v;
}

function int(k: string, v: unknown, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new ValidationError(`${k} must be an integer in [${min}, ${max}]`);
  }
  return v;
}

function list(k: string, v: unknown, each: (x: unknown) => string): string[] {
  if (!Array.isArray(v) || v.length > MAX_LIST) throw new ValidationError(`${k} must be an array (max ${MAX_LIST})`);
  return [...new Set(v.map(each))];
}

/**
 * Strictly validate a settings patch. Unknown keys and wrong types are rejected;
 * nothing is coerced silently. Control-scope patches may only touch CONTROL_KEYS.
 */
export function validateSettingsPatch(input: unknown, scope: PatchScope): Partial<Settings> {
  if (!isPlainObject(input)) throw new ValidationError("settings patch must be an object");
  const out: Partial<Settings> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!(k in DEFAULT_SETTINGS)) throw new ValidationError(`unknown setting: ${k.slice(0, 40)}`);
    const key = k as keyof Settings;
    if (scope === "control" && !CONTROL_KEYS.has(key)) throw new ValidationError(`setting not changeable via control channel: ${k}`);
    switch (key) {
      case "enabled": case "sticky": case "plaintext":
        out[key] = bool(k, v); break;
      case "apiBase": out.apiBase = validateApiBase(v); break;
      case "gatewayHost":
        if (typeof v !== "string" || !HOST_RE.test(v)) throw new ValidationError("gatewayHost must be a hostname or IPv4");
        out.gatewayHost = v.toLowerCase(); break;
      case "gatewayPort": out.gatewayPort = int(k, v, 1, 65535); break;
      case "country": out.country = validateCountry(v); break;
      case "ipClass":
        if (v !== null && !IP_CLASSES.includes(v as IpClass)) throw new ValidationError("ipClass must be residential, dc, mobile or null");
        out.ipClass = v as IpClass | null; break;
      case "sessionId":
        if (v !== null && (typeof v !== "string" || !SESSION_RE.test(v))) throw new ValidationError("sessionId must be 1-64 alphanumeric chars");
        out.sessionId = v as string | null; break;
      case "rotateMinutes": out.rotateMinutes = int(k, v, 0, 1440); break;
      case "spendCapCents": out.spendCapCents = v === null ? null : int(k, v, 1, MAX_CENTS); break;
      case "controlExtensionIds":
        out.controlExtensionIds = list(k, v, (x) => {
          if (typeof x !== "string" || !EXT_ID_RE.test(x)) throw new ValidationError("extension ids are 32 chars a-p");
          return x;
        });
        break;
      case "controlPageOrigins": out.controlPageOrigins = list(k, v, validateOrigin); break;
      case "exitCheckUrl":
        if (v === null) { out.exitCheckUrl = null; break; }
        if (typeof v !== "string" || v.length > 500 || !/^https:\/\//.test(v)) throw new ValidationError("exitCheckUrl must be an https URL");
        try { new URL(v); } catch { throw new ValidationError("exitCheckUrl is not a valid URL"); }
        out.exitCheckUrl = v; break;
    }
  }
  return out;
}

export function validateApiKey(v: unknown): string {
  if (typeof v !== "string" || !API_KEY_RE.test(v)) throw new ValidationError("apiKey must be a dn_live_/dn_test_ key");
  return v;
}

/** Merge stored data over defaults, dropping anything invalid (never throws). */
export function normalizeSettings(stored: unknown): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS };
  if (!isPlainObject(stored)) return s;
  for (const [k, v] of Object.entries(stored)) {
    try { Object.assign(s, validateSettingsPatch({ [k]: v }, "operator")); } catch { /* drop invalid */ }
  }
  return s;
}
