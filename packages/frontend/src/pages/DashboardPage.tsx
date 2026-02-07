import { useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../hooks/useApi";
import { get } from "../api/client";
import UsageChart from "../components/UsageChart";
import ActiveSessions from "../components/ActiveSessions";

interface PlanItem {
  id: string;
  name: string;
  pricePerGbCents: number;
  pricePerGbUsd: number;
  monthlyBandwidthBytes: number;
  monthlyBandwidthGB: number | null;
  isDefault: boolean;
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

interface WalletResponse {
  balanceCents: number;
  balanceUsd: number;
}

interface UsageResponse {
  summary: {
    totalBytes: number;
    totalCostCents: number;
    requestCount: number;
    totalGB: number;
    totalCostUsd: number;
  };
}

interface DailyDay {
  date: string;
  totalGB: number;
  totalCostUsd: number;
  requestCount: number;
}

interface DailyResponse {
  days: DailyDay[];
}

type ChartMetric = "bandwidth" | "cost" | "requests";

export default function DashboardPage() {
  const { data: wallet } = useApi<WalletResponse>(() => get("/api/wallet"));
  const { data: usage } = useApi<UsageResponse>(() => get("/api/usage"));
  const { data: daily } = useApi<DailyResponse>(() => get("/api/usage/daily"));
  const { data: userPlan } = useApi<UserPlanResponse>(() => get("/api/plans/user/plan"));
  const [chartMetric, setChartMetric] = useState<ChartMetric>("bandwidth");

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <p className="text-sm text-gray-400">Current Plan</p>
          <p className="text-3xl font-bold text-indigo-400 mt-1">
            {userPlan?.plan.name ?? "..."}
          </p>
          <p className="text-xs text-gray-500 mt-1">
            ${userPlan?.plan.pricePerGbUsd ?? "5.00"}/GB
          </p>
          <Link to="/plans" className="text-sm text-indigo-400 hover:text-indigo-300 mt-2 inline-block">
            Manage plan &rarr;
          </Link>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <p className="text-sm text-gray-400">Wallet Balance</p>
          <p className="text-3xl font-bold text-green-400 mt-1">
            ${wallet?.balanceUsd.toFixed(2) ?? "0.00"}
          </p>
          <p className="text-xs text-gray-500 mt-1">
            ={" "}
            {wallet && userPlan
              ? (wallet.balanceCents / userPlan.plan.pricePerGbCents).toFixed(2)
              : wallet
                ? (wallet.balanceCents / 500).toFixed(2)
                : "0.00"}{" "}
            GB at current rate
          </p>
          <Link to="/wallet" className="text-sm text-indigo-400 hover:text-indigo-300 mt-2 inline-block">
            Top up &rarr;
          </Link>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <p className="text-sm text-gray-400">Data Used (30 days)</p>
          <p className="text-3xl font-bold mt-1">
            {usage?.summary.totalGB.toFixed(3) ?? "0.000"} GB
          </p>
          <Link to="/usage" className="text-sm text-indigo-400 hover:text-indigo-300 mt-2 inline-block">
            View details &rarr;
          </Link>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <p className="text-sm text-gray-400">Total Spent (30 days)</p>
          <p className="text-3xl font-bold mt-1">
            ${usage?.summary.totalCostUsd.toFixed(2) ?? "0.00"}
          </p>
          <p className="text-xs text-gray-500 mt-2">
            {usage?.summary.requestCount ?? 0} requests
          </p>
        </div>
      </div>

      {/* Usage Chart */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold">Usage (Last 30 Days)</h2>
          <div className="flex gap-1">
            {(["bandwidth", "cost", "requests"] as ChartMetric[]).map((m) => (
              <button
                key={m}
                onClick={() => setChartMetric(m)}
                className={`px-3 py-1 rounded text-xs font-medium capitalize transition-colors ${
                  chartMetric === m
                    ? "bg-indigo-600 text-white"
                    : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
        <UsageChart days={daily?.days ?? []} metric={chartMetric} />
      </div>

      {/* Active Sessions */}
      <ActiveSessions />

      {/* Quick Actions */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <h2 className="font-semibold mb-3">Quick Actions</h2>
        <div className="flex gap-3">
          <Link
            to="/keys"
            className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            Manage API Keys
          </Link>
          <Link
            to="/wallet"
            className="bg-gray-800 hover:bg-gray-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            Top Up Wallet
          </Link>
        </div>
      </div>

      {/* Getting Started */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <h2 className="font-semibold mb-3">Getting Started</h2>
        <p className="text-sm text-gray-400 mb-3">
          Use your API key as the proxy password. Username controls routing options.
        </p>
        <div className="space-y-4">
          {/* Basic usage */}
          <div className="bg-gray-950 border border-gray-800 rounded-lg p-4 font-mono text-sm">
            <p className="text-gray-500 mb-1"># Basic (rotating IP)</p>
            <p className="text-gray-300">
              curl -x http://user:<span className="text-indigo-400">YOUR_API_KEY</span>@proxy.dominode.io:8080 https://httpbin.org/ip
            </p>
          </div>

          {/* Geo-targeting */}
          <div className="bg-gray-950 border border-gray-800 rounded-lg p-4 font-mono text-sm">
            <p className="text-gray-500 mb-1"># Geo-targeted (US IP)</p>
            <p className="text-gray-300">
              curl -x http://<span className="text-green-400">country-US</span>:<span className="text-indigo-400">YOUR_API_KEY</span>@proxy.dominode.io:8080 https://httpbin.org/ip
            </p>
          </div>

          {/* Sticky sessions */}
          <div className="bg-gray-950 border border-gray-800 rounded-lg p-4 font-mono text-sm">
            <p className="text-gray-500 mb-1"># Sticky session (same IP for multiple requests)</p>
            <p className="text-gray-300">
              curl -x http://<span className="text-green-400">session-abc123</span>:<span className="text-indigo-400">YOUR_API_KEY</span>@proxy.dominode.io:8080 https://httpbin.org/ip
            </p>
          </div>

          {/* Combined */}
          <div className="bg-gray-950 border border-gray-800 rounded-lg p-4 font-mono text-sm">
            <p className="text-gray-500 mb-1"># Geo-targeted + sticky session</p>
            <p className="text-gray-300">
              curl -x http://<span className="text-green-400">country-DE-session-mysess</span>:<span className="text-indigo-400">YOUR_API_KEY</span>@proxy.dominode.io:8080 https://httpbin.org/ip
            </p>
          </div>

          {/* SOCKS5 */}
          <div className="bg-gray-950 border border-gray-800 rounded-lg p-4 font-mono text-sm">
            <p className="text-gray-500 mb-1"># SOCKS5 proxy</p>
            <p className="text-gray-300">
              curl --socks5-hostname <span className="text-green-400">country-US</span>:<span className="text-indigo-400">YOUR_API_KEY</span>@proxy.dominode.io:1080 https://httpbin.org/ip
            </p>
          </div>

          {/* Python */}
          <div className="bg-gray-950 border border-gray-800 rounded-lg p-4 font-mono text-sm">
            <p className="text-gray-500 mb-1"># Python requests</p>
            <p className="text-gray-300">
              proxies = {'{'}"https": "http://country-US:<span className="text-indigo-400">YOUR_API_KEY</span>@proxy.dominode.io:8080"{'}'}
            </p>
          </div>
        </div>
        <p className="text-xs text-gray-500 mt-3">
          Pricing: From $3.00/GB &middot; HTTP &amp; SOCKS5 &middot; Residential IPs &middot; 195+ countries &middot; Geo-targeting &middot; Sticky sessions
        </p>
      </div>
    </div>
  );
}
