import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { useAuth } from "../context/AuthContext";
import { get, post, del } from "../api/client";
import Modal from "../components/Modal";
import ResponsiveTable from "../components/ResponsiveTable";

interface ApiKey {
  id: string;
  prefix: string;
  label: string;
  created_at: string;
  revoked_at: string | null;
}

interface KeysResponse {
  keys: ApiKey[];
}

interface CreateKeyResponse {
  key: string;
  id: string;
  prefix: string;
  label: string;
}

interface ProxySessionResponse {
  proxyToken: string;
  expiresAt: string;
  ttlMinutes: number;
  usage: string;
}

export default function ApiKeysPage() {
  const { user } = useAuth();
  const { data, loading, error, refetch } = useApi<KeysResponse>(() => get("/api/keys"));
  const [showCreate, setShowCreate] = useState(false);
  const [newLabel, setNewLabel] = useState("Default");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Proxy session token state
  const [proxyToken, setProxyToken] = useState<string | null>(null);
  const [proxyExpiry, setProxyExpiry] = useState<string | null>(null);
  const [proxyTtl, setProxyTtl] = useState("60");
  const [generatingProxy, setGeneratingProxy] = useState(false);
  const [proxyCopied, setProxyCopied] = useState(false);

  const hasWallet = !!user?.wallet_address;

  async function handleCreate() {
    const labelPattern = /^[a-zA-Z0-9 _-]+$/;
    if (!newLabel || newLabel.length > 50 || !labelPattern.test(newLabel)) {
      setActionError("Label must be 1-50 characters (letters, numbers, spaces, hyphens, underscores).");
      return;
    }
    setCreating(true);
    setActionError(null);
    try {
      const res = await post<CreateKeyResponse>("/api/keys", { label: newLabel });
      setNewKey(res.key);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to create key.");
    } finally {
      setCreating(false);
    }
  }

  // Validate API key ID format before using in URL path
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  async function handleRevoke(id: string) {
    if (!UUID_RE.test(id)) {
      setActionError("Invalid key ID format");
      return;
    }
    if (!confirm("Revoke this API key? This cannot be undone.")) return;
    setRevoking(id);
    setActionError(null);
    try {
      await del(`/api/keys/${id}`);
      refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to revoke key.");
    } finally {
      setRevoking(null);
    }
  }

  function handleCopy() {
    if (newKey) {
      navigator.clipboard.writeText(newKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  function handleCloseCreate() {
    setShowCreate(false);
    setNewKey(null);
    setNewLabel("Default");
    if (newKey) refetch();
  }

  async function handleGenerateProxyToken() {
    setGeneratingProxy(true);
    setActionError(null);
    try {
      const ttlMinutes = Math.max(1, Math.min(1440, parseInt(proxyTtl, 10) || 60));
      const res = await post<ProxySessionResponse>("/api/auth/wallet/proxy-session", { ttlMinutes });
      setProxyToken(res.proxyToken);
      setProxyExpiry(res.expiresAt);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to generate proxy token.");
    } finally {
      setGeneratingProxy(false);
    }
  }

  function handleCopyProxyToken() {
    if (proxyToken) {
      navigator.clipboard.writeText(proxyToken);
      setProxyCopied(true);
      setTimeout(() => setProxyCopied(false), 2000);
    }
  }

  const activeKeys = data?.keys.filter((k) => !k.revoked_at) ?? [];
  const revokedKeys = data?.keys.filter((k) => k.revoked_at) ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">API Keys</h1>
        <button
          onClick={() => setShowCreate(true)}
          className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
        >
          Create Key
        </button>
      </div>

      {(error || actionError) && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-sm text-red-400">
          {actionError || error}
        </div>
      )}

      {/* Wallet Proxy Session Token */}
      {hasWallet && (
        <div className="bg-gray-900 border border-emerald-800/50 rounded-xl p-4 sm:p-5 space-y-4">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
            <h2 className="text-sm font-semibold text-emerald-400">Wallet Proxy Authentication</h2>
          </div>
          <p className="text-sm text-gray-400">
            Use your linked wallet ({user?.wallet_address?.slice(0, 6)}...{user?.wallet_address?.slice(-4)}) to authenticate proxy requests without API keys. Generate a session token that works just like an API key.
          </p>

          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Duration (minutes)</label>
              <select
                value={proxyTtl}
                onChange={(e) => setProxyTtl(e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-emerald-500"
              >
                <option value="15">15 min</option>
                <option value="60">1 hour</option>
                <option value="240">4 hours</option>
                <option value="480">8 hours</option>
                <option value="1440">24 hours</option>
              </select>
            </div>
            <button
              onClick={handleGenerateProxyToken}
              disabled={generatingProxy}
              className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
            >
              {generatingProxy ? "Generating..." : "Generate Proxy Token"}
            </button>
          </div>

          {proxyToken && (
            <div className="space-y-3 border-t border-gray-800 pt-3">
              <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2 text-sm text-yellow-300">
                Copy this token now. It cannot be retrieved later. Expires {proxyExpiry ? new Date(proxyExpiry).toLocaleString() : "soon"}.
              </div>
              <div className="flex gap-2">
                <input
                  readOnly
                  value={proxyToken}
                  autoComplete="off"
                  data-lpignore="true"
                  className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded-lg px-2 sm:px-3 py-2 text-xs font-mono"
                />
                <button
                  onClick={handleCopyProxyToken}
                  className="bg-gray-700 hover:bg-gray-600 px-3 py-2 rounded-lg text-sm transition-colors flex-shrink-0"
                >
                  {proxyCopied ? "Copied!" : "Copy"}
                </button>
              </div>
              <div className="bg-gray-800 rounded-lg px-3 py-2">
                <p className="text-xs text-gray-500 mb-1">Usage example:</p>
                <code className="text-xs text-emerald-400 break-all">
                  curl -x http://country-US:{proxyToken.slice(0, 20)}...@proxy:8080 https://httpbin.org/ip
                </code>
              </div>
              <button
                onClick={() => { setProxyToken(null); setProxyExpiry(null); }}
                className="w-full bg-gray-800 hover:bg-gray-700 text-gray-400 text-sm font-medium py-2 rounded-lg transition-colors"
              >
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}

      {loading ? (
        <p className="text-gray-500">Loading...</p>
      ) : (
        <>
          {/* Active Keys */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <ResponsiveTable<ApiKey>
              columns={[
                { key: "prefix", header: "Prefix", primary: true, render: (k) => <span className="font-mono text-indigo-400">{k.prefix}...</span> },
                { key: "label", header: "Label", render: (k) => k.label },
                { key: "created", header: "Created", render: (k) => <span className="text-gray-400">{new Date(k.created_at).toLocaleDateString()}</span> },
                { key: "actions", header: "Actions", align: "right", render: (k) => (
                  <button
                    onClick={() => handleRevoke(k.id)}
                    disabled={revoking === k.id}
                    className="text-red-400 hover:text-red-300 text-sm disabled:opacity-50"
                  >
                    {revoking === k.id ? "Revoking..." : "Revoke"}
                  </button>
                )},
              ]}
              data={activeKeys}
              keyExtractor={(k) => k.id}
              emptyMessage="No active API keys. Create one to get started."
            />
          </div>

          {/* Revoked Keys */}
          {revokedKeys.length > 0 && (
            <div>
              <h2 className="text-sm font-medium text-gray-500 mb-2">Revoked Keys</h2>
              <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden opacity-60">
                <ResponsiveTable<ApiKey>
                  columns={[
                    { key: "prefix", header: "Prefix", primary: true, render: (k) => <span className="font-mono text-gray-500">{k.prefix}...</span> },
                    { key: "label", header: "Label", render: (k) => <span className="text-gray-500">{k.label}</span> },
                    { key: "revoked", header: "Revoked", render: (k) => <span className="text-gray-500">Revoked {new Date(k.revoked_at!).toLocaleDateString()}</span> },
                  ]}
                  data={revokedKeys}
                  keyExtractor={(k) => k.id}
                />
              </div>
            </div>
          )}
        </>
      )}

      {/* Create Key Modal */}
      <Modal open={showCreate} onClose={handleCloseCreate} title={newKey ? "Key Created" : "Create API Key"}>
        {!newKey ? (
          <div className="space-y-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Label</label>
              <input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                required
                maxLength={50}
                pattern="[a-zA-Z0-9 _-]+"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                placeholder="e.g. Production, Scraper, etc."
              />
            </div>
            <button
              onClick={handleCreate}
              disabled={creating}
              className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium py-2.5 rounded-lg transition-colors"
            >
              {creating ? "Creating..." : "Create Key"}
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2 text-sm text-yellow-300">
              Copy this key now. You won't be able to see it again.
            </div>
            <div className="flex gap-2">
              <input
                readOnly
                value={newKey}
                autoComplete="off"
                data-lpignore="true"
                className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded-lg px-2 sm:px-3 py-2 text-xs sm:text-sm font-mono"
              />
              <button
                onClick={handleCopy}
                className="bg-gray-700 hover:bg-gray-600 px-3 py-2 rounded-lg text-sm transition-colors flex-shrink-0"
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
            <button
              onClick={handleCloseCreate}
              className="w-full bg-gray-800 hover:bg-gray-700 text-white font-medium py-2.5 rounded-lg transition-colors"
            >
              Done
            </button>
          </div>
        )}
      </Modal>
    </div>
  );
}
