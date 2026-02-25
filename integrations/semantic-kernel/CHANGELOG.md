# Changelog

## 1.0.0 (2026-02-24)

### Added

- Initial release with 22 Semantic Kernel functions for DomiNode proxy service
- `DominusNodePlugin` class with `@kernel_function` decorators for all 22 operations
- Proxied fetch with SSRF protection, OFAC blocking, and credential scrubbing
- Wallet balance and usage monitoring functions
- Proxy configuration and active session listing
- Agentic wallet management: create, fund, balance, list, transactions, freeze, unfreeze, delete
- Team management: create, list, details, fund, create key, usage, update, update member role
- x402 micropayment protocol info function
- PayPal top-up function
- Full security suite: DNS rebinding protection, Teredo/6to4 IPv6 tunnel detection, IPv4-mapped/compatible IPv6 handling, hex/octal/decimal IP normalization, prototype pollution prevention
- 101 tests covering SSRF, sanitization, OFAC, HTTP methods, validation, authentication, and all 22 kernel functions
