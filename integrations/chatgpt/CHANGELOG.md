# Changelog

## 2.0.1

### Changed
- Default API base URL is now `https://api.dominusnode.com` and the default proxy host `proxy.dominusnode.com` (primary domain). The `*.dominusnode.daedalusdevelopmentgroup.com` hosts remain served as aliases.

## 2.0.0

### Changed (breaking)
- Function handler rebuilt on `@dominusnode/sdk` ^2.0.0; no bundled HTTP client, SSRF/DNS-rebinding checks, proxy tunnel or PoW code.
- Exposes exactly the 19 standard v2 functions (`dominusnode_<name>`): fetch, proxy_url, network_policy, network_pricing, network_stats, balance, transactions, topup_crypto, check_payment, usage, active_sessions, report_session, node_list, node_tier, node_setup_guide, credits_balance, credits_convert, payouts_list, x402_info. `functions.json` is generated from the handler.
- `openapi.yaml` (Custom GPT Actions) now describes only real routes that accept a raw `dn_live_` Bearer key: the public and agent `/v1` routes and `/api/x402/info`, with operationIds equal to the standard tool names. Tests check every path against the dashboard router.
- API key read from `DOMINUSNODE_API_KEY` (or GPT Action auth settings) only; never a function argument or output. All results and errors are credential-scrubbed.

### Removed
- Stripe and PayPal top-ups, plans, slots/waitlist, register/login/MFA, agent-secret headers, key/team/agentic-wallet management.
- `dc-`/`residential-` pool prefixes and hardcoded prices (use `network_pricing`).

## 1.0.1

- Fix branding: replace "DomiNode" with "Dominus Node" throughout

## 1.0.0 (2026-02-23)
- Initial release with OpenAPI 3.1.0 spec for ChatGPT Custom GPTs
- Full coverage: auth, proxy, wallet, usage, agentic wallets, teams, PayPal

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

