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
  maturationHours: number;
  rails: string[];
}

export interface NetworkStats {
  onlineNodes: number;
  byClass: Record<string, number>;
  /** Countries with >= 3 online nodes; smaller groups fold into otherCountries. */
  byCountry: Array<{ country: string; online: number }>;
  otherCountries: number;
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
}
