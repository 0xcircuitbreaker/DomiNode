import { createLogger } from "@dominusnode/shared";
import type { X402Requirements, X402VerifyResult, X402Settlement } from "../../x402.js";
import { stripDangerousKeys, parseUsdcAmount, validateSettleResponse } from "../x402-util.js";
import type { X402FacilitatorAdapter } from "../types.js";
import { FACILITATOR_URLS } from "./urls.js";

const log = createLogger("billing:x402");

/** Lifted verbatim from x402.ts (commit 23, no behaviour change); URLs from the allowlist. */

async function verifyCoinbasePayment(
  paymentHeader: string,
  requirements: X402Requirements,
): Promise<X402VerifyResult> {
  const cdpKeyId = process.env["CDP_API_KEY_ID"];
  const cdpKeySecret = process.env["CDP_API_KEY_SECRET"];

  if (!cdpKeyId || !cdpKeySecret) {
    // H-2: Generic error to client
    log.error("Coinbase CDP credentials not configured");
    return { valid: false, payer: "", amountUsd: "0", facilitator: "coinbase", error: "Facilitator unavailable" };
  }

  // Find the coinbase accept entry from requirements
  const coinbaseAccept = requirements.accepts.find(a => a.extra.facilitator === "coinbase");
  if (!coinbaseAccept) {
    return { valid: false, payer: "", amountUsd: "0", facilitator: "coinbase", error: "Facilitator unavailable" };
  }

  // Call Coinbase x402 facilitator verify endpoint
  // C-1: Include both key ID and secret in auth headers
  const verifyUrl = FACILITATOR_URLS.coinbase.verify;
  const body = JSON.stringify({
    payment: paymentHeader,
    requirements: coinbaseAccept,
  });

  const res = await fetch(verifyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CDP-API-KEY-ID": cdpKeyId,
      "X-CDP-API-KEY-SECRET": cdpKeySecret,
    },
    body,
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    log.error("Coinbase verify failed", { status: res.status, error: errText.slice(0, 200) });
    return { valid: false, payer: "", amountUsd: "0", facilitator: "coinbase", error: "Payment verification failed" };
  }

  // Size-limit facilitator response to prevent OOM
  const resText = await res.text();
  if (resText.length > 10_000) {
    log.error("Coinbase verify response too large", { length: resText.length });
    return { valid: false, payer: "", amountUsd: "0", facilitator: "coinbase", error: "Facilitator response too large" };
  }
  const result = JSON.parse(resText) as { valid?: boolean; payer?: string; amount?: string };
  stripDangerousKeys(result as Record<string, unknown>);

  if (!result.valid) {
    return { valid: false, payer: result.payer ?? "", amountUsd: "0", facilitator: "coinbase", error: "Payment invalid" };
  }

  // H-5: Validate amount format
  const amountUsdc = parseUsdcAmount(result.amount);
  if (amountUsdc === 0) {
    return { valid: false, payer: result.payer ?? "", amountUsd: "0", facilitator: "coinbase", error: "Invalid amount from facilitator" };
  }

  // C-4: Verify amount meets requirement
  const requiredAmount = parseInt(coinbaseAccept.maxAmountRequired, 10);
  if (amountUsdc < requiredAmount) {
    return { valid: false, payer: result.payer ?? "", amountUsd: "0", facilitator: "coinbase", error: "Payment amount insufficient" };
  }

  const amountUsd = (amountUsdc / 1_000_000).toFixed(6);

  return {
    valid: true,
    payer: result.payer ?? "",
    amountUsd,
    facilitator: "coinbase",
  };
}

async function settleCoinbasePayment(
  paymentHeader: string,
  paymentRequirements?: X402Requirements["accepts"][number],
): Promise<X402Settlement> {
  // H-3: Validate credentials exist before settlement
  const cdpKeyId = process.env["CDP_API_KEY_ID"];
  const cdpKeySecret = process.env["CDP_API_KEY_SECRET"];
  if (!cdpKeyId || !cdpKeySecret) {
    throw new Error("Coinbase CDP credentials not configured for settlement");
  }

  const settleUrl = FACILITATOR_URLS.coinbase.settle;
  const body = JSON.stringify(
    paymentRequirements ? { payment: paymentHeader, paymentRequirements } : { payment: paymentHeader },
  );

  // C-1: Include both key ID and secret
  const res = await fetch(settleUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CDP-API-KEY-ID": cdpKeyId,
      "X-CDP-API-KEY-SECRET": cdpKeySecret,
    },
    body,
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    // Log full facilitator error server-side but scrub from thrown error
    // to prevent leaking internal facilitator details to callers/logs upstream
    log.error("Coinbase settle failed", { status: res.status, body: errText.slice(0, 200) });
    throw new Error(`Coinbase settlement failed (HTTP ${res.status})`);
  }

  // Size-limit settle response
  const settleText = await res.text();
  if (settleText.length > 10_000) throw new Error("Coinbase settle response too large");
  return validateSettleResponse(settleText, "coinbase", paymentRequirements?.maxAmountRequired);
}


export const coinbaseFacilitator: X402FacilitatorAdapter = {
  id: "coinbase",
  verify: verifyCoinbasePayment,
  settle: settleCoinbasePayment,
};
