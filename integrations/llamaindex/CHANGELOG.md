# Changelog

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
