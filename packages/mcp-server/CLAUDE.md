# @dominusnode/mcp-server

Team: **AI & Integrations**

MCP server for the AI-agent relay network: 66 authenticated + 13 bootstrap tools
(canonical list: `tests/tool-list.ts`; registration: `src/register.ts`).

## Rules
- Tool response types MUST match REST API camelCase field names — snake_case causes undefined
- Proxy auth: API key in PASSWORD field, routing in USERNAME field
- Username flags (gateway parseProxyOptions): country-XX, class-residential|dc|mobile, session-<alnum>, allowhttp-1; HYPHENS not underscores
- No legacy pool prefixes (dc-/residential-/auto) and no hardcoded prices — pricing text comes from GET /v1/pricing at runtime
- Plaintext http:// requires allow_http (allowhttp-1); explain it is exit-visible; flag X-DominusNode-Exit-Visible: 1
- proxyFetch: GET/HEAD only (function + Zod), drop body, ports 80/443 only, no redirects, 10MB cap
- proxyFetch: DNS rebinding check — resolve hostname and reject if ANY address is private (assertPublicResolution)
- /v1 agent routes (requireAgentPrincipal) take the dn_live_ key as Bearer (`bearer` option on HttpClient.request); non-wallet JWTs and team keys are rejected there
- node_register: wallet key ONLY from DOMINUSNODE_WALLET_KEY_FILE (0600 enforced), never a tool argument
- node_register: build attestation with src/attestation.ts (vendored copy of shared, parity-tested; no runtime dep on private @dominusnode/shared) and refuse if the server's `message` differs
- dn_node_ key: write to a new 0600 file (no overwrite), never echo it in tool output — return the path
- Credential scrubbing: scrub dn_live_/dn_test_/dn_node_/dn_proxy_/das_/JWT/Bearer in ALL error messages
- Usage tools: backend expects since/until ISO dates, NOT days integer
- check_payment: backend at GET /api/wallet/crypto/status/:invoiceId
- create_team: max_members <= 100; pay_crypto: >= $5
- Agent secret: DOMINUSNODE_AGENT_SECRET (alias MCP_AGENT_SECRET), require 32+ characters
- Process shutdown: SIGINT/SIGTERM/exit handlers call tokenManager.clear()
- Agent auto-verify: X-DominusNode-Agent:mcp header → email_verified=true server-side
- 429/401 retry safe: server rejected BEFORE processing (no mutation occurred)
- No Stripe/PayPal/plans/slots/email-password tools: humans are admin-only
- Earnings tools (src/tools/credits.ts): signing keys ONLY from DOMINUSNODE_WALLET_KEY_FILE / DOMINUSNODE_PAYOUT_WALLET_KEY_FILE; rebuild the challenge message locally (must match dashboard routes/v1/credits.ts byte for byte) and refuse to sign on mismatch
- Money fields from /v1 credits routes are {musd, usd} objects (docs/agent-network/AGENT_API.md)

- Bootstrap: wallet_setup unlocks the authenticated set in-process (unlockAuthenticatedTools); its key-file signer only signs the standard sign-in message (isSignInMessage)
- x402_info is public and registered in both modes

## Common Mistakes
- get_account_info: REST returns {user:{...}} wrapper, not flat object
- Tool counts: update tests/tool-list.ts, README, this file, root CLAUDE.md together
- Tests: mock Response with text() (safeJson pattern), not json()
