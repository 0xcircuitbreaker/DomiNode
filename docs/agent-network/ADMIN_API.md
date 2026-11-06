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

Response `200`:
```ts
{ nodeId: string; previousStatus: NodeStatus; status: NodeStatus; changed: boolean; gatewayEffect: "within_sync_interval" }
```
`changed: false` when already in the target status (no audit row). Invalid transition or inactive owner → `409`. Unknown node → `404`.
Audit actions: `node_quarantine`, `node_activate`, `node_revoke` (details `{ from, to, reason }`).
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
- `resolved_node`: the charge stays held (`disputed`) for a manual clawback or adjustment.

Response: `{ id: string; status: string; relayChargeId: string | null; chargeReleased: boolean }`. Audit: `byte_dispute_resolve`.

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

Actions: `node_credit_unfreeze`, `node_credit_freeze`, `node_quarantine`, `node_activate`, `node_revoke`, `node_payout_reverse`, `byte_dispute_resolve`, `relay_abuse_log_access`, `network_policy_publish`, `network_pricing_update`, `revenue_split_append`, `node_tier_update`.

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
