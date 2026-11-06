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
- **Stateless id.** `id = base64url(HMAC-SHA256(MPP_CHALLENGE_SECRET, realm|method|intent|request|expires|digest|opaque))`.
- **Credential.** The client sends `Authorization: Payment <base64url JSON {challenge, source?, payload}>`.
- **Verification steps:**
  1. Recompute the id and compare it in constant time.
  2. Check `expires`.
  3. Check that the realm, recipient, currency and chain match ours, and that the amount is at least the current quote.
  4. Accept `payload {type:"hash", hash}` and verify it with `eth_getTransactionReceipt` on `MPP_RPC_URL`. The receipt must have status `0x1`, and a TIP-20 `TransferWithMemo` log must show the token, the recipient and an amount of at least the challenge amount.
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
  - A failure before settle releases the claim, so the same transaction can be retried.
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

## Solana x402 payers

- **Identity.** Non-EVM payers map to a wallet-identity user through `payer_identities(chain, address, user_id)`. `users.wallet_address` keeps its 0x-only CHECK.
- **Atomic creation.** The user and the identity row are created in one statement, and concurrent creates collapse on the deterministic email.
- **Self-dealing.** The selector excludes the payer's own user id. At settle time, the charge counts as self-dealing if the payer identity belongs to the node owner.
- **Case.** Solana addresses are case-sensitive and are never lowercased.
