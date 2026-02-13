---
name: dominode-proxy
description: Rotating proxy access for AI agents — fetch URLs through geo-targeted residential IPs, pay with crypto (BTC/ETH/XMR/SOL/ZEC), manage API keys, monitor bandwidth usage and billing. Supports bootstrap mode (no API key needed) and x402 machine-to-machine payments.
version: 1.0.0
author: DomiNode
tools:
  - name: dominode_fetch
    description: Fetch a URL through rotating proxy with optional geo-targeting
    parameters:
      url: { type: string, required: true }
      method: { type: string, default: GET }
      country: { type: string, description: "2-letter ISO code" }
      state: { type: string }
      city: { type: string }
  - name: dominode_get_balance
    description: Get wallet balance in USD
  - name: dominode_get_usage
    description: Get bandwidth usage summary
    parameters:
      days: { type: number, default: 30 }
  - name: dominode_register
    description: Create a new DomiNode account (free tier available)
    parameters:
      email: { type: string, required: true }
      password: { type: string, required: true }
  - name: dominode_setup
    description: One-shot account creation + API key + proxy config
    parameters:
      email: { type: string, required: true }
      password: { type: string, required: true }
      key_label: { type: string, default: ai-agent }
  - name: dominode_pay_crypto
    description: Create crypto payment invoice
    parameters:
      amount_usd: { type: number, required: true, min: 1, max: 10000 }
      currency: { type: string, enum: [BTC, ETH, XMR, SOL, ZEC, USDC, USDT] }
  - name: dominode_check_payment
    description: Check status of a crypto payment
    parameters:
      invoice_id: { type: string, required: true }
  - name: dominode_x402_info
    description: Get x402 micropayment protocol info for machine-to-machine payments
  - name: dominode_agent_wallet_create
    description: Create a Coinbase Agentic Wallet with spending limits
    parameters:
      label: { type: string }
      max_spend_usd: { type: number, default: 100 }
---

# DomiNode Proxy Skill

You have access to DomiNode's rotating proxy network. Use it to fetch web pages through residential/datacenter IPs with optional geo-targeting.

## Quick Start

If you don't have an account yet, use `dominode_setup` to create one automatically:
```
dominode_setup(email: "<your-unique-email>", password: "<generate-a-random-32-char-password>")
```
**IMPORTANT:** Generate a unique random password for every account. Do NOT reuse example values.

Then fetch URLs through the proxy:
```
dominode_fetch(url: "https://example.com", country: "US")
```

## Bootstrap Mode

If no API key is configured, you can still:
1. Create an account with `dominode_setup` or `dominode_register`
2. Pay with crypto using `dominode_pay_crypto` (BTC, ETH, XMR, SOL, ZEC, USDC, USDT)
3. Check x402 info with `dominode_x402_info` for machine-to-machine payments
4. Create a Coinbase Agentic Wallet with `dominode_agent_wallet_create`

## Cost Awareness

- Pricing: **$5.00/GB** bandwidth (pay-as-you-go)
- A typical HTML page is ~100KB = ~$0.0005
- Always check balance with `dominode_get_balance` before large scraping jobs
- Use `dominode_get_forecast` to estimate when funds will run out
- Free tier: 1GB bandwidth, 10 connections — no payment required

## Crypto Payments

For anonymous or autonomous payments:
```
dominode_pay_crypto(amount_usd: 10, currency: "XMR")  # Monero — private
dominode_pay_crypto(amount_usd: 5, currency: "USDC")   # Stablecoin
dominode_check_payment(invoice_id: "inv_xxx")           # Check status
```

Privacy coins (XMR, ZEC) provide enhanced payment privacy.

## Geo-Targeting

Route requests through specific locations:
- `country: "US"` — any US IP
- `country: "US", state: "CA"` — California IP
- `country: "US", state: "CA", city: "Los Angeles"` — LA IP
- `country: "GB"` — United Kingdom IP
- `country: "DE"` — Germany IP

## Tips

1. **Check balance first** for large jobs — prevents mid-scrape failures
2. **Use HEAD requests** to check URLs without downloading full content
3. **Set timeouts** for slow sites: `timeout_ms: 60000`
4. **Monitor usage** with `dominode_get_daily_usage` to track spend
5. **Rotate keys** periodically with `dominode_create_key` / `dominode_revoke_key`
6. **Use free tier** for testing — 1GB bandwidth, no payment required
7. **Pay with crypto** for autonomous agent operation — no credit card needed
