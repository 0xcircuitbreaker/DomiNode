import { useEffect, useState } from "react";
import { API_BASE } from "./site";

/** Shapes of the public, unauthenticated /v1 endpoints (packages/dashboard/src/routes/v1/public.ts). */
export interface PricingResponse {
  currency: string;
  unit: string;
  prices: Array<{ ipClass: string; pricePerGbMusd: string }>;
  nodeShare: Array<{ tier: string; rank: number; nodeShareBps: number }>;
  /** List prices above; node owners buy at their tier discount (GET /v1/pricing, launch additions). */
  buyerDiscounts?: Array<{ tier: string; rank: number; buyerDiscountBps: number }>;
  maturationHours?: number;
  rails?: string[];
}

export interface StatsResponse {
  onlineNodes: number;
  byClass: Record<string, number>;
  byCountry: Array<{ country: string; online: number }>;
  otherCountries: number;
  generatedAt: string;
}

export interface PolicyResponse {
  version: number;
  sha256: string;
  floorGuarantees?: string[];
}

const MAX_BYTES = 256 * 1024;

/** safeJson pattern: text() + size check + JSON.parse; throws on empty or oversized bodies. */
export async function fetchPublic<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { signal, credentials: "omit", headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text || text.length > MAX_BYTES) throw new Error("Bad response size");
  return JSON.parse(text) as T;
}

export type Loadable<T> = { state: "loading" } | { state: "ok"; data: T } | { state: "error" };

export function usePublic<T>(path: string, validate: (v: unknown) => v is T): Loadable<T> {
  const [value, setValue] = useState<Loadable<T>>({ state: "loading" });
  useEffect(() => {
    const ctl = new AbortController();
    fetchPublic<unknown>(path, ctl.signal)
      .then((d) => setValue(validate(d) ? { state: "ok", data: d } : { state: "error" }))
      .catch(() => {
        if (!ctl.signal.aborted) setValue({ state: "error" });
      });
    return () => ctl.abort();
  }, [path, validate]);
  return value;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export const isPricing = (v: unknown): v is PricingResponse =>
  isObj(v) && Array.isArray(v["prices"]) && Array.isArray(v["nodeShare"]);
export const isStats = (v: unknown): v is StatsResponse =>
  isObj(v) && typeof v["onlineNodes"] === "number" && isObj(v["byClass"]) && Array.isArray(v["byCountry"]);
export const isPolicy = (v: unknown): v is PolicyResponse =>
  isObj(v) && typeof v["version"] === "number" && typeof v["sha256"] === "string";

/** µUSD integer string -> "$0.50". Returns null for anything that is not a non-negative integer. */
export function musdToUsd(musd: string): string | null {
  if (!/^\d{1,15}$/.test(musd)) return null;
  const n = Number(musd) / 1_000_000;
  return `$${n.toFixed(n < 0.01 && n > 0 ? 4 : 2)}`;
}

export const bpsToPct = (bps: number): string =>
  Number.isFinite(bps) ? `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%` : "?";
