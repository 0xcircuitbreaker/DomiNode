# AI Integration Patterns

These rules apply when working on any integration in integrations/.

## Required Security for ALL Integrations

- SSRF: DNS rebinding protection required (resolve hostname, check all resolved IPs)
- HTTP methods: restrict to GET/HEAD/OPTIONS only (no POST/PUT/DELETE through proxy)
- Error messages: scrub dn_live_*/dn_test_* credentials from all error returns
- Redirect following: DISABLED (follow_redirects=False) to prevent open redirect abuse
- OFAC: check sanctioned countries (Cuba, Iran, North Korea, Russia, Syria)
- Prototype pollution: recursive stripDangerousKeys on all parsed JSON
- Response body: size cap (10MB) on all fetched content

## Authentication Patterns

- OpenClaw: must use JWT Bearer tokens (via /api/auth/verify-key), NOT x-api-key header
- MCP agents: X-DominusNode-Agent:mcp header triggers server-side email auto-verification
- AI auto-verify must be MCP-only (not SDK) — prevents human automation bypass
- reCAPTCHA bypass: X-DominusNode-Agent:mcp + X-DominusNode-Agent-Secret headers

## Proxy Routing (Integration Fetch)

- Must route through actual HTTP proxy gateway (CONNECT tunnel for HTTPS, full-URL path for HTTP)
- NOT /api/proxy/fetch or direct fetch()
- API key goes in PASSWORD field, routing options in USERNAME field (Basic auth)
- Geo-targeting uses HYPHENS (country-US) not underscores (country_US)

## Standard Tool Count

- Full integrations: 26 tools (matching MCP tool set)
- All function-based integrations have 22+ functions (incl. PayPal + Stripe + Crypto topup)
