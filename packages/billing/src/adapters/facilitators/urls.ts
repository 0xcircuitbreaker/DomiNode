/**
 * Hardcoded facilitator endpoint allowlist. Facilitator URLs are never taken
 * from env or request data (SSRF / payment-redirect protection).
 */
export const FACILITATOR_URLS = Object.freeze({
  // Coinbase CDP x402 facilitator (Bearer JWT auth; see coinbase.ts).
  coinbase: Object.freeze({
    verify: "https://api.cdp.coinbase.com/platform/v2/x402/verify",
    settle: "https://api.cdp.coinbase.com/platform/v2/x402/settle",
  }),
  payai: Object.freeze({ verify: "https://api.payai.network/v1/x402/verify", settle: "https://api.payai.network/v1/x402/settle" }),
});
