# Changelog

## 2.0.0 (2026-11-06)

Breaking: rebuilt on the DominusNode Python SDK v2 and the relay network.

- Exposes exactly the 19 standard v2 tools (fetch, proxy_url, network policy/pricing/stats,
  wallet balance/transactions/crypto top-up/payment status, usage, sessions, nodes, node setup
  guide, credits, payouts, x402).
- Removed Stripe/PayPal top-ups, plans, slots, account/email/password/MFA tools, team and
  agentic-wallet admin tools, hardcoded prices and dc-/residential- pool prefixes.
- Removed the duplicated HTTP client and SSRF code; the SDK handles both.
- API key only from `DOMINUSNODE_API_KEY` or config; all outputs and errors are scrubbed.

## 1.0.1

- Fix branding: replace "DomiNode" with "Dominus Node" throughout

## 1.0.0 (2025-02-23)

### Added
- Initial release of `dominusnode-llamaindex` integration
- `DominusNodeToolSpec` with 22 tools for LlamaIndex agents
- `DominusNodeClient` HTTP client with JWT authentication and 401 retry
- Proxy tools: proxied_fetch, check_balance, check_usage, get_proxy_config, list_sessions
- Agentic wallet tools: create, fund, balance, list, transactions, freeze, unfreeze, delete
- Team tools: create, list, details, fund, create_key, usage, update, update_member_role
- PayPal top-up tool
- Full SSRF prevention (private IPs, hex/octal/decimal, DNS rebinding, Teredo, 6to4, CGNAT)
- OFAC sanctioned country blocking (CU, IR, KP, RU, SY)
- Credential scrubbing in error messages
- Prototype pollution prevention
- HTTP method restriction (GET/HEAD/OPTIONS only for proxied fetch)
- Response truncation (4000 chars) and size cap (10 MB)
- 55 unit tests covering all security and validation paths

## [2.1.0] - 2026-11-12

### Added
- The fetch tool's `ip_class` accepts `masked` (cheapest, VPN/anonymizer exits, opt-in; never used unless asked).

### Changed
- Requires the DominusNode SDK 2.1.0 or later (`masked` support).

