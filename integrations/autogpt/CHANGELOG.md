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

## 1.0.0 (2025-02-23)

### Added

- Initial release with 22 AutoGPT commands for Dominus Node proxy service
- Proxied fetch with SSRF protection, OFAC blocking, and credential scrubbing
- Wallet balance and usage monitoring commands
- Proxy configuration and active session listing
- Agentic wallet management: create, fund, balance, list, transactions, freeze, unfreeze, delete
- Team management: create, list, details, fund, create key, usage, update, update member role
- PayPal top-up command
- Full security suite: DNS rebinding protection, Teredo/6to4 IPv6 tunnel detection, IPv4-mapped/compatible IPv6 handling, hex/octal/decimal IP normalization, prototype pollution prevention
- 45 tests covering SSRF, sanitization, OFAC, HTTP methods, validation, and PayPal

## [2.1.0] - 2026-11-12

### Added
- The fetch tool's `ip_class` accepts `masked` (cheapest, VPN/anonymizer exits, opt-in; never used unless asked).

### Changed
- Requires the DominusNode SDK 2.1.0 or later (`masked` support).

