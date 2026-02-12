import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { get, put } from "../api/client";

interface PlanItem {
  id: string;
  name: string;
  pricePerGbCents: number;
  pricePerGbUsd: number;
  monthlyBandwidthBytes: number;
  monthlyBandwidthGB: number | null;
  isDefault: boolean;
}

interface PlansResponse {
  plans: PlanItem[];
}

interface UserPlanResponse {
  plan: PlanItem;
  usage: {
    monthlyUsageBytes: number;
    monthlyUsageGB: number;
    limitBytes: number;
    limitGB: number | null;
    percentUsed: number | null;
  };
}

interface ChangePlanResponse {
  message: string;
  plan: PlanItem;
}

function formatBandwidth(gb: number | null): string {
  if (gb === null || gb === 0) return "Unlimited";
  if (gb >= 1024) return `${(gb / 1024).toFixed(0)} TB`;
  if (gb < 1) return `${(gb * 1024).toFixed(0)} MB`;
  return `${gb.toFixed(0)} GB`;
}

export default function PlansPage() {
  const { data: plansData, error: plansError } = useApi<PlansResponse>(() => get("/api/plans"));
  const { data: userPlan, error: userPlanError, refetch: refetchPlan } = useApi<UserPlanResponse>(() => get("/api/plans/user/plan"));
  const [changingPlan, setChangingPlan] = useState<string | null>(null);
  const [changeError, setChangeError] = useState<string | null>(null);

  async function handleChangePlan(planId: string) {
    if (planId === userPlan?.plan.id) return;
    const planName = plansData?.plans.find((p) => p.id === planId)?.name ?? planId;
    if (!window.confirm(`Switch to the ${planName} plan? This takes effect immediately.`)) return;
    setChangingPlan(planId);
    setChangeError(null);
    try {
      await put<ChangePlanResponse>("/api/plans/user/plan", { planId });
      refetchPlan();
    } catch (err) {
      setChangeError(err instanceof Error ? err.message : "Failed to change plan");
    } finally {
      setChangingPlan(null);
    }
  }

  const usagePercent = userPlan?.usage.percentUsed ?? 0;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Plans</h1>

      {(plansError || userPlanError || changeError) && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-sm text-red-400">
          {changeError || plansError || userPlanError}
        </div>
      )}

      {/* Current Plan & Usage */}
      {userPlan && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm text-gray-400">Current Plan</p>
              <p className="text-2xl font-bold text-indigo-400 mt-1">{userPlan.plan.name}</p>
            </div>
            <div className="text-right">
              <p className="text-sm text-gray-400">Price</p>
              <p className="text-2xl font-bold mt-1">${userPlan.plan.pricePerGbUsd}/GB</p>
            </div>
          </div>

          {/* Monthly Usage */}
          <div className="mt-4">
            <div className="flex items-center justify-between text-sm mb-2">
              <span className="text-gray-400">Monthly Usage</span>
              <span className="text-gray-300">
                {userPlan.usage.monthlyUsageGB.toFixed(3)} GB
                {userPlan.usage.limitGB ? ` / ${formatBandwidth(userPlan.usage.limitGB)}` : " (unlimited)"}
              </span>
            </div>
            {userPlan.usage.limitGB && userPlan.usage.limitGB > 0 ? (
              <div className="w-full bg-gray-800 rounded-full h-3">
                <div
                  className={`h-3 rounded-full transition-all ${
                    usagePercent > 90
                      ? "bg-red-500"
                      : usagePercent > 70
                        ? "bg-yellow-500"
                        : "bg-indigo-500"
                  }`}
                  style={{ width: `${Math.min(usagePercent, 100)}%` }}
                />
              </div>
            ) : (
              <div className="w-full bg-gray-800 rounded-full h-3">
                <div className="h-3 rounded-full bg-indigo-500/30 w-full" />
              </div>
            )}
            {userPlan.usage.percentUsed !== null && (
              <p className="text-xs text-gray-500 mt-1">
                {userPlan.usage.percentUsed}% of monthly allowance used
              </p>
            )}
          </div>
        </div>
      )}

      {/* Available Plans */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {plansData?.plans.map((plan) => {
          const isCurrent = plan.id === userPlan?.plan.id;
          const isChanging = changingPlan === plan.id;

          return (
            <div
              key={plan.id}
              className={`bg-gray-900 border rounded-xl p-5 flex flex-col ${
                isCurrent ? "border-indigo-500" : "border-gray-800"
              }`}
            >
              {isCurrent && (
                <span className="text-xs font-medium text-indigo-400 mb-2">Current Plan</span>
              )}
              <h3 className="text-lg font-semibold">{plan.name}</h3>
              <p className="text-3xl font-bold mt-2">
                ${plan.pricePerGbUsd}
                <span className="text-sm font-normal text-gray-400">/GB</span>
              </p>
              <p className="text-sm text-gray-400 mt-2">
                {formatBandwidth(plan.monthlyBandwidthGB)}
                {plan.monthlyBandwidthGB ? " /month" : ""}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                {plan.id === "free"
                  ? "100 MB trial bandwidth for new users"
                  : plan.id === "payg"
                    ? "Standard rate, no commitment"
                    : plan.id === "vol100"
                      ? "Best for medium volume, save 20%"
                      : "Best for high volume, save 40%"}
              </p>
              <div className="mt-auto pt-4">
                <button
                  onClick={() => handleChangePlan(plan.id)}
                  disabled={isCurrent || isChanging}
                  className={`w-full py-2.5 rounded-lg text-sm font-medium transition-colors ${
                    isCurrent
                      ? "bg-gray-800 text-gray-500 cursor-default"
                      : "bg-indigo-600 hover:bg-indigo-500 text-white"
                  }`}
                >
                  {isChanging ? "Switching..." : isCurrent ? "Current" : "Switch Plan"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Plan Details */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <h2 className="font-semibold mb-3">Plan Details</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-gray-400">
                <th className="text-left px-4 py-3 font-medium">Plan</th>
                <th className="text-left px-4 py-3 font-medium">Price/GB</th>
                <th className="text-left px-4 py-3 font-medium">Monthly Bandwidth</th>
                <th className="text-left px-4 py-3 font-medium">Savings</th>
              </tr>
            </thead>
            <tbody>
              {plansData?.plans.map((plan) => (
                <tr key={plan.id} className={`border-b border-gray-800/50 ${plan.id === userPlan?.plan.id ? "bg-indigo-500/5" : ""}`}>
                  <td className="px-4 py-3 font-medium">
                    {plan.name}
                    {plan.id === userPlan?.plan.id && (
                      <span className="ml-2 text-xs text-indigo-400">(current)</span>
                    )}
                  </td>
                  <td className="px-4 py-3">${plan.pricePerGbUsd}</td>
                  <td className="px-4 py-3 text-gray-400">{formatBandwidth(plan.monthlyBandwidthGB)}</td>
                  <td className="px-4 py-3 text-gray-400">
                    {plan.pricePerGbCents < 500
                      ? `${Math.round((1 - plan.pricePerGbCents / 500) * 100)}% off`
                      : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
