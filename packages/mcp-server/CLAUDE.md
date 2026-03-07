# @dominusnode/mcp-server

Team: **AI & Integrations**

MCP (Model Context Protocol) server providing 59 authenticated + 17 bootstrap tools.

## Rules
- Tool response types MUST match REST API camelCase field names — snake_case causes undefined
- Proxy auth: API key in PASSWORD field, routing in USERNAME field
- Geo-targeting: HYPHENS (country-US) not underscores (country_US)
- Usage tools: backend expects since/until ISO dates, NOT days integer
- ProxyConfig: backend returns {httpProxy:{host,port}} objects, not flat strings
- check_payment: re-enabled, backend at GET /api/wallet/crypto/status/:invoiceId
- create_team: max_members <= 100; pay_crypto: >= $5
- Credential scrubbing: scrub dn_live_*/dn_test_*/JWT in error messages
- proxyFetch: enforce GET/HEAD at function level + Zod schema (defense-in-depth)
- proxyFetch: drop body on GET/HEAD (opts.body = undefined)
- URL/header size limits on fetch requests
- MCP_AGENT_SECRET: require 32+ characters
- Process shutdown: SIGINT/SIGTERM/exit handlers call tokenManager.clear()
- Agent auto-verify: X-DominusNode-Agent:mcp header → email_verified=true server-side
- 429/401 retry safe: server rejected BEFORE processing (no mutation occurred)

## Common Mistakes
- get_account_info: REST returns {user:{...}} wrapper, not flat object
- MCP types.ts must use camelCase matching REST API responses
- Stale tool counts in README/comments — verify actual count
