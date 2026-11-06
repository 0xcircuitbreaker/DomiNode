# @dominusnode/billing

Team: **Billing & Payments**

Payment rails for agents: x402, MPP, Tempo and NOWPayments crypto. Stripe and PayPal remain for human admin use only (not exposed to agents).

## Key Files
- `src/adapters/rails/` — x402, MPP, Tempo and NOWPayments rails (see docs/agent-network/PAYMENTS.md)
- `src/x402.ts` — x402 per-request payments
- `src/stripe.ts`, `src/paypal.ts` — admin-only fiat flows
- `src/nowpayments.ts` — Crypto invoices (10 currencies), IPN verification
- `src/index.ts` — Re-exports

## Rules
- atomicCompleteInvoiceAndCredit: invoice completion + wallet credit MUST be single DB transaction
- PayPal capture: failInvoice only on 4xx, leave pending on 5xx for webhook retry
- NOWPayments IPN: filter __proto__/constructor/prototype before sorted key iteration
- Webhook IP allowlist: normalize IPv6 (::ffff:, ::, %zone) to IPv4 before matching
- PayPal order IDs: validate format (/^[A-Z0-9]{5,50}$/) before URL construction
- NaN check: always isNaN() after parseFloat/Number on amounts — NaN comparison returns false
- Webhook errors: return 500 for transient (DB), 200 for permanent (balance cap stops retries)
- Affiliate commissions: fire-and-forget (.catch(() => {})) — NEVER block billing webhook
- createInvoice: validate amountCents range (>0 and <=MAX_INT)

## Pricing
- Per-GB prices live in `network_pricing` (admin-tunable; defaults $0.50 residential, $0.20 dc). Never hardcode.
- Node share by tier: 25% (Probation) to 50% (Partner); see docs/agent-network/ECONOMICS.md
- Wallet: MAX_BALANCE_CENTS = $10,000 (1000000 cents)
