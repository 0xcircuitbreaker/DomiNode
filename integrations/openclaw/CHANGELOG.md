# Changelog

## 2.0.1

### Changed
- Default API base URL is now `https://api.dominusnode.com` and the default proxy host `proxy.dominusnode.com` (primary domain). The `*.dominusnode.daedalusdevelopmentgroup.com` hosts remain served as aliases.

## 2.0.0

### Changed (breaking)
- Rebuilt on `@dominusnode/sdk` ^2.0.0; the integration no longer ships its own HTTP client, SSRF/DNS-rebinding checks or proxy tunnel code.
- Exposes exactly the 19 standard v2 tools (named `dominusnode_<name>`): fetch, proxy_url, network_policy, network_pricing, network_stats, balance, transactions, topup_crypto, check_payment, usage, active_sessions, report_session, node_list, node_tier, node_setup_guide, credits_balance, credits_convert, payouts_list, x402_info.
- New plugin layout: `src/index.ts` default export `{ id, name, description, register(api) }`, `openclaw.plugin.json` manifest with `contracts.tools`, JSON-Schema parameters, and `{ content, details }` results. JWT Bearer auth via `/api/auth/verify-key` is handled by the SDK.
- API key read from `DOMINUSNODE_API_KEY` or the credentials store only; never a tool argument or output. All results and errors are credential-scrubbed.

### Removed
- Stripe and PayPal top-ups, plans, slots/waitlist, email/password and MFA flows, key/team/agentic-wallet management tools.
- `dc-`/`residential-` pool prefixes and hardcoded prices (use `network_pricing`).


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

