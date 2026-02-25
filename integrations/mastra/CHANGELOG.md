# Changelog

## 1.0.0 (2026-02-24)

### Added

- Initial release with 23 Mastra AI tools for DomiNode proxy service
- Proxied fetch with full SSRF protection, DNS rebinding, OFAC blocking, and credential scrubbing
- Wallet balance and usage monitoring tools
- Proxy configuration and active session listing
- Agentic wallet management: create, fund, balance, list, transactions, freeze, unfreeze, delete
- Team management: create, list, details, fund, create key, usage, update, update member role
- PayPal top-up and x402 micropayment info tools
- Full security suite: DNS rebinding protection, Teredo/6to4 IPv6 tunnel detection, IPv4-mapped/compatible IPv6 handling, hex/octal/decimal IP normalization, prototype pollution prevention
- Comprehensive test suite covering SSRF, sanitization, OFAC, HTTP methods, validation, and all 23 tools
