/** Typed client for /api/admin/network (docs/agent-network/ADMIN_API.md). */
import { get, post, put } from "./client";
import type { Money } from "../lib/format";

export type { Money };
export type Rail = "wallet" | "team" | "agentic_wallet" | "x402" | "mpp" | "free";
export type IpClass = "residential" | "dc" | "mobile" | "unknown";
export type NodeStatus = "pending" | "active" | "cooldown" | "quarantined" | "suspended" | "revoked";
export type PayoutStatus = "pending" | "held_tax" | "held_frozen" | "submitted" | "confirmed" | "failed" | "reversed";
export type DisputeStatus = "open" | "resolved_gateway" | "resolved_node" | "dismissed";
export type Period = "24h" | "7d" | "30d" | "90d" | "all";

export const RAILS: Rail[] = ["wallet", "team", "agentic_wallet", "x402", "mpp", "free"];
export const IP_CLASSES: IpClass[] = ["residential", "dc", "mobile", "unknown"];
export const NODE_STATUSES: NodeStatus[] = ["pending", "active", "cooldown", "quarantined", "suspended", "revoked"];
export const PAYOUT_STATUSES: PayoutStatus[] = ["pending", "held_tax", "held_frozen", "submitted", "confirmed", "failed", "reversed"];
export const DISPUTE_STATUSES: DisputeStatus[] = ["open", "resolved_gateway", "resolved_node", "dismissed"];
export const PERIODS: Period[] = ["24h", "7d", "30d", "90d", "all"];

export interface Paged<T> { limit: number; offset: number; total: number; items: T[] }
export interface RevenueAcc { gross: Money; platform: Money; node: Money; bytes: string; gb: string; charges: number }
interface TrafficAcc { bytes: string; gb: string; charges: number; gross: Money; platform: Money; node: Money }
interface CountAmount { count: number; amount: Money }

export interface Overview {
  generatedAt: string;
  nodes: {
    total: number; online: number; byStatus: Record<NodeStatus, { total: number; online: number }>;
    quarantined: number; uniquePrefixesOnline: number; uniqueAsnsOnline: number;
  };
  agents: {
    requestersActive24h: number; requestersActive7d: number; requestersActive30d: number;
    nodeOwners: number; nodeOwnersWithActiveNode: number;
  };
  traffic: Record<"24h" | "7d" | "30d" | "all", TrafficAcc>;
  credits: { accounts: number; frozenAccounts: number; pending: Money; available: Money; frozenBalance: Money };
  payouts: {
    pending: CountAmount; heldTax: CountAmount; heldFrozen: CountAmount; submitted: CountAmount;
    confirmed30d: CountAmount; failed30d: CountAmount; reversed30d: CountAmount;
  };
  disputes: { open: number; nodesWithOpen: number };
}

export type Bucket = "hour" | "day" | "week";
export interface RevenuePoint extends RevenueAcc { t: string; byRail: Record<Rail, RevenueAcc>; byClass: Record<IpClass, RevenueAcc> }
export interface Revenue {
  from: string; to: string; bucket: Bucket; series: RevenuePoint[];
  totals: RevenueAcc & { byRail: Record<Rail, RevenueAcc>; byClass: Record<IpClass, RevenueAcc> };
}
export interface TopRequester {
  userId: string; email: string | null; walletAddress: string | null; gross: Money; platform: Money; node: Money;
  bytes: string; gb: string; charges: number; lastChargeAt: string;
}
export interface TopNodeOwner {
  userId: string; email: string | null; walletAddress: string | null; tier: string | null; earnings: Money;
  gross: Money; platform: Money; bytes: string; gb: string; charges: number; nodesWithTraffic: number;
}

export interface NodeBase {
  id: string; ownerUserId: string; ownerWallet: string; nodePubkey: string | null; status: NodeStatus;
  attestationVersion: number; observedIp: string | null; ipPrefix: string | null; asn: number | null;
  country: string | null; ipClass: IpClass | null; maxStreams: number; maxGbDay: number; reputation: number;
  byteDisputes: number; agentVersion: string | null; lastSeenAt: string | null; createdAt: string; online: boolean;
}
export interface NodeRow extends NodeBase {
  ownerEmail: string | null; bytesToday: string; gbToday: string; bytes30d: string; gb30d: string; openDisputes: number;
}
export interface NodeDetail {
  node: NodeBase & { ownerEmail: string | null; ownerStatus: string | null; ownerTier: string | null };
  dailyStats: Array<{ day: string; bytes: string; gb: string; streams: number; failures: number; burns: number }>;
  reputationByTarget: Array<{ target: string; okCount: number; burnCount: number; cooldownUntil: string | null }>;
  disputes: Array<{ id: string; relayChargeId: string | null; bytesGateway: string; bytesNode: string; status: DisputeStatus; createdAt: string; resolvedAt: string | null }>;
  chargesDaily: Array<{ day: string; gross: Money; node: Money; platform: Money; bytes: string; gb: string; charges: number; requesters: number }>;
  chargesByRail30d: Array<{ rail: Rail; gross: Money; node: Money; bytes: string; gb: string; charges: number; disputed: number; zeroShare: number }>;
  adminActions: Array<{ id: string; adminUserId: string | null; action: string; details: Record<string, unknown>; createdAt: string }>;
}
export interface NodeActionResult { nodeId: string; previousStatus: NodeStatus; status: NodeStatus; changed: boolean; gatewayEffect: string }

export interface Payout {
  id: string; userId: string | null; email: string | null; amount: Money; trigger: "auto" | "on_demand";
  status: PayoutStatus; batchId: string | null; txHash: string | null; failureReason: string | null;
  createdAt: string; updatedAt: string;
  payoutWallet: { address: string; chain: string; status: string } | null;
}

export interface Agent {
  userId: string; email: string | null; walletAddress: string | null; status: "active" | "suspended" | "deleted";
  createdAt: string; tier: string | null; tierId: number | null; isRequester: boolean; isNodeOwner: boolean;
  spend: Money; spend30d: Money; bytesRequested: string; gbRequested: string; lastRequestAt: string | null;
  earnings: Money; earnings30d: Money; nodes: number; activeNodes: number; onlineNodes: number;
  credits: { pending: Money; available: Money; frozen: boolean }; walletBalance: Money | null;
}
export interface AgentDetail {
  agent: Agent;
  creditAccount: { autoConvertPct: number; taxFormStatus: string; taxFormType: string | null; taxYear: number | null; ytdPaid: Money; updatedAt: string } | null;
  nodes: NodeBase[];
  recentPayouts: Payout[];
  recentCreditTransactions: Array<{ id: string; type: string; amount: Money; relayChargeId: string | null; externalRef: string | null; createdBy: string | null; createdAt: string }>;
  spendByRail30d: Array<{ rail: Rail; gross: Money; bytes: string; gb: string; charges: number }>;
}

export interface GeoRow { nodes: number; activeNodes: number; onlineNodes: number; bytes: string; gb: string; gross: Money; nodeEarnings: Money }
export interface Geo { period: Period; byCountry: Array<GeoRow & { country: string }>; byAsn: Array<GeoRow & { asn: number | null }> }

export interface CreditAccount {
  userId: string; email: string | null; walletAddress: string | null; pending: Money; available: Money; frozen: boolean;
  autoConvertPct: number; taxFormStatus: string; ytdPaid: Money; heldPayouts: Money; updatedAt: string;
}

export interface Dispute {
  id: string; relayChargeId: string | null; nodeId: string | null; nodeOwnerUserId: string | null; requesterUserId: string | null;
  paymentRail: Rail | null; bytesGateway: string; bytesNode: string; bytesDiff: string; diffBps: number | null;
  gross: Money | null; nodeShare: Money | null; status: DisputeStatus; createdAt: string; resolvedAt: string | null;
}

export interface AbuseLog extends Paged<{ id: string; ts: string; sessionId: string; requesterUserId: string; nodeId: string; destHost: string; destPort: number; bytes: string }> {
  from: string; to: string; retentionDays: number;
}

export interface Health {
  generatedAt: string;
  jobs: Array<{
    name: string; instanceId: string | null; lastStartedAt: string | null; lastFinishedAt: string | null;
    lastOk: boolean | null; lastError: string | null; lastDurationMs: number | null; lastSuccessAt: string | null;
    runCount: number; failCount: number; expectedIntervalMs: number | null; stale: boolean;
  }>;
  settleRetryQueue: { pending: number; due: number; dead: number; oldestPendingAt: string | null; maxAttempts: number };
  gateway: { liveInstances: number; connectedNodes: number; lastHeartbeatAt: string | null };
  dbPool: { total: number | null; idle: number | null; waiting: number | null };
}

export interface AuditRow {
  id: string; adminUserId: string | null; adminEmail: string | null; action: string; resource: string;
  resourceId: string | null; ipAddress: string | null; details: Record<string, unknown>; createdAt: string;
}
export const AUDIT_ACTIONS = [
  "node_credit_unfreeze", "node_credit_freeze", "node_quarantine", "node_activate", "node_revoke",
  "node_payout_reverse", "byte_dispute_resolve", "relay_abuse_log_access",
  "network_policy_publish", "network_pricing_update", "revenue_split_append", "node_tier_update",
] as const;

export type PlaintextMode = "deny" | "opt_in" | "allow";
export interface NetworkPolicy {
  ports: number[]; categoriesVersion: number; denyCategories: string[]; denyDomains: string[];
  nodeDefaults: { maxStreams: number; maxGbDay: number };
  requesterLimits: { reqPerSec: number; dailySpendMusd: number };
  sanctionedCountries: string[]; attestation: { minVersion: number; text: string };
  plaintext: PlaintextMode; logRetentionDays: number;
  nodeCapsPerPrefix: { per32: number; per24: number; perAsn: number }; freeTierRelay: boolean;
}
export interface PolicyResponse { version: number; sha256: string; body: NetworkPolicy; createdAt: string | null }
export interface PricingRow { ipClass: string; pricePerGbMusd: string; updatedAt: string }
export interface SplitRow { id: number; nodeShareBps: number; maturationHours: number; effectiveFrom: string; note: string | null; createdAt?: string }
export interface Tier {
  id: number; name: string; rank: number; nodeShareBps: number; minTenureDays: number; minUptimeBps: number;
  minActiveIps: number; minReputation: number; noClawbackDays: number; holdDays: number; maxNodes: number;
  dailyWithdrawLimitMusd: string;
}

const BASE = "/api/admin/network";

/** Build a query string from defined, non-empty params. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : "";
}

type Q = Record<string, string | number | boolean | null | undefined>;

export const adminApi = {
  overview: () => get<Overview>(`${BASE}/overview`),
  revenue: (q: Q) => get<Revenue>(`${BASE}/revenue${qs(q)}`),
  topRequesters: (q: Q) => get<Paged<TopRequester> & { period: Period }>(`${BASE}/revenue/top-requesters${qs(q)}`),
  topNodeOwners: (q: Q) => get<Paged<TopNodeOwner> & { period: Period }>(`${BASE}/revenue/top-node-owners${qs(q)}`),
  nodes: (q: Q) => get<Paged<NodeRow>>(`${BASE}/nodes${qs(q)}`),
  node: (id: string) => get<NodeDetail>(`${BASE}/nodes/${encodeURIComponent(id)}`),
  nodeAction: (id: string, action: "quarantine" | "activate" | "revoke", reason?: string) =>
    post<NodeActionResult>(`${BASE}/nodes/${encodeURIComponent(id)}/${action}`, reason ? { reason } : {}),
  agents: (q: Q) => get<Paged<Agent>>(`${BASE}/agents${qs(q)}`),
  agent: (id: string) => get<AgentDetail>(`${BASE}/agents/${encodeURIComponent(id)}`),
  freeze: (userId: string, reason: string) =>
    post<{ userId: string; frozen: true; wasFrozen: boolean; heldPayouts: number }>(`${BASE}/accounts/${encodeURIComponent(userId)}/freeze`, { reason }),
  unfreeze: (userId: string, payouts: "release" | "reverse") =>
    post<{ userId: string; mode: string; wasFrozen: boolean; payouts: number; musd: string }>(`${BASE}/accounts/${encodeURIComponent(userId)}/unfreeze`, { payouts }),
  geo: (q: Q) => get<Geo>(`${BASE}/network/geo${qs(q)}`),
  creditAccounts: (q: Q) => get<Paged<CreditAccount>>(`${BASE}/credits/accounts${qs(q)}`),
  payouts: (q: Q) => get<Paged<Payout> & { totalAmount: Money }>(`${BASE}/payouts${qs(q)}`),
  reversePayout: (id: string, reason: string) =>
    post<{ id: string; status: "reversed"; amount: Money }>(`${BASE}/payouts/${encodeURIComponent(id)}/reverse`, { reason }),
  disputes: (q: Q) => get<Paged<Dispute>>(`${BASE}/disputes${qs(q)}`),
  resolveDispute: (id: string, resolution: Exclude<DisputeStatus, "open">, reason?: string) =>
    post<{ id: string; status: string; chargeReleased: boolean }>(`${BASE}/disputes/${encodeURIComponent(id)}/resolve`, reason ? { resolution, reason } : { resolution }),
  abuseLog: (q: Q) => get<AbuseLog>(`${BASE}/abuse-log${qs(q)}`),
  health: () => get<Health>(`${BASE}/health`),
  audit: (q: Q) => get<Paged<AuditRow>>(`${BASE}/audit${qs(q)}`),
  policy: () => get<PolicyResponse>(`${BASE}/policy`),
  publishPolicy: (body: NetworkPolicy) =>
    put<PolicyResponse & { previousVersion: number; attestationRaised: boolean }>(`${BASE}/policy`, body),
  pricing: () => get<{ pricing: PricingRow[] }>(`${BASE}/pricing`),
  setPricing: (ipClass: string, pricePerGbMusd: number) => put<PricingRow>(`${BASE}/pricing`, { ipClass, pricePerGbMusd }),
  split: () => get<{ current: SplitRow; history: SplitRow[] }>(`${BASE}/split`),
  addSplit: (body: { nodeShareBps: number; maturationHours: number; effectiveFrom?: string; note?: string }) =>
    post<SplitRow>(`${BASE}/split`, body),
  tiers: () => get<{ tiers: Tier[] }>(`${BASE}/tiers`),
  updateTier: (id: number, body: Partial<Omit<Tier, "id" | "name" | "rank">>) =>
    put<{ tier: Tier }>(`${BASE}/tiers/${id}`, body),
};
