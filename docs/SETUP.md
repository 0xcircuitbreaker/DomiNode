# Dominus Node — Deployment Guide

Complete deployment reference for Dominus Node, a rotating proxy-as-a-service (PaaS) platform. Covers every method from local development to production VPS/Docker.

**Current state:** Alpha — 2,500 registration slots, waitlist active when full.

---

## Table of Contents

1. [What Gets Deployed](#1-what-gets-deployed)
2. [Prerequisites](#2-prerequisites)
3. [Environment Variables](#3-environment-variables)
4. [Method 1 — Local Development](#4-method-1--local-development)
5. [Method 2 — Docker](#5-method-2--docker)
6. [Method 3 — VPS / Ubuntu](#6-method-3--vps--ubuntu)
7. [Method 4 — Netlify (Frontend Only)](#7-method-4--netlify-frontend-only)
8. [Reverse Proxy (Nginx / Caddy)](#8-reverse-proxy-nginx--caddy)
9. [Database](#9-database)
10. [API Endpoint Reference](#10-api-endpoint-reference)
11. [Proxy Usage](#11-proxy-usage)
12. [MCP Server](#12-mcp-server)
13. [AI Integrations](#13-ai-integrations)
14. [Alpha & Waitlist System](#14-alpha--waitlist-system)
15. [Post-Deployment Checklist](#15-post-deployment-checklist)
16. [Troubleshooting](#16-troubleshooting)

---

## 1. What Gets Deployed

### Services

| Service | Port | Protocol | Description |
|---------|------|----------|-------------|
| HTTP Proxy Gateway | 8080 | HTTP/HTTPS CONNECT | Routes client traffic through Webshare upstream |
| SOCKS5 Proxy Gateway | 1080 | SOCKS5 | Alternative SOCKS5 proxy |
| REST API | 3000 | HTTP/JSON | Account management, billing, admin |
| Frontend (dev only) | 5173 | HTTP | Vite dev server — not for production |

### Packages (npm workspaces)

| Package | Path | Role |
|---------|------|------|
| `@dominusnode/shared` | `packages/shared/` | Types, DB client, auth, repositories |
| `@dominusnode/pool-manager` | `packages/pool-manager/` | Webshare dual-pool integration |
| `@dominusnode/proxy-gateway` | `packages/proxy-gateway/` | HTTP + SOCKS5 proxy servers |
| `@dominusnode/metering` | `packages/metering/` | Cost calculation, usage recording |
| `@dominusnode/billing` | `packages/billing/` | Stripe, PayPal, NOWPayments, x402 |
| `@dominusnode/dashboard` | `packages/dashboard/` | Express REST API |
| `@dominusnode/mcp-server` | `packages/mcp-server/` | 59 MCP tools for AI agents |
| `@dominusnode/frontend` | `packages/frontend/` | React 18 + Vite SPA |
| `@dominusnode/extension` | `packages/extension/` | MV3 browser extension |

### Feature Set

| Feature | Status |
|---------|--------|
| HTTP/HTTPS + SOCKS5 proxy | ✅ |
| API key auth (SHA-256, O(1) lookup) | ✅ |
| EVM wallet auth (EIP-191) | ✅ |
| JWT + refresh tokens (7d rotating) | ✅ |
| MFA / TOTP + backup codes | ✅ |
| Prepaid wallet (Stripe / PayPal / 10 crypto currencies) | ✅ |
| x402 pay-per-request (9 chains) | ✅ |
| Agentic wallets (sub-wallets with spending limits) | ✅ |
| Teams (shared wallet, roles, invites) | ✅ |
| Referral codes + affiliate commissions | ✅ |
| Promo codes + loyalty tiers | ✅ |
| GDPR export + deletion | ✅ |
| MCP server (59 authenticated + 17 bootstrap tools) | ✅ |
| 24 AI framework integrations | ✅ |
| Browser extension (MV3) | ✅ |
| Dual-pool geo-targeting (DC + residential) | ✅ |
| Alpha slot cap + waitlist | ✅ |
| OFAC sanctions enforcement | ✅ |
| Rate limiting + SSRF protection | ✅ |
| 48 security audit rounds | ✅ |

---

## 2. Prerequisites

### Required Software

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 22+ | `nvm install 22` or [nodejs.org](https://nodejs.org) |
| npm | 9+ | Bundled with Node.js |
| PostgreSQL | 16+ | `docker compose up -d` or `apt install postgresql` |
| Git | 2.x | `apt install git` |

### Required External Accounts

| Service | Purpose | Sign Up |
|---------|---------|---------|
| **Webshare** | Upstream proxy provider (required) | [webshare.io](https://webshare.io) |
| **Stripe** | Credit card / PayPal wallet top-ups | [dashboard.stripe.com](https://dashboard.stripe.com) |
| **NOWPayments** | Crypto payments (10 currencies) | [nowpayments.io](https://nowpayments.io) |

### Optional External Accounts

| Service | Purpose |
|---------|---------|
| **PayPal** | Direct PayPal integration (lower fees than Stripe PayPal) |
| **Coinbase Developer Platform** | x402 Base chain USDC facilitator |
| **PayAI** | x402 Solana + EVM chain facilitator |
| **SMTP provider** | Email notifications (waitlist, password reset, etc.) |
| **Google reCAPTCHA v3** | Registration anti-bot protection |

---

## 3. Environment Variables

Copy `.env.example` to `.env` and fill in the values. Everything in this section is from `.env.example`.

### Database

```env
DATABASE_URL=postgresql://dominusnode:dominusnode_dev@localhost:5432/dominusnode
DB_POOL_MAX=20
DB_POOL_MIN=2
DB_CONNECTION_TIMEOUT_MS=5000
```

### REST API

```env
DASHBOARD_PORT=3000
JWT_SECRET=                          # REQUIRED — openssl rand -hex 32
CORS_ORIGINS=http://localhost:5173   # Production: https://yourdomain.com
TRUST_PROXY=1                        # Required behind Nginx/Caddy
```

### MFA / Security

```env
MFA_ENCRYPTION_KEY=                  # REQUIRED for MFA — openssl rand -hex 32
MCP_AGENT_SECRET=                    # Recommended — openssl rand -hex 32
                                     # Allows MCP agents to skip email verification
```

### Proxy Gateway

```env
PROXY_LISTEN_PORT=8080
SOCKS5_LISTEN_PORT=1080
PROXY_CONNECT_TIMEOUT_MS=30000
PROXY_SESSION_MAX_AGE_MS=3600000
PROXY_STALE_CLEANUP_INTERVAL_MS=60000
BALANCE_CACHE_TTL_MS=5000
PROXY_MAX_RETRIES=2
PROXY_RETRY_BASE_DELAY_MS=200
PROXY_MAX_CONNECTIONS=5000
PROXY_PUBLIC_HOST=proxy.dominusnode.com
```

### Webshare (Upstream Proxy — Required)

```env
WEBSHARE_PROXY_HOST=p.webshare.io
WEBSHARE_HTTP_PORT=80
WEBSHARE_SOCKS5_PORT=1080
WEBSHARE_DC_USERNAME=
WEBSHARE_DC_PASSWORD=
WEBSHARE_RES_USERNAME=
WEBSHARE_RES_PASSWORD=
WEBSHARE_API_KEY=
```

### Stripe

```env
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_SUCCESS_URL=https://yourdomain.com/dashboard?topup=success
STRIPE_CANCEL_URL=https://yourdomain.com/dashboard?topup=cancel
STRIPE_PAYMENT_METHODS=card,link
```

**Required Stripe webhook events:** `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`

### NOWPayments (Crypto)

```env
NOWPAYMENTS_API_KEY=
NOWPAYMENTS_IPN_SECRET=
NOWPAYMENTS_API_URL=https://api.nowpayments.io/v1
```

**Supported currencies:** BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB, LINK

### PayPal (Direct)

```env
PAYPAL_CLIENT_ID=
PAYPAL_CLIENT_SECRET=
PAYPAL_ENVIRONMENT=sandbox            # Change to "live" for production
PAYPAL_WEBHOOK_ID=
PAYPAL_RETURN_URL=https://yourdomain.com/wallet?topup=success&provider=paypal
PAYPAL_CANCEL_URL=https://yourdomain.com/wallet?topup=cancel&provider=paypal
```

**Required PayPal webhook events:** `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`

### x402 Micropayments (Pay-Per-Request)

```env
X402_ENABLED=false
X402_DC_PRICE_PER_REQUEST_USD=0.001
X402_RES_PRICE_PER_REQUEST_USD=0.005
X402_MAX_REQUEST_BODY_BYTES=10485760

# Coinbase facilitator — Base chain USDC
X402_RECEIVING_ADDRESS=
CDP_API_KEY_ID=
CDP_API_KEY_SECRET=

# PayAI facilitator — Solana
X402_RECEIVING_ADDRESS_SOLANA=
PAYAI_API_KEY_ID=
PAYAI_API_KEY_SECRET=

# PayAI facilitator — EVM chains
X402_RECEIVING_ADDRESS_POLYGON=
X402_RECEIVING_ADDRESS_AVALANCHE=
X402_RECEIVING_ADDRESS_SEI=
X402_RECEIVING_ADDRESS_SKALE=
X402_RECEIVING_ADDRESS_IOTEX=
X402_RECEIVING_ADDRESS_XLAYER=
X402_RECEIVING_ADDRESS_PEAQ=
```

### Email (SMTP)

```env
EMAIL_ENABLED=false
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=noreply@dominusnode.com
SMTP_SECURE=false
SMTP_IGNORE_TLS=true
APP_URL=https://yourdomain.com
```

### Registration & Domain

```env
MAX_REGISTERED_USERS=2500            # Alpha cap. 0 = unlimited (production)
DOMINUSNODE_DOMAIN=dominusnode.com
```

### reCAPTCHA

```env
RECAPTCHA_SITE_KEY=
RECAPTCHA_SECRET_KEY=
RECAPTCHA_SCORE_THRESHOLD=0.5
```

### Circuit Breaker / Logging

```env
CIRCUIT_BREAKER_FAILURE_THRESHOLD=5
CIRCUIT_BREAKER_COOLDOWN_MS=30000
LOG_LEVEL=info
```

---

## 4. Method 1 — Local Development

```bash
# 1. Clone and install
git clone https://64.176.195.20/0xcircuitbreaker/DomiNode.git
cd DomiNode
npm install

# 2. Start PostgreSQL
docker compose up -d

# 3. Configure environment
cp .env.example .env
# Edit .env — at minimum set: JWT_SECRET, WEBSHARE_* credentials

# 4. Apply database schema
npm run db:migrate

# 5. Build all packages
npm run build

# 6. Start services (three terminals or use tmux)
npm run start:proxy       # HTTP :8080 + SOCKS5 :1080
npm run start:api         # REST API :3000
npm run start:frontend    # Vite dev server :5173 (frontend only)
```

**Verify:**
```bash
curl http://localhost:3000/api/health
# → {"status":"ok","timestamp":"..."}

curl -x http://anything:dn_live_YOURKEY@localhost:8080 https://httpbin.org/ip
# → {"origin": "...webshare IP..."}
```

---

## 5. Method 2 — Docker

The `infra/docker/` directory contains three Dockerfiles.

### Dockerfiles

| File | Exposes | Notes |
|------|---------|-------|
| `infra/docker/api.Dockerfile` | 3000 | REST API |
| `infra/docker/proxy.Dockerfile` | 8080, 1080 | HTTP + SOCKS5 proxy |
| `infra/docker/frontend.Dockerfile` | 8080 (Nginx) | Built SPA served via Nginx |

### docker-compose (dev — PostgreSQL only)

```bash
docker compose up -d
```

The included `docker-compose.yml` only starts PostgreSQL. It auto-loads `packages/shared/src/schema.sql` on first boot.

### Full Stack docker-compose (production)

Create `docker-compose.prod.yml`:

```yaml
version: "3.8"

services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: dominusnode
      POSTGRES_USER: dominusnode
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    ports:
      - "127.0.0.1:5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./packages/shared/src/schema.sql:/docker-entrypoint-initdb.d/01-schema.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U dominusnode"]
      interval: 10s
      timeout: 5s
      retries: 5

  api:
    build:
      context: .
      dockerfile: infra/docker/api.Dockerfile
    ports:
      - "127.0.0.1:3000:3000"
    env_file: .env
    environment:
      NODE_ENV: production
      DATABASE_URL: postgresql://dominusnode:${DB_PASSWORD}@postgres:5432/dominusnode
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped

  proxy:
    build:
      context: .
      dockerfile: infra/docker/proxy.Dockerfile
    ports:
      - "8080:8080"
      - "1080:1080"
    env_file: .env
    environment:
      NODE_ENV: production
      DATABASE_URL: postgresql://dominusnode:${DB_PASSWORD}@postgres:5432/dominusnode
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped

  frontend:
    build:
      context: .
      dockerfile: infra/docker/frontend.Dockerfile
    ports:
      - "127.0.0.1:8081:8080"
    restart: unless-stopped

volumes:
  pgdata:
```

```bash
docker compose -f docker-compose.prod.yml up -d
```

---

## 6. Method 3 — VPS / Ubuntu

Tested on Ubuntu 22.04 / 24.04. Run as a non-root user with sudo.

```bash
# 1. System dependencies
sudo apt update && sudo apt install -y git curl

# 2. Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# 3. PostgreSQL 16
sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable postgresql
sudo systemctl start postgresql

# 4. Create DB user and database
sudo -u postgres psql -c "CREATE USER dominusnode WITH PASSWORD 'CHANGE_THIS';"
sudo -u postgres psql -c "CREATE DATABASE dominusnode OWNER dominusnode;"

# 5. Clone and install
sudo git clone https://64.176.195.20/0xcircuitbreaker/DomiNode.git /opt/dominusnode
sudo chown -R $USER:$USER /opt/dominusnode
cd /opt/dominusnode
npm install

# 6. Configure environment
cp .env.example .env
nano .env
# Set: DATABASE_URL, JWT_SECRET, MFA_ENCRYPTION_KEY, WEBSHARE_* credentials

# 7. Migrate + build
npm run db:migrate
npm run build

# 8. Systemd services
sudo tee /etc/systemd/system/dominusnode-api.service > /dev/null <<EOF
[Unit]
Description=Dominus Node REST API
After=network.target postgresql.service

[Service]
Type=simple
User=$USER
WorkingDirectory=/opt/dominusnode
EnvironmentFile=/opt/dominusnode/.env
ExecStart=/usr/bin/node packages/dashboard/dist/src/main.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/dominusnode-proxy.service > /dev/null <<EOF
[Unit]
Description=Dominus Node Proxy Gateway
After=network.target postgresql.service

[Service]
Type=simple
User=$USER
WorkingDirectory=/opt/dominusnode
EnvironmentFile=/opt/dominusnode/.env
ExecStart=/usr/bin/node packages/proxy-gateway/dist/src/main.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable dominusnode-api dominusnode-proxy
sudo systemctl start dominusnode-api dominusnode-proxy
sudo systemctl status dominusnode-api dominusnode-proxy
```

### Frontend (Static)

Build the frontend and serve with Nginx:

```bash
cd /opt/dominusnode/packages/frontend
npm run build
# dist/ is the static output — serve with Nginx (see Section 8)
```

---

## 7. Method 4 — Netlify (Frontend Only)

The frontend is a static Vite SPA. Deploy the built `dist/` folder to Netlify.

```bash
cd packages/frontend
npm run build
# Drag-and-drop dist/ folder to Netlify, or use CLI:
npx netlify-cli deploy --prod --dir=dist
```

The `dist/_redirects` file is pre-configured:

```
/api/*  https://your-api.dominusnode.com/api/:splat  200
/*      /index.html                                   200
```

Update the `/api/*` proxy URL to point to your production API before building.

**Vite env for production build:**

Create `packages/frontend/.env.production`:

```env
VITE_API_BASE=https://api.dominusnode.com
```

---

## 8. Reverse Proxy (Nginx / Caddy)

### Nginx

Config file: `infra/nginx/default.conf`

Key configuration:

```nginx
server {
    listen 80;
    server_name dominusnode.com;

    # Rate limiting
    limit_req zone=auth burst=5 nodelay;
    limit_req zone=general burst=50 nodelay;

    # API → backend
    location /api/ {
        proxy_pass http://localhost:3000;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Frontend → static files
    location / {
        root /opt/dominusnode/packages/frontend/dist;
        try_files $uri $uri/ /index.html;
        expires 1y;
    }
}
```

```bash
sudo nginx -t
sudo systemctl reload nginx
```

### Caddy (automatic TLS)

Config file: `infra/caddy/Caddyfile`

```caddyfile
dominusnode.com {
    reverse_proxy /api/* localhost:3000
    root * /opt/dominusnode/packages/frontend/dist
    file_server
    try_files {path} /index.html
    encode zstd gzip
}

proxy.dominusnode.com {
    # Proxy gateway — TCP passthrough, not HTTP reverse proxy
    # The proxy gateway binds directly to :8080/:1080
}
```

---

## 9. Database

### Schema Overview

The schema lives at `packages/shared/src/schema.sql`. It is automatically copied to `dist/` on every `npm run build`.

**Tables (28 total):**

| Table | Purpose |
|-------|---------|
| `users` | Accounts, email verification, admin flag |
| `api_keys` | SHA-256 hashed keys, `dn_live_*` / `dn_test_*` prefix |
| `wallets` | Prepaid balance (cents integer, `CHECK >= 0`) |
| `wallet_transactions` | Credit/debit history |
| `sessions` | Active proxy sessions (byte counting, billing) |
| `usage_records` | Settled usage — bytes in/out, cost |
| `payment_invoices` | Stripe / PayPal / NOWPayments invoices |
| `plans` | Pricing tiers (free-dc, payg, vol100, vol1tb, agent, swarm-dc, swarm-mixed) |
| `refresh_tokens` | JWT refresh tokens, family-based rotation |
| `mfa_configs` | TOTP secrets (AES-256-GCM encrypted) |
| `mfa_backup_codes` | MFA recovery codes |
| `wallet_challenges` | EIP-191 nonces for wallet auth |
| `email_verification_tokens` | Email verification |
| `password_reset_tokens` | Password reset |
| `agentic_wallets` | Per-agent sub-wallets with spending limits |
| `agentic_wallet_transactions` | Agent wallet history |
| `teams` | Team accounts |
| `team_wallets` | Team shared wallets |
| `team_members` | Membership + roles (owner/admin/member) |
| `team_invites` | Pending email invitations |
| `x402_transactions` | Pay-per-request micropayment records |
| `waitlist` | Alpha waitlist (pending/notified/registered/cancelled) |
| `referral_codes` | Referral codes (SHA-256 hashed) |
| `referral_redemptions` | Redemption tracking |
| `affiliate_links` | Affiliate tracking links |
| `affiliate_commissions` | 10% commission records |
| `promo_codes` | Admin-created promotional codes |
| `promo_redemptions` | Promo usage tracking |
| `loyalty_tiers` | Cashback tiers (none/bronze/silver/gold) |
| `loyalty_rewards` | Loyalty reward history |
| `bug_reports` | Bug bounty submissions |

### Run Migration

```bash
npm run db:migrate
```

> **Important:** After every `npm run build`, `schema.sql` is copied to `packages/shared/dist/src/schema.sql`. The migration script reads from `dist/`. Always build before migrating.

### Plans Inserted by Schema

| ID | Name | $/GB | BW/month | Connections | Pool |
|----|------|------|----------|-------------|------|
| `free-dc` | Free DC (default) | $0 | 500 MB | 5 | DC only |
| `free-res` | Free Residential | $0 | 50 MB | 5 | Residential only |
| `swarm-dc` | Swarm DC | $0 | 200 MB | 2 | DC only |
| `swarm-mixed` | Swarm Mixed | $0 | 200 MB | 2 | All |
| `payg` | Pay As You Go | $5 | Unlimited | 100 | All |
| `vol100` | Volume 100GB | $4 | 100 GB | 100 | All |
| `vol1tb` | Volume 1TB | $3 | 1 TB | 100 | All |
| `agent` | AI Agent | $5 | 5 GB | 50 | All |

---

## 10. API Endpoint Reference

Base URL: `http://localhost:3000` (or your production domain)

### Authentication

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | None | Create account (email + password) |
| POST | `/api/auth/login` | None | Login → JWT + refresh token |
| POST | `/api/auth/refresh` | None | Refresh JWT |
| POST | `/api/auth/logout` | JWT | Revoke refresh token |
| POST | `/api/auth/verify-email` | None | Verify email token |
| POST | `/api/auth/resend-verification` | JWT | Resend verification email |
| POST | `/api/auth/forgot-password` | None | Request password reset |
| POST | `/api/auth/reset-password` | None | Reset password with token |
| GET | `/api/auth/me` | JWT | Get current user profile |
| POST | `/api/auth/wallet/challenge` | None | Request EIP-191 signing challenge |
| POST | `/api/auth/wallet/verify` | None | Verify signature → login or register |
| POST | `/api/auth/wallet/link` | JWT | Link wallet to existing account |
| POST | `/api/auth/mfa/setup` | JWT | Start TOTP setup |
| POST | `/api/auth/mfa/verify-setup` | JWT | Confirm TOTP code → enable MFA |
| POST | `/api/auth/mfa/verify` | JWT (MFA challenge) | Verify TOTP on login |
| POST | `/api/auth/mfa/disable` | JWT | Disable MFA |

### API Keys

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/keys` | JWT | Create API key (returned once) |
| GET | `/api/keys` | JWT | List API keys |
| DELETE | `/api/keys/:id` | JWT | Revoke API key |

### Wallet & Billing

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/wallet` | JWT | Balance + loyalty tier |
| GET | `/api/wallet/transactions` | JWT | Transaction history |
| POST | `/api/wallet/topup/stripe` | JWT | Create Stripe checkout session |
| POST | `/api/wallet/topup/crypto` | JWT | Create NOWPayments invoice |
| GET | `/api/wallet/crypto/status/:invoiceId` | JWT | Poll payment status |
| POST | `/api/wallet/topup/paypal` | JWT | Create PayPal order |
| POST | `/api/wallet/topup/paypal/capture` | JWT | Capture PayPal payment |

### Usage & Plans

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/usage` | JWT | Usage stats (since/until ISO dates) |
| GET | `/api/plans` | None | Available plans + pricing |

### Proxy Info

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/proxy/config` | JWT | Proxy endpoint host + port + routing format |
| GET | `/api/proxy/health` | JWT | Upstream provider health status |
| GET | `/api/sessions` | JWT | Currently active proxy sessions |

### Agentic Wallets

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/agent-wallet` | JWT | Create sub-wallet |
| GET | `/api/agent-wallet` | JWT | List sub-wallets |
| POST | `/api/agent-wallet/:id/fund` | JWT | Transfer from main wallet |
| GET | `/api/agent-wallet/:id/transactions` | JWT | Sub-wallet history |
| GET | `/api/agent-wallet/:id/balance` | JWT | Sub-wallet balance |
| POST | `/api/agent-wallet/:id/freeze` | JWT | Freeze sub-wallet |
| POST | `/api/agent-wallet/:id/unfreeze` | JWT | Unfreeze sub-wallet |
| DELETE | `/api/agent-wallet/:id` | JWT | Delete + refund to main |

### Teams

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/teams` | JWT | Create team |
| GET | `/api/teams` | JWT | List teams |
| GET | `/api/teams/:id` | JWT | Team details + wallet balance |
| PATCH | `/api/teams/:id` | JWT (owner) | Update team name |
| DELETE | `/api/teams/:id` | JWT (owner) | Delete team |
| GET | `/api/teams/:id/members` | JWT | List members |
| POST | `/api/teams/:id/members` | JWT (owner/admin) | Add member directly |
| DELETE | `/api/teams/:id/members/:userId` | JWT (owner/admin) | Remove member |
| PATCH | `/api/teams/:id/members/:userId/role` | JWT (owner) | Change member role |
| POST | `/api/teams/:id/invites` | JWT (owner/admin) | Send email invite |
| GET | `/api/teams/:id/invites` | JWT | List pending invites |
| DELETE | `/api/teams/:id/invites/:inviteId` | JWT (owner/admin) | Cancel invite |
| POST | `/api/teams/invites/accept` | JWT | Accept invite by token |
| POST | `/api/teams/:id/fund` | JWT (owner/admin) | Fund team wallet from personal |
| POST | `/api/teams/:id/keys` | JWT (owner/admin) | Create team API key |
| GET | `/api/teams/:id/keys` | JWT | List team API keys |
| DELETE | `/api/teams/:id/keys/:keyId` | JWT (owner/admin) | Revoke team key |
| GET | `/api/teams/:id/usage` | JWT | Team usage stats |

### Referrals & Affiliate

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/referrals/codes` | JWT | List referral codes |
| POST | `/api/referrals/codes` | JWT | Create referral code |
| GET | `/api/referrals/stats` | JWT | Referral earnings + redemptions |
| POST | `/api/referrals/redeem` | JWT | Redeem a code |
| GET | `/api/referrals/affiliate` | JWT | Affiliate link + commission stats |
| GET | `/api/referrals/promo/check` | None | Check promo code validity |
| POST | `/api/referrals/loyalty/claim` | JWT | Claim pending loyalty rewards |

### Slots & Waitlist

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/slots` | None | `{total, used, remaining, unlimited}` |
| POST | `/api/waitlist/join` | None | Join waitlist (email only) |
| GET | `/api/waitlist/count` | None | `{pending: N}` |

### Webhooks

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/webhooks/stripe` | Stripe signature | Stripe payment events |
| POST | `/api/webhooks/nowpayments` | IPN signature | Crypto payment events |
| POST | `/api/webhooks/paypal` | PayPal signature | PayPal payment events |

### Account (GDPR)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/account/export` | JWT | Download all personal data (JSON) |
| DELETE | `/api/account` | JWT | Delete account + anonymize all data |

### Admin

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/admin/users` | JWT + admin | List users (paginated) |
| GET | `/api/admin/users/:id` | JWT + admin | User details |
| POST | `/api/admin/users/:id/activate` | JWT + admin | Activate suspended user |
| POST | `/api/admin/users/:id/suspend` | JWT + admin | Suspend user |
| DELETE | `/api/admin/users/:id` | JWT + admin | Delete user (anonymize) |
| PUT | `/api/admin/users/:id/plan` | JWT + admin | Change user plan |
| POST | `/api/admin/credit-wallet` | JWT + admin (allowlisted email) | Credit user or team wallet |
| GET | `/api/admin/bug-reports` | JWT + admin | List bug reports |
| POST | `/api/admin/bug-reports/:id/approve` | JWT + admin | Approve + credit |
| POST | `/api/admin/bug-reports/:id/reject` | JWT + admin | Reject report |
| GET | `/api/admin/promo-codes` | JWT + admin | List promo codes |
| POST | `/api/admin/promo-codes` | JWT + admin | Create promo code |
| GET | `/api/admin/affiliates` | JWT + admin | List affiliate accounts |
| POST | `/api/admin/loyalty/adjust` | JWT + admin | Manually adjust loyalty tier |

### Machine-Readable Discovery

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/.well-known/agent-tool.json` | None | Agent tool card (pricing, auth, proxy config) |
| GET | `/.well-known/security.txt` | None | Security contact |
| GET | `/api/health` | None | `{status:"ok"}` |

---

## 11. Proxy Usage

### Authentication

The proxy uses **HTTP Basic Auth** where:

- **Username:** routing options (pool type, country)
- **Password:** API key (`dn_live_*` or `dn_test_*`)

### Routing Format

```
{pool}-country-{ISO2}

dc-country-US         → US datacenter IP
dc-country-GB         → UK datacenter IP
residential-country-FR → French residential IP
auto-country-DE       → Germany, auto-select pool
```

### Examples

```bash
# HTTP proxy — US datacenter ($3/GB)
curl -x http://dc-country-US:dn_live_YOURKEY@localhost:8080 https://httpbin.org/ip

# HTTP proxy — UK residential ($5/GB)
curl -x http://residential-country-GB:dn_live_YOURKEY@localhost:8080 https://httpbin.org/ip

# SOCKS5 proxy
curl -x socks5://dc-country-US:dn_live_YOURKEY@localhost:1080 https://httpbin.org/ip

# Default (no routing options) — auto pool selection
curl -x http://anything:dn_live_YOURKEY@localhost:8080 https://httpbin.org/ip
```

### Pricing

| Pool | Sell Price | Upstream Cost | Margin |
|------|-----------|---------------|--------|
| Datacenter | $3.00/GB | $0.012/GB | ~99.6% |
| Residential | $5.00/GB | $4.00/GB | ~20% |

### Billing

- Prepaid wallet (balance in cents, `CHECK >= 0` constraint)
- 50-cent minimum reservation per session at open
- Settlement on session close
- 1-cent minimum charge per session (even for tiny requests)
- Team API keys bill to team wallet

---

## 12. MCP Server

The MCP (Model Context Protocol) server exposes tools for AI agents to manage the proxy service.

### Install

```bash
npx @dominusnode/mcp-server
```

### Authenticate

Run once to configure:

```bash
npx @dominusnode/mcp-server --bootstrap
# Follow prompts to create account + API key
```

### Platform Configurations

**Claude Desktop** (`~/.config/claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "dominusnode": {
      "command": "npx",
      "args": ["@dominusnode/mcp-server"],
      "env": {
        "DOMINUSNODE_API_KEY": "dn_live_your_key",
        "DOMINUSNODE_API_BASE": "https://api.dominusnode.com"
      }
    }
  }
}
```

**Cursor** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "dominusnode": {
      "command": "npx",
      "args": ["@dominusnode/mcp-server"],
      "env": {
        "DOMINUSNODE_API_KEY": "dn_live_your_key"
      }
    }
  }
}
```

### Tool Categories (59 authenticated + 17 bootstrap)

| Category | Count | Examples |
|----------|-------|---------|
| Account setup | 17 bootstrap | `dominusnode_setup`, `dominusnode_register`, `dominusnode_check_slots` |
| Account management | 8 | `dominusnode_get_account_info`, `dominusnode_create_apikey` |
| Wallet & billing | 10 | `dominusnode_wallet_balance`, `dominusnode_topup_stripe`, `dominusnode_topup_crypto`, `dominusnode_topup_paypal` |
| x402 micropayments | 3 | `dominusnode_pay_x402`, `dominusnode_x402_info` |
| Proxy | 4 | `dominusnode_proxy_config`, `dominusnode_proxy_status`, `dominusnode_active_sessions` |
| Usage | 3 | `dominusnode_usage_stats`, `dominusnode_plans` |
| Agentic wallets | 9 | `dominusnode_create_agent_wallet`, `dominusnode_fund_agent_wallet`, `dominusnode_freeze_agent_wallet` |
| Teams | 17 | `dominusnode_create_team`, `dominusnode_team_fund`, `dominusnode_team_create_key` |
| Referrals | 5 | `dominusnode_referral_codes`, `dominusnode_referral_stats` |

### Auto-Verification

When `MCP_AGENT_SECRET` is set, AI agents that include the header `X-DominusNode-Agent: mcp` + `X-DominusNode-Agent-Secret: <secret>` are automatically marked as email-verified on registration — no email confirmation needed for agent accounts.

---

## 13. AI Integrations

24 AI framework integrations available in `integrations/`:

### Python (pip install)

| Package | Framework | Tools |
|---------|-----------|-------|
| `dominusnode-langchain` | LangChain | 26 |
| `dominusnode-crewai` | CrewAI | 26 |
| `dominusnode-llamaindex` | LlamaIndex | 26 |
| `dominusnode-autogpt` | AutoGPT | 26 |
| `dominusnode-agentzeroplugin` | Agent Zero | 26 |
| `dominusnode-pydanticai` | PydanticAI | 26 |
| `dominusnode-camel` | CAMEL-AI | 26 |
| `dominusnode-metagpt` | MetaGPT | 26 |
| `dominusnode-superagi` | SuperAGI | 26 |
| `dominusnode-agno` | Agno | 26 |
| `dominusnode-semantic-kernel` | Semantic Kernel | 26 |
| `dominusnode-ironclaw` | IronClaw | 26 |
| `dominusnode-haystack` | Haystack | 26 |
| `dominusnode-composio` | Composio | 26 |
| `dominusnode-dify` | Dify | 26 |

### TypeScript / Node.js (npm install)

| Package | Framework | Tools |
|---------|-----------|-------|
| `@dominusnode/vercel-ai-tools` | Vercel AI SDK | 26 |
| `@dominusnode/openai-functions` | OpenAI Functions | 26 |
| `@dominusnode/openclaw` | OpenClaw | 26 |
| `@dominusnode/gemini-tools` | Gemini / Vertex AI | 26 |
| `n8n-nodes-dominusnode` | n8n | 3 nodes |
| `@dominusnode/flowise-toolkit` | Flowise | 26 |
| `@dominusnode/mastra-toolkit` | Mastra | 26 |

### Schema-Only

| Package | Framework |
|---------|-----------|
| ChatGPT GPT Actions | OpenAPI 3.1 YAML |

### Integration Showcase Swarm

Test all 24 integrations simultaneously:

```bash
# Install Python deps
pip install -r scripts/requirements-swarm-showcase.txt

# Build Node.js integrations
for dir in integrations/flowise integrations/mastra integrations/openclaw \
           integrations/vercel-ai integrations/openai-functions integrations/n8n integrations/gemini; do
  (cd $dir && npm install && npm run build)
done

# Run TUI showcase
SHOWCASE_API_KEY=dn_live_YOUR_KEY python3 scripts/swarm-showcase.py

# Or headless
SHOWCASE_API_KEY=dn_live_YOUR_KEY python3 scripts/swarm-showcase.py --no-tui
```

---

## 14. Alpha & Waitlist System

### How it works

- `MAX_REGISTERED_USERS=2500` — hard cap on active (non-deleted, non-admin) accounts
- When cap is reached, registration returns HTTP 403
- Frontend automatically switches the register page to a waitlist form — same URL, transparent to the user
- Marketing banner updates live: shows remaining slots or waitlist count
- Waitlist emails are sent when slots open (requires SMTP configured)

### Slot check API

```bash
curl https://api.dominusnode.com/api/slots
# {"total":2500,"used":1247,"remaining":1253,"unlimited":false}

curl https://api.dominusnode.com/api/waitlist/count
# {"pending":34}
```

### Configuration

| Variable | Value | Effect |
|----------|-------|--------|
| `MAX_REGISTERED_USERS=2500` | 2500 | Alpha cap |
| `MAX_REGISTERED_USERS=0` | 0 | Unlimited (production) |

### Admin: notify waitlist

When a slot opens (e.g., user deleted), notify the next person on the waitlist:

```bash
# The waitlist-repo exposes getNextPending() + markNotified() + markRegistered()
# Email is sent automatically when EMAIL_ENABLED=true and a slot opens
```

---

## 15. Post-Deployment Checklist

### Secrets

- [ ] `JWT_SECRET` — 64 hex chars: `openssl rand -hex 32`
- [ ] `MFA_ENCRYPTION_KEY` — 64 hex chars: `openssl rand -hex 32`
- [ ] `MCP_AGENT_SECRET` — 64+ hex chars: `openssl rand -hex 32`
- [ ] Strong PostgreSQL password (not `dominusnode_dev`)
- [ ] `CORS_ORIGINS` set to production domain

### Billing

- [ ] Stripe live keys configured (not test keys)
- [ ] Stripe webhook endpoint registered + secret set
- [ ] NOWPayments IPN URL registered
- [ ] PayPal live credentials + webhook registered
- [ ] x402 receiving addresses set (if enabling `X402_ENABLED=true`)

### Infrastructure

- [ ] `NODE_ENV=production`
- [ ] `TRUST_PROXY=1` (behind reverse proxy)
- [ ] TLS/HTTPS on reverse proxy (Nginx/Caddy)
- [ ] PostgreSQL not exposed publicly (`127.0.0.1:5432` only)
- [ ] Proxy ports (8080/1080) exposed to internet
- [ ] API port (3000) bound to `127.0.0.1` only (Nginx proxies it)
- [ ] `DOMINUSNODE_DOMAIN` set to actual domain

### Email & reCAPTCHA

- [ ] `EMAIL_ENABLED=true` and SMTP credentials set
- [ ] `RECAPTCHA_SITE_KEY` + `RECAPTCHA_SECRET_KEY` set
- [ ] `APP_URL` set to production domain

### Registration Cap

- [ ] `MAX_REGISTERED_USERS=2500` for alpha
- [ ] Set `MAX_REGISTERED_USERS=0` to lift the cap for production

### Admin Account

```bash
# Register your admin account via API:
curl -X POST https://api.dominusnode.com/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@yourdomain.com","password":"strong-password"}'

# Then set is_admin=true in the database:
psql $DATABASE_URL -c "UPDATE users SET is_admin=true WHERE email='admin@yourdomain.com';"

# Set ADMIN_CREDIT_EMAILS to your admin email in .env:
# ADMIN_CREDIT_EMAILS=admin@yourdomain.com
```

### Verify Everything

```bash
# Health
curl https://api.dominusnode.com/api/health

# Slots
curl https://api.dominusnode.com/api/slots

# Proxy (after creating API key)
curl -x http://dc-country-US:dn_live_YOURKEY@proxy.dominusnode.com:8080 https://httpbin.org/ip

# Agent tool card
curl https://api.dominusnode.com/.well-known/agent-tool.json
```

---

## 16. Troubleshooting

### Port in use

```bash
lsof -i :8080 && lsof -i :3000
kill -9 <PID>
```

### Database connection refused

```bash
# Check PostgreSQL is running
docker compose ps
# or
sudo systemctl status postgresql

# Test connection
psql $DATABASE_URL -c "SELECT 1"
```

### API key not working in proxy

- Key must start with `dn_live_` or `dn_test_`
- Check wallet balance: `GET /api/wallet`
- Check proxy logs: `sudo journalctl -u dominusnode-proxy -f`
- Verify Webshare credentials are correct

### Test Webshare upstream directly

```bash
curl -x http://WEBSHARE_DC_USERNAME:WEBSHARE_DC_PASSWORD@p.webshare.io:80 https://httpbin.org/ip
```

### Proxy returns 407 Proxy Auth Required

- API key missing or wrong — verify `dn_live_*` format in password field
- Key revoked — check `GET /api/keys`

### Proxy returns 402 Payment Required

- Wallet balance zero or below minimum reservation (50 cents)
- Top up wallet via Stripe/crypto/PayPal

### Stripe webhook failing

- Verify `STRIPE_WEBHOOK_SECRET` matches Stripe Dashboard → Webhooks → Signing secret
- Ensure raw request body reaches webhook handler (no JSON middleware before it)
- Check webhook endpoint is publicly accessible

### MFA not working after restart

- TOTP replay protection is in-memory — restarts clear used JTI set (by design for alpha)
- Move to Redis or DB for production MFA replay protection

### Build fails: `schema.sql not found`

```bash
npm run build    # This copies schema.sql to dist/
npm run db:migrate
```

### Graceful shutdown not settling sessions

Wait up to 30 seconds for the drain period. If force-killed, check:

```bash
psql $DATABASE_URL -c "SELECT * FROM usage_records ORDER BY created_at DESC LIMIT 10;"
```

---

*Generated: 2026-03-02 — reflects the current codebase state post 48 security audit rounds.*
*Alpha: 2,500 slots | 59 MCP tools | 24 AI integrations | 28 DB tables | Stripe + PayPal + 10 crypto currencies + x402 (9 chains)*
