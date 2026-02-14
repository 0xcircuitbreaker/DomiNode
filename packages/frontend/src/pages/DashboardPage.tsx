import { useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../hooks/useApi";
import { useAuth } from "../context/AuthContext";
import { get } from "../api/client";
import UsageChart from "../components/UsageChart";
import ActiveSessions from "../components/ActiveSessions";

interface ProxyStatusResponse {
  status: "operational" | "degraded" | "down" | "unknown";
  circuitBreaker: string;
  activeSessions: number;
  userActiveSessions: number;
  avgLatencyMs: number;
  endpoints: {
    http: string;
    socks5: string;
  };
  uptimeSeconds: number;
}

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

const statusColors: Record<string, { dot: string; bg: string; text: string }> = {
  operational: { dot: "bg-green-400", bg: "bg-green-900/30", text: "text-green-400" },
  degraded: { dot: "bg-yellow-400", bg: "bg-yellow-900/30", text: "text-yellow-400" },
  down: { dot: "bg-red-400", bg: "bg-red-900/30", text: "text-red-400" },
  unknown: { dot: "bg-gray-400", bg: "bg-gray-900/30", text: "text-gray-400" },
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);
  return (
    <button
      onClick={handleCopy}
      className="ml-2 text-xs text-gray-500 hover:text-gray-300 transition-colors"
      title="Copy to clipboard"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  const { data: wallet } = useApi<WalletResponse>(() => get("/api/wallet"));
  const { data: usage } = useApi<UsageResponse>(() => get("/api/usage"));
  const { data: daily } = useApi<DailyResponse>(() => get("/api/usage/daily"));
  const { data: userPlan } = useApi<UserPlanResponse>(() => get("/api/plans/user/plan"));
  const { data: proxyStatus } = useApi<ProxyStatusResponse>(() => get("/api/proxy/status"));
  const [chartMetric, setChartMetric] = useState<ChartMetric>("bandwidth");

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>

      {/* Wallet Address (if linked) */}
      {user?.wallet_address && (
        <div className="bg-gray-900 border border-indigo-800/40 rounded-xl p-3 sm:p-4 flex items-center gap-3 min-w-0">
          <span className="text-indigo-400 text-xs sm:text-sm font-medium flex-shrink-0">Wallet</span>
          <code className="text-xs font-mono text-gray-300 truncate">{user.wallet_address}</code>
        </div>
      )}

      {/* Proxy Status */}
      {proxyStatus && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h2 className="font-semibold">Proxy Status</h2>
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${statusColors[proxyStatus.status]?.bg ?? statusColors.unknown.bg} ${statusColors[proxyStatus.status]?.text ?? statusColors.unknown.text}`}>
              <span className={`h-2 w-2 rounded-full ${statusColors[proxyStatus.status]?.dot ?? statusColors.unknown.dot}`} />
              {proxyStatus.status.charAt(0).toUpperCase() + proxyStatus.status.slice(1)}
            </span>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 text-sm">
            <div>
              <p className="text-gray-500 text-xs">Active Sessions</p>
              <p className="font-medium">{proxyStatus.activeSessions}</p>
            </div>
            <div>
              <p className="text-gray-500 text-xs">Avg Latency</p>
              <p className="font-medium">{proxyStatus.avgLatencyMs}ms</p>
            </div>
            <div className="min-w-0">
              <p className="text-gray-500 text-xs">HTTP Proxy</p>
              <p className="font-mono text-xs text-gray-300 truncate">
                {proxyStatus.endpoints.http}
                <CopyButton text={proxyStatus.endpoints.http} />
              </p>
            </div>
            <div className="min-w-0">
              <p className="text-gray-500 text-xs">SOCKS5 Proxy</p>
              <p className="font-mono text-xs text-gray-300 truncate">
                {proxyStatus.endpoints.socks5}
                <CopyButton text={proxyStatus.endpoints.socks5} />
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 sm:p-5">
          <p className="text-sm text-gray-400">Current Plan</p>
          <p className="text-xl sm:text-2xl lg:text-3xl font-bold text-indigo-400 mt-1">
            {userPlan?.plan.name ?? "..."}
          </p>
          <p className="text-xs text-gray-500 mt-1">
            ${userPlan?.plan.pricePerGbUsd ?? "5.00"}/GB
          </p>
          <Link to="/app/plans" className="text-sm text-indigo-400 hover:text-indigo-300 mt-2 inline-block">
            Manage plan &rarr;
          </Link>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 sm:p-5">
          <p className="text-sm text-gray-400">Wallet Balance</p>
          <p className="text-xl sm:text-2xl lg:text-3xl font-bold text-green-400 mt-1">
            ${wallet?.balanceUsd.toFixed(2) ?? "0.00"}
          </p>
          <p className="text-xs text-gray-500 mt-1">
            ={" "}
            {wallet && userPlan && userPlan.plan.pricePerGbCents > 0
              ? (wallet.balanceCents / userPlan.plan.pricePerGbCents).toFixed(2)
              : wallet
                ? (wallet.balanceCents / 500).toFixed(2)
                : "0.00"}{" "}
            GB at current rate
          </p>
          <Link to="/app/wallet" className="text-sm text-indigo-400 hover:text-indigo-300 mt-2 inline-block">
            Top up &rarr;
          </Link>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 sm:p-5">
          <p className="text-sm text-gray-400">Data Used (30 days)</p>
          <p className="text-xl sm:text-2xl lg:text-3xl font-bold mt-1">
            {usage?.summary.totalGB.toFixed(3) ?? "0.000"} GB
          </p>
          <Link to="/app/usage" className="text-sm text-indigo-400 hover:text-indigo-300 mt-2 inline-block">
            View details &rarr;
          </Link>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 sm:p-5">
          <p className="text-sm text-gray-400">Total Spent (30 days)</p>
          <p className="text-xl sm:text-2xl lg:text-3xl font-bold mt-1">
            ${usage?.summary.totalCostUsd.toFixed(2) ?? "0.00"}
          </p>
          <p className="text-xs text-gray-500 mt-2">
            {usage?.summary.requestCount ?? 0} requests
          </p>
        </div>
      </div>

      {/* Usage Chart */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <h2 className="font-semibold">Usage (Last 30 Days)</h2>
          <div className="flex flex-wrap gap-1">
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
        <div className="flex flex-wrap gap-3">
          <Link
            to="/app/keys"
            className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            Manage API Keys
          </Link>
          <Link
            to="/app/wallet"
            className="bg-gray-800 hover:bg-gray-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            Top Up Wallet
          </Link>
          {!user?.wallet_address && (
            <Link
              to="/app/security"
              className="bg-gray-800 hover:bg-gray-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
            >
              Link Wallet
            </Link>
          )}
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
          <div className="bg-gray-950 border border-gray-800 rounded-lg p-3 sm:p-4 font-mono text-xs sm:text-sm overflow-x-auto">
            <p className="text-gray-500 mb-1"># Basic (rotating IP)</p>
            <p className="text-gray-300 break-all">
              curl -x http://user:<span className="text-indigo-400">YOUR_API_KEY</span>@proxy.dominode.io:8080 https://httpbin.org/ip
            </p>
          </div>

          {/* Geo-targeting */}
          <div className="bg-gray-950 border border-gray-800 rounded-lg p-3 sm:p-4 font-mono text-xs sm:text-sm overflow-x-auto">
            <p className="text-gray-500 mb-1"># Geo-targeted (US IP)</p>
            <p className="text-gray-300 break-all">
              curl -x http://<span className="text-green-400">country-US</span>:<span className="text-indigo-400">YOUR_API_KEY</span>@proxy.dominode.io:8080 https://httpbin.org/ip
            </p>
          </div>

          {/* Sticky sessions */}
          <div className="bg-gray-950 border border-gray-800 rounded-lg p-3 sm:p-4 font-mono text-xs sm:text-sm overflow-x-auto">
            <p className="text-gray-500 mb-1"># Sticky session (same IP for multiple requests)</p>
            <p className="text-gray-300 break-all">
              curl -x http://<span className="text-green-400">session-abc123</span>:<span className="text-indigo-400">YOUR_API_KEY</span>@proxy.dominode.io:8080 https://httpbin.org/ip
            </p>
          </div>

          {/* Combined */}
          <div className="bg-gray-950 border border-gray-800 rounded-lg p-3 sm:p-4 font-mono text-xs sm:text-sm overflow-x-auto">
            <p className="text-gray-500 mb-1"># Geo-targeted + sticky session</p>
            <p className="text-gray-300 break-all">
              curl -x http://<span className="text-green-400">country-DE-session-mysess</span>:<span className="text-indigo-400">YOUR_API_KEY</span>@proxy.dominode.io:8080 https://httpbin.org/ip
            </p>
          </div>

          {/* SOCKS5 */}
          <div className="bg-gray-950 border border-gray-800 rounded-lg p-3 sm:p-4 font-mono text-xs sm:text-sm overflow-x-auto">
            <p className="text-gray-500 mb-1"># SOCKS5 proxy</p>
            <p className="text-gray-300 break-all">
              curl --socks5-hostname <span className="text-green-400">country-US</span>:<span className="text-indigo-400">YOUR_API_KEY</span>@proxy.dominode.io:1080 https://httpbin.org/ip
            </p>
          </div>

          {/* Python */}
          <div className="bg-gray-950 border border-gray-800 rounded-lg p-3 sm:p-4 font-mono text-xs sm:text-sm overflow-x-auto">
            <p className="text-gray-500 mb-1"># Python requests</p>
            <p className="text-gray-300 break-all">
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
