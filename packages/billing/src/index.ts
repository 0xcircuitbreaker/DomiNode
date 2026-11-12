export { PRICE_PER_GB_CENTS, COST_PER_GB_CENTS, RELAY_BYTES_PER_GB } from "@dominusnode/shared";

export {
  createCheckoutSession,
  handleCheckoutWebhook,
} from "./stripe.js";

export {
  createCryptoInvoice,
  verifyIpnSignature,
  handleIpnCallback,
} from "./nowpayments.js";

export {
  createPaypalOrder,
  capturePaypalOrder,
  handlePaypalWebhook,
  verifyPaypalWebhook,
} from "./paypal.js";

export {
  isX402Enabled,
  buildX402Requirements,
  verifyX402Payment,
  settleX402Payment,
  updateX402Transaction,
  claimPaymentHash,
  releasePaymentHash,
  detectFacilitator,
  getDcPricePerRequestUsd,
  getResPricePerRequestUsd,
  getMaxRequestBodyBytes,
  getX402MaxResponseBytes,
  hashPaymentHeader,
} from "./x402.js";

export type {
  X402Facilitator,
  X402Requirements,
  X402PaymentOption,
  X402VerifyResult,
  X402Settlement,
} from "./x402.js";

export { MAX_X402_AMOUNT_MUSD, X402_RESOURCE_DESCRIPTION, bazaarExtension } from "./x402.js";
export * from "./adapters/index.js";
