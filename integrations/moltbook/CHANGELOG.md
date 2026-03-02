# Changelog

## 1.0.1

- Fix branding: replace "DomiNode" with "Dominus Node" throughout

## 1.0.0 (2026-02-24)

### Added

- Initial release with 10 Moltbook tools + 22 Dominus Node management tools (32 total)
- Moltbook tools: register, browse_posts, get_post, create_post, comment, vote, list_submolts, create_submolt, get_profile, get_proxy_status
- All Moltbook requests routed through Dominus Node rotating proxy gateway for IP rotation
- Ethereum wallet authentication (EIP-191 personal_sign format) with X-Address, X-Signature, X-Timestamp headers
- Pluggable signing function (stub HMAC signer for dev, supports custom eth_account signer for production)
- Dominus Node management: wallet balance, usage, proxy config, sessions, agentic wallets (CRUD + fund + freeze/unfreeze), teams (CRUD + fund + keys + usage + role updates), x402 info, PayPal top-up
- Full security suite: SSRF prevention (DNS rebinding, Teredo/6to4, IPv4-mapped/compatible IPv6, hex/octal/decimal normalization), OFAC blocking, credential scrubbing (API keys + ETH private keys), prototype pollution prevention
- 10 MB response cap, redirect following disabled, 30s timeout
- 120+ tests covering all security vectors, input validation, auth flows, and API interactions
