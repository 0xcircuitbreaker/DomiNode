# DomiNode Backend MVP — Implementation Plan

## Goal
Build a working proxy-as-a-service backend that resells PacketStream bandwidth at $7/GB with prepaid wallet billing via Stripe + crypto (BTC, ETH, XMR, SOL, ZEC via NOWPayments).

Two processes: **proxy gateway** (port 8080) and **REST API** (port 3000), both backed by PostgreSQL.

---

## Architecture

```
User App                        Dashboard/Frontend
   |                                   |
   | Proxy-Authorization: Basic        | Authorization: Bearer JWT
   | (API key as password)             |
   v                                   v
┌──────────────────┐          ┌──────────────────┐
│  Proxy Gateway   │          │  REST API Server │
│  :8080           │          │  :3000           │
│                  │          │                  │
│  - Auth (API key)│          │  - Auth routes   │
│  - Balance check │          │  - API key mgmt  │
│  - Chain to PS   │          │  - Wallet/topup  │
│  - Count bytes   │          │  - Usage stats   │
│  - Debit wallet  │          │  - Webhooks      │
└────────┬─────────┘          └────────┬─────────┘
         │                             │
         └──────────┬──────────────────┘
                    │
              ┌─────▼─────┐
              │ PostgreSQL │
              │  :5432     │
              └───────────┘
                    │
    ┌───────────────┼────────────────┐
    │               │                │
 users          wallets         usage_records
 api_keys    wallet_transactions  sessions
```

**Proxy chaining**: Client → DomiNode (8080) → PacketStream (`gw.packetstream.io:31112`) → Target

---

## Phases (9 total, ~26 new/modified files)

### Phase 1: Shared Foundation
| File | Action |
|------|--------|
| `packages/shared/src/types.ts` | Replace — add User, ApiKey, Wallet, WalletTransaction, Session types + constants ($7/GB = 700 cents) |
| `packages/shared/src/index.ts` | Update exports |
| `packages/shared/src/db.ts` | **New** — pg.Pool singleton, `query()` helper |
| `packages/shared/src/schema.sql` | **New** — full DDL: users, api_keys, wallets, wallet_transactions, sessions, usage_records |
| `packages/shared/src/migrate.ts` | **New** — script to apply schema.sql |
| `packages/shared/src/logger.ts` | **New** — simple JSON logger |
| `packages/shared/src/validation.ts` | **New** — email, password, amount validators |
| `packages/shared/package.json` | Add deps: `pg`, `@types/pg`, `dotenv`, `bcrypt`, `@types/bcrypt`, `jsonwebtoken`, `@types/jsonwebtoken` |

### Phase 2: Auth System
| File | Action |
|------|--------|
| `packages/shared/src/auth.ts` | **New** — `generateApiKey()` (SHA-256 hash for fast lookup), `hashPassword()`/`verifyPassword()` (bcrypt), `signJwt()`/`verifyJwt()` |
| `packages/shared/src/repositories/user-repo.ts` | **New** — CRUD for users + api_keys, `findUserByApiKeyHash()` |
| `packages/shared/src/repositories/wallet-repo.ts` | **New** — `creditWallet()`, `debitWallet()` (with SELECT FOR UPDATE), `getBalance()` |
| `packages/shared/src/repositories/usage-repo.ts` | **New** — session CRUD, usage recording, usage summaries |

### Phase 3: PacketStream Integration
| File | Action |
|------|--------|
| `packages/pool-manager/src/packetstream.ts` | **New** — `buildProxyAuth()` with country/session suffixes, `generateStickySession()`, reseller API calls |
| `packages/pool-manager/src/index.ts` | Rewrite — `getUpstreamProxy()` returning PacketStream gateway details |
| `packages/pool-manager/package.json` | Add `dotenv` |

### Phase 4: Proxy Gateway (core rewrite)
| File | Action |
|------|--------|
| `packages/proxy-gateway/src/auth.ts` | **New** — parse Proxy-Authorization header, SHA-256 lookup API key |
| `packages/proxy-gateway/src/balance-check.ts` | **New** — DB balance check with 30s in-memory cache |
| `packages/proxy-gateway/src/counting-stream.ts` | **New** — byte counters for client/upstream sockets |
| `packages/proxy-gateway/src/session-manager.ts` | **New** — in-memory Map of active sessions, `endSession()` writes usage + debits wallet |
| `packages/proxy-gateway/src/server.ts` | **Rewrite** — real auth, PacketStream chaining (HTTP forwarding + HTTPS double-CONNECT), byte counting |
| `packages/proxy-gateway/src/main.ts` | **New** — entrypoint with dotenv + graceful shutdown |
| `packages/proxy-gateway/package.json` | Add deps: `@dominode/pool-manager`, `dotenv` |
| `packages/proxy-gateway/tsconfig.json` | Add pool-manager reference |

### Phase 5: Metering
| File | Action |
|------|--------|
| `packages/metering/src/index.ts` | Rewrite — `computeCostCents()` at $7/GB, `recordUsage()`, `debitForUsage()` |

### Phase 6: Billing (Stripe + Crypto)
| File | Action |
|------|--------|
| `packages/billing/src/index.ts` | Rewrite — flat $7/GB pricing, re-export stripe/nowpayments modules |
| `packages/billing/src/stripe.ts` | **New** — `createCheckoutSession()` for wallet top-ups, `handleCheckoutWebhook()` with signature verification |
| `packages/billing/src/nowpayments.ts` | **New** — `createInvoice()` (BTC/ETH/XMR/SOL/ZEC), `verifyIpnSignature()` (HMAC-SHA512), `handleIpnCallback()` |
| `packages/billing/package.json` | Add `stripe` dep |

### Phase 7: REST API Server
| File | Action |
|------|--------|
| `packages/dashboard/src/server.ts` | **New** — Express app, CORS, raw body for Stripe webhooks |
| `packages/dashboard/src/main.ts` | **New** — entrypoint with dotenv + graceful shutdown |
| `packages/dashboard/src/middleware/auth.ts` | **New** — JWT verification middleware |
| `packages/dashboard/src/routes/auth.ts` | **New** — POST /register, POST /login |
| `packages/dashboard/src/routes/keys.ts` | **New** — POST/GET/DELETE API keys |
| `packages/dashboard/src/routes/usage.ts` | **New** — GET usage stats with date range |
| `packages/dashboard/src/routes/wallet.ts` | **New** — GET balance, GET transactions, POST topup/stripe, POST topup/crypto |
| `packages/dashboard/src/routes/webhooks.ts` | **New** — Stripe + NOWPayments webhook handlers (idempotent) |
| `packages/dashboard/src/index.ts` | Rewrite — export `startApiServer` |
| `packages/dashboard/package.json` | Add deps: `express`, `@types/express`, `cors`, `@types/cors`, `@dominode/billing`, `@dominode/metering`, `dotenv` |
| `packages/dashboard/tsconfig.json` | Add billing, metering references |

### Phase 8: Infrastructure
| File | Action |
|------|--------|
| `docker-compose.yml` | **New** — PostgreSQL 16 with auto-schema init |
| `.env.example` | Update — all env vars (PacketStream, Stripe, NOWPayments, JWT) |
| `package.json` (root) | Add scripts: `start:proxy`, `start:api`, `db:migrate` |

### Phase 9: CLAUDE.md Update
Update project status, commands, and current state.

---

## Key Design Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| API key hashing | SHA-256 (not bcrypt) | Need O(1) lookup on every proxy request. 128-bit random key is strong enough for fast hash. Same as GitHub/Stripe. |
| Wallet model | Prepaid credits in cents (integer) | No floating point, DB CHECK prevents negative balance |
| Wallet debit | SELECT FOR UPDATE in transaction | Prevents race conditions from concurrent sessions |
| Crypto payments | NOWPayments | Only hosted provider supporting all 5 coins (BTC/ETH/XMR/SOL/ZEC) at 0.5% fee |
| Session tracking | In-memory Map | No Redis needed for MVP. Cleanup timer evicts stale sessions. |
| HTTPS tunneling | Double-CONNECT through PacketStream | Client CONNECTs to us, we CONNECT to PacketStream, they CONNECT to target |
| Pricing | Flat $7/GB (our cost: $1/GB from PacketStream) | Simple, 85% gross margin |

## API Endpoints Summary

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/auth/register | None | Create account |
| POST | /api/auth/login | None | Get JWT |
| POST | /api/keys | JWT | Create API key (shown once) |
| GET | /api/keys | JWT | List API keys |
| DELETE | /api/keys/:id | JWT | Revoke API key |
| GET | /api/wallet | JWT | Get balance |
| GET | /api/wallet/transactions | JWT | Transaction history |
| POST | /api/wallet/topup/stripe | JWT | Create Stripe checkout |
| POST | /api/wallet/topup/crypto | JWT | Create NOWPayments invoice |
| GET | /api/usage | JWT | Usage stats |
| POST | /api/webhooks/stripe | Signature | Stripe webhook |
| POST | /api/webhooks/nowpayments | Signature | NOWPayments IPN |

## Verification Plan

1. `docker compose up -d` — start PostgreSQL
2. `npm run db:migrate` — apply schema
3. `npm run build` — compile all packages
4. `npm run start:api &` — start REST API on :3000
5. `npm run start:proxy &` — start proxy on :8080
6. Register user → create API key → check $0 wallet
7. Manually credit wallet in DB → proxy through httpbin.org/ip → verify residential IP
8. Check usage endpoint shows recorded bytes and wallet debit
