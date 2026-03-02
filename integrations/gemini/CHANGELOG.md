# Changelog

## 1.0.1

- Fix branding: replace "DomiNode" with "Dominus Node" throughout

All notable changes to this project will be documented in this file.

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
