# AI Integration Patterns

These rules apply to every integration in integrations/.

## Build on the SDKs (v2)

- Python integrations depend on the DominusNode Python SDK (`sdks/python`, v2); JS/TS integrations on `@dominusnode/sdk` (`sdks/node`, v2). Do not reimplement HTTP, signing, SSRF or proxy logic in an integration.
- Surface contract: `sdks/SDK_SURFACE.md`. Gateway username flags: country-XX, class-residential|dc|mobile, session-<id>, allowhttp-1 (HYPHENS).
- No hardcoded prices (read `network.pricing()`), no dc-/residential- pool prefixes, no Stripe/PayPal/plans/slots, no email/password or human MFA flows. Humans are admin-only.

## Standard v2 tool set (every integration, same names with the framework's naming style)

| # | Tool | SDK call |
|---|---|---|
| 1 | fetch | proxy.fetch (GET/HEAD, country, ip_class, session_id, allow_http) |
| 2 | proxy_url | proxy.buildUrl / username builder |
| 3 | network_policy | network.policy |
| 4 | network_pricing | network.pricing |
| 5 | network_stats | network.stats |
| 6 | balance | wallet.balance |
| 7 | transactions | wallet.transactions |
| 8 | topup_crypto | wallet.topUpCrypto |
| 9 | check_payment | wallet crypto status |
| 10 | usage | usage summary |
| 11 | active_sessions | sessions.getActive |
| 12 | report_session | sessions.report |
| 13 | node_list | nodes.list |
| 14 | node_tier | nodes.tier |
| 15 | node_setup_guide | static steps for the node agent |
| 16 | credits_balance | credits.balance |
| 17 | credits_convert | credits.convert |
| 18 | payouts_list | payouts.list |
| 19 | x402_info | x402.info |

Signing flows (node register, withdraw, payout wallet) are NOT exposed as LLM tools; point agents to the MCP server or SDK with a signer key file.

## Required security (enforced by the SDK; integrations must not weaken it)

- SSRF + DNS rebinding on fetch, GET/HEAD only, ports 80/443, no redirects, 10MB cap, plaintext only with allow_http (exit-visible).
- Scrub dn_live_/dn_test_/dn_node_/dn_proxy_ and JWTs from every error returned to the model.
- API key from environment/config only, never a tool argument or tool output.
- OFAC countries refused (Cuba, Iran, North Korea, Russia, Syria).

## Authentication

- API key (`dn_live_`) via `DOMINUSNODE_API_KEY`; `/v1` routes use the raw key, `/api` routes the JWT (SDK handles it).
- X-DominusNode-Agent:mcp is MCP-server-only; integrations must not send it.

## Tests

- Each integration: tool registration matches the 19-tool set exactly; each tool calls the right SDK method (SDK mocked); errors scrubbed; key never appears in tool schemas or outputs.
