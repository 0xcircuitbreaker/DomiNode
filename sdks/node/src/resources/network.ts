import type { HttpClient } from "../http.js";
import type { IpClass } from "../proxy-fetch.js";

export interface NetworkPolicy {
  version: number;
  sha256: string;
  /** Full policy document (ports, plaintext rules, attestation text/minVersion, nodeDefaults, requesterLimits, ...). */
  body: Record<string, unknown>;
  /** Human-readable non-disableable node floor. */
  floorGuarantees: string[];
}

export interface NetworkPricing {
  currency: "USD";
  unit: "musd_per_gb";
  prices: Array<{ ipClass: IpClass | string; pricePerGbMusd: string }>;
  nodeShare: Array<{ tier: string; rank: number; nodeShareBps: number }>;
  /** Buyer discount per owner tier, in basis points. */
  buyerDiscounts: Array<{ tier: string; rank: number; buyerDiscountBps: number }>;
  maturationHours: number;
  rails: string[];
}

/** Online nodes and paid bytes in the last 24h for one operator group (paidBytes24h is a decimal string). */
export interface NetworkGroupStats {
  online: number;
  paidBytes24h: string;
}

export interface NetworkStats {
  onlineNodes: number;
  byClass: Record<string, number>;
  /** Countries with >= 3 online nodes; smaller groups fold into otherCountries. */
  byCountry: Array<{ country: string; online: number }>;
  otherCountries: number;
  /** Operator-run seed nodes. */
  seed: NetworkGroupStats;
  /** Community (agent-run) nodes. */
  community: NetworkGroupStats;
  generatedAt: string;
}

export type StatusLevel = "operational" | "degraded" | "down" | "unknown";

/** Public incident as published on /v1/status (no incident ids). */
export interface PublicIncident {
  title: string;
  body: string;
  severity: string;
  status: string;
  startedAt: string;
  resolvedAt: string | null;
  updatedAt: string;
}

/** GET /v1/status: aggregate public health. No node ids, instance ids or IPs. */
export interface NetworkStatus {
  status: StatusLevel;
  coordinator: { status: "operational" | "down"; policyVersion: number | null };
  gateway: { status: "operational" | "down" | "unknown"; instancesOnline: number; lastHeartbeatAt: string | null };
  /** Share of minutes with a live gateway, in percent; null before any heartbeat. */
  availability: { last24h: number | null; last7d: number | null };
  nodes: {
    onlineNodes: number;
    byClass: Record<string, number>;
    byCountry: Array<{ country: string; online: number }>;
    otherCountries: number;
    countriesAvailable: number;
    /** Figures hidden by k-anonymity (published as 0). */
    suppressed?: string[];
  } | null;
  incidents: PublicIncident[];
  generatedAt: string;
}

/** Public relay-network info (no auth). */
export class NetworkResource {
  constructor(private http: HttpClient) {}

  /** GET /v1/policy */
  async policy(): Promise<NetworkPolicy> {
    return this.http.get("/v1/policy", "none");
  }

  /** GET /v1/pricing — live per-GB price by IP class (µUSD strings). */
  async pricing(): Promise<NetworkPricing> {
    return this.http.get("/v1/pricing", "none");
  }

  /** GET /v1/network/stats — aggregates only, never node ids or IPs. */
  async stats(): Promise<NetworkStats> {
    return this.http.get("/v1/network/stats", "none");
  }

  /** GET /v1/status — public health summary (gateway, coordinator, availability, incidents). */
  async status(): Promise<NetworkStatus> {
    return this.http.get("/v1/status", "none");
  }
}
