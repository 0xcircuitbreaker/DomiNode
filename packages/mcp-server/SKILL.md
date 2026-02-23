---
name: dominusnode-proxy
description: Rotating proxy access for AI agents — fetch URLs through geo-targeted datacenter ($3/GB) or residential ($5/GB) IPs, pay with crypto (BTC/ETH/LTC/XMR/ZEC/USDC/SOL/USDT/DAI/BNB/LINK) or card/PayPal/Link via Stripe, manage API keys, agentic wallets, teams, and monitor bandwidth usage. Supports bootstrap mode (no API key needed) and x402 machine-to-machine payments.
version: 1.0.0
author: Dominus Node
tools:
  - name: dominusnode_fetch
    description: Fetch a URL through rotating proxy with optional geo-targeting and pool selection
    parameters:
      url: { type: string, required: true }
      method: { type: string, enum: [GET, HEAD], default: GET }
      country: { type: string, description: "2-letter ISO code" }
      pool_type: { type: string, enum: [dc, residential, auto], default: auto }
      timeout_ms: { type: number, default: 30000 }
  - name: dominusnode_get_balance
    description: Get wallet balance in USD
  - name: dominusnode_get_forecast
    description: Get spending forecast and estimated days remaining
  - name: dominusnode_get_transactions
    description: Get wallet transaction history
  - name: dominusnode_get_usage
    description: Get bandwidth usage summary
    parameters:
      days: { type: number, default: 30 }
  - name: dominusnode_get_daily_usage
    description: Get daily bandwidth breakdown
    parameters:
      days: { type: number, default: 7 }
  - name: dominusnode_get_top_hosts
    description: Get top target hosts by bandwidth
    parameters:
      limit: { type: number, default: 10 }
      days: { type: number, default: 30 }
  - name: dominusnode_get_proxy_config
    description: Get proxy endpoint configuration and pricing
  - name: dominusnode_get_proxy_status
    description: Get live proxy network status and latency
  - name: dominusnode_register
    description: Create a new Dominus Node account
    parameters:
      email: { type: string, required: true }
      password: { type: string, required: true }
  - name: dominusnode_login
    description: Log in to existing account
    parameters:
      email: { type: string, required: true }
      password: { type: string, required: true }
  - name: dominusnode_setup
    description: One-shot account creation + API key (recommended for agents)
    parameters:
      email: { type: string, required: true }
      password: { type: string, required: true }
      key_label: { type: string, default: ai-agent }
  - name: dominusnode_get_account_info
    description: Get current account details
  - name: dominusnode_update_password
    description: Change account password
  - name: dominusnode_verify_email
    description: Verify email with token
  - name: dominusnode_resend_verification
    description: Resend email verification
  - name: dominusnode_pay_crypto
    description: Create crypto payment invoice
    parameters:
      amount_usd: { type: number, required: true, min: 10, max: 1000 }
      currency: { type: string, enum: [BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB, LINK] }
  - name: dominusnode_check_payment
    description: Check status of a crypto payment
    parameters:
      invoice_id: { type: string, required: true }
  - name: dominusnode_list_keys
    description: List API keys
  - name: dominusnode_create_key
    description: Create a new API key
  - name: dominusnode_revoke_key
    description: Revoke an API key
  - name: dominusnode_get_plan
    description: Get current plan and usage
  - name: dominusnode_list_plans
    description: List available plans
  - name: dominusnode_get_active_sessions
    description: Get active proxy sessions
  - name: dominusnode_x402_info
    description: Get x402 micropayment protocol info
  - name: dominusnode_agent_wallet_create
    description: Create an agentic sub-wallet with spending limits
    parameters:
      label: { type: string }
      spending_limit_cents: { type: number, default: 10000 }
  - name: dominusnode_agent_wallet_balance
    description: Get agentic wallet balance
  - name: dominusnode_agent_wallet_fund
    description: Fund an agentic wallet from main wallet
  - name: dominusnode_agent_wallet_list
    description: List all agentic wallets
  - name: dominusnode_agent_wallet_transactions
    description: Get agentic wallet transaction history
  - name: dominusnode_agent_wallet_freeze
    description: Freeze an agentic wallet (stop spending)
  - name: dominusnode_agent_wallet_unfreeze
    description: Unfreeze an agentic wallet
  - name: dominusnode_agent_wallet_delete
    description: Delete an agentic wallet (refunds balance to main)
  - name: dominusnode_wallet_challenge
    description: Request a wallet signature challenge (crypto login)
  - name: dominusnode_register_wallet
    description: Verify wallet signature and create/login account
  - name: dominusnode_wallet_setup
    description: One-shot wallet auth + API key creation
  - name: dominusnode_check_slots
    description: Check available registration slots
  - name: dominusnode_join_waitlist
    description: Join the waitlist
  - name: dominusnode_get_waitlist_count
    description: Get waitlist count
  - name: dominusnode_create_team
    description: Create a team with shared wallet
  - name: dominusnode_list_teams
    description: List your teams
  - name: dominusnode_team_details
    description: Get team details
  - name: dominusnode_team_update
    description: Update team name or max member limit
  - name: dominusnode_team_update_member_role
    description: Change a team member's role (admin/member)
  - name: dominusnode_team_add_member
    description: Add a member to a team
  - name: dominusnode_team_remove_member
    description: Remove a member from a team
  - name: dominusnode_team_list_members
    description: List team members
  - name: dominusnode_team_invite_member
    description: Invite a member via email
  - name: dominusnode_team_list_invites
    description: List pending team invites
  - name: dominusnode_team_cancel_invite
    description: Cancel a pending invite
  - name: dominusnode_team_fund
    description: Fund team wallet from personal wallet
  - name: dominusnode_team_create_key
    description: Create a team API key (bills to team wallet)
  - name: dominusnode_team_list_keys
    description: List team API keys
  - name: dominusnode_team_revoke_key
    description: Revoke a team API key
  - name: dominusnode_team_usage
    description: Get team wallet transaction history
  - name: dominusnode_team_delete
    description: Delete a team (refunds wallet to owner)
---

# Dominus Node Proxy Skill

You have access to Dominus Node's rotating proxy network. Use it to fetch web pages through datacenter or residential IPs with optional geo-targeting.

## Quick Start

If you don't have an account yet, use `dominusnode_setup` to create one automatically:
```
dominusnode_setup(email: "<your-unique-email>", password: "<generate-a-random-32-char-password>")
```
**IMPORTANT:** Generate a unique random password for every account. Do NOT reuse example values.

Then fetch URLs through the proxy:
```
dominusnode_fetch(url: "https://example.com", country: "US")
dominusnode_fetch(url: "https://example.com", pool_type: "dc", country: "DE")  # Datacenter, cheaper
```

## Bootstrap Mode (No API Key)

If no API key is configured, you can still:
1. Create an account with `dominusnode_setup` or `dominusnode_register`
2. Pay with crypto using `dominusnode_pay_crypto` (11 currencies supported)
3. Check payment status with `dominusnode_check_payment`
4. Check x402 info with `dominusnode_x402_info` for machine-to-machine payments

After setup, set DOMINUSNODE_API_KEY and restart to unlock all 56 tools.

## Cost Awareness

- **Datacenter Pool:** $3.00/GB (pool_type: "dc") — faster, cheaper
- **Residential Pool:** $5.00/GB (pool_type: "residential") — harder to detect
- **Auto (default):** Tries datacenter first, falls back to residential
- A typical HTML page is ~100KB = ~$0.0003 (DC) or $0.0005 (residential)
- Always check balance with `dominusnode_get_balance` before large scraping jobs
- Use `dominusnode_get_forecast` to estimate when funds will run out
- Free tier: 1GB bandwidth, 10 connections — no payment required

## Crypto Payments

For anonymous or autonomous payments (11 currencies, minimum $10):
```
dominusnode_pay_crypto(amount_usd: 10, currency: "XMR")    # Monero — private
dominusnode_pay_crypto(amount_usd: 10, currency: "USDC")    # Stablecoin
dominusnode_check_payment(invoice_id: "inv_xxx")             # Check status
```

Supported: BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB, LINK.
Privacy coins (XMR, ZEC) provide enhanced payment privacy.

## Agentic Wallets

Create sub-wallets with spending limits for autonomous sub-tasks:
```
dominusnode_agent_wallet_create(label: "scraper-task", spending_limit_cents: 5000)
dominusnode_agent_wallet_fund(wallet_id: "...", amount_cents: 1000)
dominusnode_agent_wallet_freeze(wallet_id: "...")   # Emergency stop
```

## Teams

Create teams with shared billing:
```
dominusnode_create_team(name: "My Team", max_members: 5)
dominusnode_team_fund(team_id: "...", amount_cents: 10000)
dominusnode_team_create_key(team_id: "...", label: "worker-1")  # Bills to team
```

## Geo-Targeting

Route requests through specific locations:
- `country: "US"` — any US IP
- `country: "GB"` — United Kingdom IP
- `country: "DE"` — Germany IP

Note: State/city targeting is not supported by the current provider (country-level only).

## Tips

1. **Check balance first** for large jobs — prevents mid-scrape failures
2. **Use HEAD requests** to check URLs without downloading full content
3. **Use DC pool** for non-geo-sensitive targets — saves 40% vs residential
4. **Set timeouts** for slow sites: `timeout_ms: 60000`
5. **Monitor usage** with `dominusnode_get_daily_usage` to track spend
6. **Rotate keys** periodically with `dominusnode_create_key` / `dominusnode_revoke_key`
7. **Use free tier** for testing — 1GB bandwidth, no payment required
8. **Pay with crypto** for autonomous agent operation — no credit card needed
9. **Use agentic wallets** to isolate spending for sub-tasks
10. **Use teams** for shared billing across multiple agents
