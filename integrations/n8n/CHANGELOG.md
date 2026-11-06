# Changelog

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
