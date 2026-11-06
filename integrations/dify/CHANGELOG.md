# Changelog

## 2.0.0 (2026-11-06)

### Breaking
- Rebuilt on the DominusNode Python SDK v2 (`dominusnode>=2.0.0`); the integration no longer
  contains its own HTTP client, SSRF checks or proxy code.
- Exposes exactly the 19 standard v2 tools (fetch, proxy_url, network_policy, network_pricing, network_stats, balance, transactions, topup_crypto, check_payment, usage, active_sessions, report_session, node_list, node_tier, node_setup_guide, credits_balance, credits_convert, payouts_list, x402_info).
- Removed: Stripe/PayPal top-ups, plans, slots, email/password and MFA account tools, API key and
  team management tools, agentic wallet tools, hardcoded prices and `dc-`/`residential-` prefixes.
- The API key comes only from `DOMINUSNODE_API_KEY` or configuration.

## 1.0.1

- Fix branding: replace "DomiNode" with "Dominus Node" throughout

## 1.0.0 (2026-02-24)

### Added

- Initial release with 22 Dify tools for Dominus Node proxy service
- YAML provider definition with API key, base URL, and proxy host credentials
- 22 YAML tool definitions with full parameter schemas and LLM descriptions
- Proxied fetch with SSRF protection, OFAC blocking, and credential scrubbing
- Wallet balance and usage monitoring tools
- Proxy configuration and active session listing
- Agentic wallet management: create, fund, balance, list, transactions, freeze, unfreeze, delete
- Team management: create, list, details, fund, create key, usage, update, update member role
- x402 micropayment protocol info tool
- PayPal top-up tool
- Full security suite: DNS rebinding protection, Teredo/6to4 IPv6 tunnel detection, IPv4-mapped/compatible IPv6 handling, hex/octal/decimal IP normalization, prototype pollution prevention
- Float-to-int coercion for Dify number parameters
- 120+ tests covering SSRF, sanitization, OFAC, HTTP methods, validation, auth, and all 22 tools
