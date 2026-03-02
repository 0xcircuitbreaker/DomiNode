# Changelog

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
