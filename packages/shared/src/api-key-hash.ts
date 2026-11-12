/**
 * API key hashing (SECURITY_ARCHITECTURE.md §2.6).
 *
 * v1: SHA-256(key) hex. Legacy; still accepted for lookup.
 * v2: HMAC-SHA256(pepper, key) hex, with the pepper read from
 *     API_KEY_PEPPER_FILE (outside the database). A DB dump alone then cannot
 *     confirm or correlate a candidate key.
 *
 * Both are 64 hex chars and live in api_keys.key_hash. A v1 row is rewritten
 * to v2 on its next successful authentication (lazy migration). Without a
 * pepper everything stays v1, so the change is safe to deploy before the
 * pepper file exists. The gateway and the API MUST share the same pepper.
 *
 * Plain HMAC (not Argon2id) is right here: keys are 256-bit random, so a slow
 * KDF adds per-request latency and no security.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";

export const API_KEY_PEPPER_MIN_BYTES = 32;

let pepper: Buffer | null | undefined;

/**
 * Load the pepper once. Returns null when API_KEY_PEPPER_FILE is unset.
 * Throws (fail closed) when the file is set but unreadable or too short, so a
 * misconfigured deployment does not silently keep writing v1 hashes.
 */
export function apiKeyPepper(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (p: string) => Buffer = (p) => fs.readFileSync(p),
): Buffer | null {
  if (pepper !== undefined) return pepper;
  const file = env["API_KEY_PEPPER_FILE"];
  if (!file || file.trim() === "") {
    pepper = null;
    return pepper;
  }
  const raw = readFile(file.trim());
  // Accept a binary file or a text file (trailing newline trimmed).
  const txt = raw.toString("utf8").trim();
  const buf = /^[0-9a-fA-F]+$/.test(txt) && txt.length % 2 === 0 ? Buffer.from(txt, "hex") : Buffer.from(txt, "utf8");
  if (buf.length < API_KEY_PEPPER_MIN_BYTES) {
    throw new Error(`API_KEY_PEPPER_FILE must hold at least ${API_KEY_PEPPER_MIN_BYTES} bytes (generate: openssl rand -hex 32)`);
  }
  pepper = buf;
  return pepper;
}

/** Test hook: forget the cached pepper (or set one). */
export function _setApiKeyPepperForTest(p: Buffer | null | undefined): void {
  pepper = p;
}

/** v1 legacy hash: SHA-256 hex. */
export function hashApiKeyV1(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/** v2 hash: HMAC-SHA256(pepper, raw) hex. */
export function hashApiKeyV2(raw: string, p: Buffer): string {
  return crypto.createHmac("sha256", p).update(raw).digest("hex");
}

/** Hash to store for a new key: v2 when a pepper is configured, else v1. */
export function hashApiKeyForStorage(raw: string): string {
  const p = apiKeyPepper();
  return p ? hashApiKeyV2(raw, p) : hashApiKeyV1(raw);
}

export interface ApiKeyLookup {
  /** Hashes to look up, preferred first ([v2, v1] with a pepper, [v1] without). */
  candidates: string[];
  /** The hash the row should hold after migration. */
  current: string;
}

export function apiKeyLookup(raw: string): ApiKeyLookup {
  const v1 = hashApiKeyV1(raw);
  const p = apiKeyPepper();
  if (!p) return { candidates: [v1], current: v1 };
  const v2 = hashApiKeyV2(raw, p);
  return { candidates: [v2, v1], current: v2 };
}

/** Constant-time comparison of two hex digests. */
export function hashEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
