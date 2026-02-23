# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
