# Changelog

## 1.0.1

- Fix branding: replace "DomiNode" with "Dominus Node" throughout

## 1.0.0 (2026-02-24)

### Added

- Initial release with 22 PydanticAI tool functions for Dominus Node proxy service
- DominusNodeToolkit class with get_tools() returning plain callables for PydanticAI agent registration
- Proxied fetch with SSRF protection, OFAC blocking, and credential scrubbing
- Wallet balance and usage monitoring tools
- Proxy configuration and active session listing
- Agentic wallet management: create, fund, balance, list, transactions, freeze, unfreeze, delete
- Team management: create, list, details, fund, create key, usage, update, update member role
- x402 micropayment protocol information tool
- PayPal top-up tool
- Full security suite: DNS rebinding protection, Teredo/6to4 IPv6 tunnel detection, IPv4-mapped/compatible IPv6 handling, hex/octal/decimal IP normalization, prototype pollution prevention
- All tools return dicts (not JSON strings) for native PydanticAI consumption
- 101 tests covering SSRF, sanitization, OFAC, HTTP methods, validation, PayPal, dict returns, and tool wrappers
