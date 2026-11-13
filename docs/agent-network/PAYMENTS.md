# Payment rails: Tempo and MPP

This file covers the two Tempo-based payment rails (DESIGN.md §7 and §15) and how Solana x402 payers get an identity. It says which wire formats come from public specs and which we assumed.

Sources (checked 2026-11-06):
- MPP core: "The Payment HTTP Authentication Scheme", https://www.ietf.org/archive/id/draft-ryan-httpauth-payment-01.txt. Also https://github.com/tempoxyz/mpp-specs and https://paymentauth.org/.
- MPP Tempo method: https://mpp.hexdocs.pm/MPP.Methods.Tempo.html and https://tempo.xyz/developers/docs/api/mpp.
- TIP-20 memos: https://docs.tempo.xyz/guide/payments/transfer-memos and https://rustdocs.tempo.xyz/tempo_precompiles/tip20/ITIP20/index.html.

## MPP per-request rail (`billing/src/adapters/rails/mpp-rail.ts`)

**Confirmed against the spec:**
- **Challenge.** A 402 response carries `WWW-Authenticate: Payment id, realm, method="tempo", intent="charge", expires (RFC 3339), request` and `Cache-Control: no-store`.
  - `request` is base64url-nopad of the JCS JSON `{amount, currency, recipient, methodDetails:{chainId}}`.
  - `amount` is in TIP-20 base units. These have 6 decimals, so one base unit is 1 µUSD.
- **Stateless id.** `id = base64url(HMAC-SHA256(MPP_CHALLENGE_SECRET, realm|method|intent|request|expires|digest|opaque))`. Every challenge carries a random 128-bit `opaque`, so each 402 has its own unguessable id and memo; a credential whose challenge has no `opaque` is refused. (Without it the id depended only on the amount and the second, and anyone polling the 402 could match a victim's on-chain memo and redeem the victim's transfer first.)
- **Credential.** The client sends `Authorization: Payment <base64url JSON {challenge, source?, payload}>`.
- **Verification steps:**
  1. Recompute the id and compare it in constant time.
  2. Check `expires`.
  3. Check that the realm, recipient, currency and chain match ours, and that the amount is at least the current quote.
  4. Accept `payload {type:"hash", hash}` and verify it with `eth_getTransactionReceipt` on `MPP_RPC_URL`. The receipt must have status `0x1`, and a TIP-20 `TransferWithMemo` log must show the token, the recipient and an amount of at least the challenge amount. A transfer above the per-payment cap ($10,000) is still accepted: the request is served for the cap and the excess is stored on the claim (`mpp_transactions.excess_musd`) for reconciliation (refund or credit to the payer).
  5. If `source` is present, it must be `did:pkh:eip155:<chainId>:<from>`.
- **Single-use proofs.** The replay key is `sha256("tempo:<chainId>:<txHash>")`, claimed in `mpp_transactions.payment_hash` (UNIQUE). It is keyed on the proof rather than on the credential bytes, so wrapping the same transaction in a new credential is still a replay.

**Assumed (not public, or not yet confirmed):**
- **Memo binding.** The challenge-bound memo is `bytes32 = sha256(challenge.id)`. The Tempo method docs say a memo bound to the challenge is required but do not give the derivation.
- **Pull mode.** `payload.type = "transaction"` (server broadcast) is refused with `method-unsupported`.
- **Proxy credentials.** On a forward proxy we also accept `Proxy-Authorization: Payment <cred>`, because CONNECT clients usually cannot set `Authorization`.
- **Receipts.** `Payment-Receipt` is built by `buildMppReceipt` but the gateway does not send it yet. A relayed response belongs to the origin.

**Configuration:** `MPP_CHALLENGE_SECRET` (at least 32 characters), `MPP_PAY_TO`, `MPP_CURRENCY` (TIP-20 address), `MPP_CHAIN_ID`, `MPP_RPC_URL` (https only) and `MPP_REALM` (optional). The rail is disabled unless all of the required variables are set.

### Gateway

- **402 offer.** When MPP is enabled, a 402 response adds the `WWW-Authenticate: Payment` challenge and an `mpp` block in the body, next to `x402`.
- **HTTP and CONNECT.** An MPP credential follows the x402 order: verify (the proof is claimed), then map the payer to a wallet-identity user, then select a node, lock the snapshot and open the stream, then settle (which commits the claim), then relay.
- **Failures.**
  - The transfer is final once verified, so a refusal after verification (method, target or policy refusal, no node, spend cap, settle failure, payer rate limit, a quote that moved) never deletes the claim. The claim becomes `refund_due`, the payer's wallet-identity user is credited the whole cents (`wallet_transactions` provider `mpp`, payment id `mpp-refund:<hash>`), and the claim records `refund_musd`/`refunded_cents`; it becomes `refunded` once fully credited. Sub-cent remainders, failed credits and refused (e.g. sanctioned) payers stay `refund_due` for reconciliation. The same transaction cannot be presented again.
  - An overpayment above `X402_MAX_OVERPAY_FACTOR` × quote is served at the cap and the excess is credited the same way (payment id `mpp-excess:<hash>`).
  - A failure after settle refunds the payer's identity user through `creditWallet(provider 'mpp', 'mpp-refund:<hash>')`, which is unique per payment.
- **Recording and forwarding.** `relay_charges.payment_rail = 'mpp'`. The MPP `Authorization` header is never forwarded to the origin.
- **Kill switch.** `X402_RELAY_ENABLED=false` refuses MPP as well.

## Tempo prepaid top-up (`billing/src/adapters/rails/tempo.ts`)

**Confirmed:** TIP-20 `TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo)` and 6-decimal stablecoins.

**Assumed:** Tempo publishes no payment webhook. The callback is therefore our own chain watcher's signed POST:
- **Signature.** The `x-tempo-signature: t=<unix>,v1=<hmac hex>` header covers `${t}.${body}`. The timestamp must be within ±5 min, and the body is capped at 16 KB.
- **Body.** `{status, chainId, txHash, token, from, to, amount, memo}`, run through `stripDangerousKeys`.
- **Memo.** The memo is the charge UUID (16 bytes), right-padded with zeros to bytes32.

**Rules:**
- **Matching.** The amount must equal the invoice exactly, in base units divided by 10,000 per cent. The token, recipient and chain must match the configuration.
- **Single-transaction credit.** Crediting goes through `atomicCompleteInvoiceAndCredit` in one transaction.
- **Failed then paid.** A `paid` event for an invoice already marked `failed` is still credited, once. The claim covers `pending|failed → completed` inside the credit transaction, so redelivery is a no-op.
- **No downgrade.** A `failed` event never downgrades a completed invoice.

**Configuration:** `TEMPO_WEBHOOK_SECRET`, `TEMPO_PAY_TO`, `TEMPO_TOKEN` and `TEMPO_CHAIN_ID`.

## Coinbase CDP x402 facilitator (`billing/src/adapters/facilitators/coinbase.ts`)

Endpoints (hardcoded allowlist in `facilitators/urls.ts`): `POST https://api.cdp.coinbase.com/platform/v2/x402/verify` and `.../settle`.

Request body (both): `{x402Version: 1, paymentPayload, paymentRequirements}`.
- `paymentPayload` is the decoded `X-PAYMENT` header (base64 JSON; raw JSON also accepted), x402 v1 exact/EVM: `{x402Version: 1, scheme: "exact", network, payload: {signature, authorization: {from, to, value, validAfter, validBefore, nonce}}}`.
- `paymentRequirements` is our v1 `accepts[]` entry for coinbase (`scheme, network, maxAmountRequired, resource, description, mimeType, payTo, asset, maxTimeoutSeconds, outputSchema?, extra: {name, version}`); the internal routing hint `extra.facilitator` is not sent.

Responses:
- verify: `{isValid, invalidReason?, invalidMessage?, payer}`.
- settle: `{success, errorReason?, errorMessage?, transaction, network, payer}`. `transaction` may be set with `success:false` (`settlement_pending`); we treat anything but `success:true` with a 0x tx hash as failure.

Authentication: `Authorization: Bearer <JWT>` per request, built with `node:crypto` from `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET`. Header `{alg, kid: keyId, typ: "JWT", nonce: 16 random bytes hex}`; claims `{sub: keyId, iss: "cdp", aud: ["cdp_service"], nbf: now, exp: now + 120, uri: "POST api.cdp.coinbase.com/platform/v2/x402/<verify|settle>"}`. Secret API keys are Ed25519 (base64 of 64 bytes, seed || public key; `alg: EdDSA`); a PEM EC key (legacy) signs ES256.

Our checks (fail closed; the adapter interface is unchanged):
- The paid amount is the signed `authorization.value` (exact scheme), never a facilitator field. It must be >= `maxAmountRequired`; `authorization.to` must equal `payTo` and the payload network must equal the requirement network, all checked before calling the facilitator.
- verify passes only on `isValid === true`, and a returned `payer` must equal `authorization.from`.
- settle passes only on `success === true` with a 0x 32-byte `transaction`, a matching `network` (when returned) and `payer` (when returned); it reports `amountSettled` = the signed value. Settlement without requirements is refused.
- Missing credentials, non-2xx, oversized (>10 KB) or non-JSON responses: verify returns invalid, settle throws.

Not covered: x402 v2 payloads (`accepted`/`resource`/`extensions`) are not accepted by this adapter. The PayAI adapter (`payai.ts`) still uses its older `{payment, requirements}` body and `X-PayAI-Key-*` headers and was not changed here.

Sources (read 2026-11-12):
- CDP API reference, verify a payment (request `x402Version`/`paymentPayload`/`paymentRequirements`, v1 and v2 shapes; response `x402VerifyResponse` `{isValid, invalidReason, invalidMessage, payer, extra}`): https://docs.cdp.coinbase.com/api-reference/v2/rest-api/x402-facilitator/verify-payment.md
- CDP API reference, settle a payment (`{success, errorReason, errorMessage, transaction, network, payer}`): https://docs.cdp.coinbase.com/api-reference/v2/rest-api/x402-facilitator/settle-payment.md
- CDP API authentication (Secret API key Bearer JWT: EdDSA/Ed25519, `kid`, `nonce`, `sub`, `iss: cdp`, `aud: [cdp_service]`, `nbf`, `exp = nbf + 120`, `uri`): https://docs.cdp.coinbase.com/api-reference/v2/authentication
- x402 facilitator concepts: https://x402.gitbook.io/x402/core-concepts/facilitator

## Solana x402 payers

- **Identity.** Non-EVM payers map to a wallet-identity user through `payer_identities(chain, address, user_id)`. `users.wallet_address` keeps its 0x-only CHECK.
- **Atomic creation.** The user and the identity row are created in one statement, and concurrent creates collapse on the deterministic email.
- **Self-dealing.** The selector excludes the payer's own user id. At settle time, the charge counts as self-dealing if the payer identity belongs to the node owner.
- **Case.** Solana addresses are case-sensitive and are never lowercased.

## x402 Bazaar discovery

Catalogs such as the Coinbase CDP x402 Bazaar (and Agentic.Market, which is built on it) index a resource once a payment for it has settled through a facilitator that carries discovery metadata. `buildX402Requirements` (`billing/src/x402.ts`) therefore adds, to every 402 the gateway returns and to the `paymentRequirements` sent on settle:

| Where | Field | Value |
|---|---|---|
| each `accepts[]` entry (x402 v1) | `description` | `X402_RESOURCE_DESCRIPTION` (≤500 chars; the CDP facilitator rejects verify/settle with longer descriptions) |
| | `mimeType` | `application/json` |
| | `maxTimeoutSeconds` | 60 |
| | `outputSchema` | `{ input: { type: "http", method: "GET", discoverable: true, headerFields }, output: { type, example } }` (v1 discovery location) |
| top level | `x402Version` | `1` |
| top level (v2 shape) | `resource` | `{ url, description, mimeType }` |
| | `extensions.bazaar` | `{ info: { input: { type: "http", method: "GET", queryParams, headers }, output: { type: "json", example } }, schema }` (JSON Schema that validates `info`) |

`GET /api/x402/info` publishes the same `resource` and `extensions.bazaar` under `discovery`, with `discoverable: true`.

The gateway is a proxy rather than a single URL, so the declared input is a GET with the `Proxy-Authorization` flags and `X-PAYMENT` header; the output example describes the relayed response.

Before launch: settle one test payment through the CDP facilitator, run the CDP validate endpoint against the gateway resource, then confirm the listing appears (LAUNCH_PLAN §8 item 8). Optional `resource.iconUrl` (JPG/PNG/WebP/GIF, not SVG) is not set yet.

Sources (checked 2026-11-12):
- Coinbase CDP, "Get discovered" (seller guide): https://docs.cdp.coinbase.com/x402/seller/get-discovered. Covers `extensions.bazaar`, the ≤500-character description limit, `resource.iconUrl`, input examples validated against `schema.properties.input`, and that settle must carry `paymentPayload.extensions.bazaar` and `paymentPayload.resource`.
- x402 Bazaar extension spec: https://github.com/coinbase/x402/blob/main/specs/extensions/bazaar.md. Covers `extensions.bazaar.{info,schema}`, `info.input` (`type: "http"`, `method`, `queryParams`), `info.output` (`type` required, `example`), the v2 `resource.{url,description,mimeType}`, and v1 discovery through `accepts[0].outputSchema`.
- Coinbase CDP validate endpoint: https://docs.cdp.coinbase.com/x402/validate-endpoint
- Coinbase CDP Bazaar (discovery API): https://docs.cdp.coinbase.com/x402/bazaar
