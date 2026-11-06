import { invalidArg } from "./errors.js";
import { MAX_AMOUNT_CENTS } from "./constants.js";

export const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const EIP191_SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;
export const MAX_SIGNATURE_LENGTH = 200;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const HEX64_RE = /^[0-9a-f]{64}$/;
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,120}$/;
const MUSD_RE = /^[1-9][0-9]{0,15}$/;

export function validateAddress(address: unknown, name = "address"): string {
  if (typeof address !== "string" || !ETH_ADDRESS_RE.test(address)) {
    throw invalidArg(`${name} must be an Ethereum address (0x followed by 40 hex characters)`);
  }
  return address;
}

export function validateSignature(signature: unknown, name = "signature"): string {
  if (typeof signature !== "string") throw invalidArg(`${name} must be a string`);
  if (signature.length > MAX_SIGNATURE_LENGTH) throw invalidArg(`${name} must not exceed ${MAX_SIGNATURE_LENGTH} characters`);
  if (!EIP191_SIGNATURE_RE.test(signature)) throw invalidArg(`${name} must be an EIP-191 signature (0x followed by 130 hex characters)`);
  return signature;
}

/** 0 < amountCents <= 2,147,483,647, integer. */
export function validateCents(amountCents: unknown, name = "amountCents", allowZero = false): number {
  const ok = typeof amountCents === "number" && Number.isInteger(amountCents)
    && (allowZero ? amountCents >= 0 : amountCents > 0) && amountCents <= MAX_AMOUNT_CENTS;
  if (!ok) throw invalidArg(`${name} must be an integer ${allowZero ? ">= 0" : "> 0"} and <= ${MAX_AMOUNT_CENTS}`);
  return amountCents as number;
}

export type MusdInput = bigint | string | number;

/** Normalise a µUSD amount (bigint, decimal-integer string, or safe integer) to its canonical string; enforce [min, max]. */
export function toMusd(v: MusdInput, min: bigint, max: bigint, name = "amountMusd"): string {
  let n: bigint;
  if (typeof v === "bigint") n = v;
  else if (typeof v === "number" && Number.isSafeInteger(v)) n = BigInt(v);
  else if (typeof v === "string" && MUSD_RE.test(v)) n = BigInt(v);
  else throw invalidArg(`${name} must be a positive integer number of µUSD (bigint, digit string or safe integer)`);
  if (n < min || n > max) throw invalidArg(`${name} must be between ${min} and ${max} µUSD`);
  return n.toString();
}

export function validateIdempotencyKey(key: unknown): string {
  if (typeof key !== "string" || !IDEMPOTENCY_KEY_RE.test(key)) {
    throw invalidArg("idempotencyKey must be 8-120 characters of [A-Za-z0-9_-]");
  }
  return key;
}

export function validateUuid(v: unknown, name: string): string {
  if (typeof v !== "string" || !UUID_RE.test(v)) throw invalidArg(`${name} must be a UUID`);
  return v;
}

export function validateNonEmpty(v: unknown, name: string, max = 256): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max) throw invalidArg(`${name} must be a non-empty string (max ${max})`);
  return v;
}

export function validateIntRange(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw invalidArg(`${name} must be an integer in [${min}, ${max}]`);
  return v;
}

/** Path segment encoder — every user-supplied path parameter goes through this. */
export function seg(v: string): string {
  return encodeURIComponent(v);
}

export function qs(params: Record<string, string | number | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}
