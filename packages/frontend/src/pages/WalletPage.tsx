import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { get, post } from "../api/client";
import ResponsiveTable from "../components/ResponsiveTable";

interface ForecastResponse {
  dailyAvgCents: number;
  daysRemaining: number | null;
  trend: "up" | "down" | "stable";
  trendPct: number;
}

interface UserPlanResponse {
  plan: {
    id: string;
    name: string;
    pricePerGbCents: number;
    pricePerGbUsd: number;
  };
}

interface WalletResponse {
  balanceCents: number;
  balanceUsd: number;
  lastToppedUp: string | null;
}

interface Transaction {
  id: string;
  type: string;
  amountCents: number;
  amountUsd: number;
  description: string;
  paymentProvider: string | null;
  createdAt: string;
}

interface TxResponse {
  transactions: Transaction[];
}

// R19 H-4: Use strict hostname matching with dot-prefix to prevent subdomain bypass
// (e.g., evil-stripe.com would match endsWith("stripe.com"))
function isAllowedPaymentUrl(url: string, allowedHosts: string[]): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const hostname = parsed.hostname.toLowerCase();
    return allowedHosts.some(h => {
      const allowed = h.toLowerCase();
      return hostname === allowed || hostname.endsWith("." + allowed);
    });
  } catch {
    return false;
  }
}

const PRESETS = [500, 1000, 2500, 5000, 10000]; // cents
const CRYPTO_OPTIONS = ["btc", "eth", "ltc", "xmr", "zec", "usdc"] as const;

export default function WalletPage() {
  const { data: wallet, error: walletError, refetch: refetchWallet } = useApi<WalletResponse>(() => get("/api/wallet"));
  const { data: txData, error: txError } = useApi<TxResponse>(() => get("/api/wallet/transactions"));
  const { data: userPlan } = useApi<UserPlanResponse>(() => get("/api/plans/user/plan"));
  const { data: forecast } = useApi<ForecastResponse>(() => get("/api/wallet/forecast"));
  const pricePerGbCents = userPlan?.plan.pricePerGbCents ?? 500;
  const [amount, setAmount] = useState(1000);
  const [customAmount, setCustomAmount] = useState("");
  const [loadingStripe, setLoadingStripe] = useState(false);
  const [loadingCrypto, setLoadingCrypto] = useState(false);
  const [selectedCrypto, setSelectedCrypto] = useState<string>("btc");
  const [paymentError, setPaymentError] = useState<string | null>(null);

  const rawCustom = customAmount ? parseInt(customAmount, 10) * 100 : 0;
  const effectiveAmount = customAmount ? rawCustom : amount;
  const isValidAmount = effectiveAmount >= 500 && effectiveAmount <= 100000;

  async function handleStripe() {
    if (!isValidAmount) {
      setPaymentError("Amount must be between $5 and $1,000");
      return;
    }
    setLoadingStripe(true);
    setPaymentError(null);
    try {
      const res = await post<{ url: string }>("/api/wallet/topup/stripe", {
        amountCents: effectiveAmount,
      });
      if (!isAllowedPaymentUrl(res.url, ["stripe.com"])) {
        setPaymentError("Invalid payment URL received");
        return;
      }
      window.location.href = res.url;
    } catch (err) {
      setPaymentError(err instanceof Error ? err.message : "Payment failed. Please try again.");
    } finally {
      setLoadingStripe(false);
    }
  }

  async function handleCrypto() {
    if (!isValidAmount) {
      setPaymentError("Amount must be between $5 and $1,000");
      return;
    }
    setLoadingCrypto(true);
    setPaymentError(null);
    try {
      const res = await post<{ invoiceUrl: string }>("/api/wallet/topup/crypto", {
        amountUsd: effectiveAmount / 100,
        currency: selectedCrypto,
      });
      if (!isAllowedPaymentUrl(res.invoiceUrl, ["nowpayments.io"])) {
        setPaymentError("Invalid payment URL received");
        return;
      }
      window.open(res.invoiceUrl, "_blank", "noopener,noreferrer");
      // Poll for balance update
      setTimeout(() => { refetchWallet(); }, 5000);
    } catch (err) {
      setPaymentError(err instanceof Error ? err.message : "Payment failed. Please try again.");
    } finally {
      setLoadingCrypto(false);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Wallet</h1>

      {(walletError || txError || paymentError) && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-sm text-red-400">
          {paymentError || walletError || txError}
        </div>
      )}

      {/* Balance */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 sm:p-6">
        <p className="text-sm text-gray-400">Current Balance</p>
        <p className="text-2xl sm:text-3xl lg:text-4xl font-bold text-green-400 mt-1">
          ${wallet?.balanceUsd.toFixed(2) ?? "0.00"}
        </p>
        {wallet?.lastToppedUp && (
          <p className="text-xs text-gray-500 mt-2">
            Last topped up: {new Date(wallet.lastToppedUp).toLocaleDateString()}
          </p>
        )}
        <p className="text-xs text-gray-500 mt-1">
          ={" "}
          {wallet && pricePerGbCents > 0
            ? (wallet.balanceCents / pricePerGbCents).toFixed(2)
            : "0.00"}{" "}
          GB of bandwidth at ${(pricePerGbCents / 100).toFixed(2)}/GB ({userPlan?.plan.name ?? "..."})
        </p>
      </div>

      {/* Forecast */}
      {forecast && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <h2 className="text-sm font-medium text-gray-400 mb-3">Spending Forecast</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            <div>
              <p className="text-xs text-gray-500">Daily Avg Spend</p>
              <p className="text-lg sm:text-xl font-bold mt-0.5">
                ${(forecast.dailyAvgCents / 100).toFixed(2)}/day
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Balance Lasts</p>
              <p className={`text-lg sm:text-xl font-bold mt-0.5 ${
                forecast.daysRemaining === null
                  ? "text-green-400"
                  : forecast.daysRemaining > 7
                    ? "text-green-400"
                    : forecast.daysRemaining > 3
                      ? "text-yellow-400"
                      : "text-red-400"
              }`}>
                {forecast.daysRemaining === null
                  ? "No spending"
                  : `~${forecast.daysRemaining} days`}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Trend (vs prev 7d)</p>
              <p className="text-lg sm:text-xl font-bold mt-0.5">
                <span className={
                  forecast.trend === "up" ? "text-red-400" :
                  forecast.trend === "down" ? "text-green-400" :
                  "text-gray-400"
                }>
                  {forecast.trend === "up" ? "\u2191" : forecast.trend === "down" ? "\u2193" : "\u2192"}
                  {" "}{forecast.trendPct}%
                </span>
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Top Up */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
        <h2 className="font-semibold">Top Up</h2>

        {/* Amount Selection */}
        <div>
          <p className="text-sm text-gray-400 mb-2">Select amount</p>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((cents) => (
              <button
                key={cents}
                onClick={() => { setAmount(cents); setCustomAmount(""); }}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  !customAmount && amount === cents
                    ? "bg-indigo-600 text-white"
                    : "bg-gray-800 text-gray-300 hover:bg-gray-700"
                }`}
              >
                ${(cents / 100).toFixed(0)}
              </button>
            ))}
            <input
              type="number"
              placeholder="Custom $"
              value={customAmount}
              onChange={(e) => setCustomAmount(e.target.value)}
              min={5}
              max={1000}
              className="w-24 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
            />
          </div>
          <p className="text-xs text-gray-500 mt-2">
            ${(effectiveAmount / 100).toFixed(2)} ={" "}
            {pricePerGbCents > 0 ? (effectiveAmount / pricePerGbCents).toFixed(2) : "N/A"} GB of bandwidth at ${(pricePerGbCents / 100).toFixed(2)}/GB
          </p>
        </div>

        {/* Payment Methods */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Stripe */}
          <div className="border border-gray-700 rounded-lg p-4">
            <h3 className="text-sm font-medium mb-3">Card Payment (Stripe)</h3>
            <button
              onClick={handleStripe}
              disabled={loadingStripe || effectiveAmount < 500}
              className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium py-2.5 rounded-lg transition-colors text-sm"
            >
              {loadingStripe ? "Redirecting..." : `Pay $${(effectiveAmount / 100).toFixed(2)} with Card`}
            </button>
          </div>

          {/* Crypto */}
          <div className="border border-gray-700 rounded-lg p-4">
            <h3 className="text-sm font-medium mb-3">Crypto Payment</h3>
            <div className="flex gap-2 mb-3">
              {CRYPTO_OPTIONS.map((c) => (
                <button
                  key={c}
                  onClick={() => setSelectedCrypto(c)}
                  className={`px-3 py-1.5 min-h-[44px] rounded text-xs font-medium uppercase transition-colors ${
                    selectedCrypto === c
                      ? "bg-indigo-600 text-white"
                      : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
            <button
              onClick={handleCrypto}
              disabled={loadingCrypto || effectiveAmount < 500}
              className="w-full bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white font-medium py-2.5 rounded-lg transition-colors"
            >
              {loadingCrypto ? "Creating invoice..." : `Pay with ${selectedCrypto.toUpperCase()}`}
            </button>
          </div>
        </div>
      </div>

      {/* Transaction History */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800">
          <h2 className="font-semibold">Transaction History</h2>
        </div>
        <ResponsiveTable<Transaction>
          columns={[
            { key: "type", header: "Type", primary: true, render: (tx) => (
              <span
                className={`px-2 py-0.5 rounded text-xs font-medium ${
                  tx.type === "topup"
                    ? "bg-green-500/10 text-green-400"
                    : tx.type === "debit"
                      ? "bg-red-500/10 text-red-400"
                      : "bg-gray-500/10 text-gray-400"
                }`}
              >
                {tx.type}
              </span>
            )},
            { key: "amount", header: "Amount", render: (tx) => (
              <span className={`font-medium ${tx.type === "topup" ? "text-green-400" : "text-red-400"}`}>
                {tx.type === "topup" ? "+" : "-"}${Math.abs(tx.amountUsd).toFixed(2)}
              </span>
            )},
            { key: "description", header: "Description", render: (tx) => <span className="text-gray-400">{tx.description}</span> },
            { key: "provider", header: "Provider", hideOnMobile: true, render: (tx) => <span className="text-gray-500">{tx.paymentProvider ?? "-"}</span> },
            { key: "date", header: "Date", render: (tx) => <span className="text-gray-400">{new Date(tx.createdAt).toLocaleDateString()}</span> },
          ]}
          data={txData?.transactions ?? []}
          keyExtractor={(tx) => tx.id}
          emptyMessage="No transactions yet."
        />
      </div>
    </div>
  );
}
