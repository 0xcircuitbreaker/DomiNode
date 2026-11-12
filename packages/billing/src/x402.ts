import * as crypto from "node:crypto";
import { createLogger, query } from "@dominusnode/shared";
import { stripDangerousKeys, validateSettleResponse } from "./adapters/x402-util.js";
import { getFacilitator, facilitatorOverride } from "./adapters/facilitators/index.js";

export { validateSettleResponse };

const log = createLogger("billing:x402");

// ─── Types ──────────────────────────────────────────────────────────

export type X402Facilitator = "coinbase" | "payai";

// USDC contract addresses for well-known chains.
// These are Circle's official deployments (EVM) and the canonical SPL mint (Solana).
// For chains not listed here, operators must set X402_USDC_ADDRESS_{NETWORK_UPPER} env var.
// E.g., X402_USDC_ADDRESS_SEI, X402_USDC_ADDRESS_SKALE_BASE, X402_USDC_ADDRESS_IOTEX, etc.
const USDC_ASSET_ADDRESSES: Record<string, string> = {
  "base":          "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Circle official — Base mainnet
  "base-sepolia":  "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Circle official — Base Sepolia
  "solana":        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // Circle official — Solana mainnet
  "solana-devnet": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", // Solana devnet test USDC
  "polygon":       "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", // Circle native USDC — Polygon PoS
  "avalanche":     "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", // Circle official — Avalanche C-Chain
};

/**
 * Look up the USDC token contract address for a given x402 network.
 * Checks the hardcoded map first; falls back to X402_USDC_ADDRESS_{NETWORK_SCREAMING_SNAKE} env var.
 * Returns null if the address is unknown — callers should skip the chain and warn.
 */
function getUsdcAssetAddress(network: string): string | null {
  if (USDC_ASSET_ADDRESSES[network]) return USDC_ASSET_ADDRESSES[network];
  const envKey = `X402_USDC_ADDRESS_${network.toUpperCase().replace(/-/g, "_")}`;
  return process.env[envKey]?.trim() || null;
}

// PayAI-supported EVM chains beyond Solana.
// Each entry maps an env var holding the receiving address → x402 network string.
// Operators configure whichever chains they want to accept by setting the env vars.
// For exotic chains (sei, skale-base, iotex, xlayer, peaq) also set the corresponding
// X402_USDC_ADDRESS_{CHAIN} env var with the bridged USDC contract address on that network.
const PAYAI_EVM_CHAINS: { envVar: string; network: string }[] = [
  { envVar: "X402_RECEIVING_ADDRESS_POLYGON",   network: "polygon" },    // Circle native USDC
  { envVar: "X402_RECEIVING_ADDRESS_AVALANCHE",  network: "avalanche" }, // Circle native USDC
  { envVar: "X402_RECEIVING_ADDRESS_SEI",        network: "sei" },       // Requires X402_USDC_ADDRESS_SEI
  { envVar: "X402_RECEIVING_ADDRESS_SKALE",      network: "skale-base" },// Requires X402_USDC_ADDRESS_SKALE_BASE
  { envVar: "X402_RECEIVING_ADDRESS_IOTEX",      network: "iotex" },     // Requires X402_USDC_ADDRESS_IOTEX
  { envVar: "X402_RECEIVING_ADDRESS_XLAYER",     network: "xlayer" },    // Requires X402_USDC_ADDRESS_XLAYER
  { envVar: "X402_RECEIVING_ADDRESS_PEAQ",       network: "peaq" },      // Requires X402_USDC_ADDRESS_PEAQ
];

// Network identifiers that route to the PayAI facilitator.
// Anything NOT in this set but with an 0x address → Coinbase (Base).
const PAYAI_NETWORKS = new Set([
  "solana", "solana-devnet",
  "polygon", "polygon-amoy",
  "avalanche", "avalanche-fuji",
  "sei", "sei-testnet",
  "peaq",
  "iotex",
  "xlayer", "xlayer-testnet",
  "skale-base", "skale-base-sepolia",
]);

export interface X402Requirements {
  version: string;
  /** Spec field name for the protocol version (x402 v1 PaymentRequired). */
  x402Version?: 1;
  accepts: X402PaymentOption[];
  /** v2-style resource info + Bazaar discovery extension (ignored by v1 clients). */
  resource?: { url: string; description: string; mimeType: string };
  extensions?: { bazaar: BazaarExtension };
}

/**
 * x402 Bazaar discovery metadata (docs/agent-network/PAYMENTS.md "Bazaar").
 * v1: accepts[].description / mimeType / outputSchema{input{discoverable}, output};
 * v2: resource{url,description,mimeType} + extensions.bazaar{info, schema}.
 */
export interface BazaarExtension {
  info: {
    input: { type: "http"; method: "GET"; queryParams: Record<string, string>; headers: Record<string, string> };
    output: { type: "json"; example: Record<string, unknown> };
  };
  schema: Record<string, unknown>;
}

/** Bazaar/CDP reject descriptions over 500 characters. */
export const X402_RESOURCE_DESCRIPTION =
  "Dominus Node relay gateway: pay-per-request HTTPS egress through agent-run residential, mobile or datacenter exit nodes. " +
  "Send any GET/HEAD through the proxy (HTTP :8080 or SOCKS5 :1080) with an X-PAYMENT header; one payment buys a fixed byte allowance. " +
  "Proxy username flags: country-XX, class-residential|dc|mobile, session-<id>. HTTPS stays end-to-end TLS.";

const OUTPUT_EXAMPLE = { status: 200, note: "Upstream response relayed byte-for-byte through the exit node; 402 JSON with payment requirements when unpaid." };

export function bazaarExtension(): BazaarExtension {
  return {
    info: {
      input: {
        type: "http", method: "GET",
        queryParams: {},
        headers: { "Proxy-Authorization": "Basic base64(country-US-class-residential:)", "X-PAYMENT": "<x402 payment payload>" },
      },
      output: { type: "json", example: OUTPUT_EXAMPLE },
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: {
            type: { const: "http" },
            method: { enum: ["GET", "HEAD"] },
            queryParams: { type: "object" },
            headers: { type: "object" },
          },
          required: ["type", "method"],
        },
        output: { type: "object", properties: { type: { const: "json" }, example: { type: "object" } }, required: ["type"] },
      },
      required: ["input"],
    },
  };
}

/** v1 outputSchema (Bazaar indexes resources whose input is marked discoverable). */
function v1OutputSchema() {
  return {
    input: {
      type: "http", method: "GET", discoverable: true,
      headerFields: {
        "Proxy-Authorization": { type: "string", required: false, description: "Basic auth; username carries flags country-XX, class-residential|dc|mobile, session-<id>; empty password" },
        "X-PAYMENT": { type: "string", required: true, description: "x402 payment payload" },
      },
    },
    output: { type: "object", description: "Upstream response relayed through an exit node", example: OUTPUT_EXAMPLE },
  };
}

export interface X402PaymentOption {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  payTo: string;
  asset: string;           // ERC-20 contract address (or SPL mint for Solana)
  extra: {
    facilitator: X402Facilitator;
    name: string;          // Token symbol, e.g. "USDC"
    version: string;       // EIP-3009 authorization version: "2" for EVM, "1" for Solana
  };
  /** Bazaar discovery metadata (v1 PaymentRequirements fields). */
  description?: string;
  mimeType?: string;
  maxTimeoutSeconds?: number;
  outputSchema?: Record<string, unknown>;
}

export interface X402VerifyResult {
  valid: boolean;
  payer: string;
  amountUsd: string;
  facilitator: X402Facilitator;
  error?: string;
}

export interface X402Settlement {
  txHash: string;
  amountSettled: string;
  facilitator: X402Facilitator;
}

// ─── Config ─────────────────────────────────────────────────────────

export function isX402Enabled(): boolean {
  return process.env["X402_ENABLED"] === "true";
}

export function getDcPricePerRequestUsd(): string {
  return process.env["X402_DC_PRICE_PER_REQUEST_USD"] ?? "0.001";
}

export function getResPricePerRequestUsd(): string {
  return process.env["X402_RES_PRICE_PER_REQUEST_USD"] ?? "0.005";
}

function getMaxRequestBodyBytes(): number {
  const val = parseInt(process.env["X402_MAX_REQUEST_BODY_BYTES"] ?? "10485760", 10);
  if (isNaN(val) || val < 1024 || val > 104857600) {
    throw new Error("X402_MAX_REQUEST_BODY_BYTES must be between 1024 and 104857600");
  }
  return val;
}

// ─── Facilitator Detection ──────────────────────────────────────────

/**
 * Detect which facilitator to use based on the X-PAYMENT header content.
 * - Coinbase: Base / base-sepolia (0x EVM address)
 * - PayAI: Solana (base58) OR any PAYAI_NETWORKS chain (Polygon, Avalanche, Sei, SKALE, IoTeX, XLayer)
 * Falls back to coinbase if ambiguous.
 */
export function detectFacilitator(paymentHeader: string): X402Facilitator {
  // X402_FACILITATOR env (allowlisted values only) overrides detection.
  const forced = facilitatorOverride();
  if (forced) return forced;
  if (!paymentHeader || paymentHeader.length === 0) {
    return "coinbase"; // default
  }

  // Try to parse as JSON first
  try {
    const parsed = JSON.parse(paymentHeader);
    // Recursive prototype pollution protection
    if (typeof parsed === "object" && parsed !== null) {
      stripDangerousKeys(parsed);
    }
    // Explicit facilitator field wins unconditionally
    if (parsed.facilitator === "payai") return "payai";
    if (parsed.facilitator === "coinbase") return "coinbase";
    // Network field: PayAI handles its network set; Coinbase handles Base
    if (typeof parsed.network === "string") {
      if (PAYAI_NETWORKS.has(parsed.network)) return "payai";
      if (parsed.network === "base" || parsed.network === "base-sepolia") return "coinbase";
    }
    // Address format as last resort
    if (typeof parsed.payTo === "string") {
      // Solana base58 (no 0x prefix)
      if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(parsed.payTo)) return "payai";
      // EVM 0x — default to Coinbase (Base) unless network said otherwise above
      if (parsed.payTo.startsWith("0x")) return "coinbase";
    }
  } catch {
    // Not JSON — check raw content patterns
    if (paymentHeader.includes('"facilitator":"payai"')) return "payai";
    if (paymentHeader.includes('"facilitator":"coinbase"')) return "coinbase";
    // Check all PayAI network strings in raw payload
    for (const net of PAYAI_NETWORKS) {
      if (paymentHeader.includes(`"network":"${net}"`)) return "payai";
    }
  }

  return "coinbase"; // default fallback
}

// ─── USDC Amount Helpers ────────────────────────────────────────────

// ─── Build Requirements ─────────────────────────────────────────────

/**
 * Build x402 payment requirements for a given pool type.
 * Returns the JSON structure that goes in the 402 response body.
 */
export const MAX_X402_AMOUNT_MUSD = 10_000_000_000n; // $10,000 sanity ceiling

export function buildX402Requirements(arg: "dc" | "residential" | { amountMusd: bigint }): X402Requirements {
  let amountUsdc: string;
  if (typeof arg === "object") {
    // Relay pricing (DESIGN.md §7): USDC has 6 decimals, so 1 µUSD == 1 base unit.
    if (typeof arg.amountMusd !== "bigint" || arg.amountMusd < 1n || arg.amountMusd > MAX_X402_AMOUNT_MUSD) {
      throw new Error("Invalid x402 amount");
    }
    amountUsdc = arg.amountMusd.toString();
  } else {
    const poolType = arg;
    const priceUsd = poolType === "dc" ? getDcPricePerRequestUsd() : getResPricePerRequestUsd();
    // Convert USD string to USDC base units (6 decimals)
    const priceFloat = parseFloat(priceUsd);
    if (isNaN(priceFloat) || priceFloat <= 0) {
      throw new Error(`Invalid x402 price for ${poolType}: ${priceUsd}`);
    }
    amountUsdc = Math.ceil(priceFloat * 1_000_000).toString();
  }

  const accepts: X402PaymentOption[] = [];
  const resourceUrl = `https://${process.env["PROXY_PUBLIC_HOST"] ?? "proxy.dominusnode.com"}`;

  // Coinbase facilitator — Base chain (USDC, EIP-3009 gasless transfer)
  const evmAddr = process.env["X402_RECEIVING_ADDRESS"];
  if (evmAddr) {
    // H-1: Validate EVM address format
    if (!/^0x[0-9a-fA-F]{40}$/.test(evmAddr)) {
      log.warn("Invalid X402_RECEIVING_ADDRESS format — must be 0x + 40 hex chars", { addr: evmAddr.slice(0, 6) });
    } else {
      const network = process.env["X402_NETWORK"] ?? "base-sepolia";
      const assetAddress = getUsdcAssetAddress(network);
      if (!assetAddress) {
        log.warn(`No USDC asset address for Coinbase network ${network} — set X402_USDC_ADDRESS_${network.toUpperCase().replace(/-/g, "_")}`);
      } else {
        accepts.push({
          scheme: "exact",
          network,
          maxAmountRequired: amountUsdc,
          resource: resourceUrl,
          payTo: evmAddr,
          asset: assetAddress,
          extra: { facilitator: "coinbase", name: "USDC", version: "2" },
        });
      }
    }
  }

  // PayAI facilitator — Solana (base58 address, SPL USDC)
  const solAddr = process.env["X402_RECEIVING_ADDRESS_SOLANA"];
  if (solAddr) {
    // H-1: Validate Solana address format (base58, 32-44 chars)
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(solAddr)) {
      log.warn("Invalid X402_RECEIVING_ADDRESS_SOLANA format", { addr: solAddr.slice(0, 6) });
    } else {
      const assetAddress = getUsdcAssetAddress("solana");
      accepts.push({
        scheme: "exact",
        network: "solana",
        maxAmountRequired: amountUsdc,
        resource: resourceUrl,
        payTo: solAddr,
        asset: assetAddress!, // Always known — Circle official SPL mint
        extra: { facilitator: "payai", name: "USDC", version: "1" },
      });
    }
  }

  // PayAI facilitator — EVM chains (Polygon, Avalanche, Sei, SKALE, IoTeX, XLayer, Peaq)
  // Each uses an 0x EVM address on the respective chain, all settled via PayAI's facilitator.
  // Operators opt-in per chain by setting the corresponding env var.
  // For chains without a hardcoded USDC address, also set X402_USDC_ADDRESS_{CHAIN}.
  for (const { envVar, network } of PAYAI_EVM_CHAINS) {
    const addr = process.env[envVar]?.trim();
    if (!addr) continue;
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
      log.warn(`Invalid ${envVar} format — must be 0x + 40 hex chars`, { network, addr: addr.slice(0, 6) });
      continue;
    }
    const assetAddress = getUsdcAssetAddress(network);
    if (!assetAddress) {
      log.warn(`No USDC asset address for PayAI network ${network} — set X402_USDC_ADDRESS_${network.toUpperCase().replace(/-/g, "_")} to the bridged USDC contract on that chain`);
      continue;
    }
    accepts.push({
      scheme: "exact",
      network,
      maxAmountRequired: amountUsdc,
      resource: resourceUrl,
      payTo: addr,
      asset: assetAddress,
      extra: { facilitator: "payai", name: "USDC", version: "2" },
    });
  }

  // H-8: Warn if no accepts and x402 is enabled
  if (accepts.length === 0 && isX402Enabled()) {
    log.error("x402 is enabled but no valid receiving addresses configured");
  }

  const discovery = { description: X402_RESOURCE_DESCRIPTION, mimeType: "application/json", maxTimeoutSeconds: 60, outputSchema: v1OutputSchema() };
  return {
    version: "1",
    x402Version: 1,
    accepts: accepts.map((a) => ({ ...a, ...discovery })),
    resource: { url: resourceUrl, description: X402_RESOURCE_DESCRIPTION, mimeType: "application/json" },
    extensions: { bazaar: bazaarExtension() },
  };
}

// ─── Replay Protection ──────────────────────────────────────────────

/**
 * C-5: Hash the payment header for replay detection.
 */
export function hashPaymentHeader(paymentHeader: string): string {
  const key = canonicalReplayKey(paymentHeader);
  return crypto.createHash("sha256").update(key ?? `raw:${paymentHeader}`).digest("hex");
}

/**
 * Derive a replay key from the SIGNED fields of the payment payload so that
 * re-encodings (whitespace, key order, unsigned fields) map to the same key.
 * Returns null if the header cannot be parsed (falls back to raw hashing).
 */
function canonicalReplayKey(paymentHeader: string): string | null {
  let parsed: unknown;
  const trimmed = paymentHeader.trim();
  try {
    parsed = JSON.parse(trimmed.startsWith("{") ? trimmed : Buffer.from(trimmed, "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const network = typeof obj["network"] === "string" ? (obj["network"] as string).toLowerCase() : "";
  const payload = obj["payload"];
  if (typeof payload !== "object" || payload === null) return null;
  const pl = payload as Record<string, unknown>;
  const auth = pl["authorization"];
  if (typeof auth === "object" && auth !== null) {
    const a = auth as Record<string, unknown>;
    if (typeof a["from"] === "string" && typeof a["nonce"] === "string") {
      return `eip3009:${network}:${(a["from"] as string).toLowerCase()}:${(a["nonce"] as string).toLowerCase()}`;
    }
  }
  if (typeof pl["signature"] === "string" && (pl["signature"] as string).length > 0) {
    return `sig:${network}:${pl["signature"] as string}`;
  }
  if (typeof pl["transaction"] === "string" && (pl["transaction"] as string).length > 0) {
    return `tx:${network}:${pl["transaction"] as string}`;
  }
  return null;
}

/**
 * Atomic replay guard — INSERT with ON CONFLICT to prevent TOCTOU race.
 * Returns true if the hash was claimed (proceed), false if already used (replay).
 * Only settled transactions block replays (failed settlements don't poison).
 */
export async function claimPaymentHash(paymentHash: string): Promise<boolean> {
  const result = await query(
    `INSERT INTO x402_transactions (facilitator, payer_address, amount_usd, pool_type, status, payment_hash)
     VALUES ('coinbase', '', '0', 'dc', 'pending', $1)
     ON CONFLICT (payment_hash) DO NOTHING`,
    [paymentHash],
  );
  return (result.rowCount ?? 0) > 0; // true = claimed, false = replay
}

// ─── Verify Payment ─────────────────────────────────────────────────

/**
 * Verify an x402 payment header against requirements.
 * This calls the appropriate facilitator API to validate the payment.
 */
export async function verifyX402Payment(
  paymentHeader: string,
  requirements: X402Requirements,
): Promise<X402VerifyResult> {
  if (!paymentHeader || paymentHeader.length === 0) {
    return { valid: false, payer: "", amountUsd: "0", facilitator: "coinbase", error: "Empty payment header" };
  }

  // Cap payment header size to prevent abuse
  if (paymentHeader.length > 10_000) {
    return { valid: false, payer: "", amountUsd: "0", facilitator: "coinbase", error: "Payment header too large" };
  }

  // H-8: Reject if no accepts configured
  if (requirements.accepts.length === 0) {
    return { valid: false, payer: "", amountUsd: "0", facilitator: "coinbase", error: "No payment facilitators configured" };
  }

  // Atomic replay guard — claim the hash BEFORE verify/settle
  const paymentHash = hashPaymentHeader(paymentHeader);
  try {
    const claimed = await claimPaymentHash(paymentHash);
    if (!claimed) {
      return { valid: false, payer: "", amountUsd: "0", facilitator: "coinbase", error: "Payment already used" };
    }
  } catch (err) {
    // DB check failed — fail closed
    log.error("replay claim failed", { error: err instanceof Error ? err.message : String(err) });
    return { valid: false, payer: "", amountUsd: "0", facilitator: "coinbase", error: "Payment verification temporarily unavailable" };
  }

  const facilitator = detectFacilitator(paymentHeader);

  try {
    const result: X402VerifyResult = await getFacilitator(facilitator).verify(paymentHeader, requirements);
    // If verification returned invalid, release the claimed hash so
    // the same payment can be retried (e.g., after transient facilitator error)
    if (!result.valid) {
      await releasePaymentHash(paymentHash).catch(() => {});
    }
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("x402 verification failed", { facilitator, error: msg });
    // Release hash so payment can be retried after transient errors
    await releasePaymentHash(paymentHash).catch(() => {});
    // H-2: Generic error to client — specific error logged server-side
    return { valid: false, payer: "", amountUsd: "0", facilitator, error: "Payment verification failed" };
  }
}

// ─── Settle Payment ─────────────────────────────────────────────────

/**
 * Settle (finalize) an x402 payment.
 * C-2: Settlement is now called BEFORE proxying to prevent free service.
 */
export async function settleX402Payment(
  paymentHeader: string,
  facilitator: X402Facilitator,
  requirements?: X402Requirements,
): Promise<X402Settlement> {
  const reqs = requirements?.accepts.find((a) => (a.extra as { facilitator?: string } | undefined)?.facilitator === facilitator)
    ?? requirements?.accepts[0];
  return getFacilitator(facilitator).settle(paymentHeader, reqs);
}

// ─── Record Transaction ─────────────────────────────────────────────

/**
 * Update a pending x402 transaction (claimed by claimPaymentHash) with settlement result.
 * This replaces the old INSERT-after-settle pattern with UPDATE-after-settle.
 */
export async function updateX402Transaction(
  paymentHash: string,
  facilitator: X402Facilitator,
  payerAddress: string,
  amountUsd: string,
  txHash: string | null,
  poolType: "dc" | "residential" | "mobile" | "masked" | "any",
  targetHost: string,
  status: "settled" | "failed",
): Promise<void> {
  const safePayer = payerAddress.slice(0, 255);
  const safeAmount = /^\d+\.?\d*$/.test(amountUsd) ? amountUsd.slice(0, 50) : "0";
  const safeTxHash = txHash ? txHash.slice(0, 255) : null;
  const safeTarget = targetHost.slice(0, 255);

  await query(
    `UPDATE x402_transactions
     SET facilitator = $1, payer_address = $2, amount_usd = $3, tx_hash = $4,
         pool_type = $5, target_host = $6, status = $7
     WHERE payment_hash = $8`,
    [facilitator, safePayer, safeAmount, safeTxHash, poolType, safeTarget, status, paymentHash],
  );
}

// ─── Release Payment Hash ────────────────────────────────────────────

/**
 * Release a pending payment hash so the same payment can be retried
 * after a failed settlement. Only deletes rows with status='pending'.
 */
export async function releasePaymentHash(paymentHash: string): Promise<void> {
  await query(
    "DELETE FROM x402_transactions WHERE payment_hash = $1 AND status = 'pending'",
    [paymentHash],
  );
}

// ─── Response Size Config ────────────────────────────────────────────

/**
 * Max response bytes per x402 request.
 * Prevents bandwidth theft through unlimited data transfer for a single micropayment.
 */
export function getX402MaxResponseBytes(): number {
  const val = parseInt(process.env["X402_MAX_RESPONSE_BYTES"] ?? "10485760", 10);
  if (isNaN(val) || val < 1024 || val > 104857600) {
    throw new Error("X402_MAX_RESPONSE_BYTES must be between 1024 and 104857600");
  }
  return val;
}

// ─── Re-exports for convenience ─────────────────────────────────────

export { getMaxRequestBodyBytes, hashPaymentHeader as _hashPaymentHeader };
