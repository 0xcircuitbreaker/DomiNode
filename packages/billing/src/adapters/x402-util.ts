import { createLogger } from "@dominusnode/shared";
import type { X402Facilitator, X402Settlement } from "../x402.js";

const log = createLogger("billing:x402");

// ─── Prototype Pollution Protection ─────────────────────────────────

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Recursively strip dangerous keys to prevent prototype pollution */
export function stripDangerousKeys(obj: Record<string, unknown>, depth = 0): void {
  if (depth > 5) return; // prevent deep recursion
  for (const key of Object.keys(obj)) {
    if (DANGEROUS_KEYS.has(key)) {
      delete obj[key];
    } else if (typeof obj[key] === "object" && obj[key] !== null && !Array.isArray(obj[key])) {
      stripDangerousKeys(obj[key] as Record<string, unknown>, depth + 1);
    }
  }
}

/** Parse USDC base units from facilitator response, returning 0 on invalid input */
export function parseUsdcAmount(raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw)) return 0;
  const val = parseInt(raw, 10);
  if (!Number.isSafeInteger(val) || val < 0) return 0;
  return val;
}

const TX_HASH_RE = /^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{43,90})$/;

/**
 * Validate a facilitator settle response body. Throws unless the facilitator
 * explicitly reports success with a well-formed tx hash and (when known)
 * a settled amount covering the required amount.
 */
export function validateSettleResponse(
  settleText: string,
  facilitator: X402Facilitator,
  requiredAmount?: string,
): X402Settlement {
  let result: { success?: unknown; txHash?: unknown; transaction?: unknown; amount?: unknown; errorReason?: unknown };
  try {
    result = JSON.parse(settleText);
  } catch {
    throw new Error(`${facilitator} settle response invalid`);
  }
  if (typeof result !== "object" || result === null || result.success !== true) {
    log.error("x402 settle reported failure", {
      facilitator,
      errorReason: typeof result?.errorReason === "string" ? result.errorReason.slice(0, 200) : undefined,
    });
    throw new Error(`${facilitator} settlement not successful`);
  }
  const txHash = typeof result.txHash === "string" ? result.txHash : typeof result.transaction === "string" ? result.transaction : "";
  if (!TX_HASH_RE.test(txHash)) {
    throw new Error(`${facilitator} settlement missing valid txHash`);
  }
  const amount = typeof result.amount === "string" ? result.amount : "0";
  if (requiredAmount !== undefined) {
    const required = parseUsdcAmount(requiredAmount);
    const settled = parseUsdcAmount(amount);
    if (required === 0 || settled < required) {
      throw new Error(`${facilitator} settled amount insufficient`);
    }
  }
  return { txHash, amountSettled: amount, facilitator };
}

