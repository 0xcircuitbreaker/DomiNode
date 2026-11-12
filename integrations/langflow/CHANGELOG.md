# Changelog

## 2.0.0 (2026-11-06)

### Breaking
- Rebuilt on the DominusNode Python SDK v2 (`dominusnode>=2.0.0`); the integration no longer
  contains its own HTTP client, SSRF checks or proxy code.
- Exposes exactly the 19 standard v2 tools (fetch, proxy_url, network_policy, network_pricing, network_stats, balance, transactions, topup_crypto, check_payment, usage, active_sessions, report_session, node_list, node_tier, node_setup_guide, credits_balance, credits_convert, payouts_list, x402_info).
- Removed: Stripe/PayPal top-ups, plans, slots, email/password and MFA account tools, API key and
  team management tools, agentic wallet tools, hardcoded prices and `dc-`/`residential-` prefixes.
- The API key comes only from `DOMINUSNODE_API_KEY` or configuration.

## [2.1.0] - 2026-11-12

### Added
- The fetch tool's `ip_class` accepts `masked` (cheapest, VPN/anonymizer exits, opt-in; never used unless asked).

### Changed
- Requires the DominusNode SDK 2.1.0 or later (`masked` support).

