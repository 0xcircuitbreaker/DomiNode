/** Typed client for /api/admin/network (docs/agent-network/ADMIN_API.md). */
import { get, post, put, patch, del } from "./client";
import type { Money } from "../lib/format";

export type { Money };
export type Rail = "wallet" | "team" | "agentic_wallet" | "x402" | "mpp" | "free";
export type IpClass = "residential" | "dc" | "mobile" | "masked" | "unknown";
export type NodeStatus = "pending" | "active" | "cooldown" | "quarantined" | "suspended" | "revoked";
export type PayoutStatus = "pending" | "held_tax" | "held_frozen" | "submitted" | "confirmed" | "failed" | "reversed";
export type DisputeStatus = "open" | "resolved_gateway" | "resolved_node" | "dismissed";
export type Period = "24h" | "7d" | "30d" | "90d" | "all";

export const RAILS: Rail[] = ["wallet", "team", "agentic_wallet", "x402", "mpp", "free"];
export const IP_CLASSES: IpClass[] = ["residential", "dc", "mobile", "masked", "unknown"];
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
  /** Gateway-verified (effective) vs owner-declared exit class. */
  verifiedClass?: IpClass; declaredClass?: IpClass | null; classVerifiedAt?: string | null; openEgressMismatchFlags?: number;
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
  "node_operator_run_set", "starter_credit_settings_update", "starter_credit_revoke", "genesis_settings_update", "referral_settings_update",
  "genesis_credit_clawback", "buyer_discount_settings_update", "network_incident_create", "network_incident_update",
  "announcement_create", "announcement_update", "announcement_delete",
  "abuse_report_triage", "contribution_allowlist_add", "contribution_allowlist_remove",
  "user_suspend", "user_activate", "user_delete", "user_plan_set", "admin_role_set",
  "wallet_credit", "team_wallet_credit", "bug_report_approve", "bug_report_reject",
  "promo_create", "promo_disable", "waitlist_approve", "waitlist_bulk_approve", "waitlist_cancel",
  "loyalty_process", "commissions_process",
] as const;

export type PlaintextMode = "deny" | "opt_in" | "allow";
export interface NetworkPolicy {
  ports: number[]; categoriesVersion: number; denyCategories: string[]; denyDomains: string[];
  nodeDefaults: { maxStreams: number; maxGbDay: number };
  requesterLimits: { reqPerSec: number; dailySpendMusd: number };
  sanctionedCountries: string[]; attestation: { minVersion: number; text: string };
  plaintext: PlaintextMode; logRetentionDays: number;
  nodeCapsPerPrefix: { per32: number; per24: number; perAsn: number }; freeTierRelay: boolean;
  requireContribution: boolean; contributionWindowDays: number; allowAnonymousPayers: boolean;
}
export interface PolicyResponse { version: number; sha256: string; body: NetworkPolicy; createdAt: string | null }
export interface PricingRow { ipClass: string; pricePerGbMusd: string; tierWeightBps?: number | null; updatedAt: string }
export interface SplitRow { id: number; nodeShareBps: number; maturationHours: number; effectiveFrom: string; note: string | null; createdAt?: string }
export interface Tier {
  id: number; name: string; rank: number; nodeShareBps: number; minTenureDays: number; minUptimeBps: number;
  minActiveIps: number; minReputation: number; noClawbackDays: number; holdDays: number; maxNodes: number;
  dailyWithdrawLimitMusd: string; buyerDiscountBps: number;
}

const BASE = "/api/admin/network";

// ─── Launch readiness (ADMIN_API.md §14) ───────────────────────────
export interface SeedSide { total: number; online: number; countries: number; asns: number; paidBytes24h: string; paid24h: Money; paidBytes30d: string; paid30d: Money }
export interface StarterSettings {
  enabled: boolean; amount: Money; dailyBudget: Money; perPrefixCap: number; perFundingSourceCap: number; capWindowDays: number;
  expiryDays: number; seedNodesOnly: boolean; seedOnlyDays: number; requireFunding?: boolean; minTopupCents?: number; rpcConfigured?: boolean;
  updatedAt: string | null; grantedToday?: { count: number; amount: Money };
}
export interface StarterGrant { id: string; userId: string; walletAddress: string | null; amount: Money; remaining: Money; ipPrefix: string | null; status: string; expiresAt: string; createdAt: string; closedAt: string | null }
export interface GenesisSettings { enabled: boolean; maxOwners: number; bonusBps: number; boostDays: number; credit: Money; creditThresholdBytes: string; minDistinctPayers?: number; creditThresholdNodeMusd?: string; minPayerSpendMusd?: string; members?: number; updatedAt: string | null }
export interface GenesisMember { ownerUserId: string; walletAddress: string | null; seq: number; enrolledAt: string; boostUntil: string; creditStatus: string; credit: Money | null; creditGrantedAt: string | null; creditMaturesAt: string | null; qualifyingBytes: string }
export interface Incident { id: string; title: string; body: string; severity: string; status: string; startedAt: string; resolvedAt: string | null; updatedAt: string }
export interface Announcement { id: string; title: string; body: string; category: string; url: string | null; published: boolean; publishedAt: string; updatedAt: string }
export interface UnmetDemand { days: number; groups: Array<{ country: string | null; ipClass: string | null; requests: number; lastHour: string }>; daily: Array<{ day: string; requests: number }> }
export interface AbuseReport {
  id: string; destHost: string; windowStart: string; windowEnd: string; category: string; description: string; contact: string | null;
  status: string; adminNote: string | null; triagedBy: string | null; triagedAt: string | null; createdAt: string; matches: { sessions: number; requesters: number };
}
export interface AllowlistEntry { userId: string; walletAddress: string | null; note: string | null; createdBy: string | null; createdAt: string }

export const launchApi = {
  seedSummary: () => get<{ seed: SeedSide; community: SeedSide }>(`${BASE}/seed-summary`),
  setOperatorRun: (nodeId: string, operatorRun: boolean, reason?: string) =>
    post<{ nodeId: string; operatorRun: boolean; previous: boolean }>(`${BASE}/nodes/${encodeURIComponent(nodeId)}/operator-run`, reason ? { operatorRun, reason } : { operatorRun }),
  starterSettings: () => get<StarterSettings>(`${BASE}/starter-credits/settings`),
  updateStarterSettings: (b: Record<string, unknown>) => put<StarterSettings>(`${BASE}/starter-credits/settings`, b),
  starterGrants: (q: Q) => get<Paged<StarterGrant>>(`${BASE}/starter-credits/grants${qs(q)}`),
  clawbackGenesis: (ownerUserId: string, reason: string) =>
    post<{ ownerUserId: string; creditStatus: string; amount: Money }>(`${BASE}/genesis/members/${encodeURIComponent(ownerUserId)}/clawback`, { reason }),
  revokeGrant: (id: string, reason: string) => post<{ id: string; status: string; removed: Money }>(`${BASE}/starter-credits/grants/${encodeURIComponent(id)}/revoke`, { reason }),
  genesisSettings: () => get<GenesisSettings>(`${BASE}/genesis/settings`),
  updateGenesisSettings: (b: Record<string, unknown>) => put<GenesisSettings>(`${BASE}/genesis/settings`, b),
  genesisMembers: (q: Q) => get<Paged<GenesisMember>>(`${BASE}/genesis/members${qs(q)}`),
  discountSettings: () => get<{ enabled: boolean; minPlatformMarginBps: number; updatedAt: string | null }>(`${BASE}/buyer-discounts/settings`),
  updateDiscountSettings: (b: { enabled?: boolean; minPlatformMarginBps?: number }) => put<{ updated: Record<string, unknown> }>(`${BASE}/buyer-discounts/settings`, b),
  incidents: (q: Q) => get<Paged<Incident>>(`${BASE}/incidents${qs(q)}`),
  createIncident: (b: { title: string; body?: string; severity: string; status?: string }) => post<{ id: string }>(`${BASE}/incidents`, b),
  updateIncident: (id: string, b: Record<string, unknown>) => patch<{ id: string }>(`${BASE}/incidents/${encodeURIComponent(id)}`, b),
  announcements: (q: Q) => get<Paged<Announcement>>(`${BASE}/announcements${qs(q)}`),
  createAnnouncement: (b: { title: string; body?: string; category?: string; url?: string; published?: boolean }) => post<{ id: string }>(`${BASE}/announcements`, b),
  updateAnnouncement: (id: string, b: Record<string, unknown>) => patch<{ id: string }>(`${BASE}/announcements/${encodeURIComponent(id)}`, b),
  deleteAnnouncement: (id: string) => del(`${BASE}/announcements/${encodeURIComponent(id)}`),
  unmetDemand: (days: number) => get<UnmetDemand>(`${BASE}/unmet-demand${qs({ days })}`),
  abuseReports: (q: Q) => get<Paged<AbuseReport>>(`${BASE}/abuse-reports${qs(q)}`),
  triageReport: (id: string, status: string, note?: string) => post<{ id: string; status: string }>(`${BASE}/abuse-reports/${encodeURIComponent(id)}/triage`, note ? { status, note } : { status }),
  allowlist: (q: Q) => get<Paged<AllowlistEntry>>(`${BASE}/contribution-allowlist${qs(q)}`),
  addAllowlist: (userId: string, note?: string) => post<{ userId: string }>(`${BASE}/contribution-allowlist`, note ? { userId, note } : { userId }),
  removeAllowlist: (userId: string) => del(`${BASE}/contribution-allowlist/${encodeURIComponent(userId)}`),
};

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
  setTierWeight: (ipClass: string, tierWeightBps: number, reason: string) => put<PricingRow>(`${BASE}/pricing`, { ipClass, tierWeightBps, reason }),
  split: () => get<{ current: SplitRow; history: SplitRow[] }>(`${BASE}/split`),
  addSplit: (body: { nodeShareBps: number; maturationHours: number; effectiveFrom?: string; note?: string }) =>
    post<SplitRow>(`${BASE}/split`, body),
  tiers: () => get<{ tiers: Tier[] }>(`${BASE}/tiers`),
  updateTier: (id: number, body: Partial<Omit<Tier, "id" | "name" | "rank">>) =>
    put<{ tier: Tier }>(`${BASE}/tiers/${id}`, body),
};

/* ─── Collusion flags (ADMIN_API.md §12) ─────────────────────────────── */
export const COLLUSION_STATUSES = ["open", "dismissed", "confirmed"] as const;
// Must match KINDS in dashboard routes/admin-network-collusion.ts.
export const COLLUSION_KINDS = ["concentration", "cluster", "circular", "report_penalty", "egress_mismatch"] as const;
export interface CollusionFlag {
  id: string; kind: string; ownerUserId: string; ownerEmail: string | null; nodeId: string | null;
  requesterUserId: string | null; requesterEmail: string | null; shareBps: number; volume: Money; total: Money;
  windowDays: number; status: string; autoFrozen: boolean; ownerCreditsFrozen: boolean; resolvedBy: string | null;
  resolutionNote: string | null; firstSeenAt: string; lastSeenAt: string; resolvedAt: string | null;
}
export interface CollusionSettings {
  windowDays: number; minNodeVolume: Money; concentrationBps: number; clusterSize: number; clusterBps: number;
  circularMin: Money; autoFreeze: boolean; freezeBps: number; freezeMinVolume: Money; updatedBy: string | null; updatedAt: string | null;
}
export const collusionApi = {
  flags: (q: Q) => get<Paged<CollusionFlag>>(`${BASE}/collusion/flags${qs(q)}`),
  resolve: (id: string, action: "dismiss" | "confirm", note?: string) =>
    post<{ id: string; status: string }>(`${BASE}/collusion/flags/${encodeURIComponent(id)}/${action}`, note ? { note } : {}),
  settings: () => get<CollusionSettings>(`${BASE}/collusion/settings`),
  updateSettings: (b: Record<string, unknown>) => put<CollusionSettings>(`${BASE}/collusion/settings`, b),
};
