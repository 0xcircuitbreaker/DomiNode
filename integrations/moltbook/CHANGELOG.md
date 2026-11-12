# Changelog

## 2.0.0 (2026-11-06)

### Breaking

- Rebuilt on the DominusNode SDK v2: exposes exactly the 19 standard relay-network tools
  (fetch, proxy_url, network_policy/pricing/stats, balance, transactions, topup_crypto, check_payment, usage,
  active_sessions, report_session, node_list, node_tier, node_setup_guide, credits_balance, credits_convert,
  payouts_list, x402_info).
- Removed Stripe/PayPal top-ups, plans, slots, teams/agentic-wallet/key management, email/password and MFA
  flows, hardcoded prices and dc-/residential- pool prefixes.
- Removed the bundled HTTP client and SSRF code; the SDK now provides HTTP, DNS-rebinding checks, OFAC refusal
  and credential scrubbing.
- Removed MoltbookClient and every Moltbook API call: account registration, posting, commenting, submolt creation, voting, browsing, ETH wallet signing and rotating-IP posting. The package is now only the framework-neutral tool surface (tool_definitions, DominusNodeTools, make_tool_callables).

### Added

- Live pricing via network_pricing, node earnings tools and a node agent setup guide.
- The API key is read only from DOMINUSNODE_API_KEY/config; proxy_url returns a key placeholder.

## 1.1.0

- Expand to 53 tools: add 27 new Dominus Node management tools
- New proxy: dn_get_proxy_status (GET /api/proxy/status)
- New wallet: get_transactions, get_forecast, check_payment
- New usage: get_daily_usage, get_top_hosts
- New account: register_account, login_account, get_account_info, verify_email, resend_verification, update_password
- New API keys: list_keys, create_key, revoke_key
- New plans: get_plan, list_plans, change_plan
- New teams: team_delete, team_revoke_key, team_list_keys, team_list_members, team_add_member, team_remove_member, team_invite_member, team_list_invites, team_cancel_invite

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

## [2.1.0] - 2026-11-12

### Added
- The fetch tool's `ip_class` accepts `masked` (cheapest, VPN/anonymizer exits, opt-in; never used unless asked).

### Changed
- Requires the DominusNode SDK 2.1.0 or later (`masked` support).

