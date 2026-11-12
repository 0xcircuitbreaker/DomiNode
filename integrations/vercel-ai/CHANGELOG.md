# Changelog

## 2.0.1

### Changed
- Default API base URL is now `https://api.dominusnode.com` and the default proxy host `proxy.dominusnode.com` (primary domain). The `*.dominusnode.daedalusdevelopmentgroup.com` hosts remain served as aliases.

## 2.0.0

### Changed (breaking)
- Rebuilt on `@dominusnode/sdk` ^2.0.0; the integration no longer ships its own HTTP client, SSRF/DNS-rebinding checks or proxy tunnel code.
- Exposes exactly the 19 standard v2 tools (keyed `dominusnode_<name>`): fetch, proxy_url, network_policy, network_pricing, network_stats, balance, transactions, topup_crypto, check_payment, usage, active_sessions, report_session, node_list, node_tier, node_setup_guide, credits_balance, credits_convert, payouts_list, x402_info.
- Tools use the AI SDK v5+ `inputSchema` with `jsonSchema()`; `zod` is no longer a dependency and `ai` is a peer dependency (>=5).
- API key read from `DOMINUSNODE_API_KEY` or the credentials store only; never a tool argument or output. All results and errors are credential-scrubbed.

### Removed
- Stripe and PayPal top-ups, plans, slots/waitlist, email/password and MFA flows, key/team/agentic-wallet management tools.
- `dc-`/`residential-` pool prefixes and hardcoded prices (use `network_pricing`).

