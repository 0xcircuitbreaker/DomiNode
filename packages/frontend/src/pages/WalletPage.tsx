import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { get, post } from "../api/client";

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

const PRESETS = [500, 1000, 2500, 5000, 10000]; // cents
const CRYPTO_OPTIONS = ["btc", "eth", "xmr", "sol", "zec"] as const;

export default function WalletPage() {
  const { data: wallet, error: walletError, refetch: refetchWallet } = useApi<WalletResponse>(() => get("/api/wallet"));
  const { data: txData, error: txError } = useApi<TxResponse>(() => get("/api/wallet/transactions"));
  const { data: userPlan } = useApi<UserPlanResponse>(() => get("/api/plans/user/plan"));
  const pricePerGbCents = userPlan?.plan.pricePerGbCents ?? 500;
  const [amount, setAmount] = useState(1000);
  const [customAmount, setCustomAmount] = useState("");
  const [loadingStripe, setLoadingStripe] = useState(false);
  const [loadingCrypto, setLoadingCrypto] = useState(false);
  const [selectedCrypto, setSelectedCrypto] = useState<string>("btc");
  const [paymentError, setPaymentError] = useState<string | null>(null);

  const effectiveAmount = customAmount ? parseInt(customAmount, 10) * 100 : amount;

  async function handleStripe() {
    setLoadingStripe(true);
    setPaymentError(null);
    try {
      const res = await post<{ url: string }>("/api/wallet/topup/stripe", {
        amountCents: effectiveAmount,
      });
      window.location.href = res.url;
    } catch (err) {
      setPaymentError(err instanceof Error ? err.message : "Payment failed. Please try again.");
    } finally {
      setLoadingStripe(false);
    }
  }

  async function handleCrypto() {
    setLoadingCrypto(true);
    setPaymentError(null);
    try {
      const res = await post<{ invoiceUrl: string }>("/api/wallet/topup/crypto", {
        amountUsd: effectiveAmount / 100,
        currency: selectedCrypto,
      });
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
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <p className="text-sm text-gray-400">Current Balance</p>
        <p className="text-4xl font-bold text-green-400 mt-1">
          ${wallet?.balanceUsd.toFixed(2) ?? "0.00"}
        </p>
        {wallet?.lastToppedUp && (
          <p className="text-xs text-gray-500 mt-2">
            Last topped up: {new Date(wallet.lastToppedUp).toLocaleDateString()}
          </p>
        )}
        <p className="text-xs text-gray-500 mt-1">
          ={" "}
          {wallet
            ? (wallet.balanceCents / pricePerGbCents).toFixed(2)
            : "0.00"}{" "}
          GB of bandwidth at ${(pricePerGbCents / 100).toFixed(2)}/GB ({userPlan?.plan.name ?? "..."})
        </p>
      </div>

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
            {(effectiveAmount / pricePerGbCents).toFixed(2)} GB of bandwidth at ${(pricePerGbCents / 100).toFixed(2)}/GB
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
              className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium py-2.5 rounded-lg transition-colors"
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
                  className={`px-3 py-1.5 rounded text-xs font-medium uppercase transition-colors ${
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
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-gray-400">
              <th className="text-left px-4 py-3 font-medium">Type</th>
              <th className="text-left px-4 py-3 font-medium">Amount</th>
              <th className="text-left px-4 py-3 font-medium">Description</th>
              <th className="text-left px-4 py-3 font-medium">Provider</th>
              <th className="text-left px-4 py-3 font-medium">Date</th>
            </tr>
          </thead>
          <tbody>
            {!txData?.transactions.length ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                  No transactions yet.
                </td>
              </tr>
            ) : (
              txData.transactions.map((tx) => (
                <tr key={tx.id} className="border-b border-gray-800/50">
                  <td className="px-4 py-3">
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
                  </td>
                  <td className={`px-4 py-3 font-medium ${tx.type === "topup" ? "text-green-400" : "text-red-400"}`}>
                    {tx.type === "topup" ? "+" : "-"}${Math.abs(tx.amountUsd).toFixed(2)}
                  </td>
                  <td className="px-4 py-3 text-gray-400">{tx.description}</td>
                  <td className="px-4 py-3 text-gray-500">{tx.paymentProvider ?? "-"}</td>
                  <td className="px-4 py-3 text-gray-400">
                    {new Date(tx.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
