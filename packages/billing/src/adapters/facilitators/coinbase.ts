import * as crypto from "node:crypto";
import { createLogger } from "@dominusnode/shared";
import type { X402Requirements, X402VerifyResult, X402Settlement, X402PaymentOption } from "../../x402.js";
import { stripDangerousKeys } from "../x402-util.js";
import type { X402FacilitatorAdapter } from "../types.js";
import { FACILITATOR_URLS } from "./urls.js";

const log = createLogger("billing:x402");

/**
 * Coinbase CDP x402 facilitator (docs/agent-network/PAYMENTS.md "Coinbase CDP facilitator").
 *
 * Wire format (CDP API v2, POST /platform/v2/x402/verify and /settle):
 *   request  {x402Version, paymentPayload, paymentRequirements}
 *   verify   {isValid, invalidReason?, invalidMessage?, payer}
 *   settle   {success, errorReason?, errorMessage?, transaction, network, payer}
 * Auth: `Authorization: Bearer <JWT>` signed with the CDP Secret API key
 * (EdDSA/Ed25519, or ES256 for legacy PEM EC keys), 120 s lifetime, bound to
 * "METHOD host/path" in the `uri` claim.
 *
 * The paid amount is taken from the payer-signed EIP-3009 authorization `value`
 * (exact scheme), never from a facilitator-supplied field. Every failure is
 * fail-closed: verify returns valid:false, settle throws.
 */

const MAX_RESPONSE_BYTES = 10_000;
const MAX_HEADER_BYTES = 10_000;
const JWT_TTL_S = 120;
const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^\d{1,78}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

// ─── CDP JWT ────────────────────────────────────────────────────────

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/**
 * Build the CDP Bearer JWT for one request. `secret` is either the base64 Ed25519
 * key (64 bytes: seed || public key) or a PEM EC private key (ES256).
 */
export function buildCdpJwt(
  keyId: string,
  secret: string,
  method: string,
  url: string,
  nowS: number = Math.floor(Date.now() / 1000),
): string {
  const u = new URL(url);
  const pem = secret.includes("-----BEGIN") ? secret.replace(/\\n/g, "\n") : null;
  let key: crypto.KeyObject;
  let alg: "EdDSA" | "ES256";
  if (pem) {
    key = crypto.createPrivateKey(pem);
    if (key.asymmetricKeyType !== "ec") throw new Error("CDP PEM key must be an EC (P-256) key");
    alg = "ES256";
  } else {
    const raw = Buffer.from(secret, "base64");
    if (raw.length !== 64) throw new Error("CDP Ed25519 secret must decode to 64 bytes");
    key = crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, raw.subarray(0, 32)]), format: "der", type: "pkcs8" });
    alg = "EdDSA";
  }
  const header = { alg, kid: keyId, typ: "JWT", nonce: crypto.randomBytes(16).toString("hex") };
  const claims = {
    sub: keyId, iss: "cdp", aud: ["cdp_service"], nbf: nowS, exp: nowS + JWT_TTL_S,
    uri: `${method.toUpperCase()} ${u.host}${u.pathname}`,
  };
  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  const sig = alg === "EdDSA"
    ? crypto.sign(null, Buffer.from(signingInput), key)
    : crypto.sign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${b64u(sig)}`;
}

// ─── Payment payload (exact scheme, EVM) ────────────────────────────

export interface ExactEvmPayload {
  x402Version: number;
  scheme: "exact";
  network: string;
  payload: {
    signature: string;
    authorization: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string };
  };
}

/** X-PAYMENT header: base64(JSON PaymentPayload); raw JSON is accepted too. */
export function decodeExactPayload(header: string): ExactEvmPayload | null {
  if (!header || header.length > MAX_HEADER_BYTES) return null;
  const text = header.trim().startsWith("{") ? header : Buffer.from(header, "base64").toString("utf8");
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  stripDangerousKeys(obj as Record<string, unknown>);
  const p = obj as Record<string, unknown>;
  const inner = p["payload"] as Record<string, unknown> | undefined;
  const a = inner?.["authorization"] as Record<string, unknown> | undefined;
  if (p["x402Version"] !== 1 || p["scheme"] !== "exact" || typeof p["network"] !== "string") return null;
  if (!inner || typeof inner["signature"] !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(inner["signature"])) return null;
  if (!a || typeof a !== "object") return null;
  const s = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
  if (!EVM_ADDR.test(s("from")) || !EVM_ADDR.test(s("to"))) return null;
  if (!UINT.test(s("value")) || !UINT.test(s("validAfter")) || !UINT.test(s("validBefore"))) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(s("nonce"))) return null;
  return {
    x402Version: 1, scheme: "exact", network: p["network"] as string,
    payload: {
      signature: inner["signature"] as string,
      authorization: { from: s("from"), to: s("to"), value: s("value"), validAfter: s("validAfter"), validBefore: s("validBefore"), nonce: s("nonce") },
    },
  };
}

/** v1 PaymentRequirements as CDP expects them (our routing hint `extra.facilitator` is dropped). */
function toCdpRequirements(accept: X402PaymentOption): Record<string, unknown> {
  return {
    scheme: accept.scheme,
    network: accept.network,
    maxAmountRequired: accept.maxAmountRequired,
    resource: accept.resource,
    description: accept.description ?? "",
    mimeType: accept.mimeType ?? "",
    payTo: accept.payTo,
    asset: accept.asset,
    maxTimeoutSeconds: accept.maxTimeoutSeconds ?? 60,
    ...(accept.outputSchema ? { outputSchema: accept.outputSchema } : {}),
    extra: { name: accept.extra.name, version: accept.extra.version },
  };
}

/** Local checks binding the signed authorization to our requirements. Returns the paid amount or an error. */
function checkAgainstRequirements(p: ExactEvmPayload, accept: X402PaymentOption): { amount: bigint } | { error: string } {
  if (accept.scheme !== "exact") return { error: "Unsupported scheme" };
  if (p.network !== accept.network) return { error: "Network mismatch" };
  if (p.payload.authorization.to.toLowerCase() !== accept.payTo.toLowerCase()) return { error: "Payment recipient mismatch" };
  if (!/^\d+$/.test(accept.maxAmountRequired)) return { error: "Payment amount insufficient" };
  const amount = BigInt(p.payload.authorization.value);
  if (amount <= 0n || amount < BigInt(accept.maxAmountRequired)) return { error: "Payment amount insufficient" };
  return { amount };
}

const usdOf = (amount: bigint) => {
  const whole = amount / 1_000_000n;
  const frac = (amount % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${frac}`;
};

function credentials(): { keyId: string; secret: string } | null {
  const keyId = process.env["CDP_API_KEY_ID"];
  const secret = process.env["CDP_API_KEY_SECRET"];
  return keyId && secret ? { keyId, secret } : null;
}

async function postCdp(url: string, body: unknown, creds: { keyId: string; secret: string }, timeoutMs: number): Promise<{ status: number; ok: boolean; text: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${buildCdpJwt(creds.keyId, creds.secret, "POST", url)}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  const text = await res.text().catch(() => "");
  return { status: res.status, ok: res.ok, text };
}

function parseObject(text: string): Record<string, unknown> | null {
  if (text.length > MAX_RESPONSE_BYTES) return null;
  try {
    const o = JSON.parse(text) as unknown;
    if (!o || typeof o !== "object" || Array.isArray(o)) return null;
    stripDangerousKeys(o as Record<string, unknown>);
    return o as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ─── verify / settle ────────────────────────────────────────────────

async function verifyCoinbasePayment(paymentHeader: string, requirements: X402Requirements): Promise<X402VerifyResult> {
  const fail = (error: string, payer = ""): X402VerifyResult => ({ valid: false, payer, amountUsd: "0", facilitator: "coinbase", error });
  const creds = credentials();
  if (!creds) {
    log.error("Coinbase CDP credentials not configured");
    return fail("Facilitator unavailable");
  }
  const accept = requirements.accepts.find((a) => a.extra.facilitator === "coinbase");
  if (!accept) return fail("Facilitator unavailable");

  const payload = decodeExactPayload(paymentHeader);
  if (!payload) return fail("Payment invalid");
  const local = checkAgainstRequirements(payload, accept);
  if ("error" in local) return fail(local.error, payload.payload.authorization.from);

  const r = await postCdp(FACILITATOR_URLS.coinbase.verify, {
    x402Version: 1, paymentPayload: payload, paymentRequirements: toCdpRequirements(accept),
  }, creds, 10_000);
  if (!r.ok) {
    log.error("Coinbase verify failed", { status: r.status, error: r.text.slice(0, 200) });
    return fail("Payment verification failed");
  }
  const result = parseObject(r.text);
  if (!result) {
    log.error("Coinbase verify response invalid or too large", { length: r.text.length });
    return fail("Facilitator response invalid");
  }
  if (result["isValid"] !== true) {
    log.warn("Coinbase verify: payment invalid", {
      invalidReason: typeof result["invalidReason"] === "string" ? result["invalidReason"].slice(0, 100) : undefined,
    });
    return fail("Payment invalid", typeof result["payer"] === "string" ? result["payer"] : "");
  }
  const signer = payload.payload.authorization.from;
  if (typeof result["payer"] === "string" && result["payer"].toLowerCase() !== signer.toLowerCase()) {
    return fail("Payer mismatch");
  }
  return { valid: true, payer: signer, amountUsd: usdOf(local.amount), facilitator: "coinbase" };
}

async function settleCoinbasePayment(paymentHeader: string, accept?: X402PaymentOption): Promise<X402Settlement> {
  const creds = credentials();
  if (!creds) throw new Error("Coinbase CDP credentials not configured for settlement");
  if (!accept) throw new Error("Coinbase settlement needs the payment requirements");
  const payload = decodeExactPayload(paymentHeader);
  if (!payload) throw new Error("coinbase settlement: invalid payment payload");
  const local = checkAgainstRequirements(payload, accept);
  if ("error" in local) throw new Error(`coinbase settlement: ${local.error}`);

  const r = await postCdp(FACILITATOR_URLS.coinbase.settle, {
    x402Version: 1, paymentPayload: payload, paymentRequirements: toCdpRequirements(accept),
  }, creds, 15_000);
  if (!r.ok) {
    log.error("Coinbase settle failed", { status: r.status, body: r.text.slice(0, 200) });
    throw new Error(`Coinbase settlement failed (HTTP ${r.status})`);
  }
  const result = parseObject(r.text);
  if (!result) throw new Error("coinbase settle response invalid");
  if (result["success"] !== true) {
    log.error("x402 settle reported failure", {
      facilitator: "coinbase",
      errorReason: typeof result["errorReason"] === "string" ? result["errorReason"].slice(0, 200) : undefined,
    });
    throw new Error("coinbase settlement not successful");
  }
  const tx = typeof result["transaction"] === "string" ? result["transaction"] : "";
  if (!TX_HASH.test(tx)) throw new Error("coinbase settlement missing valid transaction");
  if (typeof result["network"] === "string" && result["network"] !== accept.network) {
    throw new Error("coinbase settlement network mismatch");
  }
  if (typeof result["payer"] === "string" && result["payer"].toLowerCase() !== payload.payload.authorization.from.toLowerCase()) {
    throw new Error("coinbase settlement payer mismatch");
  }
  return { txHash: tx, amountSettled: local.amount.toString(), facilitator: "coinbase" };
}

export const coinbaseFacilitator: X402FacilitatorAdapter = {
  id: "coinbase",
  verify: verifyCoinbasePayment,
  settle: settleCoinbasePayment,
};
