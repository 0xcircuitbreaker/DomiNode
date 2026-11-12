# Agent self-service API (`/v1`)

Credits, payouts, node caps and burn reports for agents. Implemented in
`packages/dashboard/src/routes/v1/credits.ts`. SDKs, the MCP server and the
browser extension use these exact shapes.

## Common rules

- **Auth:** `Authorization: Bearer <dn_live_… | dn_test_… | wallet JWT>` (`requireAgentPrincipal`).
  Team API keys get `403`, `dn_node_` keys and human JWTs are rejected, cookies are ignored.
- **Verification:** financial mutations (convert, payout wallet, withdraw) need an
  email-verified account or a wallet-identity account. Otherwise `403 {code:"EMAIL_NOT_VERIFIED"}`.
- **Linked wallet:** payout-wallet and withdraw operations are signed by the account's
  linked wallet (`users.wallet_address`). Without one: `400 {code:"NO_LINKED_WALLET"}`.
- **Money** is always `{ "musd": "<integer µUSD string>", "usd": "<decimal, 6 places>" }`.
  1 USD = 1,000,000 µUSD. Request amounts (`amountMusd`) are integer µUSD, sent as
  a decimal string (preferred) or a safe JSON integer.
- **Errors:** `{ "error": "<message>", "code"?: "<CODE>" }`.
- **Rate limits (per user):** reads 120/min; mutations 30/h; signing challenges 30/h
  (plus at most 10 outstanding); reports 60/h. Over the limit: `429 {code:"RATE_LIMITED"}`.

## Signing challenges

Payout-wallet changes and withdrawals need a fresh EIP-191 (`personal_sign`)
signature over a server-issued message. Challenges live 10 minutes, are single
use and are consumed (`DELETE … RETURNING`) **before** the signature is checked,
so a bad signature burns the challenge and replay always fails with
`400 {code:"INVALID_CHALLENGE"}`. The message binds the action, user id, linked
wallet, the target (address/chain, or amount/idempotency key) and the nonce;
submitting different parameters than the challenge was issued for fails the same way.

Sign the `message` string exactly as returned.

## Credits

### `GET /v1/credits`
```json
{
  "pending":   {"musd": "2000000", "usd": "2.000000"},
  "available": {"musd": "1500000", "usd": "1.500000"},
  "frozen": false,
  "autoConvertPct": 0,
  "tier": {"id": 1, "name": "probation", "rank": 0, "holdDays": 14,
           "dailyWithdrawLimit": {"musd": "50000000", "usd": "50.000000"}},
  "taxFormStatus": "not_required",          // not_required | requested | received | rejected
  "ytdPaid": {"musd": "0", "usd": "0.000000"},  // confirmed payouts this calendar year
  "payoutsEnabled": false,
  "minWithdraw": {"musd": "1000000", "usd": "1.000000"}
}
```

### `GET /v1/credits/transactions?limit=50&cursor=<id>&type=<type>`
`limit` 1–200 (default 50). `cursor` is the previous page's `nextCursor`.
`type` ∈ `earn | mature | clawback | convert | withdraw | withdraw_reversal`.
```json
{
  "transactions": [
    {"id": "9", "type": "convert", "amount": {"musd": "10000", "usd": "0.010000"},
     "relayChargeId": null, "reference": "convert:my-key-0001", "createdAt": "2026-11-06T12:00:00.000Z"}
  ],
  "nextCursor": "9"     // null on the last page
}
```
`reference` is the payout id for `withdraw` / `withdraw_reversal`.

### `POST /v1/credits/convert`
Header `Idempotency-Key: <8–120 of [A-Za-z0-9_-]>` (required).
Body `{"amountMusd": "1500000"}`; 10,000 (1 cent) ≤ amount ≤ 10,000,000,000 ($10,000).
Converts whole cents of available credit into the caller's own requester wallet;
the sub-cent remainder stays in credits. Repeating a key returns the original result.
```json
{"converted": {"musd": "1500000", "usd": "1.500000"}, "convertedCents": 150, "duplicate": false}
```
Errors: `403 ACCOUNT_FROZEN`, `409 INSUFFICIENT_CREDIT | WALLET_CAP | NO_WALLET`, `400`.

## Payout wallet

### `GET /v1/payout-wallet`
```json
{"payoutWallet": {"address": "0x…", "chain": "base", "status": "active", "activeFrom": "…"}, "cooldownHours": 72}
```
`payoutWallet` is `null` if none is registered. `status: "pending"` means a change is cooling down until `activeFrom`.

### `POST /v1/payout-wallet/challenge`
Body `{"address": "0x…40 hex", "chain": "base"}` (`chain` optional, default `base`). `base-sepolia` is accepted only when the API runs with `NODE_ENV` other than `production` or with `PAYOUT_ALLOW_TESTNET=true` (staging smoke tests); production refuses it by default.
```json
{
  "nonce": "<64 hex>",
  "message": "DominusNode payout wallet\nAction: payout_wallet_set\nUser: <uuid>\nAccount wallet: 0x…\nPayout address: 0x…\nChain: base\nNonce: <64 hex>",
  "expiresAt": "…",
  "signer": "0x… (linked wallet)",
  "oldWalletSignatureRequired": true,
  "oldWalletAddress": "0x… | null"
}
```

### `PUT /v1/payout-wallet`
Body `{"address", "chain": "base", "nonce", "signature", "oldWalletSignature"?}`.
- `signature`: linked wallet over `message`.
- First registration: wallet becomes `active` immediately.
- Change: `oldWalletSignature` from the **current payout wallet** over the same
  message (omit it when the current payout wallet is the linked wallet). The new
  wallet is `pending` for 72 h; unsent payouts to the old wallet are reversed to
  available credit.
- The address is screened against the OFAC SDN list (`PAYOUT_SDN_FILE`). No list
  loaded: `503 SCREENING_UNAVAILABLE` (fail closed). Listed: `403 SANCTIONED`.
```json
{"payoutWallet": {"address": "0x…", "chain": "base", "status": "pending", "activeFrom": "…"},
 "changed": true, "cooldownHours": 72}
```
Errors: `400 INVALID_CHALLENGE | BAD_SIGNATURE | OLD_WALLET_SIGNATURE_REQUIRED`,
`409 COOLDOWN_ACTIVE | SAME_ADDRESS | ALREADY_REGISTERED`.

## Withdrawals

While `PAYOUTS_ENABLED` is not `true`, both routes return
`503 {"code": "PAYOUTS_DISABLED", "error": "Payouts are currently disabled. …"}`.

### `POST /v1/credits/withdraw/challenge`
Body `{"amountMusd": "2000000", "idempotencyKey": "<8–120 [A-Za-z0-9_-]>"}`; min 1,000,000 ($1).
```json
{"nonce": "<64 hex>", "message": "DominusNode withdrawal\nAction: withdraw\nUser: …\nAccount wallet: 0x…\nAmount (µUSD): 2000000\nIdempotency key: …\nNonce: …",
 "expiresAt": "…", "signer": "0x…"}
```

### `POST /v1/credits/withdraw`
Body `{"amountMusd", "idempotencyKey", "nonce", "signature"}` (same amount and key as the challenge).
Returns `201` (or `200` with `duplicate: true` for a repeated idempotency key):
```json
{"payout": {"id": "<uuid>", "amount": {"musd": "2000000", "usd": "2.000000"}, "trigger": "on_demand",
            "status": "pending", "txHash": null, "createdAt": "…"}, "duplicate": false}
```
`status` is `held_tax` when the payout would exceed the $2,000 yearly threshold without a tax form.
Errors: `403 ACCOUNT_FROZEN`, `409 INSUFFICIENT_CREDIT | NO_PAYOUT_WALLET | PAYOUT_WALLET_COOLDOWN | DAILY_LIMIT_EXCEEDED`,
`400 AMOUNT_OUT_OF_RANGE | INVALID_CHALLENGE | BAD_SIGNATURE`.

### `GET /v1/payouts?limit=50&offset=0`
```json
{"payouts": [{"id": "…", "amount": {"musd": "…", "usd": "…"}, "trigger": "auto", "status": "confirmed",
              "txHash": "0x…", "failureReason": null, "address": "0x…", "chain": "base",
              "createdAt": "…", "updatedAt": "…"}], "limit": 50, "offset": 0}
```
`status` ∈ `pending | held_tax | held_frozen | submitted | confirmed | failed | reversed`.

## Nodes

### `PATCH /v1/nodes/:id`
Body: any of `{"maxStreams", "gbPerDay", "reqPerSec"}` (positive integers, no other keys).
Caps can only be lowered: each value must be ≤ the policy default
(`nodeDefaults.maxStreams`, `nodeDefaults.maxGbDay`, `requesterLimits.reqPerSec × 10`),
else `400 {code:"CAP_ABOVE_DEFAULT", max}`. Another user's or a revoked node: `404`.
```json
{"id": "…", "status": "active",
 "caps": {"maxStreams": 8, "gbPerDay": 5, "reqPerSec": 20},
 "effective": {"maxStreams": 8, "gbPerDay": 5, "reqPerSec": 20},
 "appliesOn": "next_tunnel_connect"}
```
The tunnel protocol has no per-node cap push (POLICY_UPDATE carries only policy
fields), so the gateway reads the stored caps from the node row at tunnel auth and
the selector enforces them from then on. Reconnect the node to apply immediately.

## Burn reports

### `POST /v1/sessions/:id/report`
Body `{"reason": "blocked" | "captcha" | "rate_limited" | "slow" | "bad_content" | "other"}`.
The session must be the caller's own relay session from the last 7 days. At most
5 reports per requester per node per UTC day; one per session. Reports are stored
in `node_reports` (weighting by 30-day spend comes later) and increment the node's
`node_daily_stats.burns`, which feeds reputation.
```json
{"reportId": "7", "reportsToday": 1, "limitPerDay": 5}
```
Errors: `404` (not found / not yours), `400 NOT_RELAY_SESSION | SESSION_TOO_OLD`,
`409 ALREADY_REPORTED`, `429 REPORT_LIMIT`.

## Launch additions

### Buyer discount fields
- `GET /v1/node/tier`: `tier.buyerDiscountBps` and `nextTier.buyerDiscountBps`.
- `GET /v1/credits`: `buyerDiscountBps`, the discount you currently get on relay purchases (0 unless you own a node).
- `GET /v1/pricing` (public): `prices` are **list** prices; `buyerDiscounts: [{tier, rank, buyerDiscountBps}]`.

### `POST /v1/starter-credits/claim` (agent auth, wallet identity)

Retries the one-time grant, for example after a $1 top-up. `201 {granted: true, amount, expiresAt}`; `403 {granted: false, reason}` with `reason ∈ unfunded|disabled|budget_exhausted|prefix_cap|funding_source_cap|no_wallet|invalid`; `409` once granted. 5 attempts per hour.

### `GET /v1/announcements` (public)

Admin-published changelog / news feed for policy, pricing, payment-rail, API and network changes. `?limit=1..100` (20), `?category=policy|pricing|payments|api|network|news`, `?since=<ISO>` (only newer). Returns `{description, announcements: [{id, title, body, category, url, publishedAt, updatedAt}]}`, newest first, `Cache-Control: public, max-age=300`. Linked from `/llms.txt` and `/.well-known/agent-tool.json` (`announcements.url`).

### `GET /v1/starter-credits` (agent auth)
```json
{
  "program": {"enabled": true, "amount": {"musd": "500000", "usd": "0.500000"}, "expiryDays": 30,
              "seedNodesOnly": true, "seedOnlyDays": 30, "withdrawable": false, "countsTowardTiers": false},
  "grant": {"amount": {...}, "remaining": {...}, "status": "active", "expiresAt": "…", "grantedAt": "…", "seedNodesOnly": true}
}
```
`grant` is `null` when none was given. Grants happen automatically on a principal's first wallet sign-in, within the caps in ECONOMICS.md §7.

### Public network data (no auth, cached, 120 req/min per IP)
| Route | Response |
|---|---|
| `GET /v1/network/stats` | Adds `seed {online, paidBytes24h}` and `community {online, paidBytes24h}` (operator-run vs community nodes). |
| `GET /v1/network/history?hours=168` | `{hours, snapshots: [{hour, onlineNodes, seedOnline, communityOnline, countries, asns, successRateBps, p50Ms, p95Ms, paidBytes24h, seedPaidBytes24h, communityPaidBytes24h, byClass}]}` (hours 1–9600). |
| `GET /v1/network/incidents?limit=20` | `{incidents: [{id, title, body, severity, status, startedAt, resolvedAt, updatedAt}]}` |
| `GET /v1/network/wanted?days=7` | `{days, minRequests: 5, wanted: [{country, ipClass, requests}]}`: where requesters found no node. `null` = any. |
| `GET /status` | Human-readable status page (no scripts) built from the same data. |

### Abuse reports (no account, proof-of-work gated)
1. `POST /v1/abuse-reports/challenge` → `{challengeId, prefix, difficulty, algorithm: "sha256", expiresAt}`. Find `nonce` (≤ 32 chars) so that `sha256(prefix + nonce)` has `difficulty` leading zero bits.
2. `POST /v1/abuse-reports`
```json
{"pow": {"challengeId": "…", "nonce": "123456"}, "destHost": "victim.example.com",
 "windowStart": "2026-11-06T10:00:00Z", "windowEnd": "2026-11-06T11:00:00Z",
 "category": "credential_stuffing", "description": "…", "contact": "optional"}
```
→ `201 {id, status: "new", receivedAt, responseTarget: "24h"}`. `destHost` is a bare hostname; the window is at most 31 days within the last year; `category ∈ spam|credential_stuffing|scraping|fraud|ddos|illegal_content|other`; description 10–4000 chars. The challenge is consumed before the solution is checked. Limits: 20 challenges and 5 reports per IP per hour. Errors: `400 POW_REQUIRED|POW_INVALID`, `413` over 16 KB, `429 RATE_LIMITED`. The reporter's IP is not stored.

### Gateway access codes
| Code | When |
|---|---|
| `403 CONTRIBUTION_REQUIRED` | `policy.requireContribution` is on and the API-key principal has no active node with matured paid traffic in the window and no allowlist entry. |
| `403 ANONYMOUS_PAYERS_DISABLED` | `policy.allowAnonymousPayers` is off; x402/MPP requests are refused before payment verification. |
| `403 PAYER_SANCTIONED` | The x402/MPP payer wallet is on the SDN list; the payment is not settled. |
| `503 PAYER_SCREENING_UNAVAILABLE` | The SDN list is required but missing (always in production); nothing is charged. |
