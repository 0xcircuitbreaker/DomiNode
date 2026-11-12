# Changelog

## 2.0.1

### Changed
- Default API base URL is now `https://api.dominusnode.com` and the default proxy host `proxy.dominusnode.com` (primary domain). The `*.dominusnode.daedalusdevelopmentgroup.com` hosts remain served as aliases.

## 2.0.0

### Changed (breaking)
- Rebuilt on `@dominusnode/sdk` ^2.0.0; the integration no longer ships its own HTTP client, SSRF/DNS-rebinding checks or proxy tunnel code.
- Exposes exactly the 19 standard v2 tools (named `dominusnode_<name>`): fetch, proxy_url, network_policy, network_pricing, network_stats, balance, transactions, topup_crypto, check_payment, usage, active_sessions, report_session, node_list, node_tier, node_setup_guide, credits_balance, credits_convert, payouts_list, x402_info.
- Schemas use the `typebox` 1.x package (peer dependency, as pi recommends) instead of `@sinclair/typebox`; the package is ESM and `pi.extensions` points at `./dist/index.js`. Skill rewritten for the relay network.
- API key read from `DOMINUSNODE_API_KEY` or the credentials store only; never a tool argument or output. All results and errors are credential-scrubbed.

### Removed
- Stripe and PayPal top-ups, plans, slots/waitlist, email/password and MFA flows, key/team/agentic-wallet management tools.
- `dc-`/`residential-` pool prefixes and hardcoded prices (use `network_pricing`).

## [2.1.0] - 2026-11-12

### Added
- The fetch tool's `ip_class` accepts `masked` (cheapest, VPN/anonymizer exits, opt-in; never used unless asked).

### Changed
- Requires the DominusNode SDK 2.1.0 or later (`masked` support).

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
