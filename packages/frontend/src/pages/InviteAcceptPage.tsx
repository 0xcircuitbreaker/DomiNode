import { useState, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { get, post } from "../api/client";

interface InviteDetails {
  teamName: string;
  role: string;
  email: string;
  expiresAt: string;
}

export default function InviteAcceptPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get("token") ?? "";

  const [invite, setInvite] = useState<InviteDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    if (!token) {
      setError("No invite token provided.");
      setLoading(false);
      return;
    }

    // Validate token format: only allow alphanumeric, hyphens, underscores, dots
    const tokenPattern = /^[a-zA-Z0-9._-]+$/;
    if (!tokenPattern.test(token) || token.length > 512) {
      setError("Invalid invite token.");
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function fetchInvite() {
      try {
        const res = await get<InviteDetails>(
          `/api/teams/invites/${encodeURIComponent(token)}`,
          { redirectOnUnauthorized: false },
        );
        if (!cancelled) {
          setInvite(res);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load invite details.");
          setLoading(false);
        }
      }
    }

    fetchInvite();
    return () => { cancelled = true; };
  }, [token]);

  async function handleAccept() {
    if (!token) return;
    setAccepting(true);
    setError(null);
    try {
      await post(`/api/teams/invites/${encodeURIComponent(token)}/accept`);
      setAccepted(true);
      setTimeout(() => {
        navigate("/app/teams");
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to accept invite.");
    } finally {
      setAccepting(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-gray-800 border border-gray-700 rounded-xl p-6 sm:p-8 space-y-6">
        <h1 className="text-2xl font-bold text-center text-gray-100">Team Invitation</h1>

        {/* Error state */}
        {error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        {/* Loading state */}
        {loading && !error && (
          <div className="text-center py-8">
            <p className="text-gray-400">Loading invite details...</p>
          </div>
        )}

        {/* Invite details */}
        {invite && !accepted && (
          <div className="space-y-4">
            <div className="bg-gray-900 rounded-lg p-4 space-y-3">
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wider">Team</p>
                <p className="text-lg font-semibold text-gray-100 mt-0.5">{invite.teamName}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wider">Role</p>
                <p className="mt-0.5">
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                    invite.role === "admin"
                      ? "bg-yellow-500/20 text-yellow-400"
                      : "bg-gray-500/20 text-gray-400"
                  }`}>
                    {invite.role}
                  </span>
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wider">Invited as</p>
                <p className="text-sm text-gray-300 mt-0.5">{invite.email}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wider">Expires</p>
                <p className="text-sm text-gray-300 mt-0.5">
                  {new Date(invite.expiresAt).toLocaleDateString()}
                </p>
              </div>
            </div>

            <button
              onClick={handleAccept}
              disabled={accepting}
              className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium py-2.5 rounded-lg transition-colors"
            >
              {accepting ? "Accepting..." : "Accept Invitation"}
            </button>
          </div>
        )}

        {/* Success state */}
        {accepted && (
          <div className="text-center py-4 space-y-3">
            <div className="bg-green-500/10 border border-green-500/20 rounded-lg px-4 py-3 text-sm text-green-400">
              Invitation accepted successfully!
            </div>
            <p className="text-sm text-gray-400">Redirecting to teams page...</p>
          </div>
        )}
      </div>
    </div>
  );
}
