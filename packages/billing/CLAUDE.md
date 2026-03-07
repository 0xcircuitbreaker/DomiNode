# @dominusnode/billing

Team: **Billing & Payments**

Handles all payment processing: Stripe, PayPal, NOWPayments crypto, x402 micropayments.

## Key Files
- `src/stripe.ts` — Checkout sessions, webhook handling
- `src/paypal.ts` — createOrder->capture flow, webhook verification
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
- DC: $3/GB sell (PRICE_PER_GB_CENTS_DC=300), $0.012/GB cost
- Residential: $5/GB sell (PRICE_PER_GB_CENTS=500), $4/GB cost
- Wallet: MAX_BALANCE_CENTS = $10,000 (1000000 cents)
