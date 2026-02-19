import { useState, useEffect, useCallback } from "react";
import { get, post, del } from "../api/client";

// --- Types ---

interface Team {
  id: string;
  name: string;
  role: string;
  balanceCents: number;
  createdAt: string;
}

interface TeamsResponse {
  teams: Team[];
}

interface TeamDetail {
  id: string;
  name: string;
  role: string;
  balanceCents: number;
  createdAt: string;
}

interface Member {
  id: string;
  userId: string;
  email: string;
  role: string;
  joinedAt: string;
}

interface Invite {
  id: string;
  email: string;
  role: string;
  createdAt: string;
  expiresAt: string;
}

interface TeamKey {
  id: string;
  prefix: string;
  label: string;
  createdAt: string;
}

interface CreateKeyResponse {
  id: string;
  key: string;
  prefix: string;
  label: string;
}

interface Transaction {
  id: string;
  type: string;
  amountCents: number;
  description: string;
  createdAt: string;
}

// --- UUID validation for path params ---
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- Sub-tab type ---
type DetailTab = "members" | "invites" | "keys" | "wallet";

export default function TeamsPage() {
  // --- Top-level state ---
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamsLoading, setTeamsLoading] = useState(true);
  const [teamsError, setTeamsError] = useState<string | null>(null);

  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [teamDetail, setTeamDetail] = useState<TeamDetail | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("members");

  const [createName, setCreateName] = useState("");
  const [creating, setCreating] = useState(false);

  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  // --- Members state ---
  const [members, setMembers] = useState<Member[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [addMemberEmail, setAddMemberEmail] = useState("");
  const [addingMember, setAddingMember] = useState(false);
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);

  // --- Invites state ---
  const [invites, setInvites] = useState<Invite[]>([]);
  const [invitesLoading, setInvitesLoading] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [sendingInvite, setSendingInvite] = useState(false);
  const [cancellingInviteId, setCancellingInviteId] = useState<string | null>(null);

  // --- Keys state ---
  const [teamKeys, setTeamKeys] = useState<TeamKey[]>([]);
  const [keysLoading, setKeysLoading] = useState(false);
  const [newKeyLabel, setNewKeyLabel] = useState("");
  const [creatingKey, setCreatingKey] = useState(false);
  const [newKeyValue, setNewKeyValue] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const [revokingKeyId, setRevokingKeyId] = useState<string | null>(null);

  // --- Wallet state ---
  const [fundAmount, setFundAmount] = useState("");
  const [funding, setFunding] = useState(false);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [txLoading, setTxLoading] = useState(false);

  // --- Deleting team ---
  const [deletingTeam, setDeletingTeam] = useState(false);

  // --- Fetch teams ---
  const fetchTeams = useCallback(async () => {
    setTeamsLoading(true);
    setTeamsError(null);
    try {
      const res = await get<TeamsResponse>("/api/teams");
      setTeams(res.teams);
    } catch (err) {
      setTeamsError(err instanceof Error ? err.message : "Failed to load teams");
    } finally {
      setTeamsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTeams();
  }, [fetchTeams]);

  // --- Fetch team detail ---
  const fetchTeamDetail = useCallback(async (id: string) => {
    if (!UUID_RE.test(id)) return;
    try {
      const res = await get<TeamDetail>(`/api/teams/${id}`);
      setTeamDetail(res);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to load team");
    }
  }, []);

  // --- Fetch sub-resources ---
  const fetchMembers = useCallback(async (id: string) => {
    if (!UUID_RE.test(id)) return;
    setMembersLoading(true);
    try {
      const res = await get<{ members: Member[] }>(`/api/teams/${id}/members`);
      setMembers(res.members);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to load members");
    } finally {
      setMembersLoading(false);
    }
  }, []);

  const fetchInvites = useCallback(async (id: string) => {
    if (!UUID_RE.test(id)) return;
    setInvitesLoading(true);
    try {
      const res = await get<{ invites: Invite[] }>(`/api/teams/${id}/invites`);
      setInvites(res.invites);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to load invites");
    } finally {
      setInvitesLoading(false);
    }
  }, []);

  const fetchKeys = useCallback(async (id: string) => {
    if (!UUID_RE.test(id)) return;
    setKeysLoading(true);
    try {
      const res = await get<{ keys: TeamKey[] }>(`/api/teams/${id}/keys`);
      setTeamKeys(res.keys);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to load keys");
    } finally {
      setKeysLoading(false);
    }
  }, []);

  const fetchTransactions = useCallback(async (id: string) => {
    if (!UUID_RE.test(id)) return;
    setTxLoading(true);
    try {
      const res = await get<{ transactions: Transaction[] }>(`/api/teams/${id}/wallet/transactions`);
      setTransactions(res.transactions);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to load transactions");
    } finally {
      setTxLoading(false);
    }
  }, []);

  // --- Select team ---
  function selectTeam(id: string) {
    setSelectedTeamId(id);
    setDetailTab("members");
    setActionError(null);
    setActionSuccess(null);
    setNewKeyValue(null);
    fetchTeamDetail(id);
    fetchMembers(id);
  }

  // --- Refresh sub-tab data when tab changes ---
  useEffect(() => {
    if (!selectedTeamId) return;
    setActionError(null);
    setActionSuccess(null);
    if (detailTab === "members") fetchMembers(selectedTeamId);
    else if (detailTab === "invites") fetchInvites(selectedTeamId);
    else if (detailTab === "keys") { fetchKeys(selectedTeamId); setNewKeyValue(null); }
    else if (detailTab === "wallet") { fetchTeamDetail(selectedTeamId); fetchTransactions(selectedTeamId); }
  }, [detailTab, selectedTeamId, fetchMembers, fetchInvites, fetchKeys, fetchTransactions, fetchTeamDetail]);

  // --- Create team ---
  async function handleCreateTeam() {
    const namePattern = /^[a-zA-Z0-9 _-]+$/;
    if (!createName || createName.length > 100 || !namePattern.test(createName)) {
      setActionError("Team name must be 1-100 characters (letters, numbers, spaces, hyphens, underscores).");
      return;
    }
    setCreating(true);
    setActionError(null);
    try {
      await post("/api/teams", { name: createName });
      setCreateName("");
      await fetchTeams();
      setActionSuccess("Team created successfully.");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to create team");
    } finally {
      setCreating(false);
    }
  }

  // --- Delete team ---
  async function handleDeleteTeam() {
    if (!selectedTeamId || !UUID_RE.test(selectedTeamId)) return;
    if (!confirm("Delete this team? This cannot be undone.")) return;
    setDeletingTeam(true);
    setActionError(null);
    try {
      await del(`/api/teams/${selectedTeamId}`);
      setSelectedTeamId(null);
      setTeamDetail(null);
      await fetchTeams();
      setActionSuccess("Team deleted.");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to delete team");
    } finally {
      setDeletingTeam(false);
    }
  }

  // --- Add member ---
  async function handleAddMember() {
    if (!selectedTeamId || !UUID_RE.test(selectedTeamId)) return;
    if (!addMemberEmail || !addMemberEmail.includes("@")) {
      setActionError("Please enter a valid email address.");
      return;
    }
    setAddingMember(true);
    setActionError(null);
    try {
      await post(`/api/teams/${selectedTeamId}/members`, { email: addMemberEmail });
      setAddMemberEmail("");
      await fetchMembers(selectedTeamId);
      setActionSuccess("Member added.");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to add member");
    } finally {
      setAddingMember(false);
    }
  }

  // --- Remove member ---
  async function handleRemoveMember(userId: string) {
    if (!selectedTeamId || !UUID_RE.test(selectedTeamId) || !UUID_RE.test(userId)) return;
    if (!confirm("Remove this member from the team?")) return;
    setRemovingMemberId(userId);
    setActionError(null);
    try {
      await del(`/api/teams/${selectedTeamId}/members/${userId}`);
      await fetchMembers(selectedTeamId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to remove member");
    } finally {
      setRemovingMemberId(null);
    }
  }

  // --- Send invite ---
  async function handleSendInvite() {
    if (!selectedTeamId || !UUID_RE.test(selectedTeamId)) return;
    if (!inviteEmail || !inviteEmail.includes("@")) {
      setActionError("Please enter a valid email address.");
      return;
    }
    setSendingInvite(true);
    setActionError(null);
    try {
      await post(`/api/teams/${selectedTeamId}/invites`, { email: inviteEmail, role: inviteRole });
      setInviteEmail("");
      setInviteRole("member");
      await fetchInvites(selectedTeamId);
      setActionSuccess("Invite sent.");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to send invite");
    } finally {
      setSendingInvite(false);
    }
  }

  // --- Cancel invite ---
  async function handleCancelInvite(inviteId: string) {
    if (!selectedTeamId || !UUID_RE.test(selectedTeamId) || !UUID_RE.test(inviteId)) return;
    setCancellingInviteId(inviteId);
    setActionError(null);
    try {
      await del(`/api/teams/${selectedTeamId}/invites/${inviteId}`);
      await fetchInvites(selectedTeamId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to cancel invite");
    } finally {
      setCancellingInviteId(null);
    }
  }

  // --- Create team key ---
  async function handleCreateKey() {
    if (!selectedTeamId || !UUID_RE.test(selectedTeamId)) return;
    const labelPattern = /^[a-zA-Z0-9 _-]+$/;
    if (!newKeyLabel || newKeyLabel.length > 50 || !labelPattern.test(newKeyLabel)) {
      setActionError("Label must be 1-50 characters (letters, numbers, spaces, hyphens, underscores).");
      return;
    }
    setCreatingKey(true);
    setActionError(null);
    try {
      const res = await post<CreateKeyResponse>(`/api/teams/${selectedTeamId}/keys`, { label: newKeyLabel });
      setNewKeyValue(res.key);
      setNewKeyLabel("");
      await fetchKeys(selectedTeamId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to create key");
    } finally {
      setCreatingKey(false);
    }
  }

  // --- Revoke key ---
  async function handleRevokeKey(keyId: string) {
    if (!selectedTeamId || !UUID_RE.test(selectedTeamId) || !UUID_RE.test(keyId)) return;
    if (!confirm("Revoke this API key? This cannot be undone.")) return;
    setRevokingKeyId(keyId);
    setActionError(null);
    try {
      await del(`/api/teams/${selectedTeamId}/keys/${keyId}`);
      await fetchKeys(selectedTeamId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to revoke key");
    } finally {
      setRevokingKeyId(null);
    }
  }

  // --- Copy key ---
  function handleCopyKey() {
    if (newKeyValue) {
      navigator.clipboard.writeText(newKeyValue);
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2000);
    }
  }

  // --- Fund wallet ---
  async function handleFund() {
    if (!selectedTeamId || !UUID_RE.test(selectedTeamId)) return;
    const cents = parseInt(fundAmount, 10) * 100;
    if (!cents || cents < 100 || cents > 1000000) {
      setActionError("Amount must be between $1 and $10,000.");
      return;
    }
    if (cents > 2147483647) {
      setActionError("Amount exceeds maximum allowed value.");
      return;
    }
    setFunding(true);
    setActionError(null);
    try {
      await post(`/api/teams/${selectedTeamId}/wallet/fund`, { amountCents: cents });
      await fetchTeamDetail(selectedTeamId);
      await fetchTransactions(selectedTeamId);
      setFundAmount("");
      setActionSuccess(`Funded $${(cents / 100).toFixed(2)} to team wallet.`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to fund wallet");
    } finally {
      setFunding(false);
    }
  }

  // --- Role badge ---
  function roleBadge(role: string) {
    const colors: Record<string, string> = {
      owner: "bg-indigo-500/20 text-indigo-400",
      admin: "bg-yellow-500/20 text-yellow-400",
      member: "bg-gray-500/20 text-gray-400",
    };
    return (
      <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors[role] ?? colors.member}`}>
        {role}
      </span>
    );
  }

  // --- Render ---
  const selectedTeam = teams.find((t) => t.id === selectedTeamId);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Teams</h1>

      {/* Error / Success banners */}
      {actionError && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-sm text-red-400">
          {actionError}
        </div>
      )}
      {actionSuccess && (
        <div className="bg-green-500/10 border border-green-500/20 rounded-lg px-4 py-3 text-sm text-green-400">
          {actionSuccess}
        </div>
      )}

      {/* Create team */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 sm:p-6">
        <h2 className="font-semibold mb-3">Create Team</h2>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            placeholder="Team name"
            maxLength={100}
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
          />
          <button
            onClick={handleCreateTeam}
            disabled={creating || !createName}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            {creating ? "Creating..." : "Create Team"}
          </button>
        </div>
      </div>

      {/* Teams list */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800">
          <h2 className="font-semibold">My Teams</h2>
        </div>
        {teamsLoading ? (
          <div className="px-4 py-6 text-center text-gray-500">Loading...</div>
        ) : teamsError ? (
          <div className="px-4 py-6 text-center text-red-400">{teamsError}</div>
        ) : teams.length === 0 ? (
          <div className="px-4 py-6 text-center text-gray-500">No teams yet. Create one to get started.</div>
        ) : (
          <div className="divide-y divide-gray-800">
            {teams.map((team) => (
              <button
                key={team.id}
                onClick={() => selectTeam(team.id)}
                className={`w-full text-left px-4 py-3 hover:bg-gray-800/50 transition-colors flex items-center justify-between gap-3 ${
                  selectedTeamId === team.id ? "bg-gray-800/70" : ""
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="font-medium truncate">{team.name}</span>
                  {roleBadge(team.role)}
                </div>
                <span className="text-sm text-green-400 font-medium flex-shrink-0">
                  ${(team.balanceCents / 100).toFixed(2)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Team detail */}
      {selectedTeamId && selectedTeam && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          {/* Header */}
          <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h2 className="font-semibold">{selectedTeam.name}</h2>
              {roleBadge(selectedTeam.role)}
            </div>
            {selectedTeam.role === "owner" && (
              <button
                onClick={handleDeleteTeam}
                disabled={deletingTeam}
                className="bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
              >
                {deletingTeam ? "Deleting..." : "Delete Team"}
              </button>
            )}
          </div>

          {/* Sub-tabs */}
          <div className="flex border-b border-gray-800 overflow-x-auto">
            {(["members", "invites", "keys", "wallet"] as DetailTab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setDetailTab(tab)}
                className={`px-4 py-2.5 text-sm font-medium transition-colors whitespace-nowrap ${
                  detailTab === tab
                    ? "text-indigo-400 border-b-2 border-indigo-400"
                    : "text-gray-400 hover:text-gray-300"
                }`}
              >
                {tab === "keys" ? "API Keys" : tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="p-4 sm:p-6">
            {/* Members tab */}
            {detailTab === "members" && (
              <div className="space-y-4">
                {/* Add member form */}
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="email"
                    value={addMemberEmail}
                    onChange={(e) => setAddMemberEmail(e.target.value)}
                    placeholder="Add member by email"
                    className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                  />
                  <button
                    onClick={handleAddMember}
                    disabled={addingMember || !addMemberEmail}
                    className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
                  >
                    {addingMember ? "Adding..." : "Add Member"}
                  </button>
                </div>

                {/* Members list */}
                {membersLoading ? (
                  <p className="text-gray-500">Loading members...</p>
                ) : members.length === 0 ? (
                  <p className="text-gray-500 text-sm">No members yet.</p>
                ) : (
                  <div className="divide-y divide-gray-800 border border-gray-800 rounded-lg overflow-hidden">
                    {members.map((m) => (
                      <div key={m.id} className="flex items-center justify-between px-4 py-3 gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="text-sm truncate">{m.email}</span>
                          {roleBadge(m.role)}
                        </div>
                        {m.role !== "owner" && (
                          <button
                            onClick={() => handleRemoveMember(m.userId)}
                            disabled={removingMemberId === m.userId}
                            className="text-red-400 hover:text-red-300 text-sm disabled:opacity-50 flex-shrink-0"
                          >
                            {removingMemberId === m.userId ? "Removing..." : "Remove"}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Invites tab */}
            {detailTab === "invites" && (
              <div className="space-y-4">
                {/* Create invite form */}
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="Email address"
                    className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                  />
                  <select
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value)}
                    className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                  >
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                  <button
                    onClick={handleSendInvite}
                    disabled={sendingInvite || !inviteEmail}
                    className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
                  >
                    {sendingInvite ? "Sending..." : "Send Invite"}
                  </button>
                </div>

                {/* Invites list */}
                {invitesLoading ? (
                  <p className="text-gray-500">Loading invites...</p>
                ) : invites.length === 0 ? (
                  <p className="text-gray-500 text-sm">No pending invites.</p>
                ) : (
                  <div className="divide-y divide-gray-800 border border-gray-800 rounded-lg overflow-hidden">
                    {invites.map((inv) => (
                      <div key={inv.id} className="flex items-center justify-between px-4 py-3 gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="text-sm truncate">{inv.email}</span>
                          {roleBadge(inv.role)}
                          <span className="text-xs text-gray-500 flex-shrink-0">
                            Expires {new Date(inv.expiresAt).toLocaleDateString()}
                          </span>
                        </div>
                        <button
                          onClick={() => handleCancelInvite(inv.id)}
                          disabled={cancellingInviteId === inv.id}
                          className="text-red-400 hover:text-red-300 text-sm disabled:opacity-50 flex-shrink-0"
                        >
                          {cancellingInviteId === inv.id ? "Cancelling..." : "Cancel"}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* API Keys tab */}
            {detailTab === "keys" && (
              <div className="space-y-4">
                {/* Create key form */}
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="text"
                    value={newKeyLabel}
                    onChange={(e) => setNewKeyLabel(e.target.value)}
                    placeholder="Key label (e.g. Production)"
                    maxLength={50}
                    className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                  />
                  <button
                    onClick={handleCreateKey}
                    disabled={creatingKey || !newKeyLabel}
                    className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
                  >
                    {creatingKey ? "Creating..." : "Create Key"}
                  </button>
                </div>

                {/* Newly created key display */}
                {newKeyValue && (
                  <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-4 space-y-2">
                    <p className="text-sm text-yellow-300">Copy this key now. You will not be able to see it again.</p>
                    <div className="flex gap-2">
                      <input
                        readOnly
                        value={newKeyValue}
                        autoComplete="off"
                        data-lpignore="true"
                        className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded-lg px-2 sm:px-3 py-2 text-xs sm:text-sm font-mono"
                      />
                      <button
                        onClick={handleCopyKey}
                        className="bg-gray-700 hover:bg-gray-600 px-3 py-2 rounded-lg text-sm transition-colors flex-shrink-0"
                      >
                        {copiedKey ? "Copied!" : "Copy"}
                      </button>
                    </div>
                  </div>
                )}

                {/* Keys list */}
                {keysLoading ? (
                  <p className="text-gray-500">Loading keys...</p>
                ) : teamKeys.length === 0 ? (
                  <p className="text-gray-500 text-sm">No API keys. Create one to get started.</p>
                ) : (
                  <div className="divide-y divide-gray-800 border border-gray-800 rounded-lg overflow-hidden">
                    {teamKeys.map((k) => (
                      <div key={k.id} className="flex items-center justify-between px-4 py-3 gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="font-mono text-indigo-400 text-sm">{k.prefix}...</span>
                          <span className="text-sm text-gray-400 truncate">{k.label}</span>
                          <span className="text-xs text-gray-500 flex-shrink-0">
                            {new Date(k.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                        <button
                          onClick={() => handleRevokeKey(k.id)}
                          disabled={revokingKeyId === k.id}
                          className="text-red-400 hover:text-red-300 text-sm disabled:opacity-50 flex-shrink-0"
                        >
                          {revokingKeyId === k.id ? "Revoking..." : "Revoke"}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Wallet tab */}
            {detailTab === "wallet" && (
              <div className="space-y-4">
                {/* Balance display */}
                <div className="bg-gray-800 rounded-lg p-4">
                  <p className="text-sm text-gray-400">Team Balance</p>
                  <p className="text-2xl sm:text-3xl font-bold text-green-400 mt-1">
                    ${teamDetail ? (teamDetail.balanceCents / 100).toFixed(2) : "0.00"}
                  </p>
                </div>

                {/* Fund form */}
                <div className="border border-gray-700 rounded-lg p-4 space-y-3">
                  <h3 className="text-sm font-medium">Fund Team Wallet</h3>
                  <p className="text-xs text-gray-500">
                    Transfer funds from your personal wallet to the team wallet.
                  </p>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <div className="relative flex-1">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">$</span>
                      <input
                        type="number"
                        value={fundAmount}
                        onChange={(e) => setFundAmount(e.target.value)}
                        placeholder="0.00"
                        min={1}
                        max={10000}
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-7 pr-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                      />
                    </div>
                    <button
                      onClick={handleFund}
                      disabled={funding || !fundAmount}
                      className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
                    >
                      {funding ? "Funding..." : "Fund"}
                    </button>
                  </div>
                </div>

                {/* Transaction history */}
                <div>
                  <h3 className="text-sm font-medium text-gray-400 mb-2">Transaction History</h3>
                  {txLoading ? (
                    <p className="text-gray-500">Loading transactions...</p>
                  ) : transactions.length === 0 ? (
                    <p className="text-gray-500 text-sm">No transactions yet.</p>
                  ) : (
                    <div className="divide-y divide-gray-800 border border-gray-800 rounded-lg overflow-hidden">
                      {transactions.map((tx) => (
                        <div key={tx.id} className="flex items-center justify-between px-4 py-3 gap-3">
                          <div className="flex items-center gap-3 min-w-0">
                            <span
                              className={`px-2 py-0.5 rounded text-xs font-medium ${
                                tx.type === "topup" || tx.type === "fund"
                                  ? "bg-green-500/10 text-green-400"
                                  : tx.type === "debit"
                                    ? "bg-red-500/10 text-red-400"
                                    : "bg-gray-500/10 text-gray-400"
                              }`}
                            >
                              {tx.type}
                            </span>
                            <span className="text-sm text-gray-400 truncate">{tx.description}</span>
                          </div>
                          <div className="flex items-center gap-3 flex-shrink-0">
                            <span className={`text-sm font-medium ${
                              tx.type === "topup" || tx.type === "fund" ? "text-green-400" : "text-red-400"
                            }`}>
                              {tx.type === "topup" || tx.type === "fund" ? "+" : "-"}
                              ${(Math.abs(tx.amountCents) / 100).toFixed(2)}
                            </span>
                            <span className="text-xs text-gray-500">
                              {new Date(tx.createdAt).toLocaleDateString()}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
