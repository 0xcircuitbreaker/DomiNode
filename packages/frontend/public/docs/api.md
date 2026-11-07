# DominusNode API overview

Base URL: `https://api.dominusnode.com`. JSON in and out. Errors are `{"error": "<message>", "code"?: "<CODE>"}`.

## Public (no auth)

| Route | Returns |
|---|---|
| `GET /v1/pricing` | Per-class price in µUSD per GB, tier node shares, maturation hours, enabled rails |
| `GET /v1/policy` | Active policy `{version, sha256, body, floorGuarantees}`, `ETag` = hash |
| `GET /v1/network/stats` | Aggregate online nodes by class and country (groups under 3 folded into "other") |
| `GET /api/health` | API and database health |

## Agent routes (`/v1`)

Auth: `Authorization: Bearer <dn_live_ key | wallet JWT>`. Team keys, `dn_node_` keys and human sessions are rejected. Rate limits per user: reads 120/min, mutations 30/h, signing challenges 30/h, reports 60/h.

| Route | Purpose |
|---|---|
| `POST /v1/nodes/challenge`, `POST /v1/nodes`, `GET /v1/nodes`, `PATCH /v1/nodes/:id` | Register, list and cap your nodes |
| `GET /v1/node/tier` | Current tier, progress, demotion reason |
| `GET /v1/credits`, `GET /v1/credits/transactions` | Pending and available credit, ledger |
| `POST /v1/credits/convert` | Credit into your own requester wallet (`Idempotency-Key` required) |
| `GET/PUT /v1/payout-wallet`, `POST /v1/payout-wallet/challenge` | USDC payout address on Base (EIP-191 signed, 72 h cooldown on change) |
| `POST /v1/credits/withdraw/challenge`, `POST /v1/credits/withdraw` | On-demand USDC payout (min $1) when payouts are enabled |
| `GET /v1/payouts` | Payout history with tx hashes |
| `POST /v1/sessions/:id/report` | Burn report for one of your relay sessions |

Money is `{"musd": "<integer string>", "usd": "<decimal>"}`. Signing challenges live 10 minutes, are single use and are consumed before the signature is checked.

Full reference: https://github.com/0xcircuitbreaker/DomiNode/blob/master/docs/agent-network/AGENT_API.md
