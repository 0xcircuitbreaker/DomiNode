import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { get, post, del } from "../api/client";
import Modal from "../components/Modal";

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

  async function handleRevoke(id: string) {
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
      <div className="flex items-center justify-between">
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
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-gray-400">
                  <th className="text-left px-4 py-3 font-medium">Prefix</th>
                  <th className="text-left px-4 py-3 font-medium">Label</th>
                  <th className="text-left px-4 py-3 font-medium">Created</th>
                  <th className="text-right px-4 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {activeKeys.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-gray-500">
                      No active API keys. Create one to get started.
                    </td>
                  </tr>
                ) : (
                  activeKeys.map((key) => (
                    <tr key={key.id} className="border-b border-gray-800/50">
                      <td className="px-4 py-3 font-mono text-indigo-400">{key.prefix}...</td>
                      <td className="px-4 py-3">{key.label}</td>
                      <td className="px-4 py-3 text-gray-400">
                        {new Date(key.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => handleRevoke(key.id)}
                          disabled={revoking === key.id}
                          className="text-red-400 hover:text-red-300 text-sm disabled:opacity-50"
                        >
                          {revoking === key.id ? "Revoking..." : "Revoke"}
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Revoked Keys */}
          {revokedKeys.length > 0 && (
            <div>
              <h2 className="text-sm font-medium text-gray-500 mb-2">Revoked Keys</h2>
              <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden opacity-60">
                <table className="w-full text-sm">
                  <tbody>
                    {revokedKeys.map((key) => (
                      <tr key={key.id} className="border-b border-gray-800/50">
                        <td className="px-4 py-3 font-mono text-gray-500">{key.prefix}...</td>
                        <td className="px-4 py-3 text-gray-500">{key.label}</td>
                        <td className="px-4 py-3 text-gray-500">
                          Revoked {new Date(key.revoked_at!).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono"
              />
              <button
                onClick={handleCopy}
                className="bg-gray-700 hover:bg-gray-600 px-3 py-2 rounded-lg text-sm transition-colors"
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
