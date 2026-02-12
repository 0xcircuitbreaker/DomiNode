import type { HttpClient } from "./http.js";
import type { Plan } from "./types.js";

export interface PlanEntry {
  id: string;
  name: string;
  pricePerGbCents: number;
  pricePerGbUsd: number;
  monthlyBandwidthBytes: number;
  monthlyBandwidthGB: number | null;
  isDefault: boolean;
}

export interface ListPlansResponse {
  plans: PlanEntry[];
}

export interface UserPlanResponse {
  plan: PlanEntry;
  usage: {
    monthlyUsageBytes: number;
    monthlyUsageGB: number;
    limitBytes: number;
    limitGB: number | null;
    percentUsed: number | null;
  };
}

export interface ChangePlanResponse {
  message: string;
  plan: PlanEntry;
}

export class PlansResource {
  constructor(private http: HttpClient) {}

  /** List all available plans (does not require authentication). */
  async list(): Promise<ListPlansResponse> {
    return this.http.get("/api/plans", false);
  }

  /** Get the current user's plan and monthly usage. */
  async getUserPlan(): Promise<UserPlanResponse> {
    return this.http.get("/api/plans/user/plan");
  }

  /** Change the current user's plan. */
  async changePlan(planId: string): Promise<ChangePlanResponse> {
    return this.http.put("/api/plans/user/plan", { planId });
  }
}
