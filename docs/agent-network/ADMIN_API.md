# Admin Control Panel API (`/api/admin/network`)

Operator API for the agent relay network admin panel. Source:
`packages/dashboard/src/routes/admin-network.ts` (policy, pricing, split, tiers, unfreeze),
`admin-network-metrics.ts` (overview, revenue, geo, health, audit) and
`admin-network-ops.ts` (nodes, agents, credits, payouts, disputes, abuse log).

## Conventions

- **Auth**: every route requires an authenticated session (`requireAuth`: bearer access token or auth cookie) **and** `admin_role` ≥ `admin` (`requireAdmin`). Otherwise `401` / `403`.
- **Writes** (`POST`/`PUT`) run in one transaction that re-checks the caller's role `FOR UPDATE` (`403 {"error":"Admin access required"}` if revoked mid-session) and write an `audit_events` row in that same transaction.
- **Errors**: `{ "error": string }` with status `400` (validation), `403`, `404`, `409` (state conflict) or `500` (`"<Operation> failed"`, no internal details).
- **Money** is always a `Money` object: µUSD (1 USD = 1,000,000 µUSD) as an integer string, plus USD as a decimal string with exactly 6 decimals.
  ```ts
  type Money = { musd: string; usd: string };   // { "musd": "1500000", "usd": "1.500000" }
  ```
- **Bytes** are integer strings (`"2000000000"`); fields named `gb…` are decimal strings in GB (10^9 bytes) with 6 decimals (`"2.000000"`).
- **Timestamps** are ISO 8601 strings (UTC). Days (`YYYY-MM-DD`) are UTC days.
- **Pagination** (all list endpoints): `limit` integer 1–200 (default 50 unless stated), `offset` integer 0–100000 (default 0). Out of range → `400`. List responses have `{ limit, offset, total, items }`; `total` is the total match count.
- **Booleans** in query strings are `true` / `false` exactly. UUID params must be valid UUIDs. Unknown enum values → `400`.
- **Period** (`period` query param, where noted): `24h | 7d | 30d | 90d | all`, default `30d`.
- **Online**: a node is online while its gateway slot heartbeat (`node_ip_slots`) is under 90 s old.
- **Never returned**: `nodes.node_key_hash`, `nodes.floor_hash`, API key hashes, password hashes, `payout_wallets.change_sig` / any payout signer data, `node_payouts.idempotency_key`, `relay_settle_retries.payload`, any request URL/path/payload (the abuse log is metadata only).

Shared types used below:

```ts
type Rail = "wallet" | "team" | "agentic_wallet" | "x402" | "mpp" | "free";
type IpClass = "residential" | "dc" | "mobile" | "unknown";
type NodeStatus = "pending" | "active" | "cooldown" | "quarantined" | "suspended" | "revoked";
type PayoutStatus = "pending" | "held_tax" | "held_frozen" | "submitted" | "confirmed" | "failed" | "reversed";
type DisputeStatus = "open" | "resolved_gateway" | "resolved_node" | "dismissed";

type RevenueAcc = { gross: Money; platform: Money; node: Money; bytes: string; gb: string; charges: number };

type Node = {
  id: string; ownerUserId: string; ownerWallet: string; nodePubkey: string | null; status: NodeStatus;
  attestationVersion: number; observedIp: string | null; ipPrefix: string | null /* "1.2.3.0/24" or IPv6 /48 */;
  asn: number | null; country: string | null /* ISO alpha-2 */; ipClass: IpClass | null;
  maxStreams: number; maxGbDay: number; reputation: number /* 0..10000 */; byteDisputes: number;
  agentVersion: string | null; lastSeenAt: string | null; createdAt: string; online: boolean;
};

type Payout = {
  id: string; userId: string | null; email: string | null; amount: Money; trigger: "auto" | "on_demand";
  status: PayoutStatus; batchId: string | null; txHash: string | null; failureReason: string | null;
  createdAt: string; updatedAt: string;
  payoutWallet: { address: string; chain: "base" | "base-sepolia"; status: "pending" | "active" | "superseded" | "blocked" } | null;
};
```

---

## 1. `GET /overview`

Headline metrics. No params.

```ts
{
  generatedAt: string;
  nodes: {
    total: number; online: number;
    byStatus: Record<NodeStatus, { total: number; online: number }>;   // every status present, zeros included
    quarantined: number;
    uniquePrefixesOnline: number;   // distinct /24 (IPv6 /48) among online nodes
    uniqueAsnsOnline: number;
  };
  agents: {
    requestersActive24h: number; requestersActive7d: number; requestersActive30d: number;  // distinct payers in relay_charges
    nodeOwners: number;                 // owners with ≥1 non-revoked node
    nodeOwnersWithActiveNode: number;
  };
  traffic: Record<"24h" | "7d" | "30d" | "all", {
    bytes: string; gb: string; charges: number;
    gross: Money; platform: Money; node: Money;     // node = node owners' share
  }>;
  credits: {
    accounts: number; frozenAccounts: number;
    pending: Money;          // sum of node_credit_accounts.pending_musd (not yet matured)
    available: Money;        // sum of available_musd (withdrawable/convertible)
    frozenBalance: Money;    // pending + available in frozen accounts
  };
  payouts: {                 // each { count: number; amount: Money }
    pending; heldTax; heldFrozen; submitted;          // current backlog (all time)
    confirmed30d; failed30d; reversed30d;             // updated in the last 30 days
  };
  disputes: { open: number; nodesWithOpen: number };
}
```

## 2. Revenue

### `GET /revenue`

| Param | Type | Default | Notes |
|---|---|---|---|
| `bucket` | `hour \| day \| week` | `day` | UTC `date_trunc`; weeks start Monday. |
| `from` | ISO timestamp | `to` − 30 days (`hour`: − 2 days) | inclusive |
| `to` | ISO timestamp | now | exclusive |

Max range: `hour` 31 days, `day` 366 days, `week` 1098 days → otherwise `400`. `from >= to` → `400`.

```ts
{
  from: string; to: string; bucket: "hour" | "day" | "week";
  series: Array<RevenueAcc & {
    t: string;                               // bucket start (ISO). Only buckets with charges are present (sparse).
    byRail: Record<Rail, RevenueAcc>;        // all 6 rails present (zeros included)
    byClass: Record<IpClass, RevenueAcc>;    // all 4 classes; charges whose node is gone/unclassified count as "unknown"
  }>;                                        // ascending by t
  totals: RevenueAcc & { byRail: Record<Rail, RevenueAcc>; byClass: Record<IpClass, RevenueAcc> };
}
```
`gross = platform + node` for every accumulator.

### `GET /revenue/top-requesters`

Params: `period` (default `30d`), `limit` (default **20**), `offset`. Sorted by gross desc.

```ts
{ period; limit; offset; total;
  items: Array<{ userId: string; email: string | null; walletAddress: string | null;
    gross: Money; platform: Money; node: Money; bytes: string; gb: string; charges: number; lastChargeAt: string }> }
```

### `GET /revenue/top-node-owners`

Params: `period` (default `30d`), `limit` (default **20**), `offset`. Sorted by `earnings` desc.

```ts
{ period; limit; offset; total;
  items: Array<{ userId: string; email: string | null; walletAddress: string | null; tier: string | null;
    earnings: Money /* node share */; gross: Money; platform: Money; bytes: string; gb: string;
    charges: number; nodesWithTraffic: number }> }
```

## 3. Nodes

### `GET /nodes`

| Param | Type | Notes |
|---|---|---|
| `status` | NodeStatus | |
| `country` | 2 letters | case-insensitive |
| `asn` | integer 0–4294967295 | |
| `ip_class` | IpClass | NULL class matches `unknown` |
| `owner` | UUID | owner user id |
| `online` | boolean | |
| `quarantined` | boolean | `true` ≡ `status=quarantined`; `false` excludes them |
| `search` | string ≤100 | case-insensitive substring of node id, owner wallet, observed IP, agent version |
| `sort` | `reputation \| bytes \| last_seen \| created` | default `created`; `bytes` = last 30 days |
| `order` | `asc \| desc` | default `desc` (NULLs last) |
| `limit`, `offset` | | |

```ts
{ limit; offset; total;
  items: Array<Node & { ownerEmail: string | null; bytesToday: string; gbToday: string;
    bytes30d: string; gb30d: string; openDisputes: number }> }
```

### `GET /nodes/:id`

`404` if unknown, `400` if not a UUID.

```ts
{
  node: Node & { ownerEmail: string | null; ownerStatus: "active" | "suspended" | "deleted" | null; ownerTier: string | null };
  dailyStats: Array<{ day: string; bytes: string; gb: string; streams: number; failures: number; burns: number }>;  // ≤90 days, newest first
  reputationByTarget: Array<{ target: string /* eTLD+1 */; okCount: number; burnCount: number; cooldownUntil: string | null }>; // top 50 by burns
  disputes: Array<{ id: string; relayChargeId: string | null; bytesGateway: string; bytesNode: string;
    status: DisputeStatus; createdAt: string; resolvedAt: string | null }>;          // latest 50
  chargesDaily: Array<{ day: string; gross: Money; node: Money; platform: Money; bytes: string; gb: string;
    charges: number; requesters: number }>;                                         // last 30 days, newest first
  chargesByRail30d: Array<{ rail: Rail; gross: Money; node: Money; bytes: string; gb: string;
    charges: number; disputed: number; zeroShare: number /* charges with node share zeroed */ }>;
  adminActions: Array<{ id: string; adminUserId: string | null; action: string; details: object; createdAt: string }>; // latest 50
}
```
Reputation is stored as a current score (`node.reputation`) plus per-target counters; there is no score history table. Use `dailyStats` (failures/burns) and `adminActions` for trend.

### Node actions

| Route | Body | Allowed from | To |
|---|---|---|---|
| `POST /nodes/:id/quarantine` | `{ reason: string }` (required, 1–500 printable chars) | pending, active, cooldown, suspended | quarantined |
| `POST /nodes/:id/activate` | `{ reason?: string }` | pending, cooldown, quarantined, suspended (owner must be `active`) | active |
| `POST /nodes/:id/revoke` | `{ reason: string }` (required) | any non-revoked (terminal) | revoked |
| `POST /nodes/:id/clear-penalty` | `{ reason: string }` (required) | revoked by its owner while quarantined or suspended | revoked (penalty cleared) |

Response `200`:
```ts
{ nodeId: string; previousStatus: NodeStatus; status: NodeStatus; changed: boolean; gatewayEffect: "within_sync_interval" }
```
`changed: false` when already in the target status (no audit row). Invalid transition or inactive owner → `409`. Unknown node → `404`.
Audit actions: `node_quarantine`, `node_activate`, `node_revoke` (details `{ from, to, reason }`).
`clear-penalty` clears `nodes.revoked_from_status`, so the node no longer blocks
its owner's registrations (`NODE_PENALTY_ACTIVE`); use it after a false-positive
quarantine. Response `{ nodeId, status: "revoked", previousRevokedFrom, changed: true }`;
`409` when the node carries no revocation penalty. Audit action
`node_penalty_clear` (details `{ revokedFrom, reason }`).
Gateway effect: each gateway's `node-status-sync` job (every 30 s, `NODE_STATUS_SYNC_INTERVAL_MS`) stops routing to any node not `active` and closes the tunnel of revoked, suspended or deleted nodes. Quarantined nodes stay connected but get no traffic.

## 4. Agents

Agents are users who have paid for relay traffic, own a node or have a node credit account.

```ts
type Agent = {
  userId: string; email: string | null; walletAddress: string | null; status: "active" | "suspended" | "deleted";
  createdAt: string; tier: string | null; tierId: number | null;
  isRequester: boolean; isNodeOwner: boolean;   // isNodeOwner: ≥1 non-revoked node
  spend: Money; spend30d: Money; bytesRequested: string; gbRequested: string; lastRequestAt: string | null;
  earnings: Money; earnings30d: Money;           // node share across all owned nodes
  nodes: number /* non-revoked */; activeNodes: number; onlineNodes: number;
  credits: { pending: Money; available: Money; frozen: boolean };
  walletBalance: Money | null;                   // requester USD wallet (cents × 10,000 µUSD)
};
```

### `GET /agents`

| Param | Type | Notes |
|---|---|---|
| `role` | `requester \| node_owner` | |
| `frozen` | boolean | credit account frozen |
| `status` | `active \| suspended \| deleted` | user status |
| `tier` | integer 1–100 | node tier id |
| `search` | string ≤100 | substring of email, wallet address, user id (case-insensitive) |
| `sort` | `spend \| spend_30d \| earnings \| earnings_30d \| nodes \| created \| last_request` | default `spend` |
| `order` | `asc \| desc` | default `desc` |
| `limit`, `offset` | | |

Response: `{ limit; offset; total; items: Agent[] }`.

### `GET /agents/:id`

`404` if the user is not an agent.

```ts
{
  agent: Agent;
  creditAccount: { autoConvertPct: number; taxFormStatus: "not_required" | "requested" | "received" | "rejected";
    taxFormType: "W-9" | "W-8BEN" | "W-8BEN-E" | null; taxYear: number | null; ytdPaid: Money; updatedAt: string } | null;
  nodes: Node[];                         // ≤100, newest first
  recentPayouts: Payout[];               // ≤20
  recentCreditTransactions: Array<{ id: string; type: "earn" | "mature" | "clawback" | "convert_to_wallet" | "withdraw" | "withdraw_reversal";
    amount: Money; relayChargeId: string | null; externalRef: string | null; createdBy: string | null; createdAt: string }>; // ≤50
  spendByRail30d: Array<{ rail: Rail; gross: Money; bytes: string; gb: string; charges: number }>;
}
```

## 5. `GET /network/geo`

Params: `period` (traffic window, default `30d`). Node counts are current.

```ts
{
  period;
  byCountry: Array<{ country: string /* ISO alpha-2, or "unknown" */; nodes: number /* non-revoked */; activeNodes: number;
    onlineNodes: number; bytes: string; gb: string; gross: Money; nodeEarnings: Money }>;   // all countries, by bytes desc
  byAsn: Array<{ asn: number | null; nodes; activeNodes; onlineNodes; bytes; gb; gross; nodeEarnings }>; // top 100 by bytes
}
```

## 6. Credits and payouts

### `GET /credits/accounts`

Params: `frozen` (boolean), `userId` (UUID), `sort` = `available | pending | updated` (default `available`, always desc), `limit`, `offset`.

```ts
{ limit; offset; total;
  items: Array<{ userId: string; email: string | null; walletAddress: string | null; pending: Money; available: Money;
    frozen: boolean; autoConvertPct: number; taxFormStatus: string; ytdPaid: Money;
    heldPayouts: Money /* held_tax + held_frozen payouts */; updatedAt: string }> }
```

### `POST /accounts/:userId/freeze`

Body `{ reason: string }` (required, 1–500). Freezes the node credit account (creating it if absent): maturity stops moving credits to available, and `pending` payouts become `held_frozen`. `404` if the user does not exist.
Response: `{ userId: string; frozen: true; wasFrozen: boolean; heldPayouts: number }`. Audit: `node_credit_freeze`.

### `POST /accounts/:userId/unfreeze` (existing)

Body `{ payouts: "release" | "reverse" }`. Response `{ userId; mode; wasFrozen: boolean; payouts: number; musd: string }`. Audit: `node_credit_unfreeze`.

### `GET /payouts`

Params: `status` (PayoutStatus), `userId` (UUID), `from` / `to` (created_at range), `limit`, `offset`. Newest first.

Response: `{ limit; offset; total; totalAmount: Money /* sum over all matches */; items: Payout[] }`.

### `POST /payouts/:id/reverse`

Body `{ reason: string }` (required, 1–200). Reverses a `pending`, `held_tax`, `held_frozen` or `failed` payout and re-credits the amount to the user's available credits (`payoutRepo.markPayoutReversed`, stored reason `"admin: <reason>"`). Idempotent on an already reversed payout.
`404` unknown payout. `409` when `submitted` or `confirmed`.
Response: `{ id: string; userId: string | null; status: "reversed"; amount: Money; txHash: string | null }`. Audit: `node_payout_reverse`.

## 7. Byte disputes

### `GET /disputes`

Params: `status` (DisputeStatus), `nodeId` (UUID), `limit`, `offset`. Newest first.

```ts
{ limit; offset; total;
  items: Array<{ id: string /* bigint as string */; relayChargeId: string | null; nodeId: string | null;
    nodeOwnerUserId: string | null; requesterUserId: string | null; paymentRail: Rail | null;
    bytesGateway: string; bytesNode: string; bytesDiff: string; diffBps: number | null /* |diff|/gateway × 10000 */;
    gross: Money | null; nodeShare: Money | null; status: DisputeStatus; createdAt: string; resolvedAt: string | null }> }
```

### `POST /disputes/:id/resolve`

Body `{ resolution: "resolved_gateway" | "resolved_node" | "dismissed"; reason?: string (≤500) }`. Only `open` disputes (`409` otherwise, `404` unknown).
- `resolved_gateway` / `dismissed`: the linked charge's `disputed` flag is cleared (if no other open dispute on it), so its node share can mature.
- `resolved_node`: in the same transaction the charge is re-split at the node's (lower) byte count: gross, node share, platform share and discount scale by `bytes_node / bytes_gateway` (floored); the node share difference is clawed back from the owner's pending credit; the requester gets the gross difference back in whole cents on the personal-wallet rail (over the $10,000 cap: `wallet_overflow_credits`; other rails: reported as `unrefundedMusd` for a manual refund). The charge is then released like `resolved_gateway`.

Response: `{ id: string; status: string; relayChargeId: string | null; chargeReleased: boolean; adjustment: { grossBefore, grossAfter, nodeClawbackMusd, refundCents, overflowCents, unrefundedMusd } | null }`. Audit: `byte_dispute_resolve`.

## 8. `GET /abuse-log`

Metadata only (host, port, bytes). Each call writes an audit row (`relay_abuse_log_access`) in the same transaction as the read.

| Param | Type | Notes |
|---|---|---|
| `nodeId` | UUID | |
| `requesterId` | UUID | |
| `host` | hostname/IP ≤253 | exact match, case-insensitive |
| `from` | ISO | default `to` − 24 h |
| `to` | ISO | default now |
| `limit`, `offset` | | |

The window must be ≤31 days (`400` otherwise). Rows older than the retention (min of 90 days and `policy.logRetentionDays`) are never returned.

```ts
{ from: string; to: string; retentionDays: number; limit; offset; total;
  items: Array<{ id: string; ts: string; sessionId: string; requesterUserId: string; nodeId: string;
    destHost: string; destPort: number; bytes: string }> }
```

## 9. `GET /health`

```ts
{
  generatedAt: string;
  jobs: Array<{
    name: string;  // node-status-sync, relay-settle-retry, reputation-flush, probes, maturity, retention, tiers, payouts
    instanceId: string | null; lastStartedAt: string | null; lastFinishedAt: string | null;
    lastOk: boolean | null; lastError: string | null; lastDurationMs: number | null; lastSuccessAt: string | null;
    runCount: number; failCount: number; expectedIntervalMs: number | null;
    stale: boolean;   // no run within 3 × expected interval (or never ran)
  }>;
  settleRetryQueue: { pending: number; due: number; dead: number; oldestPendingAt: string | null; maxAttempts: number };
  gateway: { liveInstances: number; connectedNodes: number; lastHeartbeatAt: string | null };
  dbPool: { total: number | null; idle: number | null; waiting: number | null };   // this API process's pool
}
```
Heartbeats come from the `job_runs` table, upserted by the gateway job runner after every run (ticks skipped because another instance holds the job's lock are not recorded). Expected intervals are the defaults; a deployment that overrides an interval env var may show `stale` early. `probes` only runs when `PROBE_URL` is set and `payouts` only when `PAYOUTS_ENABLED=true`, so those can show `stale: true` with no runs.

## 10. `GET /audit`

| Param | Type | Notes |
|---|---|---|
| `action` | one of the actions below | default: all of them |
| `adminUserId` | UUID | |
| `resourceId` | string ≤128 | node id, user id, payout id, dispute id… |
| `from`, `to` | ISO | |
| `limit`, `offset` | | |

Actions: `node_credit_unfreeze`, `node_credit_freeze`, `node_quarantine`, `node_activate`, `node_revoke`, `node_penalty_clear`, `node_payout_reverse`, `byte_dispute_resolve`, `relay_abuse_log_access`, `network_policy_publish`, `network_pricing_update`, `revenue_split_append`, `node_tier_update`, `node_credit_auto_freeze` (written by the collusion job, `adminUserId` null), `collusion_flag_dismiss`, `collusion_flag_confirm`, `collusion_settings_update`, plus the legacy `/api/admin` actions listed in section 15.

```ts
{ limit; offset; total;
  items: Array<{ id: string; adminUserId: string | null; adminEmail: string | null; action: string; resource: string;
    resourceId: string | null; ipAddress: string | null; details: object; createdAt: string }> }
```
Policy, pricing, split and tier edits write `network_policy_publish` (resource id = new version), `network_pricing_update` (ip class), `revenue_split_append` (split row id) and `node_tier_update` (tier id, details `{ changes }`) in the same transaction as the write.

## 11. Configuration endpoints (existing, `admin-network.ts`)

| Route | Body | Response |
|---|---|---|
| `GET /policy` | – | `{ version, sha256, body, createdAt }` |
| `PUT /policy` | policy JSON | `{ version, sha256, body, previousVersion, attestationRaised }` (`400 { error, details[] }` if invalid) |
| `GET /pricing` | – | `{ pricing: [{ ipClass, pricePerGbMusd: string, updatedAt }] }` |
| `PUT /pricing` | `{ ipClass: "any"\|"residential"\|"dc"\|"mobile", pricePerGbMusd: int\|string (1000–5000000) }` | `{ ipClass, pricePerGbMusd, updatedAt }` |
| `GET /split` | – | `{ current, history: [{ id, nodeShareBps, maturationHours, effectiveFrom, note, createdAt }] }` |
| `POST /split` | `{ nodeShareBps 0–5000, maturationHours 0–2160, effectiveFrom?, note? }` | `201 { id, nodeShareBps, maturationHours, effectiveFrom, note }` |
| `GET /tiers` | – | `{ tiers: [...tier, dailyWithdrawLimitMusd: string] }` |
| `PUT /tiers/:id` | any of `nodeShareBps, minTenureDays, minUptimeBps, minActiveIps, minReputation, noClawbackDays, holdDays, maxNodes, dailyWithdrawLimitMusd` | `{ tier }` |

These keep their original µUSD-string fields (`pricePerGbMusd`, `dailyWithdrawLimitMusd`) rather than `Money` objects.

## 12. Collusion flags (`admin-network-collusion.ts`)

The daily `collusion` gateway job (advisory lock, pages of 1000) flags:

- `concentration`: one requester carries >= `concentrationBps` of a node's counted paid volume (window `windowDays`, node volume >= `minNodeVolumeMusd`).
- `cluster`: at most `clusterSize` requesters carry >= `clusterBps`.
- `circular`: two owners each bought >= `circularMinMusd` from the other's nodes (one flag per owner, the other as requester; `shareBps` = balance of the two flows).

Counted traffic: `relay_charges` with gross > 0, not disputed, requester present and not the node owner. One open flag per (kind, owner, node, requester); re-detection refreshes it, and a flag dismissed within the window is not re-opened. With `autoFreeze` on (default **off**), a finding with share >= `freezeBps` and volume >= `freezeMinVolumeMusd` freezes the owner's node-credit account (same as `POST /accounts/:userId/freeze`) once per flag and writes `node_credit_auto_freeze`. Unfreeze with `POST /accounts/:userId/unfreeze`.

| Route | Body / params | Response |
|---|---|---|
| `GET /collusion/flags` | `status` (open\|dismissed\|confirmed, default open), `kind`, `ownerUserId`, `limit`, `offset` | `{ limit, offset, total, items: [{ id, kind, ownerUserId, ownerEmail, nodeId, requesterUserId, requesterEmail, shareBps, volume: Money, total: Money, windowDays, status, autoFrozen, ownerCreditsFrozen, resolvedBy, resolutionNote, firstSeenAt, lastSeenAt, resolvedAt }] }` |
| `POST /collusion/flags/:id/dismiss` | `{ note? }` (<= 500) | `{ id, status: "dismissed" }`; 404 if not open |
| `POST /collusion/flags/:id/confirm` | `{ note? }` | `{ id, status: "confirmed" }` (does not freeze; use the freeze route) |
| `GET /collusion/settings` | – | `{ windowDays, minNodeVolume: Money, concentrationBps, clusterSize, clusterBps, circularMin: Money, autoFreeze, freezeBps, freezeMinVolume: Money, updatedBy, updatedAt }` |
| `PUT /collusion/settings` | any of `windowDays 1–90, concentrationBps, clusterBps, freezeBps 1–10000, clusterSize 2–20, autoFreeze bool, minNodeVolumeMusd, circularMinMusd, freezeMinVolumeMusd` (digit strings) | same as GET |

The thresholds live in `collusion_settings`, not in the public `/v1/policy`, so they are not published to the parties being measured.

## 13. Configuration additions

- `PUT /tiers/:id` also accepts `buyerDiscountBps` (0–5000): the discount this tier gets when it **buys** relay bandwidth (see ECONOMICS.md §6). `GET /tiers` returns it.
- The network policy (`PUT /policy`) has three new keys: `requireContribution` (bool, default `false`), `contributionWindowDays` (1–365, default 30) and `allowAnonymousPayers` (bool, default `true`). See ECONOMICS.md §8.

## 14. Launch controls (`admin-network-launch.ts`)

All mutations re-check the admin role `FOR UPDATE` in one transaction and write an `audit_events` row (actions in brackets). Singleton settings use PATCH semantics on `PUT`: send only the fields you change; unknown fields are `400`. µUSD values are digit strings.

### Seed nodes
| Endpoint | Notes |
|---|---|
| `POST /nodes/:id/operator-run {operatorRun: bool, reason?}` | Flags an operator-run seed node (`node_operator_run_set`). The gateway picks it up on the node's next tunnel reconnect. |
| `GET /seed-summary` | `{seed, community}` each `{total, online, countries, asns, paidBytes24h, paid24h, paidBytes30d, paid30d}`. |

### Starter credits
| Endpoint | Notes |
|---|---|
| `GET /starter-credits/settings` | Settings plus `grantedToday {count, amount}`. |
| `PUT /starter-credits/settings` | `enabled`, `amountMusd` (whole cents, 10000–100000000), `dailyBudgetMusd`, `perPrefixCap`, `perFundingSourceCap` (0–1000), `capWindowDays` (1–3650), `expiryDays` (1–365), `seedNodesOnly`, `seedOnlyDays` (0–365), `requireFunding` (prior Base tx or paid top-up), `minTopupCents` (1–100000) (`starter_credit_settings_update`). GET also returns `rpcConfigured`. |
| `GET /starter-credits/grants?status=&userId=&limit=&offset=` | Grants with remaining amount, /24 prefix and expiry. |
| `POST /starter-credits/grants/:id/revoke {reason}` | Closes an active grant and removes the unused remainder from the wallet, never below 0 (`starter_credit_revoke`). |

### Referrals

| Endpoint | Notes |
|---|---|
| `GET /referrals/settings` / `PUT /referrals/settings` | `redemptionEnabled` (default false). When on, a referral code given at signup is recorded (redemption row + affiliate link) and no signup bonus is credited to either side. The affiliate link does pay the referrer a commission on the referee's later paid top-ups (`recordAffiliateCommission`, a share of money actually paid in). Free credit comes only from starter credits (`referral_settings_update`). |

### Genesis boost and buyer discounts
| Endpoint | Notes |
|---|---|
| `GET /genesis/settings` / `PUT /genesis/settings` | `enabled`, `maxOwners` (0–100000), `bonusBps` (0–5000), `boostDays` (1–3650), `creditMusd` (0–1e9), `creditThresholdBytes`, `minDistinctPayers` (1–1000, default 3: distinct unlinked paying principals required to enter the cohort), `minPayerSpendMusd` (default 1000000: paid spend each of those payers needs), `creditThresholdNodeMusd` (default 10000000: matured node earnings from qualifying payers needed for the credit). Seeded `enabled: false` (`genesis_settings_update`). |
| `GET /genesis/members?limit=&offset=` | Cohort in enrolment order with `boostUntil`, `creditStatus` (`pending|held|matured|clawed_back`) and qualifying matured bytes. |
| `POST /genesis/members/:userId/clawback {reason}` | Claws back a still-held genesis credit from pending (`genesis_credit_clawback`). |
| `GET /buyer-discounts/settings` / `PUT /buyer-discounts/settings` | `enabled`, `minPlatformMarginBps` (0–10000, default 2500) (`buyer_discount_settings_update`). |

### Status, demand, abuse, contribution
| Endpoint | Notes |
|---|---|
| `GET /announcements` / `POST /announcements {title, body?, category?, url?, published?, publishedAt?}` / `PATCH /announcements/:id` / `DELETE /announcements/:id` | Agent news feed. `category ∈ policy|pricing|payments|api|network|news`, `url` https only; drafts (`published: false`) stay private (`announcement_create`, `announcement_update`, `announcement_delete`). Public at `/v1/announcements`. |
| `GET /incidents` / `POST /incidents {title, body?, severity, status?, startedAt?}` / `PATCH /incidents/:id` | `severity ∈ minor|major|critical|maintenance`, `status ∈ investigating|identified|monitoring|resolved`; `resolved` stamps `resolved_at` (`network_incident_create`, `network_incident_update`). Public at `/v1/network/incidents` and `/status`. |
| `GET /unmet-demand?days=7` | `{groups: [{country, ipClass, requests, lastHour}], daily: [{day, requests}]}`; `null` country/class means "any". No requester ids or hosts exist in the table. |
| `GET /abuse-reports?status=` | Public reports with `matches {sessions, requesters}`: counts of metadata-only `relay_abuse_log` rows for the same host inside the window. Look the requesters up with `GET /abuse-log` (itself audited). |
| `POST /abuse-reports/:id/triage {status: triaged|actioned|dismissed, note?}` | (`abuse_report_triage`). |
| `GET /contribution-allowlist` / `POST /contribution-allowlist {userId, note?}` / `DELETE /contribution-allowlist/:userId` | Agents allowed to buy while `requireContribution` is on (`contribution_allowlist_add`, `contribution_allowlist_remove`). The gateway caches decisions for 30 s. |

The admin panel's **Launch controls** page (`/admin/launch`) covers all of the above; tier discounts and the margin floor are on **Pricing, Split & Tiers**, the policy flags on **Policy**. New jobs (`starter-expiry`, `genesis`, `network-snapshot`, hourly; `unmet-demand-flush`, per instance) appear on **Health**.

## 15. Legacy `/api/admin` mutations (`admin.ts`)

Every mutating route under `/api/admin` (outside `/network`) requires a JSON body field `reason`: a string of 3–500 printable characters after trimming. A missing, short, long or control-character reason is `400 {"error":"reason ..."}` and nothing changes. The change and one `audit_events` row (`user_id` = the acting admin, `details.reason` plus the previous and new state) are written in one transaction that re-checks the caller's admin role `FOR UPDATE` (`403` if revoked). If the audit insert fails, the change rolls back. The rows show up in `GET /api/admin/network/audit` and on the admin **Audit** page.

| Route | Extra body | Audit action (resource, resource id) | Details besides `reason` |
|---|---|---|---|
| `PUT /users/:id/suspend` | | `user_suspend` (user, user id) | `previousStatus`, `newStatus`, `changed`, `revokedKeys`, `revokedTokens` |
| `PUT /users/:id/activate` | | `user_activate` (user) | `previousStatus`, `newStatus`, `changed` |
| `DELETE /users/:id` | | `user_delete` (user) | `previousStatus`, `newStatus` |
| `PUT /users/:id/plan` | `planId` | `user_plan_set` (user) | `previousPlanId`, `newPlanId` |
| `PUT /roles/:userId` (root admin) | `role` | `admin_role_set` (user) | `previousRole`, `newRole` |
| `POST /credit-wallet` (cybersecurity admin+) | `targetUserId` or `teamId`, `amountCents` | `wallet_credit` (wallet, user id) / `team_wallet_credit` (team_wallet, team id) | `amountCents`, `transactionId` (user) |
| `POST /bug-reports/:id/approve` | `creditAmountCents?` | `bug_report_approve` (bug_report) | `previousStatus`, `newStatus`, `creditAmountCents`, `reporterId` |
| `POST /bug-reports/:id/reject` | | `bug_report_reject` (bug_report) | `previousStatus`, `newStatus` |
| `POST /promo` | `code`, `creditCents`, `maxUses?`, `expiresAt?` | `promo_create` (promo_code, promo id) | `prefix` (never the code), `creditCents`, `maxUses`, `expiresAt` |
| `DELETE /promo/:id` | | `promo_disable` (promo_code) | `previousActive`, `newActive` |
| `POST /waitlist/:id/approve` | | `waitlist_approve` (waitlist) | `previousStatus`, `newStatus` |
| `POST /waitlist/bulk-approve` | `count?` | `waitlist_bulk_approve` (waitlist, `bulk`) | `requested`, `approved`, `entryIds` |
| `DELETE /waitlist/:id` | | `waitlist_cancel` (waitlist) | `newStatus` |
| `POST /loyalty/process` | | `loyalty_process` (loyalty, `YYYY-MM`) | `processed`, `rewarded`, `creditedCents` |
| `POST /commissions/process` | | `commissions_process` (affiliate_commissions, `batch`) | `processed`, `totalCreditedCents` |

The loyalty and commission runs credit each user in its own transaction, so their single audit row is written after the run and records its totals. For `credit-wallet`, `reason` also becomes the wallet transaction description (first 200 chars). `DELETE` requests carry the reason as a JSON body (`Content-Type: application/json`).

## 16. Operator alerting (`admin-ops-alerts.ts`, `ops-alerts.ts`)

A checker in the API process runs every `OPS_ALERT_INTERVAL_SEC` (default 60) and posts to every webhook in `OPS_ALERT_WEBHOOKS`. Rules:

| Rule | Severity | Fires when |
|---|---|---|
| `gateway_heartbeat_stale` | critical | newest of `node_ip_slots.heartbeat_at` / `job_runs.last_finished_at` is older than `OPS_ALERT_GATEWAY_STALE_SEC` (180) |
| `live_nodes_low` | critical | live nodes (slot heartbeat < 90 s) below `OPS_ALERT_MIN_LIVE_NODES` (0 = off) |
| `live_nodes_drop` | warning | live nodes fell `OPS_ALERT_NODE_DROP_PCT` (50) % or more below the 10-minute peak |
| `payment_webhook_failures` | critical | `OPS_ALERT_PAYMENT_FAILURES` (3) or more payment webhook handler errors in 10 min |
| `wallet_debit_spike` | warning | wallet debits in 10 min ≥ `OPS_ALERT_DEBIT_SPIKE_CENTS` (5000) and ≥ `OPS_ALERT_DEBIT_SPIKE_FACTOR` (5) × the 10-min average of the prior 6 h |
| `v1_error_rate` | warning | ≥ `OPS_ALERT_V1_ERROR_PCT` (20) % of `/v1` responses were 5xx in 10 min, with at least `OPS_ALERT_V1_MIN_REQUESTS` (50) requests |

A firing rule notifies once per `OPS_ALERT_DEDUPE_SEC` (1800); a `resolved` notice is sent when it clears. All sends (including tests) share a cap of `OPS_ALERT_MAX_PER_HOUR` (30). Counters, dedupe state (capped at 1000 entries, pruned each run) and the last 200 alerts are in memory and reset on restart; each API instance alerts independently.

`OPS_ALERT_WEBHOOKS` is a comma-separated list of `[kind=]https://host/path`, kind `json` (default), `slack`, `discord` (Slack/Discord-compatible `text`/`content`) or `ntfy` (plain-text body with `Title`/`Priority`/`Tags` headers). At most 8; HTTPS on port 443 only, no credentials in the URL. Every host is DNS-resolved at startup and before each send and rejected if any address is private/internal (SSRF floor), and each send connects only to the addresses that passed that check (no second DNS lookup to rebind); a bad entry fails API startup. Requests have a 5 s timeout and do not follow redirects. Payloads hold only the rule, severity, status, a summary and numeric values: no user ids, wallets, keys or URLs.

### `GET /api/admin/ops-alerts?limit=50`

Returns `webhooks` (`kind` and `host` only; paths are secrets and never returned), `thresholds`, `firing` (rule ids) and `alerts` (newest first, ≤ 200): `{ rule, severity, status: firing|resolved|test, summary, values, at, delivered, suppressed: null|rate_limit }`. Dedupe-suppressed repeats are not listed. 503 when the checker is not running.

### `POST /api/admin/ops-alerts/test`

Body `{ "reason": "..." }` (required). Sends a test alert to every webhook (bypasses dedupe, counts toward the hourly cap) and writes audit action `ops_alert_test` (`ops_alert`, `test`) with `reason`, `delivered`, `webhooks`, `suppressed`. Returns `{ alert, webhooks }`.

## 17. Kill switches (`admin-kill-switches.ts`)

Mounted at `/api/admin/network`. Switches live in `kill_switches` (one row per key), drained nodes in `node_drains`. Every change re-checks the admin role `FOR UPDATE` and writes an `audit_events` row in the same transaction; a failed audit insert rolls the change back. `reason` (3–500 printable chars) is required on every mutation.

| Key | Refuses (new work only) | Agent-facing code (503) |
|---|---|---|
| `relay` | every new relay session (HTTP, CONNECT, SOCKS5, x402/MPP) | `RELAY_PAUSED` |
| `relay_residential`, `relay_mobile`, `relay_dc`, `relay_masked` | sessions that request that class; unflagged sessions skip it (refused only when residential, mobile and dc are all paused) | `EXIT_CLASS_PAUSED` |
| `signups` | creating a new wallet-identity account (`POST /api/auth/wallet/verify` for an unknown address); existing accounts still sign in | `SIGNUPS_PAUSED` |
| `api_keys` | `POST /api/keys`, `POST /api/teams/:id/keys` | `API_KEYS_PAUSED` |
| `payouts` | `POST /v1/credits/withdraw/challenge`, `POST /v1/credits/withdraw`, and the gateway payout job (no sends, auto-queues or receipt checks while engaged; it resumes on the next run) | `PAYOUTS_PAUSED` |
| `rail_x402`, `rail_mpp` | paid relay requests on that rail, refused at the gateway **before** verification so the payer is never charged | `PAYMENT_RAIL_PAUSED` |
| `rail_tempo`, `rail_nowpayments` | new top-ups (`POST /api/wallet/topup/tempo`, `POST /api/wallet/topup/crypto`). Webhooks for payments already made still credit | `PAYMENT_RAIL_PAUSED` |

Refusals carry `Retry-After` and `X-DominusNode-Error: <code>`; API bodies are `{ error, code }`. Open sessions, streams and in-flight settlements are never cut.

**Propagation and failure:** each gateway and API instance re-reads both tables every `KILL_SWITCH_POLL_MS` (default 5000, 1000–10000). If no read has succeeded for `KILL_SWITCH_MAX_STALE_MS` (default 15000, 5000–120000) — including at startup before the first read — the instance fails closed: every switch reads as engaged, every drained-node check as drained, and agents get `KILL_SWITCH_UNAVAILABLE` (503, `Retry-After: 30`). Invalid values for either variable stop the service at startup.

**Drain:** a drained node is excluded from node selection (sticky sessions move to another node); its tunnel stays up and open streams finish. Unlike quarantine it does not change `nodes.status` or reputation.

| Route | Body | Response |
|---|---|---|
| `GET /kill-switches` | `limit`, `offset` (drained-node page, default 100) | `{ pollIntervalMs, switches: [{ key, engaged, reason, updatedBy, updatedAt }], drainedNodes: { limit, offset, total, items: [{ nodeId, reason, createdBy, createdAt, status, ipClass, country }] } }` |
| `PUT /kill-switches/:key` | `{ engaged: bool, reason }` | `{ key, engaged, reason, updatedBy, updatedAt, previous, changed, effectWithinMs }`; unknown key `404`. Audit `kill_switch_set` (`kill_switch`, key) with `{ engaged, previous, reason }` (written even when unchanged) |
| `POST /nodes/:id/drain` | `{ reason }` | `{ nodeId, drained: true, changed, effectWithinMs }`; unknown node `404`. Audit `node_drain` when newly drained |
| `POST /nodes/:id/undrain` | `{ reason }` | `{ nodeId, drained: false, changed, effectWithinMs }`. Audit `node_undrain` with `{ reason, drainReason }` when a drain was removed |

The admin panel's **Kill switches** page (`/admin/kill-switches`) shows every switch with its agent error code, pauses/resumes with a required reason, and drains or undrains nodes.
