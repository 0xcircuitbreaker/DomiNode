/**
 * Hardcoded facilitator endpoint allowlist. Facilitator URLs are never taken
 * from env or request data (SSRF / payment-redirect protection).
 */
export const FACILITATOR_URLS = Object.freeze({
  coinbase: Object.freeze({ verify: "https://x402.org/facilitator/verify", settle: "https://x402.org/facilitator/settle" }),
  payai: Object.freeze({ verify: "https://api.payai.network/v1/x402/verify", settle: "https://api.payai.network/v1/x402/settle" }),
});
