# Changelog

## 1.1.0

### Added
- Stripe checkout top-up tool (`dominusnode_topup_stripe`) — create Stripe Checkout sessions ($5–$1,000)
- Crypto top-up tool (`dominusnode_topup_crypto`) — NOWPayments invoices for BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB, LINK ($5–$1,000)
- `dominusnode_update_wallet_policy` tool — update daily limits and domain allowlists for agentic wallets
- Comprehensive test suite: 168 tests covering SSRF protection (incl. DNS rebinding), input validation, credential scrubbing, payment response fields, and all 26 tools

### Fixed
- `topupCrypto`: use `Number.isFinite()` instead of `isNaN()` to correctly reject `NaN` and `Infinity` inputs
- Payment response field alignment: `topupStripe` uses `sessionId`/`url`, `topupCrypto` uses `invoiceId`/`invoiceUrl`/`payCurrency`/`priceAmount`

## 1.0.1

- Fix branding: replace "DomiNode" with "Dominus Node" throughout

## 1.0.0

### Added

- Initial release with 23 Flowise-compatible tools for Dominus Node proxy service
- Proxied fetch with full SSRF protection, DNS rebinding, OFAC blocking, and credential scrubbing
- Wallet balance and usage monitoring tools
- Proxy configuration and active session listing
- Agentic wallet management: create, fund, balance, list, transactions, freeze, unfreeze, delete
- Team management: create, list, details, fund, create key, usage, update, update member role
- PayPal top-up and x402 micropayment info tools
- Full security suite: DNS rebinding protection, Teredo/6to4 IPv6 tunnel detection, IPv4-mapped/compatible IPv6 handling, hex/octal/decimal IP normalization, prototype pollution prevention
