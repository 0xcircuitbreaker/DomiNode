# DomiNode

## Project Overview

DomiNode is a **rotating proxy-as-a-service (PaaS)** SaaS platform. Users connect to DomiNode, are automatically assigned a proxy IP from a managed pool, and their traffic is routed through it. Usage is metered by data (bandwidth) and billed accordingly. Burned/blocked IPs are automatically discarded and replaced with fresh ones from the pool.

## Core Concept

- **NOT a PiHole fork.** The original idea referenced PiHole, but PiHole is a DNS ad-blocker — it has no IP pool or proxy capability. DomiNode is a proxy network service built from scratch.
- Think: Bright Data / SmartProxy / Oxylabs, but self-hosted and operator-controlled.
- **You cannot "grab" IPs from a network and use them as proxies.** A device must be running proxy software to act as a proxy — an IP alone is useless. ARP spoofing, IP aliasing, and similar tricks are illegal and don't produce usable proxies.

## IP Sourcing Strategy

### Dead Ends (Do NOT Pursue)
| Approach | Why It's Dead |
|---|---|
| 911 S5 | **Shut down.** US Treasury sanctioned, DOJ seized infrastructure. Operators face criminal charges. |
| IPIDEA | **Dismantled by Google (Jan 2026).** Used by 550+ threat groups. Trojanized SDKs. Legal action taken. |
| "Grabbing" LAN IPs | Devices must run proxy software — knowing an IP gives zero proxy capability. |
| ARP spoofing / IP aliasing | Illegal under CFAA. Doesn't produce usable proxy exit nodes anyway. |
| Open proxy lists | 90%+ are honeypots, dead, or logging credentials. Unusable for production. |

### Recommended Sourcing (Cheapest → Most Expensive)

#### Tier 0: Free (MVP / Development)
- **Oracle Cloud Free Tier** — 4 ARM VMs, 24GB RAM, 2 IPv4s. Free forever.
- **GCP Free Tier** — 1 e2-micro VM, 1 IPv4. Free forever.
- **AWS/Azure** — 1 micro VM each, 12-month free trial.
- Total: ~4-6 datacenter IPs at $0/month. Enough for development & MVP testing.

#### Tier 1: Resell Existing Proxy Networks ($0.45-$1.00/GB)
Best for getting started with zero infrastructure investment.
- **Geonode** — $0.45/GB at 50TB+, $0.50/GB at 10TB+. Full reseller API + white-label.
- **PacketStream** — $1.00/GB. Reseller API available. Min purchase 50GB ($50).
- **DataImpulse** — $0.80/GB at 1TB+. Reseller API at $1.00/GB.
- **IPRoyal** — $1.00/GB via reseller API.
- **Strategy:** Buy at $0.50-1.00/GB, resell at $3-7/GB. 75-93% gross margin.

#### Tier 2: Cheap Datacenter & ISP Proxies ($0.02-$0.30/IP/month)
- **Webshare** — 100 shared datacenter IPs for $2.99/mo ($0.03/IP). Dedicated: $0.05-$0.12/IP.
- **Decodo (Smartproxy)** — $0.02/IP datacenter (shared rotating). $0.27/IP for ISP proxies.
- **Webshare ISP proxies** — $0.23/IP at bulk. 1,000 IPs = $230/month. Look residential to targets.

#### Tier 3: Cheap VPS Fleet ($0.50-$1.00/IP/month)
- **RackNerd** — $10.98/year per VPS, each with 1 dedicated IPv4. = $0.91/IP/month.
- **Hetzner Cloud** — Extra IPv4s at $0.50/month each.
- **BuyVM** — $2/month base VPS + $1-3/IP.
- **Strategy:** Buy 50x RackNerd VPS = 50 IPs for $549/year ($0.91/IP/month).

#### Tier 4: Own IPv4 Block (Lease or Buy)
- **Lease via IPXO** — $0.38-$0.45/IP/month. /24 block (256 IPs) ≈ $102/month.
- **Buy via IPv4.Global** — $28-35/IP one-time. /24 block ≈ $7,168-$8,960. Prices falling.
- Requires BGP announcement infrastructure (hosting provider with BGP peering).

#### Tier 5: DIY Mobile Proxy Farm (Highest Value IPs)
Mobile IPs are hardest to block and most valuable ($7-20/GB retail).
- **Hardware:** 4G USB dongle ($25-40 each) + Raspberry Pi/Mini PC ($35-200) + USB hub ($30-60)
- **Software:** Proxidize (free/open-source), iProxy.online ($6-10/device/month)
- **Data SIMs:** $15-50/month per SIM depending on plan
- **Total per mobile proxy:** $15-25/month ongoing. Sell at $30-50/month each.
- **Starter kit:** 10 dongles + Pi + hub ≈ $350 hardware + $150/month data = 10 mobile proxies.

### Recommended Launch Strategy
1. **MVP (now):** Use free cloud VMs (Oracle + GCP) for dev/testing
2. **Alpha:** Resell PacketStream/Geonode bandwidth via their APIs — zero infra cost
3. **Beta:** Add Webshare ISP proxies ($230/mo for 1,000 IPs) for dedicated pool
4. **Scale:** Build DIY mobile farm (10-50 dongles) + lease IPv4 block via IPXO

## Architecture (Target)

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────┐
│  User/App   │────▶│  DomiNode Proxy   │────▶│  Target Site │
│  (client)   │◀────│  Gateway (core)   │◀────│              │
└─────────────┘     └──────────────────┘     └──────────────┘
                           │
                    ┌──────┴──────┐
                    │             │
              ┌─────▼─────┐ ┌────▼────┐
              │  IP Pool   │ │ Metering │
              │  Manager   │ │ & Billing│
              └───────────┘ └─────────┘
```

### Core Components

1. **Proxy Gateway** — The main proxy server (HTTP/HTTPS/SOCKS5) that accepts user connections, authenticates them, and routes traffic through assigned IPs.
2. **IP Pool Manager** — Manages a pool of upstream proxy IPs (residential, datacenter, mobile). Handles assignment, rotation, health checks, and burn detection.
3. **Metering Engine** — Tracks bytes in/out per user session. Records usage for billing.
4. **Billing Service** — Charges users based on data consumed (per GB pricing tiers). Integrates with Stripe or similar.
5. **User Dashboard (Web UI)** — User-facing portal: signup, API key management, usage stats, billing history, proxy endpoint configuration.
6. **Admin Panel** — Operator-facing: IP pool health, user management, revenue metrics, burned IP logs.

### Key Features

- **Auto IP Assignment** — Users never pick IPs. System assigns optimal IP based on availability, geo, health score.
- **Burn Detection & Rotation** — If a proxy IP gets blocked/flagged (detected via response codes, CAPTCHAs, timeouts), it's marked burned, pulled from pool, and replaced automatically.
- **Data Metering** — Every byte routed through the proxy is counted per-user. Real-time usage tracking.
- **Usage-Based Billing** — Pay-per-GB model. Tiered pricing possible (e.g., residential vs datacenter).
- **IP Pool Sourcing** — Operator sources IPs via: purchased IP blocks, partnerships, VPS/cloud providers, or residential SDK networks.

## Tech Stack (Planned)

- **Language:** TypeScript (Node.js)
- **Proxy Engine:** Custom proxy server (using `net`, `http`, `https`, `tls` modules) or leveraging a proxy framework
- **Database:** PostgreSQL (users, billing, usage logs) + Redis (sessions, real-time counters, IP pool state)
- **Billing:** Stripe API
- **Web UI:** Next.js or React SPA
- **Deployment:** Docker containers, orchestrated with Docker Compose (dev) / Kubernetes (prod)
- **Monitoring:** Prometheus + Grafana for proxy health, throughput, IP pool metrics

## Project Structure

```
DomiNode/
├── CLAUDE.md                    # This file
├── ARCHITECTURE.md              # Full implementation plan
├── package.json                 # Root workspace config (npm workspaces)
├── tsconfig.json                # Root TS config with project references
├── docker-compose.yml           # PostgreSQL 16 for local dev
├── .env.example                 # All environment variables
├── packages/
│   ├── shared/src/
│   │   ├── types.ts             # User, ApiKey, Wallet, Session, UsageRecord, constants
│   │   ├── db.ts                # pg.Pool singleton, query() helper
│   │   ├── auth.ts              # API key gen (SHA-256), bcrypt passwords, JWT
│   │   ├── schema.sql           # Full PostgreSQL DDL
│   │   ├── migrate.ts           # Schema migration script
│   │   ├── logger.ts            # JSON structured logger
│   │   ├── validation.ts        # Input validators
│   │   └── repositories/        # user-repo, wallet-repo, usage-repo
│   ├── pool-manager/src/
│   │   ├── packetstream.ts      # PacketStream gateway auth builder, reseller API
│   │   └── index.ts             # Re-exports
│   ├── proxy-gateway/src/
│   │   ├── server.ts            # HTTP proxy + HTTPS double-CONNECT through PacketStream
│   │   ├── auth.ts              # Proxy-Authorization header parser
│   │   ├── balance-check.ts     # Wallet balance check with 30s cache
│   │   ├── counting-stream.ts   # Byte counters for billing
│   │   ├── session-manager.ts   # In-memory session tracking, usage recording, wallet debit
│   │   └── main.ts              # Entrypoint with graceful shutdown
│   ├── metering/src/
│   │   └── index.ts             # computeCostCents ($7/GB), recordUsage, debitForUsage
│   ├── billing/src/
│   │   ├── stripe.ts            # Checkout sessions, webhook handling
│   │   ├── nowpayments.ts       # Crypto invoices (BTC/ETH/XMR/SOL/ZEC), IPN verification
│   │   └── index.ts             # Re-exports
│   └── dashboard/src/
│       ├── server.ts            # Express API server
│       ├── main.ts              # Entrypoint with graceful shutdown
│       ├── middleware/auth.ts    # JWT verification middleware
│       └── routes/              # auth, keys, usage, wallet, webhooks
├── infra/docker/                # (Dockerfiles — future)
├── scripts/
└── tests/
```

## Development Guidelines

- Use TypeScript strict mode everywhere
- All services communicate via internal REST APIs or message queues
- Every PR needs tests — unit for logic, integration for service boundaries
- Proxy gateway must be high-performance: minimize per-request overhead
- Security-critical: user auth tokens, proxy credentials, and billing data must be handled with care
- IP pool data is sensitive — never expose upstream proxy credentials to end users

## Key Business Logic

### IP Lifecycle
```
AVAILABLE → ASSIGNED → IN_USE → (HEALTHY → re-pool | BURNED → discard)
```

### Billing Model
- Flat rate: **$7.00/GB** (our cost: $1.00/GB from PacketStream = 85% margin)
- Prepaid wallet system — users top up, usage debits automatically
- Payments: Stripe (fiat) + NOWPayments (BTC, ETH, XMR, SOL, ZEC)
- Balance stored in cents (integer) with DB CHECK constraint preventing negative

### Burn Detection Heuristics
- HTTP 403/429 response rate exceeds threshold
- CAPTCHA pages detected in response body
- Connection timeout rate spikes
- Target-specific signature detection (Cloudflare challenge, etc.)

## Current Status

**Backend MVP COMPLETE — all 6 packages compile, zero errors.**

### What's built:
- `@dominode/shared` — Types, PostgreSQL schema, db client, auth (API keys + JWT), repositories (user, wallet, usage)
- `@dominode/pool-manager` — PacketStream gateway integration with geo targeting + sticky sessions
- `@dominode/proxy-gateway` — Full HTTP/HTTPS proxy with API key auth, balance checks, PacketStream chaining, byte counting, session tracking, wallet debiting
- `@dominode/metering` — Real cost calculation at $7/GB, usage recording, wallet debiting
- `@dominode/billing` — Stripe Checkout for wallet top-ups, NOWPayments for crypto (BTC/ETH/XMR/SOL/ZEC)
- `@dominode/dashboard` — Express REST API with auth, API key management, wallet, usage, and webhook endpoints

### To launch:
1. `docker compose up -d` — start PostgreSQL
2. `npm run db:migrate` — apply schema
3. `npm run build` — compile
4. Set `.env` with PacketStream, Stripe, NOWPayments credentials
5. `npm run start:api` — REST API on :3000
6. `npm run start:proxy` — proxy gateway on :8080

### Next steps:
- Build frontend UI (dashboard, account management)
- Add Webshare ISP proxy pool (Tier 2 IP sourcing)
- Add rate limiting and abuse prevention
- Add health monitoring / burn detection
- Dockerize both processes

## Phases

1. ~~**Phase 1 — Foundation**~~ DONE
2. ~~**Phase 2 — Backend MVP**~~ DONE (PacketStream, auth, billing, API)
3. **Phase 3 — Frontend Dashboard:** User web UI (usage, billing, API keys)
4. **Phase 4 — ISP Proxy Pool:** Webshare integration, multi-provider pool management
5. **Phase 5 — Scale & Harden:** Rate limiting, abuse prevention, Kubernetes, monitoring

## Commands

```bash
npm install              # Install all workspace dependencies
npm run build            # Build all packages (tsc --build)
npm run clean            # Clean all build output
npm run start:proxy      # Start proxy gateway on :8080
npm run start:api        # Start REST API server on :3000
npm run db:migrate       # Apply PostgreSQL schema
npm run lint             # Lint all packages
npm run format           # Format with Prettier
docker compose up -d     # Start PostgreSQL (local dev)
```

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/auth/register | None | Create account |
| POST | /api/auth/login | None | Get JWT token |
| POST | /api/keys | JWT | Create API key (shown once) |
| GET | /api/keys | JWT | List API keys |
| DELETE | /api/keys/:id | JWT | Revoke API key |
| GET | /api/wallet | JWT | Get balance |
| GET | /api/wallet/transactions | JWT | Transaction history |
| POST | /api/wallet/topup/stripe | JWT | Create Stripe checkout |
| POST | /api/wallet/topup/crypto | JWT | Create crypto invoice |
| GET | /api/usage | JWT | Usage stats |
| POST | /api/webhooks/stripe | Signature | Stripe webhook |
| POST | /api/webhooks/nowpayments | Signature | NOWPayments IPN |
| GET | /api/health | None | Health check |

## Proxy Usage

```bash
# After creating an account and API key via the REST API:
curl -x http://anything:dn_live_YOUR_KEY@localhost:8080 http://httpbin.org/ip
curl -x http://anything:dn_live_YOUR_KEY@localhost:8080 https://httpbin.org/ip
```
