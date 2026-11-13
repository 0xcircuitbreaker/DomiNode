# Agent self-service API (`/v1`)

Every implemented `/v1` route: nodes, credits, payouts, burn reports, public
policy/pricing/network data, the probe echo, announcements and starter credits.
Implemented in `packages/dashboard/src/routes/v1/` (`nodes.ts`, `credits.ts`,
`public.ts`, `launch.ts`, `probe.ts`). SDKs, the MCP server and the browser
extension use these exact shapes.

## Route index

| Method and path | Auth | Section |
|---|---|---|
| `GET /v1/policy` | public | [Public policy and pricing](#public-policy-and-pricing) |
| `GET /v1/pricing` | public | [Public policy and pricing](#public-policy-and-pricing) |
| `GET /v1/network/stats` | public | [Public network data](#public-network-data-no-auth-cached-120-reqmin-per-ip) |
| `GET /v1/network/history` | public | same |
| `GET /v1/network/incidents` | public | same |
| `GET /v1/network/wanted` | public | same |
| `GET /v1/announcements` | public | [Launch additions](#launch-additions) |
| `GET /v1/probe/echo` | public | [Probe echo](#get-v1probeechononce) |
| `POST /v1/abuse-reports/challenge` | public (PoW) | [Abuse reports](#abuse-reports-no-account-proof-of-work-gated) |
| `POST /v1/abuse-reports` | public (PoW) | same |
| `POST /v1/nodes/challenge` | agent | [Nodes](#nodes) |
| `POST /v1/nodes` | agent | [Nodes](#nodes) |
| `GET /v1/nodes` | agent | [Nodes](#nodes) |
| `PATCH /v1/nodes/:id` | agent | [Nodes](#nodes) |
| `DELETE /v1/nodes/:id` | agent | [Nodes](#nodes) |
| `GET /v1/node/tier` | agent | [Nodes](#nodes) |
| `GET /v1/credits` | agent | [Credits](#credits) |
| `GET /v1/credits/transactions` | agent | [Credits](#credits) |
| `POST /v1/credits/convert` | agent | [Credits](#credits) |
| `GET /v1/payout-wallet` | agent | [Payout wallet](#payout-wallet) |
| `POST /v1/payout-wallet/challenge` | agent | [Payout wallet](#payout-wallet) |
| `PUT /v1/payout-wallet` | agent | [Payout wallet](#payout-wallet) |
| `POST /v1/credits/withdraw/challenge` | agent | [Withdrawals](#withdrawals) |
| `POST /v1/credits/withdraw` | agent | [Withdrawals](#withdrawals) |
| `GET /v1/payouts` | agent | [Withdrawals](#withdrawals) |
| `POST /v1/sessions/:id/report` | agent | [Burn reports](#burn-reports) |
| `GET /v1/starter-credits` | agent | [Launch additions](#launch-additions) |
| `POST /v1/starter-credits/claim` | agent (wallet identity) | [Launch additions](#launch-additions) |

Outside `/v1`, `GET /api/proxy/health` (public) returns only
`{"status": "healthy" | "degraded" | "unknown" | …}`: no counts, ports or node
data. Authenticated `GET /api/proxy/status` adds endpoints and session counts.

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
- **Errors:** `{ "error": "<message>", "code"?: "<CODE>", "requestId": "<id>" }`.
  Every response carries `X-Request-Id`; send your own (1-64 chars of
  `[A-Za-z0-9._:-]`) to correlate, otherwise the API generates one.
- **Pagination:** list routes return `nextCursor` (`null` on the last page);
  pass it back as `?cursor=` (opaque). `limit`/`offset` still work; `offset` is
  ignored when `cursor` is given. A malformed cursor is `400 {code:"INVALID_CURSOR"}`.
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

### `GET /v1/payouts?limit=50&cursor=<nextCursor>`
`limit` 1-200 (default 50). `offset` is still accepted for compatibility.
```json
{"nextCursor": "MjAyNi0…", "payouts": [{"id": "…", "amount": {"musd": "…", "usd": "…"}, "trigger": "auto", "status": "confirmed",
              "txHash": "0x…", "failureReason": null, "address": "0x…", "chain": "base",
              "createdAt": "…", "updatedAt": "…"}], "limit": 50, "offset": 0}
```
`status` ∈ `pending | held_tax | held_frozen | submitted | confirmed | failed | reversed`.

## Nodes

Registering a node needs a verified (or wallet-identity) account with a linked
wallet, a wallet signature over the attestation and a proof of work.

### `POST /v1/nodes/challenge`
Body `{"nodePubkey"?: "<64 hex ed25519 public key>"}`.
```json
{"nonce": "<64 hex>", "attestationText": "…", "attestationVersion": 3, "policyVersion": 12,
 "message": "<EIP-191 message to sign with the linked wallet>", "expiresAt": "…",
 "powChallenge": {"challengeId": "<uuid>", "prefix": "<hex>", "difficulty": 20,
                  "algorithm": "sha256", "expiresAt": "…"}}
```
The proof of work is **bound to the client IP** that requested the challenge:
solve and submit it from the same IP (a different IP gets `400 POW_INVALID`).
Find `nonce` (≤ 32 chars) so that `sha256(prefix + nonce)` has `difficulty`
leading zero bits. At most 5 open PoW challenges per IP.

### `POST /v1/nodes`
```json
{"nonce": "<from challenge>", "walletSignature": "0x<130 hex>", "nodePubkey": "<64 hex>",
 "pow": {"challengeId": "<uuid>", "nonce": "<solution>"}, "maxStreams"?: 32, "maxGbDay"?: 5,
 "declaredClass"?: "residential|mobile|dc|masked"}
```
`declaredClass` is optional and informational: the node's effective class is
always the gateway-verified one (ECONOMICS.md §1a). Declaring a class that the
verified class is below (e.g. `residential` while exiting through a VPN)
opens an admin review flag. Invalid values: `400 INVALID_DECLARED_CLASS`.
→ `201 {"nodeId", "nodeKey": "dn_node_…", "status": "pending", "attestationVersion"}`.
`nodeKey` is returned exactly once; store it for `packages/node-agent`.

### `GET /v1/nodes?limit=100&cursor=<nextCursor>`
Caller's own nodes, newest first (`limit` 1-500; `offset` still accepted):
```json
{"nodes": [{"id", "status", "walletAddress", "nodePubkey", "attestationVersion", "observedIp",
            "country", "ipClass", "verifiedClass", "declaredClass", "classVerifiedAt", "tierWeight",
            "maxStreams", "maxGbDay", "reputation", "agentVersion",
            "lastSeenAt", "createdAt"}], "limit": 100, "offset": 0, "nextCursor": null}
```
`verifiedClass` (= `ipClass`, `unknown` until classified) is the class the
gateway observed; `tierWeight` is that class's tier-credit weight as a decimal
(defaults: residential/mobile 1, dc 0.4, masked 0.25, unknown = lowest).

### `DELETE /v1/nodes/:id`
Revokes an owned node (irreversible) → `{"id", "status": "revoked"}`; not yours or
already revoked: `404`. Revoking a node that is `quarantined` or `suspended`
does not clear the penalty: for 30 days after that, `POST /v1/nodes` refuses new
registrations by the same owner with `403 NODE_PENALTY_ACTIVE` (an admin can
lift it after review).

### `GET /v1/node/tier`
`{tier, nextTier, progress, changedAt, uptimeGraceUntil, demotionReason, tierWeights}`; each
tier has `{id, name, rank, nodeShareBps, holdDays, maxNodes, dailyWithdrawLimitMusd, buyerDiscountBps}`
and `progress` lists `{required, current, met}` per requirement for the next tier.
`progress.activeIps.current` is class-weighted (sum of per-IP weights, floored);
`tierWeights` maps each exit class to its weight, e.g.
`{"residential": 1, "mobile": 1, "dc": 0.4, "masked": 0.25}`.

SDKs 2.1.0 (all six) expose `verifiedClass`, `declaredClass`, `classVerifiedAt`,
`tierWeight`, `tierWeights`, `declaredClass` on register, `class-masked` and
`nextCursor` paging (sdks/SDK_SURFACE.md, additive); the 27 integrations accept
`masked` on the fetch tool's `ip_class` and require SDK >= 2.1.0.

### Node error codes
| Status and code | When |
|---|---|
| `403 EMAIL_NOT_VERIFIED` | API-key account without a verified email (wallet identities pass) |
| `400 NO_LINKED_WALLET` | The account has no linked wallet |
| `400 INVALID_NODE_PUBKEY` | `nodePubkey` is not 64 hex chars |
| `400 INVALID_CHALLENGE` | Nonce malformed, unknown, expired or already used |
| `400 INVALID_SIGNATURE` | `walletSignature` is not `0x` + 130 hex |
| `400 SIGNATURE_MISMATCH` | Signature does not recover to the linked wallet (request a new challenge if the policy changed) |
| `400 POW_INVALID` | Missing, wrong, expired, lower-difficulty or other-IP PoW |
| `400 INVALID_CAPS` | `maxStreams` (1-1024) or `maxGbDay` (1-10000) out of range |
| `400 CLIENT_IP_UNKNOWN` | The API could not determine the client IP |
| `409 NODE_CAP_REACHED` | Tier node limit reached (`cap` in the body) |
| `403 NODE_PENALTY_ACTIVE` | One of your nodes is quarantined or suspended, or was revoked in that state in the last 30 days |
| `403 NOT_ELIGIBLE` | Account cannot register nodes |
| `503 TIERS_NOT_CONFIGURED` | Operator has not configured node tiers |
| `429 RATE_LIMITED` | Too many challenges or registration attempts |

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
`409 ALREADY_REPORTED`, `409 REPORT_LIMIT` (daily cap reached; retrying today
will not help, so it is not a 429).

## Public policy and pricing

### `GET /v1/policy`
`{version, sha256, body, floorGuarantees}` with an `ETag`; send `If-None-Match`
for `304`. `body` is the active network policy (ports, denylist, node defaults,
requester limits, attestation text). `body.freeTierRelay` is deprecated and has
no effect: all relay traffic is paid.

### `GET /v1/pricing`
```json
{"currency": "USD", "unit": "musd_per_gb",
 "prices": [{"ipClass": "dc", "pricePerGbMusd": "200000"}, {"ipClass": "mobile", "pricePerGbMusd": "500000"},
            {"ipClass": "residential", "pricePerGbMusd": "500000"}, {"ipClass": "masked", "pricePerGbMusd": "100000"},
            {"ipClass": "any", "pricePerGbMusd": "200000"}],
 "nodeShare": [{"tier", "rank", "nodeShareBps"}], "buyerDiscounts": [{"tier", "rank", "buyerDiscountBps"}],
 "maturationHours": 168, "rails": ["wallet", "x402", "crypto"]}
```
1 GB = 10^9 bytes (decimal) everywhere: quotes, byte caps and settlement. A
class without its own row, and a node of unknown class, is charged the highest
configured price. x402/MPP payments are quoted for the class in the proxy
username (`class-residential|dc|mobile|masked`); with no class the quote uses the
highest price and any non-masked node may serve it. Masked (anonymizer egress)
nodes serve only `class-masked` requests.

### `GET /v1/probe/echo?nonce=<16-64 [A-Za-z0-9_-]>`
Canary target for the gateway probe job: `{"ip": "<caller IP>", "nonce": "…"}`,
never cached, 120 requests/min per IP (`429` over). Through a relay node, `ip`
is the node's egress address.

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
