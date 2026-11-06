# DomiNode pricing, tiers and payouts: recommendation

## Context: what DESIGN.md says now (§5, §6)

- The seeded split is `node_share_bps = 7000`, so nodes get 70% (`revenue_split_config` seed, DESIGN.md L250). That is above the owner's 50% maximum and needs to come down.
- There is a single placeholder price of $0.20/GB for every IP class (`network_pricing 'any' 200000`, L259).
- Earnings are held for 7 days (`maturation_hours 168`). The design already has the pieces needed here: an internal earnings ledger (`node_credit_*`, with pending and available balances), a maturity job, clawback, and convert-to-wallet. Withdraw currently returns 501 (§6.4).
- New nodes start at reputation 0.3 with a smaller daily GB cap (T5(e)).
- The rollout gate is "≥ 20 healthy nodes in staging for 72 h" (§12 item 3). This is where the owner's point 5 (a smaller test bar before the long soak) applies.

## 1. Price per GB

Confirmed competitor floor:
- DataImpulse residential: $1.00/GB at entry, $0.80/GB at 1 TB. DataImpulse datacenter: $0.50/GB, $0.45/GB at 1 TB. (https://dataimpulse.com/)
- PacketStream: $1.00/GB with a $50 minimum (https://packetstream.io/).
- Webshare residential: $1.40–3.50/GB (https://www.webshare.io/pricing).
- Bright Data: $8/GB, shown as $4/GB during a promo (https://brightdata.com/pricing/proxy-network/residential-proxies).

Recommended prices, with no minimum purchase and credit that never expires:

| Class | Price/GB | vs cheapest confirmed |
|---|---|---|
| Residential / mobile (`residential`) | **$0.50** | 50% below DataImpulse entry, 37% below its 1 TB rate, 50% below PacketStream, about 88% below Bright Data's promo price |
| Datacenter / VPS nodes (`dc`) | **$0.20** | 56% below DataImpulse DC at 1 TB |
| x402 / MPP per-request | the same per-GB price × 10 MB = $0.005 (res) or $0.002 (dc) per request | above the $0.001 CDP fee after the 1,000 free settlements a month (https://docs.cdp.coinbase.com/x402/support/faq) and Stripe MPP's reported $0.01 minimum |

Margin math at $0.50/GB residential:

| Node share | Paid to node per GB | Kept by platform per GB | How the node payment compares |
|---|---|---|---|
| 25% | $0.125 | $0.375 | at or above PacketStream's $0.10 and Honeygain's roughly $0.10–0.20 (blog figure, unverified) |
| 50% | $0.25 | $0.25 | 2.5x PacketStream; half of Proxyrack's $0.50 residential rate (https://help.proxyrack.com/en/articles/9722403-what-is-the-payout-rate-for-the-peer-program) |

- **Costs the platform must cover:** the gateway relays every byte, which means about 2 GB of egress per billed GB. That costs roughly $0.01–0.09 per GB depending on the host, so pick a host with cheap or unmetered bandwidth. Payout gas is about $0.01 per payout on Base. Even at the 50% tier the platform keeps about $0.15–0.23/GB.
- **Datacenter nodes at $0.20/GB:** a node at the top tier earns $0.10/GB, which is double Proxyrack's $0.05 datacenter rate.
- **Undercutting Proxyrack on node pay:** the only way is to price residential at about $1/GB, which would mean matching the market instead of undercutting it. The owner asked for undercutting, so the selling point to nodes is that **AI agents earn more per IP than on Honeygain or PacketStream, paid in USDC with no $20 minimum**, not that DomiNode pays the most per GB.
- **Keep prices in `network_pricing` per class** so the admin can change them. Replace the $0.20 'any' placeholder with the two classes above.

## 2. Tiers

Recalculated daily by a job, per owner (`owner_user_id`), not per node. Every criterion must hold for the entire window. Tiers go up one step at a time and can drop straight down.

| Tier | Node share | Paid tenure (days with ≥1 MB of paid traffic from others) | 30-day uptime | Active IPs (≥1 paid session in the last 7 days) | Quality (reputation) | Maturity hold |
|---|---|---|---|---|---|---|
| Probation | 25% (2500 bps) | 0 | — | ≥1 | ≥0.3 (starting score) | 14 d |
| Bronze | 30% | ≥7 | ≥80% | ≥1 | ≥0.5 | 7 d |
| Silver | 35% | ≥30 | ≥90% | ≥3 | ≥0.6 | 7 d |
| Gold | 40% | ≥60 | ≥93% | ≥10 | ≥0.7 | 5 d |
| Platinum | 45% | ≥90 | ≥95% | ≥25 | ≥0.8 | 3 d |
| Partner | **50% (maximum)** | ≥180 | ≥97% | ≥50 | ≥0.85, and no clawbacks in 90 d | 3 d |

Notes on the table:
- **Volume pays on its own, separately from tier.** An agent with 100 IPs earns about 100x what an agent with 1 IP earns at the same tier, and the IP-count criterion then gives it a higher share as well. The tenure path alone tops out at Silver, because Gold and above need 10 or more active IPs. That is the owner's "more IPs → more money".
- **Tenure-only route (optional).** If a single-IP agent should be able to climb on tenure alone, allow Bronze to Gold on tenure with 1 IP, and require IPs only for Platinum and Partner. The trade-off: tenure is the cheapest criterion to farm.
- **Lock the tier at session start.** The share is snapshotted at `startSession` (§6.3 step 4), so a tier change in the middle of a session does not reprice it.

Anti-gaming rules:
1. **Count only paid traffic from other principals.** "Active IP" and "tenure day" count only traffic from other principals that has matured and was not disputed. This reuses T5(c) and the self-dealing check, so an agent cannot buy traffic to its own nodes to climb tiers.
2. **Count distinct IPs only.** An IP counts only if it is a distinct observed /32 within the existing per-/32, /24 and ASN caps (default 2 per /32). It also needs at least 3 distinct paying requesters in the window. That stops one buyer from keeping a farm of IPs "active".
3. **Uptime comes from the gateway, not the node.** Measure it from tunnel PING/liveness at the gateway. The node's own reports never count (principle 3).
4. **Aggregate tier inputs per beneficial owner.** Sum them across agents linked by the same payout wallet, funding source or team. Splitting IPs across many accounts then gains nothing, and a cluster gets one tier, not many.
5. **Demote on quality, with a short grace period.**
   - A clawback, a failed canary or a dispute rate above the threshold drops the owner straight to Probation and resets the tenure counter.
   - An uptime miss drops one tier, with a 3-day grace period. A short outage should not wipe out months of standing.
6. **Make the formula public but keep canaries secret.** Publish the tier formula through `GET /v1/node/tier`, which returns the current tier, progress to the next tier, and the reason for any demotion. That gives agents a clear target. Canary detection stays secret.

Schema changes needed:
- Add a `node_tiers` config table (append-only, like `revenue_split_config`).
- Add `owner_tier` and `tier_since` per owner.
- `relay_charges.node_share_bps` already stores the snapshotted share. Add a `tier_id` column next to it.

## 3. Payout flow: off-chain ledger, then on-chain USDC

The owner asked whether to pay on-chain directly or use a credit system. The answer is both: earnings are tracked as credits, and money leaves only as on-chain USDC. Paying directly on-chain per GB is not recommended. Every transfer would pay gas, and fraudulent traffic could not be reversed once paid (see Mysterium's settlement failures, https://github.com/mysteriumnetwork/node/issues/4631, and Helium's spoofing history, https://www.github.com/helium/HIP/blob/main/0066-trust-score-and-denylist-convenience.md). The off-chain ledger plus payout above a threshold is the pattern every surviving network uses: Honeygain (https://www.honeygain.com/honeygain-payout), Mysterium and Proxyrack.

1. **Earn.** Each charge credits the node's ledger as `pending_musd` (this already exists). Credits cannot be transferred between users.
2. **Maturity hold.** The hold depends on the tier (14, 7, 5 or 3 days, from the table above). Clawback works during the hold. Pending credit moves to available when the hold ends.
3. **Automatic push payout.** Recommended: daily (or weekly) USDC transfers on **Base** to the payout wallet registered at signup, once available credit is at least **$1**.
   - The platform pays the gas, about $0.01 per payout. That is 1% of a $1 payout, an acceptable cost, and it means the agent never has to sign a claim or hold gas (agent-payments notes, §5).
   - A push needs no action from the agent. A claim flow needs signing and gas on the agent's side and can fail.
   - Batch the day's payouts through one disperse/multicall transaction. The savings from batching are unconfirmed, so measure them.
   - On Solana, the first USDC payout to a new address locks about $0.17 of SOL as rent, so use Base. Add Tempo as a second option once its fees are confirmed.
4. **On-demand withdrawal.** Add a `POST /v1/credits/withdraw` endpoint and an MCP tool, replacing the current 501.
   - Minimum $1. Requires a fresh wallet signature.
   - Idempotency key, and the payout row is written in the same transaction as the ledger debit.
   - A `withdraw_reversal` transaction is written if the on-chain transfer fails.
5. **Auto-spend option.** A per-agent setting such as `auto_convert_pct`. Matured credit then converts automatically into the agent's requester wallet, using the existing `convert` path. This suits an agent that both supplies and buys bandwidth, and costs no gas. The self-dealing rule still applies: an agent's spend on its own nodes earns nothing.
6. **OFAC screening of payout wallets.**
   - Screen the wallet against the SDN list (directly, or via Chainalysis, TRM or Elliptic) when it is registered and again before every payout.
   - Refuse IP supply that geolocates to Cuba, Iran, North Korea, Russia, Syria, Crimea or the DNR/LNR regions, not only payouts to those places.
   - A wallet that hits the list is frozen, and the case goes to an admin.
7. **Limits.**
   - Withdrawals per owner: Probation $50/day, rising to $5,000/day for Partner. The amount still fits the existing `amountCents ≤ 2,147,483,647` check.
   - Global daily treasury cap with an alert.
   - Changing the payout wallet needs a signature from the old wallet plus a 72-hour cooldown.
   - All payouts come from the platform treasury, which is kept separate from customer prepaid balances.
8. **Tax.** Track cumulative payouts per beneficial owner per calendar year. At **$1,500**, ask for a W-9 or W-8BEN. Withhold payouts above **$2,000** until the form is received. $2,000 is the 1099-NEC threshold for 2026 payments (https://sovos.com/regulatory-updates/trr/one-big-beautiful-bill-raises-1099-reporting-thresholds/). Small agents never see any of this.

## 4. Regulatory caveats in plain language (not legal advice)

- **Our structure:** we sell bandwidth, then pay our suppliers (the nodes) from our own money. That is generally not money transmission. It becomes risky if we hold balances that users can move, convert or send to each other (Cozen, https://www.cozen.com/news-resources/publications/2025/stablecoins-navigating-the-money-transmitter-minefield).
- **Hard rules that follow from that:**
  - Credits never move between users.
  - Buyers can never withdraw their prepaid balance.
  - We never cash out to fiat for anyone.
  - A specific buyer's payment is never routed straight through to a node.
- **Pay in USDC, not a token of our own.** A native token raises the securities question (Howey). USDC is also likely to stay allowed under the GENIUS Act from 2028 (the July 2028 date is unconfirmed) (https://www.jonesday.com/en/insights/2026/08/us-treasury-proposes-genius-act-rules-for-stablecoin-issuance-offer-and-sale).
- **EU:** paying out of our own treasury is probably outside MiCA's transfer-service (CASP) scope. Holding balances that clients can withdraw is not (https://www.esma.europa.eu/print/pdf/node/206847). DAC7 marketplace reporting (30 sales or EUR 2,000 a year) may apply to EU nodes; this is unverified.
- **OFAC is strict liability:** we are liable even without intent, so screening wallets and node geolocation is required.
- **Needs counsel before withdrawals go live:** state money-transmitter exemptions, DAC7/DAC8, and whether automated agents with no identified owner can even be issued 1099s.

## 5. Changes to DESIGN.md

1. **§5, seed split:** change the 7000 bps seed to the tier table (`node_tiers`), with Probation at 2500 and a `CHECK (node_share_bps BETWEEN 0 AND 5000)` hard ceiling for the owner's 50/50 maximum. Make `maturation_hours` depend on the tier.
2. **§5, pricing:** replace the 'any' $0.20 placeholder with `residential` 500000 µUSD ($0.50) and `dc` 200000 µUSD ($0.20). The existing $0.001–$5 CHECK is fine.
3. **§6.3:** step 4 also locks `tier_id`. In step 6, the maturity date comes from the tier's hold.
4. **§6.4:** add a daily tier job and a daily payout job.
   - The payout job uses `FOR UPDATE SKIP LOCKED LIMIT 1000` and runs OFAC screening, then a batched Base USDC send, then marks the payout confirmed or reversed.
   - Implement withdraw (no longer 501) with the limits above.
   - Add the `auto_convert_pct` setting.
   - New tables: `payout_wallets` (with screening status and wallet-change cooldown) and `node_payouts` (`tx_hash`, status, `UNIQUE` idempotency key, CHECKs with both floor and ceiling).
5. **§1 T5:** add the beneficial-owner aggregation and the "≥3 distinct paying requesters per active IP" rule. Make hold length depend on tier.
6. **§10 endpoints:** add `GET /v1/node/tier`, `GET /v1/credits`, `POST /v1/credits/withdraw` and `PUT /v1/payout-wallet`, plus the matching MCP tools.
7. **§12 item 3 / §14 (owner's point 5):** add a short smoke gate before the 72-hour soak: at least 3 healthy nodes for 2 hours in staging, plus one full earn → mature → withdraw cycle. To make that testable, staging needs `maturation_hours = 0` and a $0.10 minimum payout on Base Sepolia (the testnet). Keep "≥ 20 nodes for 72 h" as the production gate.

All of this is from reading `/home/user/DomiNode/docs/agent-network/DESIGN.md`; no files were changed.