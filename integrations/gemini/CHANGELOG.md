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
- TypeScript handler now uses @dominusnode/sdk v2; the Python handler is the dominusnode_gemini package on the dominusnode SDK v2. functions.json is generated and parity-tested in both languages.

### Added

- Live pricing via network_pricing, node earnings tools and a node agent setup guide.
- The API key is read only from DOMINUSNODE_API_KEY/config; proxy_url returns a key placeholder.

## 1.0.1

- Fix branding: replace "DomiNode" with "Dominus Node" throughout

All notable changes to this project will be documented in this file.

## [2.1.0] - 2026-11-12

### Added
- The fetch tool's `ip_class` accepts `masked` (cheapest, VPN/anonymizer exits, opt-in; never used unless asked).

### Changed
- Requires the DominusNode SDK 2.1.0 or later (`masked` support).

## [1.0.0] - 2025-02-23

### Added
- Initial release of Dominus Node Gemini / Vertex AI function declarations
- 22 Gemini-format function declarations in `functions.json`
  - All 21 functions from OpenAI Functions integration adapted to Gemini schema
  - New `dominusnode_topup_paypal` function for PayPal wallet top-ups
- TypeScript handler (`handler.ts`) with full security suite
- Python handler (`handler.py`) with full security suite
- Comprehensive SSRF prevention (private IPs, hex/octal/decimal, DNS rebinding, IPv6)
- OFAC sanctioned country blocking (CU, IR, KP, RU, SY)
- Credential sanitization in all error messages
- Prototype pollution prevention in JSON parsing
- HTTP method restriction (GET, HEAD, OPTIONS only for proxied fetch)
- 401 retry logic for expired JWT tokens
- TypeScript tests (`handler.test.ts`) -- 35+ test cases
- Python tests (`test_handler.py`) -- 35+ test cases
