import { createLogger } from "@dominusnode/shared";
import type { X402Requirements, X402VerifyResult, X402Settlement } from "../../x402.js";
import { stripDangerousKeys, parseUsdcAmount, validateSettleResponse } from "../x402-util.js";
import type { X402FacilitatorAdapter } from "../types.js";
import { FACILITATOR_URLS } from "./urls.js";

const log = createLogger("billing:x402");

/** Lifted verbatim from x402.ts (commit 23, no behaviour change); URLs from the allowlist. */

async function verifyPayAIPayment(
  paymentHeader: string,
  requirements: X402Requirements,
): Promise<X402VerifyResult> {
  const payaiKeyId = process.env["PAYAI_API_KEY_ID"];
  const payaiKeySecret = process.env["PAYAI_API_KEY_SECRET"];

  if (!payaiKeyId || !payaiKeySecret) {
    log.error("PayAI credentials not configured");
    return { valid: false, payer: "", amountUsd: "0", facilitator: "payai", error: "Facilitator unavailable" };
  }

  // Find the payai accept entry from requirements
  const payaiAccept = requirements.accepts.find(a => a.extra.facilitator === "payai");
  if (!payaiAccept) {
    return { valid: false, payer: "", amountUsd: "0", facilitator: "payai", error: "Facilitator unavailable" };
  }

  // Call PayAI facilitator verify endpoint
  const verifyUrl = FACILITATOR_URLS.payai.verify;
  const body = JSON.stringify({
    payment: paymentHeader,
    requirements: payaiAccept,
  });

  const res = await fetch(verifyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-PayAI-Key-ID": payaiKeyId,
      "X-PayAI-Key-Secret": payaiKeySecret,
    },
    body,
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    log.error("PayAI verify failed", { status: res.status, error: errText.slice(0, 200) });
    return { valid: false, payer: "", amountUsd: "0", facilitator: "payai", error: "Payment verification failed" };
  }

  // Size-limit facilitator response to prevent OOM
  const resText = await res.text();
  if (resText.length > 10_000) {
    log.error("PayAI verify response too large", { length: resText.length });
    return { valid: false, payer: "", amountUsd: "0", facilitator: "payai", error: "Facilitator response too large" };
  }
  const result = JSON.parse(resText) as { valid?: boolean; payer?: string; amount?: string };
  stripDangerousKeys(result as Record<string, unknown>);

  if (!result.valid) {
    return { valid: false, payer: result.payer ?? "", amountUsd: "0", facilitator: "payai", error: "Payment invalid" };
  }

  // H-5: Validate amount format
  const amountUsdc = parseUsdcAmount(result.amount);
  if (amountUsdc === 0) {
    return { valid: false, payer: result.payer ?? "", amountUsd: "0", facilitator: "payai", error: "Invalid amount from facilitator" };
  }

  // C-4: Verify amount meets requirement
  const requiredAmount = parseInt(payaiAccept.maxAmountRequired, 10);
  if (amountUsdc < requiredAmount) {
    return { valid: false, payer: result.payer ?? "", amountUsd: "0", facilitator: "payai", error: "Payment amount insufficient" };
  }

  const amountUsd = (amountUsdc / 1_000_000).toFixed(6);

  return {
    valid: true,
    payer: result.payer ?? "",
    amountUsd,
    facilitator: "payai",
  };
}

async function settlePayAIPayment(
  paymentHeader: string,
  paymentRequirements?: X402Requirements["accepts"][number],
): Promise<X402Settlement> {
  const payaiKeyId = process.env["PAYAI_API_KEY_ID"];
  const payaiKeySecret = process.env["PAYAI_API_KEY_SECRET"];
  if (!payaiKeyId || !payaiKeySecret) {
    throw new Error("PayAI credentials not configured for settlement");
  }

  const settleUrl = FACILITATOR_URLS.payai.settle;
  const body = JSON.stringify(
    paymentRequirements ? { payment: paymentHeader, paymentRequirements } : { payment: paymentHeader },
  );

  const res = await fetch(settleUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-PayAI-Key-ID": payaiKeyId,
      "X-PayAI-Key-Secret": payaiKeySecret,
    },
    body,
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    // Log full facilitator error server-side but scrub from thrown error
    log.error("PayAI settle failed", { status: res.status, body: errText.slice(0, 200) });
    throw new Error(`PayAI settlement failed (HTTP ${res.status})`);
  }

  // Size-limit settle response
  const settleText = await res.text();
  if (settleText.length > 10_000) throw new Error("PayAI settle response too large");
  return validateSettleResponse(settleText, "payai", paymentRequirements?.maxAmountRequired);
}


export const payaiFacilitator: X402FacilitatorAdapter = {
  id: "payai",
  verify: verifyPayAIPayment,
  settle: settlePayAIPayment,
};
