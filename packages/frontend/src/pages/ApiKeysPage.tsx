import { useState } from "react";
import { useApi } from "../hooks/useApi";
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

export default function ApiKeysPage() {
  const { data, loading, error, refetch } = useApi<KeysResponse>(() => get("/api/keys"));
  const [showCreate, setShowCreate] = useState(false);
  const [newLabel, setNewLabel] = useState("Default");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

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
