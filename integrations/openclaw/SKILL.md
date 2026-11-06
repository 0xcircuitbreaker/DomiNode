---
name: dominusnode-relay
version: 2.0.0
description: Fetch the web through the DominusNode AI-agent relay network (residential, datacenter and mobile exits), check live pricing, wallet, usage and node earnings
author: Dominus Node
tags:
  - proxy
  - relay
  - web-scraping
  - geo-targeting
  - ai-agent
requires:
  env:
    - DOMINUSNODE_API_KEY
tools:
  - dominusnode_fetch
  - dominusnode_proxy_url
  - dominusnode_network_policy
  - dominusnode_network_pricing
  - dominusnode_network_stats
  - dominusnode_balance
  - dominusnode_transactions
  - dominusnode_topup_crypto
  - dominusnode_check_payment
  - dominusnode_usage
  - dominusnode_active_sessions
  - dominusnode_report_session
  - dominusnode_node_list
  - dominusnode_node_tier
  - dominusnode_node_setup_guide
  - dominusnode_credits_balance
  - dominusnode_credits_convert
  - dominusnode_payouts_list
  - dominusnode_x402_info
---

# DominusNode relay skill

DominusNode is a relay network for AI agents: requests exit through real residential,
datacenter or mobile IPs contributed by node operators. Traffic is billed per GB from a
prepaid wallet; operators earn a share by running the node agent.

## When to use

- A page blocks datacenter traffic or needs a specific country: `dominusnode_fetch` with
  `country` and/or `ip_class`. Keep `session_id` to reuse the same exit IP.
- Before large jobs, check `dominusnode_network_pricing` (never assume prices) and
  `dominusnode_balance`; top up with `dominusnode_topup_crypto`.
- A bad exit (captcha, blocks): `dominusnode_report_session`.
- To earn: `dominusnode_node_setup_guide`, then `dominusnode_node_list`,
  `dominusnode_node_tier`, `dominusnode_credits_balance`, `dominusnode_credits_convert`.

## Rules

- https:// is the default. http:// needs `allow_http: true`; plaintext is visible to the
  exit node, so never send credentials or private data that way.
- GET/HEAD only, ports 80/443, no private or local targets, redirects are not followed,
  bodies capped at 10 MB. Sanctioned countries (CU, IR, KP, RU, SY) are refused.
- The API key comes from `DOMINUSNODE_API_KEY` only and is never shown in results.
- Withdrawals, payout wallets and node registration need a wallet signature and are not
  available as tools; use the DominusNode MCP server or SDK with a signer key file.
