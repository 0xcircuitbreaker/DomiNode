# Changelog

## 2.0.0 (2026-11-06)

Breaking: rebuilt on the DominusNode Python SDK v2 and the relay network.

- Exposes exactly the 19 standard v2 tools (fetch, proxy_url, network policy/pricing/stats,
  wallet balance/transactions/crypto top-up/payment status, usage, sessions, nodes, node setup
  guide, credits, payouts, x402).
- Removed Stripe/PayPal top-ups, plans, slots, account/email/password/MFA tools, team and
  agentic-wallet admin tools, hardcoded prices and dc-/residential- pool prefixes.
- Removed the duplicated HTTP client and SSRF code; the SDK handles both.
- API key only from `DOMINUSNODE_API_KEY` or config; all outputs and errors are scrubbed.

## 1.0.1

- Fix branding: replace "DomiNode" with "Dominus Node" throughout

## 1.0.0 (2026-03-01)

- Initial release
- 4 CrewAI tools: proxy fetch, wallet balance, top-up (Stripe), top-up (PayPal)
- SSRF protection, credential scrubbing, OFAC compliance

## [2.1.0] - 2026-11-12

### Added
- The fetch tool's `ip_class` accepts `masked` (cheapest, VPN/anonymizer exits, opt-in; never used unless asked).

### Changed
- Requires the DominusNode SDK 2.1.0 or later (`masked` support).

