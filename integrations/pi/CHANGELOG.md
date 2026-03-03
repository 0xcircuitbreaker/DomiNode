# Changelog

## [1.0.0] - 2026-03-02

### Added
- Initial release of `@dominusnode/pi-extension`
- 26 tools covering the full Dominus Node feature suite:
  - Proxied fetch (HTTP/HTTPS via DC + residential pools with geo-targeting)
  - Wallet management (balance, usage, proxy config, sessions)
  - Agentic wallets (create, fund, balance, transactions, freeze, unfreeze, delete, policy)
  - Teams (create, list, details, fund, API key management, usage, update, member roles)
  - Payments (Stripe, PayPal, crypto: BTC/ETH/LTC/XMR/ZEC/USDC/SOL/USDT/DAI/BNB/LINK)
  - x402 micropayment info
- Full SSRF protection (RFC1918, CGNAT, Teredo/6to4, IPv4-mapped IPv6, DNS rebinding, .localhost/.local/.internal/.arpa TLDs)
- OFAC sanctioned country validation (CU, IR, KP, RU, SY)
- Credential scrubbing in all error outputs (`dn_live_*` / `dn_test_*`)
- Prototype pollution prevention (recursive `stripDangerousKeys`)
- HTTP method restriction for proxied fetch (GET/HEAD/OPTIONS only)
- TypeBox parameter schemas for all 26 tools
- Pi Package manifest (`"pi"` key in package.json)
- Skill documentation (`skills/use-dominus-proxy.md`)
