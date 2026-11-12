# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [2.0.1] - 2026-11-12

### Security
- Proxy fetches now use TLS to the gateway by default (`https://proxy.dominusnode.daedalusdevelopmentgroup.com:8443`). Plaintext to `:8080`, which sends the API key in clear, needs `DOMINUSNODE_PROXY_INSECURE=1` and prints a warning. `DOMINUSNODE_PROXY_URL`, `DOMINUSNODE_PROXY_CA_FILE` and `DOMINUSNODE_PROXY_INSECURE` are documented in the README, `server.json`, `smithery.yaml` and the Dockerfile.
- Client-side SSRF checks use CIDR matching (`node:net` BlockList) and now also block `fec0::/10`, `192.0.0.0/24`, `198.18.0.0/15`, documentation ranges and NAT64 `64:ff9b::/96` with a private embedded IPv4.
- Per-agent `das_` secrets are scrubbed from error output.

### Fixed
- The 2.0.0 tarball shipped stale, unregistered tool modules (`plans`, `slots`, `stripe`, `paypal`). `prepack`/`prepublishOnly` now clean `dist/` first, and a test checks the packed file list.
- Usage figures use decimal GB (1e9 bytes, as billed) and show the raw byte count.
- `DOMINUSNODE_AGENT_SECRET` (what `create_agent_secret` tells agents to set) is now read; `MCP_AGENT_SECRET` stays as an alias. The tool description no longer promises CAPTCHA bypass or email verification.

### Changed
- Bootstrap: `dominusnode_wallet_setup` unlocks the authenticated tools in the same session (`notifications/tools/list_changed`), and can sign the standard sign-in message itself when `DOMINUSNODE_WALLET_KEY_FILE` is set. Only failed signature verifications count toward the wallet auth limit (5/hour); challenges are capped at 20/hour. The challenge text points to `dominusnode_wallet_setup`.
- `dominusnode_x402_info` is public and available in bootstrap mode (12 bootstrap tools); it shows whether x402 is enabled and how to pay with it.
- `dominusnode_fetch` documents the request headers it drops, notes them in the result, and sends `User-Agent: dominusnode-mcp-server/<version>`.
- `credits_convert` / `credits_withdraw` include the idempotency key in errors so a retry can reuse it.
- Docker image installs with `npm ci` from a lockfile; the Dockerfile documents `--user` / Docker secrets for the wallet key file check.

## [2.0.0] - 2026-11-06

### Changed
- Rebuilt for the AI-agent relay network. `dominusnode_fetch` takes `country`, `ip_class`, `session_id`, `allow_http` (gateway username flags) instead of `pool_type`; plaintext needs explicit opt-in; DNS rebinding check; ports 80/443 only; 10MB cap.
- Pricing text is read from `GET /v1/pricing` at runtime.

### Added
- `dominusnode_network_policy`, `dominusnode_network_pricing`, `dominusnode_network_stats`.
- `dominusnode_node_register_challenge`, `dominusnode_node_register`, `dominusnode_node_list`, `dominusnode_node_revoke`, `dominusnode_node_tier`, `dominusnode_node_setup_guide`.
- Node earnings: credits balance/convert and payout tools; owner-signed flows (node registration, withdrawals, payout wallet) read keys only from `DOMINUSNODE_WALLET_KEY_FILE` / `DOMINUSNODE_PAYOUT_WALLET_KEY_FILE`, never from a tool argument.
- `server.json` for the official MCP Registry (`io.github.0xcircuitbreaker/dominusnode`), published by the release workflow.

### Packaging
- The npm package ships `dist/src` without source maps, plus README, CHANGELOG and LICENSE.

### Removed
- Stripe, PayPal, plans, slots/waitlist and email/password account tools.

## [1.0.0] - 2026-02-19

### Added
- Initial release of the Dominus Node MCP Server.
- 43 authenticated-mode tools and 20 bootstrap-mode tools.
- Compatible with Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, Cline, Gemini CLI, OpenAI Codex CLI, and Zed.
- Built on the official `@modelcontextprotocol/sdk` with `zod` schema validation for all tool inputs.
- Requires Node.js 18+.
- Dual operating modes: **bootstrap mode** (no API key required) and **authenticated mode** (full tool access).
- Bootstrap mode provides account creation, wallet auth, slot management, crypto payment, and agentic wallet tools so agents can self-onboard without manual configuration.
- AI agent auto-registration with automatic email verification via `dominusnode_setup`.
- **Account tools** (6 tools): `dominusnode_setup` (one-shot registration + API key), `dominusnode_register`, `dominusnode_login`, `dominusnode_profile`, `dominusnode_mfa_setup`, `dominusnode_mfa_verify`.
- **Wallet auth tools** (3 tools): `dominusnode_wallet_challenge`, `dominusnode_wallet_setup`, `dominusnode_wallet_link` for cryptographic wallet-based authentication.
- **Key management tools** (3 tools): `dominusnode_create_key`, `dominusnode_list_keys`, `dominusnode_revoke_key`.
- **Wallet tools** (3 tools): `dominusnode_balance`, `dominusnode_transactions`, `dominusnode_topup_stripe`.
- **Crypto payment tools** (2 tools): `dominusnode_pay_crypto` (supports BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB, LINK), `dominusnode_check_payment` for invoice status polling.
- **Usage tools** (3 tools): `dominusnode_usage_summary`, `dominusnode_usage_daily`, `dominusnode_usage_top_hosts`.
- **Proxy tools** (2 tools): `dominusnode_proxy_url` (build proxy URLs with geo-targeting), `dominusnode_proxy_health`.
- **Plan tools** (2 tools): `dominusnode_list_plans`, `dominusnode_current_plan`.
- **Session tools** (1 tool): `dominusnode_active_sessions`.
- **Fetch tools** (1 tool): `dominusnode_fetch` for proxied HTTP requests through the Dominus Node gateway.
- **Slot tools** (3 tools): `dominusnode_check_slots`, `dominusnode_join_waitlist`, `dominusnode_waitlist_position` for alpha access slot management.
- **Agentic wallet tools** (6 tools): `dominusnode_agent_wallet_create`, `dominusnode_agent_wallet_balance`, `dominusnode_agent_wallet_fund`, `dominusnode_agent_wallet_list`, `dominusnode_agent_wallet_transactions`, `dominusnode_agent_wallet_x402_info` for server-side custodial sub-wallets with spending limits.
- **Team management tools** (8 tools): `dominusnode_create_team`, `dominusnode_list_teams`, `dominusnode_team_details`, `dominusnode_team_add_member`, `dominusnode_team_remove_member`, `dominusnode_team_fund`, `dominusnode_team_create_key`, `dominusnode_team_usage` for multi-agent team setups with shared wallet billing.
- **Bootstrap helper** (1 tool): `dominusnode_bootstrap_help` for guiding agents through initial setup.
- `TokenManager` for automatic JWT refresh with rotating refresh tokens.
- `HttpClient` with automatic authentication header injection, private IP blocking (SSRF prevention), and configurable API base URL.
- `ProxyFetch` module for routing HTTP requests through the Dominus Node proxy with geo-targeting and protocol selection.
- Configurable via environment variables: `DOMINUSNODE_API_KEY`, `DOMINUSNODE_API_URL`, `DOMINUSNODE_PROXY_HOST`, `DOMINUSNODE_HTTP_PROXY_PORT`.
- Installable as `dominusnode-mcp` CLI binary via npm.

[1.0.0]: https://github.com/Dominus-Node/dominusnode-mcp/releases/tag/v1.0.0
