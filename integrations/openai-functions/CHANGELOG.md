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
- TypeScript handler now uses @dominusnode/sdk v2 and accepts raw JSON argument strings; the Python handler is the dominusnode_openai_functions package on the dominusnode SDK v2. functions.json is generated and parity-tested in both languages.

### Added

- Live pricing via network_pricing, node earnings tools and a node agent setup guide.
- The API key is read only from DOMINUSNODE_API_KEY/config; proxy_url returns a key placeholder.
