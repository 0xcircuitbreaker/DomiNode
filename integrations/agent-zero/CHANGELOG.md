# Changelog

## 2.0.0 (2026-11-06)

### Breaking

- Rebuilt on the DominusNode SDK v2: exposes exactly the 19 standard relay-network tools
  (fetch, proxy_url, network_policy/pricing/stats, balance, transactions, topup_crypto, check_payment, usage,
  active_sessions, report_session, node_list, node_tier, node_setup_guide, credits_balance, credits_convert,
  payouts_list, x402_info).
- Removed Stripe/PayPal top-ups, plans, slots, teams/agentic-wallet/key management, email/password and MFA
  flows, hardcoded prices and dc-/residential- pool prefixes.
- Removed the bundled HTTP client and SSRF code; the SDK now provides HTTP, DNS-rebinding checks, OFAC refusal
  and credential scrubbing.
- Tools are now real Agent Zero Tool subclasses (python/tools/) with prompt files (prompts/); the shared/ and tools/ modules are removed.

### Added

- Live pricing via network_pricing, node earnings tools and a node agent setup guide.
- The API key is read only from DOMINUSNODE_API_KEY/config; proxy_url returns a key placeholder.

## 1.0.1

- Fix branding: replace "DomiNode" with "Dominus Node" throughout

All notable changes to the Dominus Node Agent Zero integration will be
documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.2.0] - 2026-11-13

### Changed
- Proxy traffic now goes to the gateway's TLS (HTTPS proxy) listener on port 8443 by default, and `proxy_url` returns `https://...:8443`. Production gateways refuse credentials on plaintext 8080/1080, so `fetch` failed on first use before. `DOMINUSNODE_PROXY_URL=https://host[:port]` sets the gateway host and TLS port (same variable as the MCP server; self-hosted coordinators publish 8444), `DOMINUSNODE_PROXY_TLS_PORT` sets only the port, and `DOMINUSNODE_PROXY_INSECURE=1` selects plaintext for local development.
- The node setup guide uses the published node image (`ghcr.io/0xcircuitbreaker/dominusnode-node`), which has the official coordinator pins baked in. A plain source build has none and now refuses to start.
- Requires the DominusNode SDK 2.2.0 or later (relay error codes on refused CONNECTs).

## [2.1.0] - 2026-11-12

### Added
- The fetch tool's `ip_class` accepts `masked` (cheapest, VPN/anonymizer exits, opt-in; never used unless asked).

### Changed
- Requires the DominusNode SDK 2.1.0 or later (`masked` support).

## [1.0.0] - 2025-02-23

### Added

- Initial release with 22 tools across 4 modules
- **Proxy tools** (3): proxied_fetch, get_proxy_config, list_sessions
- **Wallet tools** (3): check_balance, check_usage, topup_paypal
- **Agentic wallet tools** (8): create, fund, balance, list, transactions,
  freeze, unfreeze, delete
- **Team tools** (8): create_team, list_teams, team_details, team_fund,
  team_create_key, team_usage, update_team, update_team_member_role
- Shared SSRF prevention module with DNS rebinding protection
- Shared auth module with JWT verify-key flow and 401 retry
- Full test suite (55 tests)
