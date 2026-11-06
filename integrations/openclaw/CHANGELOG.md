# Changelog

## 2.0.0

### Changed (breaking)
- Rebuilt on `@dominusnode/sdk` ^2.0.0; the integration no longer ships its own HTTP client, SSRF/DNS-rebinding checks or proxy tunnel code.
- Exposes exactly the 19 standard v2 tools (named `dominusnode_<name>`): fetch, proxy_url, network_policy, network_pricing, network_stats, balance, transactions, topup_crypto, check_payment, usage, active_sessions, report_session, node_list, node_tier, node_setup_guide, credits_balance, credits_convert, payouts_list, x402_info.
- New plugin layout: `src/index.ts` default export `{ id, name, description, register(api) }`, `openclaw.plugin.json` manifest with `contracts.tools`, JSON-Schema parameters, and `{ content, details }` results. JWT Bearer auth via `/api/auth/verify-key` is handled by the SDK.
- API key read from `DOMINUSNODE_API_KEY` or the credentials store only; never a tool argument or output. All results and errors are credential-scrubbed.

### Removed
- Stripe and PayPal top-ups, plans, slots/waitlist, email/password and MFA flows, key/team/agentic-wallet management tools.
- `dc-`/`residential-` pool prefixes and hardcoded prices (use `network_pricing`).

