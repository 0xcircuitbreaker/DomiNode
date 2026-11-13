# Changelog

## 2.0.1

### Changed
- Default API base URL is now `https://api.dominusnode.com` and the default proxy host `proxy.dominusnode.com` (primary domain). The `*.dominusnode.daedalusdevelopmentgroup.com` hosts remain served as aliases.

## 2.0.0

### Changed (breaking)
- Rebuilt on `@dominusnode/sdk` ^2.0.0; the integration no longer ships its own HTTP client, SSRF/DNS-rebinding checks or proxy tunnel code.
- Exposes exactly the 19 standard v2 tools (as operations of one `DominusNode` node): fetch, proxy_url, network_policy, network_pricing, network_stats, balance, transactions, topup_crypto, check_payment, usage, active_sessions, report_session, node_list, node_tier, node_setup_guide, credits_balance, credits_convert, payouts_list, x402_info.
- The seven nodes (Proxy, Wallet, Usage, Account, Keys, Plans, Teams) are replaced by a single `DominusNode` node (version 2) with 19 operations and `usableAsTool: true`. The credential drops the agent-secret field (agent headers are MCP-only).
- API key read from `DOMINUSNODE_API_KEY` or the credentials store only; never a tool argument or output. All results and errors are credential-scrubbed.

### Removed
- Stripe and PayPal top-ups, plans, slots/waitlist, email/password and MFA flows, key/team/agentic-wallet management tools.
- `dc-`/`residential-` pool prefixes and hardcoded prices (use `network_pricing`).

## 1.0.1

- Fix branding: replace "DomiNode" with "Dominus Node" throughout

All notable changes to `n8n-nodes-dominusnode` will be documented in this file.

## [2.2.0] - 2026-11-13

### Changed
- Proxy traffic now goes to the gateway's TLS (HTTPS proxy) listener on port 8443 by default, and `proxy_url` returns `https://...:8443`. Production gateways refuse credentials on plaintext 8080/1080, so `fetch` failed on first use before. `DOMINUSNODE_PROXY_URL=https://host[:port]` sets the gateway host and TLS port (same variable as the MCP server; self-hosted coordinators publish 8444), `DOMINUSNODE_PROXY_TLS_PORT` sets only the port, and `DOMINUSNODE_PROXY_INSECURE=1` selects plaintext for local development. The credential gains "Proxy TLS Port" (default 8443) and "Plaintext Gateway (Local Dev Only)"; "Proxy Port" is now the plaintext port, used only with the latter.
- The node setup guide uses the published node image (`ghcr.io/0xcircuitbreaker/dominusnode-node`), which has the official coordinator pins baked in. A plain source build has none and now refuses to start.
- Requires the DominusNode SDK 2.2.0 or later (relay error codes on refused CONNECTs).

## [2.1.0] - 2026-11-12

### Added
- The fetch tool's `ip_class` accepts `masked` (cheapest, VPN/anonymizer exits, opt-in; never used unless asked).

### Changed
- Requires the DominusNode SDK 2.1.0 or later (`masked` support).

## [1.0.0] - 2025-02-23

### Added
- Initial release of n8n community nodes for Dominus Node
- **Dominus Node Proxy** node: Proxied Fetch, Get Proxy Config, List Active Sessions
- **Dominus Node Wallet** node: 20 operations covering wallet, agentic wallets, and teams
- **Dominus Node Usage** node: Check usage statistics by period (day/week/month)
- Full SSRF prevention (private IPs, hex/octal/decimal, IPv6, Teredo, 6to4, CGNAT, multicast)
- DNS rebinding protection
- OFAC sanctioned country blocking (CU, IR, KP, RU, SY)
- Read-only HTTP methods for proxied fetch (GET, HEAD, OPTIONS)
- Credential sanitization in all error messages
- Prototype pollution prevention in JSON parsing
- Support for 10 cryptocurrencies (BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB)
- PayPal top-up support via Stripe
- Agentic wallet CRUD with freeze/unfreeze/delete
- Team management with CRUD, wallet funding, API keys, and member role updates
