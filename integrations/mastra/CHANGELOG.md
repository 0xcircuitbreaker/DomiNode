# Changelog

## 2.0.1

### Changed
- Default API base URL is now `https://api.dominusnode.com` and the default proxy host `proxy.dominusnode.com` (primary domain). The `*.dominusnode.daedalusdevelopmentgroup.com` hosts remain served as aliases.

## 2.0.0

### Changed (breaking)
- Rebuilt on `@dominusnode/sdk` ^2.0.0; the integration no longer ships its own HTTP client, SSRF/DNS-rebinding checks or proxy tunnel code.
- Exposes exactly the 19 standard v2 tools (ids `dominusnode_<name>`): fetch, proxy_url, network_policy, network_pricing, network_stats, balance, transactions, topup_crypto, check_payment, usage, active_sessions, report_session, node_list, node_tier, node_setup_guide, credits_balance, credits_convert, payouts_list, x402_info.
- Targets Mastra >= 1.0 (`execute(inputData, context)`); `getTools()` now returns a record keyed by tool id. The package is ESM-only.
- API key read from `DOMINUSNODE_API_KEY` or the credentials store only; never a tool argument or output. All results and errors are credential-scrubbed.

### Removed
- Stripe and PayPal top-ups, plans, slots/waitlist, email/password and MFA flows, key/team/agentic-wallet management tools.
- `dc-`/`residential-` pool prefixes and hardcoded prices (use `network_pricing`).

## 1.1.0

### Added
- Stripe checkout top-up tool (`dominusnode_topup_stripe`) — create Stripe Checkout sessions ($5–$1,000)
- Crypto top-up tool (`dominusnode_topup_crypto`) — NOWPayments invoices for BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB, LINK ($5–$1,000)
- `dominusnode_update_wallet_policy` tool — update daily limits and domain allowlists for agentic wallets
- Comprehensive test suite: 167 tests covering SSRF protection (incl. DNS rebinding), input validation, credential scrubbing, payment response fields, and all 26 tools

### Fixed
- `topupCrypto`: use `Number.isFinite()` instead of `isNaN()` to correctly reject `NaN` and `Infinity` inputs

## 1.0.1

- Fix branding: replace "DomiNode" with "Dominus Node" throughout

## 1.0.0 (2026-02-24)

### Added

- Initial release with 23 Mastra AI tools for Dominus Node proxy service
- Proxied fetch with full SSRF protection, DNS rebinding, OFAC blocking, and credential scrubbing
- Wallet balance and usage monitoring tools
- Proxy configuration and active session listing
- Agentic wallet management: create, fund, balance, list, transactions, freeze, unfreeze, delete
- Team management: create, list, details, fund, create key, usage, update, update member role
- PayPal top-up and x402 micropayment info tools
- Full security suite: DNS rebinding protection, Teredo/6to4 IPv6 tunnel detection, IPv4-mapped/compatible IPv6 handling, hex/octal/decimal IP normalization, prototype pollution prevention
- Comprehensive test suite covering SSRF, sanitization, OFAC, HTTP methods, validation, and all 23 tools
