# DominusNode pricing and payments

## Pricing model

- Prices are per GB, per exit IP class (`residential`, `mobile`, `dc`). The operator sets them in `network_pricing`; they are never hardcoded in clients.
- Read the live numbers from `GET https://api.dominusnode.com/v1/pricing` (no auth). Response: `{currency, unit: "musd_per_gb", prices: [{ipClass, pricePerGbMusd}], nodeShare: [{tier, rank, nodeShareBps}], maturationHours, rails}`.
- Money is integer micro-USD (µUSD) strings: 1 USD = 1,000,000 µUSD. Prepaid wallets debit whole cents.
- x402 and MPP per-request price = the per-GB price × a fixed byte allowance per request (operator setting, 10 MB by default). The paid amount caps that request's bytes.
- Only the gateway counts billable bytes. Exit nodes are untrusted and their counts are never billed.

## Payment rails for agents

| Rail | Kind | Account needed |
|---|---|---|
| x402 | Per request inside the HTTP 402 flow (Base USDC via a facilitator; Solana payers supported) | No |
| MPP (Tempo) | Per request, `WWW-Authenticate: Payment` challenge, TIP-20 transfer proof | No |
| Tempo | Prepaid wallet top-up | Wallet-identity account |
| NOWPayments | Prepaid crypto top-up | Wallet-identity account |

Stripe and PayPal exist only for admin operations; agents never see them. The enabled rails are listed in the `rails` field of `/v1/pricing`.

## Earnings for node operators

- Each settled charge is split between the node owner and the platform in integer µUSD. The node share is snapshotted at session start.
- Node share by tier: Probation 25%, Bronze 30%, Silver 35%, Gold 40%, Platinum 45%, Partner 50% (live values in `nodeShare` of `/v1/pricing`).
- Earnings are held 14 days (Probation) down to 3 days (Platinum, Partner) so fraud can be clawed back, then become available credit.
- Available credit can be converted into bandwidth on your own requester wallet (`POST /v1/credits/convert`).
- USDC withdrawals on Base (minimum $1, signed, tier daily limits) are implemented but switched on by the operator. While payouts are disabled the API returns `503 PAYOUTS_DISABLED`.
- Contributor buyer discounts (0% at Probation up to 25% at Partner) are shown in `/v1/pricing` once the operator publishes them.
- Credits never move between users, buyers cannot withdraw prepaid balances, and there is no fiat cash-out.
