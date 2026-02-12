# DomiNode Usage Guide

DomiNode is a rotating proxy-as-a-service (PaaS) platform. Users connect to DomiNode, are assigned a proxy IP from a managed pool, and their traffic is routed through it. Usage is metered by bandwidth and billed from a prepaid wallet.

This guide covers everything you need to use DomiNode as an end user, developer integrating via API, or platform administrator.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Authentication](#authentication)
  - [Account Registration](#account-registration)
  - [Login](#login)
  - [Session Restoration](#session-restoration)
  - [API Key Authentication](#api-key-authentication)
  - [Token Refresh](#token-refresh)
  - [Password Change](#password-change)
  - [Logout](#logout)
- [Using the Proxy](#using-the-proxy)
  - [HTTP Proxy (Port 8080)](#http-proxy-port-8080)
  - [SOCKS5 Proxy (Port 1080)](#socks5-proxy-port-1080)
  - [Username Format for Geo-Targeting](#username-format-for-geo-targeting)
  - [Supported Countries](#supported-countries)
  - [Using in Code](#using-in-code)
- [Wallet and Billing](#wallet-and-billing)
  - [Prepaid Model](#prepaid-model)
  - [Pricing Plans](#pricing-plans)
  - [Top Up with Stripe (Credit Card)](#top-up-with-stripe-credit-card)
  - [Top Up with Crypto](#top-up-with-crypto)
  - [Check Balance](#check-balance)
  - [Transaction History](#transaction-history)
  - [Balance Forecast](#balance-forecast)
  - [Change Plan](#change-plan)
- [Two-Factor Authentication (2FA/MFA)](#two-factor-authentication-2famfa)
  - [Enable MFA](#enable-mfa)
  - [Login with MFA](#login-with-mfa)
  - [Using Backup Codes](#using-backup-codes)
  - [Disable MFA](#disable-mfa)
  - [Check MFA Status](#check-mfa-status)
- [API Key Management](#api-key-management)
  - [Create Key](#create-key)
  - [List Keys](#list-keys)
  - [Revoke Key](#revoke-key)
- [Usage Tracking](#usage-tracking)
  - [View Usage Summary](#view-usage-summary)
  - [Daily Breakdown](#daily-breakdown)
  - [Top Target Hosts](#top-target-hosts)
  - [Export as CSV](#export-as-csv)
- [Browser Extension](#browser-extension)
  - [Supported Browsers](#supported-browsers)
  - [Install from Source](#install-from-source)
  - [Configure](#configure)
- [Web Dashboard](#web-dashboard)
- [Admin Operations](#admin-operations)
  - [List Users](#list-users)
  - [Get User Details](#get-user-details)
  - [Suspend User](#suspend-user)
  - [Reactivate User](#reactivate-user)
  - [Delete User](#delete-user)
  - [Revenue Stats](#revenue-stats)
  - [Daily Revenue Breakdown](#daily-revenue-breakdown)
  - [System Stats](#system-stats)
- [Rate Limits](#rate-limits)
- [Error Codes](#error-codes)
- [Complete API Reference](#complete-api-reference)
- [Troubleshooting](#troubleshooting)

---

## Quick Start

Get up and running in four steps:

1. Register an account
2. Top up your wallet ($5 minimum)
3. Create an API key
4. Use the proxy

```bash
# 1. Register
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"SecurePass123!"}'

# Response includes a JWT token for API calls:
# {"token":"eyJ...","refreshToken":"eyJ...","user":{"id":"...","email":"you@example.com"}}

# 2. Top up your wallet ($10.00 = 1000 cents)
curl -X POST http://localhost:3000/api/wallet/topup/stripe \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"amountCents": 1000}'
# Returns a Stripe checkout URL -- complete payment there

# 3. Create an API key
curl -X POST http://localhost:3000/api/keys \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label":"my-first-key"}'
# SAVE the returned key (dn_live_xxx) -- it is shown only once

# 4. Use the proxy
curl -x http://user:dn_live_YOUR_KEY@localhost:8080 http://httpbin.org/ip

# HTTPS works too (transparent tunneling via CONNECT)
curl -x http://user:dn_live_YOUR_KEY@localhost:8080 https://httpbin.org/ip

# SOCKS5
curl -x socks5://user:dn_live_YOUR_KEY@localhost:1080 http://httpbin.org/ip
```

---

## Authentication

DomiNode supports two authentication paths:

- **Browser clients** (web dashboard): Tokens are delivered as httpOnly cookies. No token management is needed in frontend JavaScript. Cookies are sent automatically on subsequent requests.
- **API/Extension clients**: Tokens are returned in the JSON response body. You must include `Authorization: Bearer <token>` on subsequent requests.

The server determines which path to use based on whether the `Origin` header matches the configured `CORS_ORIGINS`.

### Account Registration

**POST /api/auth/register**

No authentication required.

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"SecurePass123!"}'
```

**Password requirements:**
- Minimum 8 characters, maximum 128
- At least 2 character classes (from: lowercase, uppercase, digits, symbols)
- Must not be in the top 20 common passwords list
- Must not contain your email username (if 3+ characters)

**Response (API/extension client):**
```json
{
  "token": "eyJ...",
  "refreshToken": "eyJ...",
  "user": {
    "id": "a1b2c3d4-...",
    "email": "you@example.com",
    "created_at": "2026-02-09T...",
    "is_admin": false
  }
}
```

**Response (browser client):**
Tokens are set as httpOnly cookies. The response body contains only the user object:
```json
{
  "user": {
    "id": "a1b2c3d4-...",
    "email": "you@example.com",
    "created_at": "2026-02-09T...",
    "is_admin": false
  }
}
```

Registration automatically creates a wallet with $0.00 balance.

### Login

**POST /api/auth/login**

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"SecurePass123!"}'
```

**Normal response (no MFA):** Same format as registration -- tokens in body for API clients, httpOnly cookies for browser clients.

**MFA-enabled response:**
```json
{
  "mfaRequired": true,
  "mfaChallengeToken": "eyJ..."
}
```
When MFA is enabled, the login returns a short-lived challenge token (5-minute expiry) instead of real tokens. See [Login with MFA](#login-with-mfa) to complete authentication.

**Account lockout:** After 5 failed login attempts from the same IP+email combination, the account is locked for 15 minutes. The lockout is scoped to the IP+email pair, so an attacker cannot lock arbitrary accounts from a different IP.

### Session Restoration

**GET /api/auth/me**

For browser clients using cookie-based auth. On page reload, call this endpoint to restore the user session without re-entering credentials.

```bash
curl http://localhost:3000/api/auth/me \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

Response:
```json
{
  "user": {
    "id": "a1b2c3d4-...",
    "email": "you@example.com",
    "is_admin": false
  }
}
```

### API Key Authentication

**POST /api/auth/verify-key**

For the browser extension or any client that authenticates via API key instead of email/password. Returns JWT tokens that can be used for subsequent API calls.

```bash
curl -X POST http://localhost:3000/api/auth/verify-key \
  -H "Content-Type: application/json" \
  -d '{"apiKey":"dn_live_YOUR_KEY"}'
```

Response:
```json
{
  "valid": true,
  "token": "eyJ...",
  "refreshToken": "eyJ...",
  "userId": "a1b2c3d4-...",
  "email": "you@example.com"
}
```

API key verification bypasses MFA -- possession of the key is treated as equivalent to device trust.

### Token Refresh

**POST /api/auth/refresh**

Access tokens expire after 15 minutes. Refresh tokens last 7 days.

```bash
# For API clients: send the refresh token in the request body
curl -X POST http://localhost:3000/api/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"eyJ..."}'
```

For browser clients, the refresh token is read from the httpOnly cookie automatically.

**Security features:**
- Refresh tokens rotate on each use. The old token is invalidated and a new one is issued.
- All tokens belong to a "family". If a revoked token is reused (indicating theft), the entire family is revoked, immediately logging out all sessions created from that login.
- If a password change occurs after a refresh token was issued, that token is invalidated.

### Password Change

**POST /api/auth/change-password** (requires authentication)

```bash
curl -X POST http://localhost:3000/api/auth/change-password \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"currentPassword":"OldPass123!","newPassword":"NewSecure456!"}'
```

Changing your password:
- Revokes all existing refresh tokens (logs out all other sessions)
- Issues a fresh token pair for the current session
- The new password must meet the same requirements as registration

### Logout

**POST /api/auth/logout** (requires authentication)

```bash
curl -X POST http://localhost:3000/api/auth/logout \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

Server-side logout revokes all refresh tokens for the user and clears auth cookies.

---

## Using the Proxy

DomiNode provides two proxy protocols: HTTP (with HTTPS tunneling via CONNECT) and SOCKS5.

Authentication is via proxy username/password, where:
- **Username**: encodes geo-targeting and session options (see format below)
- **Password**: your API key (the `dn_live_xxx` string)

### HTTP Proxy (Port 8080)

```bash
# Basic usage -- any location
curl -x http://user:dn_live_KEY@proxy.dominode.io:8080 http://target.com

# HTTPS (transparent tunneling via CONNECT)
curl -x http://user:dn_live_KEY@proxy.dominode.io:8080 https://httpbin.org/ip

# With country targeting (United States)
curl -x http://country-US:dn_live_KEY@proxy.dominode.io:8080 http://target.com

# With state + city targeting
curl -x http://country-US-state-california-city-losangeles:dn_live_KEY@proxy.dominode.io:8080 http://target.com

# With sticky session (same exit IP for the session duration)
curl -x http://country-US-session-mysession123:dn_live_KEY@proxy.dominode.io:8080 http://target.com

# Combined: country + state + sticky session
curl -x http://country-DE-state-bavaria-session-s1:dn_live_KEY@proxy.dominode.io:8080 http://target.com
```

For local development, replace `proxy.dominode.io` with `localhost`.

### SOCKS5 Proxy (Port 1080)

```bash
# Basic
curl -x socks5://user:dn_live_KEY@proxy.dominode.io:1080 http://target.com

# With geo-targeting (same username format as HTTP)
curl -x socks5://country-US-state-california:dn_live_KEY@proxy.dominode.io:1080 http://target.com

# SOCKS5 with HTTPS
curl -x socks5://user:dn_live_KEY@proxy.dominode.io:1080 https://httpbin.org/ip
```

### Username Format for Geo-Targeting

The proxy username encodes targeting options using a hyphen-delimited format:

```
[country-XX][-state-NAME][-city-NAME][-asn-NUMBER][-session-ID]
```

All parameters are optional. If no targeting is specified, use any string (e.g., `user`) as the username.

| Parameter | Format | Example | Description |
|-----------|--------|---------|-------------|
| country | `country-XX` | `country-US` | ISO 3166-1 alpha-2 country code |
| state | `state-NAME` | `state-california` | Lowercase, no spaces |
| city | `city-NAME` | `city-losangeles` | Lowercase, no spaces |
| asn | `asn-NUMBER` | `asn-13335` | Autonomous System Number (1-4294967295) |
| session | `session-ID` | `session-abc123` | Alphanumeric sticky session identifier |

**Examples:**
- `user` -- any location, rotating IP
- `country-US` -- United States
- `country-US-state-california` -- California, US
- `country-US-state-california-city-losangeles` -- Los Angeles, CA, US
- `country-US-session-abc123` -- Sticky session in US
- `country-DE-state-bavaria-session-s1` -- Sticky session in Bavaria, Germany
- `country-US-asn-13335` -- US, Cloudflare ASN

**Naming conventions for states and cities:** Use lowercase with no spaces. Multi-word names are concatenated: `newyork`, `losangeles`, `sanfrancisco`, `northcarolina`.

### Supported Countries

PacketStream (the default upstream provider) supports 100+ countries. The following OFAC-sanctioned countries are blocked and will return an error:

- Cuba (CU)
- Iran (IR)
- North Korea (KP)
- Russia (RU)
- Syria (SY)

### Using in Code

**Python (requests)**

```python
import requests

proxies = {
    "http": "http://country-US:dn_live_KEY@proxy.dominode.io:8080",
    "https": "http://country-US:dn_live_KEY@proxy.dominode.io:8080",
}
response = requests.get("http://httpbin.org/ip", proxies=proxies)
print(response.json())
```

**Python (with SOCKS5)**

Requires `pip install requests[socks]` (or `pip install PySocks`).

```python
import requests

proxies = {
    "http": "socks5://country-US:dn_live_KEY@proxy.dominode.io:1080",
    "https": "socks5://country-US:dn_live_KEY@proxy.dominode.io:1080",
}
response = requests.get("http://httpbin.org/ip", proxies=proxies)
print(response.json())
```

**Node.js (undici ProxyAgent)**

```javascript
import { ProxyAgent } from 'undici';

const agent = new ProxyAgent('http://country-US:dn_live_KEY@proxy.dominode.io:8080');
const res = await fetch('http://httpbin.org/ip', { dispatcher: agent });
console.log(await res.json());
```

**Node.js (https-proxy-agent)**

```javascript
import { HttpsProxyAgent } from 'https-proxy-agent';

const agent = new HttpsProxyAgent('http://country-US:dn_live_KEY@proxy.dominode.io:8080');
const res = await fetch('https://httpbin.org/ip', { agent });
console.log(await res.json());
```

**Go (net/http)**

```go
import (
    "net/http"
    "net/url"
)

proxyURL, _ := url.Parse("http://country-US:dn_live_KEY@proxy.dominode.io:8080")
client := &http.Client{
    Transport: &http.Transport{
        Proxy: http.ProxyURL(proxyURL),
    },
}
resp, err := client.Get("http://httpbin.org/ip")
```

**Java (HttpClient)**

```java
import java.net.InetSocketAddress;
import java.net.ProxySelector;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.URI;

var proxy = ProxySelector.of(new InetSocketAddress("proxy.dominode.io", 8080));
var client = HttpClient.newBuilder()
    .proxy(proxy)
    .authenticator(new java.net.Authenticator() {
        protected java.net.PasswordAuthentication getPasswordAuthentication() {
            return new java.net.PasswordAuthentication(
                "country-US", "dn_live_KEY".toCharArray());
        }
    })
    .build();

var request = HttpRequest.newBuilder()
    .uri(URI.create("http://httpbin.org/ip"))
    .build();
var response = client.send(request, HttpResponse.BodyHandlers.ofString());
System.out.println(response.body());
```

**Scrapy (Python)**

```python
# In settings.py
DOWNLOADER_MIDDLEWARES = {
    'scrapy.downloadermiddlewares.httpproxy.HttpProxyMiddleware': 110,
}
HTTP_PROXY = 'http://country-US:dn_live_KEY@proxy.dominode.io:8080'
HTTPS_PROXY = 'http://country-US:dn_live_KEY@proxy.dominode.io:8080'
```

---

## Wallet and Billing

### Prepaid Model

DomiNode uses a prepaid wallet system:

- You must have a positive balance before using the proxy.
- Usage is metered by bandwidth: every byte routed through the proxy (in + out) is counted.
- When a proxy session starts, a minimum of 10 cents is reserved from your wallet.
- When the session ends, the actual cost is calculated and the reservation is settled (excess is returned).
- If your balance drops to zero during a session, the session continues until it naturally ends, but new sessions will be rejected.

### Pricing Plans

| Plan ID | Plan Name | Price/GB | Monthly Bandwidth | Min. Wallet Balance |
|---------|-----------|----------|-------------------|---------------------|
| `payg` | Pay As You Go | $5.00/GB | Unlimited | None |
| `vol100` | Volume 100GB | $4.00/GB | 100 GB | $10.00 |
| `vol1tb` | Volume 1TB | $3.00/GB | 1 TB | $50.00 |

New accounts start on the Pay As You Go plan.

**View available plans (no auth required):**

```bash
curl http://localhost:3000/api/plans
```

**View your current plan and monthly usage:**

```bash
curl http://localhost:3000/api/plans/user/plan \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

Response:
```json
{
  "plan": {
    "id": "payg",
    "name": "Pay As You Go",
    "pricePerGbCents": 500,
    "pricePerGbUsd": 5.00,
    "monthlyBandwidthBytes": 0,
    "monthlyBandwidthGB": null,
    "isDefault": true
  },
  "usage": {
    "monthlyUsageBytes": 1073741824,
    "monthlyUsageGB": 1.0000,
    "limitBytes": 0,
    "limitGB": null,
    "percentUsed": null
  }
}
```

### Top Up with Stripe (Credit Card)

**POST /api/wallet/topup/stripe** (requires authentication)

```bash
curl -X POST http://localhost:3000/api/wallet/topup/stripe \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"amountCents": 1000}'
```

The `amountCents` field is the amount in US cents. For example, `1000` = $10.00.

Response:
```json
{
  "sessionId": "cs_test_...",
  "url": "https://checkout.stripe.com/pay/cs_test_..."
}
```

Redirect the user to the returned `url` to complete payment. After successful payment, the Stripe webhook automatically credits the wallet.

### Top Up with Crypto

**POST /api/wallet/topup/crypto** (requires authentication)

```bash
curl -X POST http://localhost:3000/api/wallet/topup/crypto \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"amountUsd": 10, "currency": "btc"}'
```

Parameters:
- `amountUsd`: Dollar amount (must be between $5 and $1,000)
- `currency`: One of `btc`, `eth`, `xmr`, `sol`, `zec`

Response:
```json
{
  "invoiceId": "...",
  "invoiceUrl": "https://nowpayments.io/payment/...",
  "payCurrency": "btc",
  "priceAmount": 10.00
}
```

Redirect the user to the `invoiceUrl` to complete payment. The NOWPayments IPN webhook automatically credits the wallet once the transaction is confirmed.

### Check Balance

**GET /api/wallet** (requires authentication)

```bash
curl http://localhost:3000/api/wallet \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

Response:
```json
{
  "balanceCents": 1000,
  "balanceUsd": 10.00,
  "currency": "USD",
  "lastToppedUp": "2026-02-09T..."
}
```

### Transaction History

**GET /api/wallet/transactions** (requires authentication)

```bash
curl "http://localhost:3000/api/wallet/transactions?limit=50&offset=0" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

Query parameters:
- `limit`: Number of transactions to return (default 50, max 200)
- `offset`: Pagination offset (default 0)

Response:
```json
{
  "transactions": [
    {
      "id": "...",
      "type": "topup",
      "amountCents": 1000,
      "amountUsd": 10.00,
      "description": "Stripe top-up",
      "paymentProvider": "stripe",
      "createdAt": "2026-02-09T..."
    },
    {
      "id": "...",
      "type": "debit",
      "amountCents": -35,
      "amountUsd": -0.35,
      "description": "Proxy usage",
      "paymentProvider": null,
      "createdAt": "2026-02-09T..."
    }
  ]
}
```

### Balance Forecast

**GET /api/wallet/forecast** (requires authentication)

Predicts how many days your balance will last based on recent usage trends.

```bash
curl http://localhost:3000/api/wallet/forecast \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

Response:
```json
{
  "dailyAvgCents": 150,
  "daysRemaining": 6.7,
  "trend": "up",
  "trendPct": 25
}
```

Fields:
- `dailyAvgCents`: Average daily spending over the last 7 days
- `daysRemaining`: Estimated days until balance reaches zero (null if no spending)
- `trend`: `"up"`, `"down"`, or `"stable"` -- comparing current 7-day period to previous 7-day period
- `trendPct`: Percentage change (absolute value)

### Change Plan

**PUT /api/plans/user/plan** (requires authentication)

```bash
curl -X PUT http://localhost:3000/api/plans/user/plan \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"planId":"vol100"}'
```

Volume plans require a minimum wallet balance to prevent discount abuse:
- `vol100` (Volume 100GB): $10.00 minimum balance
- `vol1tb` (Volume 1TB): $50.00 minimum balance

---

## Two-Factor Authentication (2FA/MFA)

DomiNode supports time-based one-time passwords (TOTP) for two-factor authentication, compatible with Google Authenticator, Authy, 1Password, and other TOTP apps. Ten one-time backup codes are also generated for emergency access.

### Enable MFA

This is a two-step process:

**Step 1: Setup** -- Generate the TOTP secret and backup codes.

**POST /api/auth/mfa/setup** (requires authentication)

```bash
curl -X POST http://localhost:3000/api/auth/mfa/setup \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

Response:
```json
{
  "secret": "JBSWY3DPEHPK3PXP...",
  "otpauthUri": "otpauth://totp/DomiNode:you@example.com?secret=JBSWY3DPEHPK3PXP...&issuer=DomiNode&algorithm=SHA1&digits=6&period=30",
  "backupCodes": [
    "a1b2c3d4",
    "e5f6g7h8",
    ...
  ]
}
```

- Scan the `otpauthUri` as a QR code with your authenticator app, or manually enter the `secret`.
- **Save the backup codes immediately** -- they are shown only once. Each backup code can be used exactly once.

**Step 2: Enable** -- Verify your authenticator is set up correctly by providing a 6-digit TOTP code.

**POST /api/auth/mfa/enable** (requires authentication)

```bash
curl -X POST http://localhost:3000/api/auth/mfa/enable \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"code":"123456"}'
```

Response:
```json
{
  "enabled": true
}
```

### Login with MFA

When MFA is enabled, the login flow requires an additional step:

1. Call **POST /api/auth/login** with email and password. The response will include `mfaRequired: true` and a challenge token.
2. Call **POST /api/auth/mfa/verify** with the TOTP code from your authenticator app.

```bash
# Step 1: Login (returns challenge token for API clients)
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"SecurePass123!"}'
# Response: {"mfaRequired":true,"mfaChallengeToken":"eyJ..."}

# Step 2: Verify TOTP code
curl -X POST http://localhost:3000/api/auth/mfa/verify \
  -H "Content-Type: application/json" \
  -d '{"mfaChallengeToken":"eyJ...","code":"123456"}'
# Response: {"token":"eyJ...","refreshToken":"eyJ...","userId":"...","email":"..."}
```

For browser clients, the challenge token is set as an httpOnly cookie (`dominode_mfa_challenge`) and read automatically -- you only need to send the `code` in the body.

**Brute-force protection:** After 5 failed MFA attempts within a 5-minute window, verification is locked for 5 minutes.

### Using Backup Codes

If you lose access to your authenticator app:

```bash
curl -X POST http://localhost:3000/api/auth/mfa/verify \
  -H "Content-Type: application/json" \
  -d '{"mfaChallengeToken":"eyJ...","code":"a1b2c3d4","isBackupCode":true}'
```

Each backup code can only be used once. After using it, the code is permanently consumed.

### Disable MFA

**POST /api/auth/mfa/disable** (requires authentication)

Disabling MFA requires both your account password and a valid TOTP code (or backup code):

```bash
curl -X POST http://localhost:3000/api/auth/mfa/disable \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"password":"SecurePass123!","code":"123456"}'
```

Disabling MFA also revokes all refresh tokens as a security measure.

### Check MFA Status

**GET /api/auth/mfa/status** (requires authentication)

```bash
curl http://localhost:3000/api/auth/mfa/status \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

Response:
```json
{
  "enabled": true,
  "backupCodesRemaining": 8
}
```

---

## API Key Management

API keys are used for proxy authentication. Each key starts with `dn_live_` and is hashed with SHA-256 for O(1) lookup speed. You can have up to 50 active API keys per account.

### Create Key

**POST /api/keys** (requires authentication)

```bash
curl -X POST http://localhost:3000/api/keys \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label":"scraping-bot"}'
```

Response:
```json
{
  "key": "dn_live_a1b2c3d4e5f6g7h8...",
  "id": "uuid-of-the-key",
  "prefix": "dn_live_a1b2",
  "label": "scraping-bot",
  "created_at": "2026-02-09T..."
}
```

**Important:** The full key (`dn_live_...`) is returned only at creation time. Store it securely -- it cannot be retrieved later.

### List Keys

**GET /api/keys** (requires authentication)

```bash
curl http://localhost:3000/api/keys \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

Response:
```json
{
  "keys": [
    {
      "id": "uuid-of-the-key",
      "prefix": "dn_live_a1b2",
      "label": "scraping-bot",
      "created_at": "2026-02-09T...",
      "revoked_at": null
    }
  ]
}
```

Note: Only the key prefix is returned, not the full key.

### Revoke Key

**DELETE /api/keys/:id** (requires authentication)

```bash
curl -X DELETE http://localhost:3000/api/keys/UUID_OF_KEY \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

Returns `204 No Content` on success. Revoked keys cannot be used for proxy authentication.

---

## Usage Tracking

All usage endpoints require authentication and support date range filtering via `since` and `until` query parameters (ISO 8601 format). The maximum query range is 90 days; longer ranges are automatically capped.

### View Usage Summary

**GET /api/usage** (requires authentication)

```bash
curl "http://localhost:3000/api/usage?since=2026-01-01&until=2026-01-31" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

Query parameters:
- `since`: Start date (default: 30 days ago)
- `until`: End date (default: now)
- `limit`: Records per page (default 200, max 1000)
- `offset`: Pagination offset (default 0)

Response:
```json
{
  "summary": {
    "totalBytes": 5368709120,
    "totalCostCents": 2500,
    "requestCount": 150,
    "totalGB": 5.0000,
    "totalCostUsd": 25.00
  },
  "records": [
    {
      "id": "...",
      "sessionId": "...",
      "bytesIn": 1024,
      "bytesOut": 51200,
      "totalBytes": 52224,
      "costCents": 1,
      "proxyType": "http",
      "targetHost": "example.com",
      "createdAt": "2026-01-15T..."
    }
  ],
  "pagination": {
    "limit": 200,
    "offset": 0,
    "total": 150
  },
  "period": {
    "since": "2026-01-01T...",
    "until": "2026-01-31T..."
  }
}
```

### Daily Breakdown

**GET /api/usage/daily** (requires authentication)

```bash
curl "http://localhost:3000/api/usage/daily?since=2026-01-01&until=2026-01-31" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

Response:
```json
{
  "days": [
    {
      "date": "2026-01-15",
      "totalBytes": 1073741824,
      "totalGB": 1.0000,
      "totalCostCents": 500,
      "totalCostUsd": 5.00,
      "requestCount": 30
    }
  ],
  "period": { "since": "...", "until": "..." }
}
```

### Top Target Hosts

**GET /api/usage/top-hosts** (requires authentication)

```bash
curl "http://localhost:3000/api/usage/top-hosts?limit=10" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

Query parameters:
- `limit`: Number of top hosts to return (default 10, max 50)

Response:
```json
{
  "hosts": [
    {
      "targetHost": "example.com",
      "totalBytes": 2147483648,
      "totalGB": 2.0000,
      "requestCount": 50
    }
  ],
  "period": { "since": "...", "until": "..." }
}
```

### Export as CSV

**GET /api/usage/export** (requires authentication)

```bash
curl "http://localhost:3000/api/usage/export?since=2026-01-01&until=2026-01-31" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -o usage.csv
```

Returns a CSV file with columns: Date, Session ID, Target Host, Bytes In, Bytes Out, Total Bytes, Cost (USD). The export is limited to 10,000 records.

---

## Browser Extension

The DomiNode browser extension provides one-click proxy toggling directly from your browser toolbar.

### Supported Browsers

- Google Chrome (Manifest V3)
- Mozilla Firefox (Manifest V3)
- Opera
- Microsoft Edge

### Install from Source

```bash
cd packages/extension

# Build for your browser
npm run build:chrome     # Chrome/Edge
npm run build:firefox    # Firefox
npm run build:opera      # Opera
npm run build:edge       # Edge
```

Then load the extension:

- **Chrome/Edge**: Go to `chrome://extensions`, enable Developer Mode, click "Load unpacked", and select the `dist/chrome/` directory.
- **Firefox**: Go to `about:debugging#/runtime/this-firefox`, click "Load Temporary Add-on", and select any file in the `dist/firefox/` directory.
- **Opera**: Go to `opera://extensions`, enable Developer Mode, click "Load unpacked", and select the `dist/opera/` directory.

### Configure

1. Click the DomiNode extension icon in your browser toolbar.
2. Enter your API key (`dn_live_xxx`) or log in with email/password (MFA is supported).
3. Select your target country, state, and/or city from the dropdowns.
4. Toggle the proxy on or off.

**Features:**
- Real-time balance display
- Balance pre-check before enabling proxy (prevents activating with $0 balance)
- WebRTC leak prevention (blocks WebRTC from revealing your real IP)
- Ephemeral token storage using `chrome.storage.session` (tokens are cleared when the browser closes)
- Automatic token refresh in the background

---

## Web Dashboard

The web frontend is a React single-page application available at `http://localhost:5173` (development) or your configured production URL.

**Pages:**

| Page | Description |
|------|-------------|
| **Dashboard** | Overview of wallet balance, recent usage, active sessions, and balance forecast |
| **API Keys** | Create, label, and revoke API keys |
| **Wallet** | View balance, transaction history, top up via Stripe or crypto |
| **Usage** | Usage charts, daily breakdown, top hosts, CSV export |
| **Plans** | View available plans, see current plan, switch plans |
| **Admin** | (Admin users only) User management, revenue analytics, system metrics |

The dashboard uses httpOnly cookie authentication. No tokens are stored in JavaScript or localStorage.

---

## Admin Operations

Admin endpoints require both authentication and admin privileges (`is_admin: true` on the user record). Admin routes are protected by `requireAuth` + `requireAdmin` middleware.

### List Users

**GET /api/admin/users** (admin only)

```bash
curl "http://localhost:3000/api/admin/users?page=1&limit=20" \
  -H "Authorization: Bearer ADMIN_TOKEN"
```

Response:
```json
{
  "users": [
    {
      "id": "...",
      "email": "user@example.com",
      "status": "active",
      "is_admin": false,
      "created_at": "..."
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "totalPages": 8
  }
}
```

### Get User Details

**GET /api/admin/users/:id** (admin only)

```bash
curl http://localhost:3000/api/admin/users/USER_UUID \
  -H "Authorization: Bearer ADMIN_TOKEN"
```

### Suspend User

**PUT /api/admin/users/:id/suspend** (admin only)

Suspending a user immediately:
- Sets their account status to `suspended`
- Revokes all their API keys
- Revokes all their refresh tokens (force logout)

```bash
curl -X PUT http://localhost:3000/api/admin/users/USER_UUID/suspend \
  -H "Authorization: Bearer ADMIN_TOKEN"
```

Safety checks:
- Cannot suspend your own account
- Cannot suspend another admin account

### Reactivate User

**PUT /api/admin/users/:id/activate** (admin only)

```bash
curl -X PUT http://localhost:3000/api/admin/users/USER_UUID/activate \
  -H "Authorization: Bearer ADMIN_TOKEN"
```

The user will need to create new API keys since their old ones were revoked during suspension.

### Delete User

**DELETE /api/admin/users/:id** (admin only)

Performs a soft delete of the user account.

```bash
curl -X DELETE http://localhost:3000/api/admin/users/USER_UUID \
  -H "Authorization: Bearer ADMIN_TOKEN"
```

Safety checks:
- Cannot delete your own account
- Cannot delete another admin account

### Revenue Stats

**GET /api/admin/revenue** (admin only)

```bash
curl "http://localhost:3000/api/admin/revenue?since=2026-01-01&until=2026-02-01" \
  -H "Authorization: Bearer ADMIN_TOKEN"
```

Response:
```json
{
  "totalRevenueCents": 250000,
  "totalRevenueUsd": 2500.00,
  "avgTransactionCents": 1500,
  "avgTransactionUsd": 15.00,
  "transactionCount": 167,
  "period": {
    "since": "2026-01-01T...",
    "until": "2026-02-01T..."
  }
}
```

The maximum date range is 365 days.

### Daily Revenue Breakdown

**GET /api/admin/revenue/daily** (admin only)

```bash
curl "http://localhost:3000/api/admin/revenue/daily?since=2026-01-01&until=2026-01-31" \
  -H "Authorization: Bearer ADMIN_TOKEN"
```

Response:
```json
{
  "days": [
    {
      "date": "2026-01-15",
      "revenueCents": 5000,
      "revenueUsd": 50.00,
      "transactionCount": 5
    }
  ],
  "period": { "since": "...", "until": "..." }
}
```

### System Stats

**GET /api/admin/stats** (admin only)

Returns aggregate system statistics.

```bash
curl http://localhost:3000/api/admin/stats \
  -H "Authorization: Bearer ADMIN_TOKEN"
```

---

## Rate Limits

| Scope | Limit | Window | Details |
|-------|-------|--------|---------|
| Global API | 100 requests | 1 minute | Per IP address |
| Auth endpoints | 10 requests | 15 minutes | Per IP address (login, register, refresh, etc.) |
| Login lockout | 5 failed attempts | 15-minute lockout | Per IP+email combination |
| MFA verification | 5 failed attempts | 5-minute lockout | Per user ID |
| Proxy sessions | 30 new sessions | 1 minute | Per user (configurable via `MAX_SESSIONS_PER_MINUTE`) |
| Per-user connections | 100 concurrent | N/A | Configurable via `PROXY_MAX_PER_USER` |
| Total proxy connections | 5,000 | N/A | Configurable via `PROXY_MAX_CONNECTIONS` |

When rate limited, the API returns HTTP `429 Too Many Requests` with a `Retry-After` header indicating when to retry.

---

## Error Codes

The proxy gateway sets the `X-DomiNode-Error` header to indicate the specific error:

| Error Code | HTTP Status | Description |
|------------|-------------|-------------|
| `AUTH_REQUIRED` | 407 | Missing Proxy-Authorization header |
| `AUTH_INVALID` | 407 | API key not found, revoked, or invalid format |
| `INSUFFICIENT_BALANCE` | 402 | Wallet balance too low to start a session |
| `BANDWIDTH_LIMIT_EXCEEDED` | 403 | Monthly bandwidth limit exceeded (volume plans) |
| `ACCOUNT_SUSPENDED` | 403 | User account has been suspended by an admin |
| `SANCTIONED_COUNTRY` | 403 | Client or target is in an OFAC-sanctioned country |
| `TARGET_BLOCKED` | 403 | Target host resolves to a private/internal IP (SSRF protection) |
| `AUTH_RATE_LIMITED` | 429 | Too many authentication failures from this IP |
| `TOO_MANY_CONNECTIONS` | 429 | Per-user connection limit or session rate limit exceeded |
| `ALL_PROVIDERS_DOWN` | 503 | All upstream proxy providers have tripped their circuit breakers |
| `UPSTREAM_UNAVAILABLE` | 502 | Upstream proxy connection failed |
| `UPSTREAM_TIMEOUT` | 504 | Upstream proxy connection timed out |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

---

## Complete API Reference

### Authentication

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/auth/register | None | Create a new account |
| POST | /api/auth/login | None | Login with email/password |
| POST | /api/auth/refresh | Refresh token | Exchange refresh token for new token pair |
| POST | /api/auth/change-password | JWT | Change password (requires current password) |
| POST | /api/auth/logout | JWT | Revoke all refresh tokens (server-side logout) |
| GET | /api/auth/me | JWT | Session restoration (returns user info) |
| POST | /api/auth/verify-key | None | Verify API key, returns JWT tokens |

### MFA

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/auth/mfa/setup | JWT | Generate TOTP secret + backup codes |
| POST | /api/auth/mfa/enable | JWT | Activate MFA with initial TOTP code |
| POST | /api/auth/mfa/verify | Challenge token | Complete MFA challenge during login |
| POST | /api/auth/mfa/disable | JWT | Disable MFA (requires password + code) |
| GET | /api/auth/mfa/status | JWT | Check MFA status and remaining backup codes |

### API Keys

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/keys | JWT | Create a new API key (max 50 per account) |
| GET | /api/keys | JWT | List API keys (prefix + label only) |
| DELETE | /api/keys/:id | JWT | Revoke an API key |

### Wallet

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/wallet | JWT | Get current balance |
| GET | /api/wallet/transactions | JWT | Transaction history (paginated) |
| POST | /api/wallet/topup/stripe | JWT | Create Stripe checkout session |
| POST | /api/wallet/topup/crypto | JWT | Create NOWPayments crypto invoice |
| GET | /api/wallet/forecast | JWT | Balance forecast based on usage trends |

### Plans

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/plans | None | List all available plans |
| GET | /api/plans/user/plan | JWT | Get current user's plan + monthly usage |
| PUT | /api/plans/user/plan | JWT | Change plan |

### Usage

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/usage | JWT | Usage records with summary (paginated) |
| GET | /api/usage/daily | JWT | Daily usage aggregation for charts |
| GET | /api/usage/top-hosts | JWT | Top target hosts by bandwidth |
| GET | /api/usage/export | JWT | CSV export of usage records |

### Sessions

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/sessions/active | JWT | List active proxy sessions |

### Webhooks

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/webhooks/stripe | Stripe signature | Stripe payment webhook |
| POST | /api/webhooks/nowpayments | IPN signature | NOWPayments IPN webhook |

### Proxy

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/proxy/config | JWT | Get proxy endpoint configuration (for extension) |
| GET | /api/proxy/health | None | Proxy health check |
| GET | /api/proxy/status | JWT | Proxy status for authenticated user |

### Admin

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/admin/users | Admin JWT | List all users (paginated) |
| GET | /api/admin/users/:id | Admin JWT | Get user details |
| PUT | /api/admin/users/:id/suspend | Admin JWT | Suspend a user |
| PUT | /api/admin/users/:id/activate | Admin JWT | Reactivate a user |
| DELETE | /api/admin/users/:id | Admin JWT | Soft-delete a user |
| GET | /api/admin/revenue | Admin JWT | Revenue statistics |
| GET | /api/admin/revenue/daily | Admin JWT | Daily revenue breakdown |
| GET | /api/admin/stats | Admin JWT | System statistics |

### System

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/health | None | API health check (includes DB connectivity) |

---

## Troubleshooting

### "Insufficient balance"

Your wallet balance is below the 10-cent minimum needed to start a session. Top up your wallet via the dashboard or the `/api/wallet/topup/stripe` endpoint.

### "Account suspended"

Your account has been suspended by an administrator. Contact support to have it reactivated.

### "Target blocked"

You are trying to proxy traffic to or from an OFAC-sanctioned country (Cuba, Iran, North Korea, Russia, Syria), or the target hostname resolves to a private/internal IP address.

### "All providers down"

All upstream proxy providers have tripped their circuit breakers due to consecutive failures. This is a temporary condition -- the circuit breakers reset after 30 seconds of cooldown. Retry your request after the `Retry-After` header value.

### CSRF 403 errors

If you receive a `403 Forbidden` response with "Missing Origin header" or "Invalid origin" on state-changing requests (POST, PUT, DELETE) from a browser, ensure:
1. Your frontend origin is listed in the `CORS_ORIGINS` environment variable.
2. The browser is sending the `Origin` header (it should do this automatically for fetch/XHR).

CSRF protection only applies to requests that include auth cookies. API/extension requests without cookies are not affected.

### Connection timeout

- Verify that PacketStream credentials are correctly set in `.env` (`PACKETSTREAM_USERNAME`, `PACKETSTREAM_PASSWORD`).
- Check that the PacketStream gateway (`gw.packetstream.io:31112`) is reachable from your server.
- The default connect timeout is 30 seconds (configurable via `PROXY_CONNECT_TIMEOUT_MS`).

### MFA locked out

After 5 failed MFA attempts, verification is locked for 5 minutes. Wait for the lockout period to expire, then:
- Try again with a fresh TOTP code from your authenticator app.
- Use a backup code with `"isBackupCode": true` in the request body.
- If you have lost your authenticator and all backup codes, contact an administrator.

### "Token reuse detected -- all sessions revoked"

This means a previously-used refresh token was submitted again, which indicates possible token theft. All tokens in the family have been revoked for your security. Log in again with your email and password to get fresh tokens.

### Rate limiting (429 responses)

Check the `Retry-After` header in the response for when you can retry. Common causes:
- **API rate limit**: More than 100 requests/minute from your IP.
- **Auth rate limit**: More than 10 auth attempts in 15 minutes.
- **Login lockout**: 5 failed login attempts -- wait 15 minutes.
- **Session rate limit**: More than 30 new proxy sessions/minute.

### Proxy not working in browser extension

1. Verify your API key is valid and not revoked.
2. Check that the proxy host and ports are correctly configured (`PROXY_HOST`, `PROXY_HTTP_PORT`, `PROXY_SOCKS5_PORT` in `.env`).
3. Ensure you have a positive wallet balance (the extension checks balance before enabling the proxy).
4. Check the extension popup for any error messages.

### CSV export issues

- The export is limited to 10,000 records per request. Use date range filters to narrow the scope.
- The maximum date range is 90 days. For longer periods, make multiple requests with non-overlapping date ranges.
