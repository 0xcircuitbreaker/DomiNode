import type { HttpClient } from "../http.js";

export interface Team {
  id: string;
  name: string;
  ownerId: string;
  maxMembers: number;
  status: string;
  balanceCents: number;
  createdAt: string;
}

export interface TeamMember {
  id: string;
  teamId: string;
  userId: string;
  email: string;
  role: string;
  joinedAt: string;
}

export interface TeamInvite {
  id: string;
  teamId: string;
  email: string;
  role: string;
  token: string;
  expiresAt: string;
  createdAt: string;
}

export interface TeamKey {
  id: string;
  keyPrefix: string;
  label: string;
  createdAt: string;
}

export interface TeamKeyCreateResponse {
  id: string;
  key: string;
  keyPrefix: string;
  label: string;
}

export interface TeamListResponse {
  teams: Team[];
}

export interface TeamDeleteResponse {
  refundedCents: number;
}

export interface TeamFundResponse {
  transaction: TeamTransaction;
}

export interface TeamTransaction {
  id: string;
  teamId: string;
  type: string;
  amountCents: number;
  description: string;
  createdAt: string;
}

export interface TeamTransactionsResponse {
  transactions: TeamTransaction[];
}

export interface TeamMembersResponse {
  members: TeamMember[];
}

export interface TeamInvitesResponse {
  invites: TeamInvite[];
}

export interface TeamKeysResponse {
  keys: TeamKey[];
}

export class TeamsResource {
  constructor(private http: HttpClient) {}

  async create(name: string, maxMembers?: number): Promise<Team> {
    const body: Record<string, unknown> = { name };
    if (maxMembers !== undefined) body.maxMembers = maxMembers;
    return this.http.post("/api/teams", body);
  }

  async list(): Promise<Team[]> {
    return this.http.get("/api/teams");
  }

  async get(teamId: string): Promise<Team> {
    return this.http.get(`/api/teams/${encodeURIComponent(teamId)}`);
  }

  async update(teamId: string, updates: { name?: string; maxMembers?: number }): Promise<Team> {
    return this.http.patch(`/api/teams/${encodeURIComponent(teamId)}`, updates);
  }

  async delete(teamId: string): Promise<TeamDeleteResponse> {
    return this.http.delete(`/api/teams/${encodeURIComponent(teamId)}`);
  }

  async fundWallet(teamId: string, amountCents: number): Promise<TeamFundResponse> {
    if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > 2_147_483_647) {
      throw new Error("amountCents must be a positive integer <= 2,147,483,647");
    }
    return this.http.post(`/api/teams/${encodeURIComponent(teamId)}/wallet/fund`, { amountCents });
  }

  async getTransactions(teamId: string, limit?: number, offset?: number): Promise<TeamTransactionsResponse> {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set("limit", String(limit));
    if (offset !== undefined) params.set("offset", String(offset));
    const qs = params.toString();
    return this.http.get(`/api/teams/${encodeURIComponent(teamId)}/wallet/transactions${qs ? `?${qs}` : ""}`);
  }

  async listMembers(teamId: string): Promise<TeamMembersResponse> {
    return this.http.get(`/api/teams/${encodeURIComponent(teamId)}/members`);
  }

  async addMember(teamId: string, email: string, role?: string): Promise<TeamMember> {
    const body: Record<string, unknown> = { email };
    if (role !== undefined) body.role = role;
    return this.http.post(`/api/teams/${encodeURIComponent(teamId)}/members`, body);
  }

  async updateMemberRole(teamId: string, userId: string, role: string): Promise<TeamMember> {
    return this.http.patch(
      `/api/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`,
      { role },
    );
  }

  async removeMember(teamId: string, userId: string): Promise<void> {
    await this.http.delete(
      `/api/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`,
    );
  }

  async createInvite(teamId: string, email: string, role?: string): Promise<TeamInvite> {
    const body: Record<string, unknown> = { email };
    if (role !== undefined) body.role = role;
    return this.http.post(`/api/teams/${encodeURIComponent(teamId)}/invites`, body);
  }

  async listInvites(teamId: string): Promise<TeamInvitesResponse> {
    return this.http.get(`/api/teams/${encodeURIComponent(teamId)}/invites`);
  }

  async cancelInvite(teamId: string, inviteId: string): Promise<void> {
    await this.http.delete(
      `/api/teams/${encodeURIComponent(teamId)}/invites/${encodeURIComponent(inviteId)}`,
    );
  }

  async acceptInvite(token: string): Promise<TeamMember> {
    return this.http.post(`/api/teams/invites/${encodeURIComponent(token)}/accept`, {});
  }

  async createKey(teamId: string, label: string): Promise<TeamKeyCreateResponse> {
    return this.http.post(`/api/teams/${encodeURIComponent(teamId)}/keys`, { label });
  }

  async listKeys(teamId: string): Promise<TeamKeysResponse> {
    return this.http.get(`/api/teams/${encodeURIComponent(teamId)}/keys`);
  }

  async revokeKey(teamId: string, keyId: string): Promise<void> {
    await this.http.delete(
      `/api/teams/${encodeURIComponent(teamId)}/keys/${encodeURIComponent(keyId)}`,
    );
  }
}
