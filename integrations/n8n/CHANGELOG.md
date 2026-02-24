# Changelog

All notable changes to `n8n-nodes-dominusnode` will be documented in this file.

## [1.0.0] - 2025-02-23

### Added
- Initial release of n8n community nodes for DomiNode
- **DomiNode Proxy** node: Proxied Fetch, Get Proxy Config, List Active Sessions
- **DomiNode Wallet** node: 20 operations covering wallet, agentic wallets, and teams
- **DomiNode Usage** node: Check usage statistics by period (day/week/month)
- Full SSRF prevention (private IPs, hex/octal/decimal, IPv6, Teredo, 6to4, CGNAT, multicast)
- DNS rebinding protection
- OFAC sanctioned country blocking (CU, IR, KP, RU, SY)
- Read-only HTTP methods for proxied fetch (GET, HEAD, OPTIONS)
- Credential sanitization in all error messages
- Prototype pollution prevention in JSON parsing
- Support for 10 cryptocurrencies (BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB)
- PayPal top-up support via Stripe
- Agentic wallet CRUD with freeze/unfreeze/delete
- Team management with CRUD, wallet funding, API keys, and member role updates
