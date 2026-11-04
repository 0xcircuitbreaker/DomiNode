# @dominusnode/proxy-gateway

Team: **Core Platform**

The high-performance proxy server handling HTTP/HTTPS/SOCKS5 connections.

## Key Files
- `src/server.ts` — HTTP proxy + HTTPS double-CONNECT through Webshare
- `src/auth.ts` — Proxy-Authorization header parser
- `src/balance-check.ts` — Wallet balance check with 30s cache
- `src/counting-stream.ts` — Byte counters for billing
- `src/session-manager.ts` — In-memory session tracking, usage recording, wallet debit
- `src/main.ts` — Entrypoint with graceful shutdown

## Rules
- Performance-critical: minimize per-request overhead
- API key in PASSWORD field, routing options in USERNAME field (Basic auth)
- Geo-targeting uses HYPHENS: `dc-country-US` not `dc_country_US`
- Balance reservation: min(balance, ceil(relay price × RELAY_SESSION_BYTE_CAP)); session maxBytes = exactly what the reservation pays for (no overrun headroom)
- getUserPlan: call ONCE per session (prevents TOCTOU)
- Team API keys bill to team wallet; balance check uses teamId
- x402 HTTP method restriction: GET/HEAD/OPTIONS only
- Socket error handlers MUST check .destroyed before writing
- IPv6 in CONNECT: must be bracketed [::1]:443
- CONNECT_TIMEOUT_MS/SOCKS5_TIMEOUT: validate for NaN after parseInt
- SOCKS5: check domLenBuf[0] === 0 to prevent empty-hostname CONNECT
- Graceful shutdown must settle all active sessions
- Bearer > cookie priority for auth token extraction

## Common Mistakes
- Forgetting to count request body bytes (not just response)
- HTTP forwarding must meter the relay stream itself (meterStream), not parsed body chunks — headers are billable bytes
- CONNECT pipe pause/resume around async gaps (known deferred item)
