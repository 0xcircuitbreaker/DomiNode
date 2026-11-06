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
- Initial release of `dominusnode-haystack`
- `DominusNodeToolkit` class with 22 tool methods
- `get_tools()` returning Haystack `Tool` objects for pipeline integration
- Full SSRF prevention (private IP blocking, DNS rebinding, Teredo/6to4, hex/octal/decimal normalization)
- OFAC sanctioned country validation (CU, IR, KP, RU, SY)
- Credential scrubbing in all error outputs
- Prototype pollution prevention on all parsed JSON
- HTTP method restriction (GET/HEAD/OPTIONS only for proxied fetch)
- 10 MB response cap, 4000 char truncation, 30s timeout
- Redirect following disabled to prevent open redirect abuse
- 401 auto-retry with re-authentication
- Tools: proxied_fetch, check_balance, check_usage, get_proxy_config, list_sessions
- Tools: create/fund/balance/list/transactions/freeze/unfreeze/delete agentic wallets
- Tools: create/list/details/fund/create_key/usage/update teams
- Tools: update_team_member_role, x402_info, topup_paypal
