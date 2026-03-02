# Changelog

## 1.0.1

- Fix branding: replace "DomiNode" with "Dominus Node" throughout

## 1.0.0 (2026-02-24)

### Added

- Initial release with 23 IronClaw-compatible tools for Dominus Node proxy service
- Proxied fetch with SSRF protection, OFAC blocking, and credential scrubbing
- Wallet balance and usage monitoring tools
- Proxy configuration and active session listing
- Agentic wallet management: create, fund, balance, list, transactions, freeze, unfreeze, delete
- Team management: create, list, details, fund, create key, usage, update, update member role
- x402 micropayment protocol information
- PayPal top-up tool
- IronClaw tool definitions via get_tool_definitions() with JSON Schema parameters
- MCP server configuration via get_mcp_config() for IronClaw's native MCP bridge
- Full security suite: DNS rebinding protection, Teredo/6to4 IPv6 tunnel detection, IPv4-mapped/compatible IPv6 handling, hex/octal/decimal IP normalization, prototype pollution prevention
- 120+ tests covering SSRF, sanitization, OFAC, HTTP methods, validation, tool definitions, MCP config, and mocked API calls
