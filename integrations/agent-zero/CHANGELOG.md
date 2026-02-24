# Changelog

All notable changes to the DomiNode Agent Zero integration will be
documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] - 2025-02-23

### Added

- Initial release with 22 tools across 4 modules
- **Proxy tools** (3): proxied_fetch, get_proxy_config, list_sessions
- **Wallet tools** (3): check_balance, check_usage, topup_paypal
- **Agentic wallet tools** (8): create, fund, balance, list, transactions,
  freeze, unfreeze, delete
- **Team tools** (8): create_team, list_teams, team_details, team_fund,
  team_create_key, team_usage, update_team, update_team_member_role
- Shared SSRF prevention module with DNS rebinding protection
- Shared auth module with JWT verify-key flow and 401 retry
- Full test suite (55 tests)
