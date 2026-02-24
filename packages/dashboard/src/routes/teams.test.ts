import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import http from "http";

// ─── Mocks ─────────────────────────────────────────────────────────────

const mockCreateTeam = vi.fn();
const mockListTeams = vi.fn();
const mockGetTeam = vi.fn();
const mockUpdateTeam = vi.fn();
const mockDeleteTeam = vi.fn();
const mockFundTeamWallet = vi.fn();
const mockGetTeamWalletTransactions = vi.fn();
const mockListMembers = vi.fn();
const mockAddMember = vi.fn();
const mockUpdateMemberRole = vi.fn();
const mockRemoveMember = vi.fn();
const mockCreateInvite = vi.fn();
const mockListInvites = vi.fn();
const mockCancelInvite = vi.fn();
const mockGetInviteByToken = vi.fn();
const mockAcceptInvite = vi.fn();
const mockCreateTeamApiKey = vi.fn();
const mockListTeamApiKeys = vi.fn();

const mockFindUserByEmail = vi.fn();
const mockFindUserById = vi.fn();

const mockGenerateApiKey = vi.fn();
const mockIsValidEmail = vi.fn();
const mockSendTeamInviteEmail = vi.fn();

vi.mock("@dominusnode/shared", () => ({
  teamRepo: {
    createTeam: (...args: unknown[]) => mockCreateTeam(...args),
    listTeams: (...args: unknown[]) => mockListTeams(...args),
    getTeam: (...args: unknown[]) => mockGetTeam(...args),
    updateTeam: (...args: unknown[]) => mockUpdateTeam(...args),
    deleteTeam: (...args: unknown[]) => mockDeleteTeam(...args),
    fundTeamWallet: (...args: unknown[]) => mockFundTeamWallet(...args),
    getTeamWalletTransactions: (...args: unknown[]) => mockGetTeamWalletTransactions(...args),
    listMembers: (...args: unknown[]) => mockListMembers(...args),
    addMember: (...args: unknown[]) => mockAddMember(...args),
    updateMemberRole: (...args: unknown[]) => mockUpdateMemberRole(...args),
    removeMember: (...args: unknown[]) => mockRemoveMember(...args),
    createInvite: (...args: unknown[]) => mockCreateInvite(...args),
    listInvites: (...args: unknown[]) => mockListInvites(...args),
    cancelInvite: (...args: unknown[]) => mockCancelInvite(...args),
    getInviteByToken: (...args: unknown[]) => mockGetInviteByToken(...args),
    acceptInvite: (...args: unknown[]) => mockAcceptInvite(...args),
    createTeamApiKey: (...args: unknown[]) => mockCreateTeamApiKey(...args),
    listTeamApiKeys: (...args: unknown[]) => mockListTeamApiKeys(...args),
  },
  userRepo: {
    findUserByEmail: (...args: unknown[]) => mockFindUserByEmail(...args),
    findUserById: (...args: unknown[]) => mockFindUserById(...args),
  },
  generateApiKey: (...args: unknown[]) => mockGenerateApiKey(...args),
  hashApiKey: vi.fn(),
  isValidEmail: (...args: unknown[]) => mockIsValidEmail(...args),
  sendTeamInviteEmail: (...args: unknown[]) => mockSendTeamInviteEmail(...args),
  sanitizeString: (s: string, maxLen: number) => {
    if (typeof s !== "string") return "";
    return s.trim().replace(/<[^>]*>/g, "").slice(0, maxLen);
  },
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("express-rate-limit", () => ({
  default: () => (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    next();
  },
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    (req as unknown as { user: { userId: string; email: string; isAdmin: boolean } }).user = {
      userId: "test-user-id",
      email: "test@test.com",
      isAdmin: false,
    };
    next();
  },
}));

import teamsRouter from "./teams.js";

// ─── Helpers ──────────────────────────────────────────────────────────

const VALID_UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const VALID_UUID_2 = "b2c3d4e5-f6a7-8901-bcde-f12345678901";
const VALID_TOKEN = "a".repeat(64);

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/teams", teamsRouter);
  return app;
}

function request(
  app: express.Express,
  method: string,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Failed to get server address"));
        return;
      }
      const port = addr.port;
      const options: http.RequestOptions = {
        hostname: "127.0.0.1",
        port,
        path,
        method: method.toUpperCase(),
        headers: { "Content-Type": "application/json" },
      };

      const req = http.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          server.close();
          try {
            resolve({ status: res.statusCode ?? 500, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 500, body: {} });
          }
        });
      });
      req.on("error", (err) => {
        server.close();
        reject(err);
      });
      req.end();
    });
  });
}

function requestWithBody(
  app: express.Express,
  method: string,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Failed to get server address"));
        return;
      }
      const port = addr.port;
      const payload = JSON.stringify(body);
      const options: http.RequestOptions = {
        hostname: "127.0.0.1",
        port,
        path,
        method: method.toUpperCase(),
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      };

      const req = http.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          server.close();
          try {
            resolve({ status: res.statusCode ?? 500, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 500, body: {} });
          }
        });
      });
      req.on("error", (err) => {
        server.close();
        reject(err);
      });
      req.write(payload);
      req.end();
    });
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("teams routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: isValidEmail returns true for valid-looking emails
    mockIsValidEmail.mockImplementation((email: string) => {
      return typeof email === "string" && email.includes("@") && email.length >= 5;
    });
    // R36 H-6: Default mock for findUserById — returns verified user for invite accept tests
    mockFindUserById.mockResolvedValue({
      id: "test-user-id",
      email: "test@example.com",
      email_verified: true,
      status: "active",
    });
  });

  // ─── POST /api/teams ─────────────────────────────────────────────────

  describe("POST /api/teams", () => {
    it("should create a new team", async () => {
      mockCreateTeam.mockResolvedValueOnce({
        id: VALID_UUID,
        name: "My Team",
        owner_id: "test-user-id",
        max_members: 10,
        status: "active",
        walletId: "wallet-1",
        created_at: "2026-02-18T00:00:00Z",
      });

      const app = createApp();
      const res = await requestWithBody(app, "POST", "/api/teams", {
        name: "My Team",
      });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe(VALID_UUID);
      expect(res.body.name).toBe("My Team");
      expect(res.body.ownerId).toBe("test-user-id");
      expect(res.body.status).toBe("active");
      expect(mockCreateTeam).toHaveBeenCalledWith("test-user-id", "My Team", "payg", undefined);
    });

    it("should return 400 for empty name", async () => {
      const app = createApp();
      const res = await requestWithBody(app, "POST", "/api/teams", {
        name: "",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Team name must be 1-100 characters");
      expect(mockCreateTeam).not.toHaveBeenCalled();
    });

    it("should truncate name over 100 chars via sanitizeString", async () => {
      mockCreateTeam.mockResolvedValueOnce({
        id: VALID_UUID,
        name: "a".repeat(100),
        owner_id: "test-user-id",
        max_members: 10,
        status: "active",
        walletId: "wallet-1",
        created_at: "2026-02-18T00:00:00Z",
      });

      const app = createApp();
      const res = await requestWithBody(app, "POST", "/api/teams", {
        name: "a".repeat(200),
      });

      // sanitizeString truncates to 100 chars, so the request succeeds
      expect(res.status).toBe(201);
      expect(mockCreateTeam).toHaveBeenCalledWith("test-user-id", "a".repeat(100), "payg", undefined);
    });

    it("should return 409 when max teams limit reached", async () => {
      mockCreateTeam.mockRejectedValueOnce(new Error("Maximum of 5 teams per user"));

      const app = createApp();
      const res = await requestWithBody(app, "POST", "/api/teams", {
        name: "Another Team",
      });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain("Maximum of");
    });

    it("should return 500 on unexpected error", async () => {
      mockCreateTeam.mockRejectedValueOnce(new Error("DB connection error"));

      const app = createApp();
      const res = await requestWithBody(app, "POST", "/api/teams", {
        name: "Team",
      });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to create team");
    });
  });

  // ─── GET /api/teams ──────────────────────────────────────────────────

  describe("GET /api/teams", () => {
    it("should list all teams", async () => {
      mockListTeams.mockResolvedValueOnce([
        {
          id: VALID_UUID,
          name: "Team Alpha",
          owner_id: "test-user-id",
          max_members: 10,
          status: "active",
          role: "owner",
          balance_cents: 5000,
          created_at: "2026-02-18T00:00:00Z",
        },
      ]);

      const app = createApp();
      const res = await request(app, "GET", "/api/teams");

      expect(res.status).toBe(200);
      const teams = res.body.teams as Array<Record<string, unknown>>;
      expect(teams).toHaveLength(1);
      expect(teams[0].id).toBe(VALID_UUID);
      expect(teams[0].name).toBe("Team Alpha");
      expect(teams[0].role).toBe("owner");
      expect(teams[0].balanceCents).toBe(5000);
      expect(mockListTeams).toHaveBeenCalledWith("test-user-id");
    });

    it("should return empty array when no teams", async () => {
      mockListTeams.mockResolvedValueOnce([]);

      const app = createApp();
      const res = await request(app, "GET", "/api/teams");

      expect(res.status).toBe(200);
      expect((res.body.teams as unknown[]).length).toBe(0);
    });

    it("should return 500 on DB error", async () => {
      mockListTeams.mockRejectedValueOnce(new Error("DB error"));

      const app = createApp();
      const res = await request(app, "GET", "/api/teams");

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to list teams");
    });
  });

  // ─── GET /api/teams/:id ──────────────────────────────────────────────

  describe("GET /api/teams/:id", () => {
    it("should return a team by ID", async () => {
      mockGetTeam.mockResolvedValueOnce({
        id: VALID_UUID,
        name: "Team Alpha",
        owner_id: "test-user-id",
        max_members: 10,
        status: "active",
        role: "owner",
        balance_cents: 2500,
        created_at: "2026-02-18T00:00:00Z",
      });

      const app = createApp();
      const res = await request(app, "GET", `/api/teams/${VALID_UUID}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(VALID_UUID);
      expect(res.body.name).toBe("Team Alpha");
      expect(res.body.balanceCents).toBe(2500);
      expect(mockGetTeam).toHaveBeenCalledWith(VALID_UUID, "test-user-id");
    });

    it("should return 400 for invalid UUID", async () => {
      const app = createApp();
      const res = await request(app, "GET", "/api/teams/not-a-uuid");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid team ID format");
      expect(mockGetTeam).not.toHaveBeenCalled();
    });

    it("should return 404 when team not found", async () => {
      mockGetTeam.mockResolvedValueOnce(null);

      const app = createApp();
      const res = await request(app, "GET", `/api/teams/${VALID_UUID}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Team not found");
    });
  });

  // ─── PATCH /api/teams/:id ────────────────────────────────────────────

  describe("PATCH /api/teams/:id", () => {
    it("should update team name", async () => {
      mockUpdateTeam.mockResolvedValueOnce({
        id: VALID_UUID,
        name: "Renamed Team",
        owner_id: "test-user-id",
        max_members: 10,
        status: "active",
        created_at: "2026-02-18T00:00:00Z",
      });

      const app = createApp();
      const res = await requestWithBody(app, "PATCH", `/api/teams/${VALID_UUID}`, {
        name: "Renamed Team",
      });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Renamed Team");
      expect(mockUpdateTeam).toHaveBeenCalledWith(VALID_UUID, "test-user-id", { name: "Renamed Team" });
    });

    it("should return 400 for invalid UUID", async () => {
      const app = createApp();
      const res = await requestWithBody(app, "PATCH", "/api/teams/bad-id", {
        name: "Test",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid team ID format");
    });

    it("should return 400 for no updates provided", async () => {
      const app = createApp();
      const res = await requestWithBody(app, "PATCH", `/api/teams/${VALID_UUID}`, {});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("No updates provided");
    });

    it("should return 403 if not owner/admin", async () => {
      mockUpdateTeam.mockRejectedValueOnce(new Error("Only team owners can update"));

      const app = createApp();
      const res = await requestWithBody(app, "PATCH", `/api/teams/${VALID_UUID}`, {
        name: "New Name",
      });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("Only team owners");
    });
  });

  // ─── DELETE /api/teams/:id ───────────────────────────────────────────

  describe("DELETE /api/teams/:id", () => {
    it("should delete a team and refund balance", async () => {
      mockDeleteTeam.mockResolvedValueOnce({ refundedCents: 2500 });

      const app = createApp();
      const res = await request(app, "DELETE", `/api/teams/${VALID_UUID}`);

      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);
      expect(res.body.refundedCents).toBe(2500);
      expect(mockDeleteTeam).toHaveBeenCalledWith(VALID_UUID, "test-user-id");
    });

    it("should return 403 when not the owner", async () => {
      mockDeleteTeam.mockRejectedValueOnce(new Error("Only the team owner can delete the team"));

      const app = createApp();
      const res = await request(app, "DELETE", `/api/teams/${VALID_UUID}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("Only the team owner");
    });

    it("should return 400 for invalid UUID", async () => {
      const app = createApp();
      const res = await request(app, "DELETE", "/api/teams/bad-id");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid team ID format");
    });

    it("should return 404 for non-existent team", async () => {
      mockDeleteTeam.mockRejectedValueOnce(new Error("Team not found"));

      const app = createApp();
      const res = await request(app, "DELETE", `/api/teams/${VALID_UUID}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("not found");
    });

    it("should return 500 on unexpected error", async () => {
      mockDeleteTeam.mockRejectedValueOnce(new Error("DB error"));

      const app = createApp();
      const res = await request(app, "DELETE", `/api/teams/${VALID_UUID}`);

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to delete team");
    });
  });

  // ─── POST /api/teams/:id/wallet/fund ─────────────────────────────────

  describe("POST /api/teams/:id/wallet/fund", () => {
    it("should fund a team wallet", async () => {
      mockFundTeamWallet.mockResolvedValueOnce({
        id: "tx-1",
        wallet_id: "wallet-1",
        type: "fund",
        amount_cents: 1000,
        description: "Funded from personal wallet",
        created_at: "2026-02-18T00:00:00Z",
      });

      const app = createApp();
      const res = await requestWithBody(app, "POST", `/api/teams/${VALID_UUID}/wallet/fund`, {
        amountCents: 1000,
      });

      expect(res.status).toBe(200);
      const tx = res.body.transaction as Record<string, unknown>;
      expect(tx.id).toBe("tx-1");
      expect(tx.amountCents).toBe(1000);
      expect(tx.type).toBe("fund");
      expect(mockFundTeamWallet).toHaveBeenCalledWith("test-user-id", VALID_UUID, 1000);
    });

    it("should return 400 for invalid UUID", async () => {
      const app = createApp();
      const res = await requestWithBody(app, "POST", "/api/teams/bad/wallet/fund", {
        amountCents: 1000,
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid team ID format");
    });

    it("should return 400 for amount below minimum (100 cents)", async () => {
      const app = createApp();
      const res = await requestWithBody(app, "POST", `/api/teams/${VALID_UUID}/wallet/fund`, {
        amountCents: 50,
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Amount must be between");
    });

    it("should return 400 for amount above maximum (1M cents)", async () => {
      const app = createApp();
      const res = await requestWithBody(app, "POST", `/api/teams/${VALID_UUID}/wallet/fund`, {
        amountCents: 1_000_001,
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Amount must be between");
    });

    it("should return 400 for insufficient personal wallet balance", async () => {
      mockFundTeamWallet.mockRejectedValueOnce(new Error("Insufficient balance in main wallet"));

      const app = createApp();
      const res = await requestWithBody(app, "POST", `/api/teams/${VALID_UUID}/wallet/fund`, {
        amountCents: 1000,
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Insufficient balance");
    });

    it("should return 404 for non-existent team", async () => {
      mockFundTeamWallet.mockRejectedValueOnce(new Error("Team not found or not active"));

      const app = createApp();
      const res = await requestWithBody(app, "POST", `/api/teams/${VALID_UUID}/wallet/fund`, {
        amountCents: 1000,
      });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("not found");
    });
  });

  // ─── GET /api/teams/:id/wallet/transactions ──────────────────────────

  describe("GET /api/teams/:id/wallet/transactions", () => {
    it("should return paginated transactions", async () => {
      mockGetTeamWalletTransactions.mockResolvedValueOnce([
        {
          id: "tx-1",
          wallet_id: "wallet-1",
          type: "fund",
          amount_cents: 1000,
          description: "Funded from personal wallet",
          created_at: "2026-02-18T00:00:00Z",
        },
      ]);

      const app = createApp();
      const res = await request(app, "GET", `/api/teams/${VALID_UUID}/wallet/transactions`);

      expect(res.status).toBe(200);
      const txns = res.body.transactions as Array<Record<string, unknown>>;
      expect(txns).toHaveLength(1);
      expect(txns[0].amountCents).toBe(1000);
      expect(txns[0].type).toBe("fund");
      expect(mockGetTeamWalletTransactions).toHaveBeenCalledWith(VALID_UUID, "test-user-id", 50, 0);
    });

    it("should respect limit and offset query params", async () => {
      mockGetTeamWalletTransactions.mockResolvedValueOnce([]);

      const app = createApp();
      const res = await request(app, "GET", `/api/teams/${VALID_UUID}/wallet/transactions?limit=10&offset=5`);

      expect(res.status).toBe(200);
      expect(mockGetTeamWalletTransactions).toHaveBeenCalledWith(VALID_UUID, "test-user-id", 10, 5);
    });

    it("should return 400 for invalid UUID", async () => {
      const app = createApp();
      const res = await request(app, "GET", "/api/teams/invalid/wallet/transactions");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid team ID format");
    });
  });

  // ─── GET /api/teams/:id/members ──────────────────────────────────────

  describe("GET /api/teams/:id/members", () => {
    it("should list team members", async () => {
      mockListMembers.mockResolvedValueOnce([
        {
          id: "member-1",
          team_id: VALID_UUID,
          user_id: "test-user-id",
          role: "owner",
          email: "test@test.com",
          joined_at: "2026-02-18T00:00:00Z",
        },
        {
          id: "member-2",
          team_id: VALID_UUID,
          user_id: VALID_UUID_2,
          role: "member",
          email: "other@test.com",
          joined_at: "2026-02-18T00:00:00Z",
        },
      ]);

      const app = createApp();
      const res = await request(app, "GET", `/api/teams/${VALID_UUID}/members`);

      expect(res.status).toBe(200);
      const members = res.body.members as Array<Record<string, unknown>>;
      expect(members).toHaveLength(2);
      expect(members[0].role).toBe("owner");
      expect(members[1].role).toBe("member");
      expect(mockListMembers).toHaveBeenCalledWith(VALID_UUID, "test-user-id");
    });

    it("should return 400 for invalid UUID", async () => {
      const app = createApp();
      const res = await request(app, "GET", "/api/teams/bad/members");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid team ID format");
    });

    it("should return 403 if not a member", async () => {
      mockListMembers.mockRejectedValueOnce(new Error("Not a member of this team"));

      const app = createApp();
      const res = await request(app, "GET", `/api/teams/${VALID_UUID}/members`);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("Not a member");
    });
  });

  // ─── POST /api/teams/:id/members ─────────────────────────────────────

  describe("POST /api/teams/:id/members", () => {
    it("should add a member by email", async () => {
      mockFindUserByEmail.mockResolvedValueOnce({
        id: VALID_UUID_2,
        email: "newuser@test.com",
        status: "active",
      });
      mockAddMember.mockResolvedValueOnce({
        id: "member-3",
        team_id: VALID_UUID,
        user_id: VALID_UUID_2,
        role: "member",
        joined_at: "2026-02-18T00:00:00Z",
      });

      const app = createApp();
      const res = await requestWithBody(app, "POST", `/api/teams/${VALID_UUID}/members`, {
        email: "newuser@test.com",
        role: "member",
      });

      expect(res.status).toBe(201);
      expect(res.body.userId).toBe(VALID_UUID_2);
      expect(res.body.role).toBe("member");
      expect(mockFindUserByEmail).toHaveBeenCalledWith("newuser@test.com");
      expect(mockAddMember).toHaveBeenCalledWith(VALID_UUID, "test-user-id", VALID_UUID_2, "member");
    });

    it("should return 404 when user not found by email", async () => {
      mockFindUserByEmail.mockResolvedValueOnce(null);

      const app = createApp();
      const res = await requestWithBody(app, "POST", `/api/teams/${VALID_UUID}/members`, {
        email: "nobody@test.com",
        role: "member",
      });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("No active user found with that email");
    });

    it("should return 400 for invalid email", async () => {
      mockIsValidEmail.mockReturnValueOnce(false);

      const app = createApp();
      const res = await requestWithBody(app, "POST", `/api/teams/${VALID_UUID}/members`, {
        email: "bad-email",
        role: "member",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid email address");
    });

    it("should return 400 for invalid role", async () => {
      const app = createApp();
      const res = await requestWithBody(app, "POST", `/api/teams/${VALID_UUID}/members`, {
        email: "valid@test.com",
        role: "owner",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Role must be 'member' or 'admin'");
    });
  });

  // ─── PATCH /api/teams/:id/members/:userId ────────────────────────────

  describe("PATCH /api/teams/:id/members/:userId", () => {
    it("should update a member role", async () => {
      mockUpdateMemberRole.mockResolvedValueOnce({
        id: "member-2",
        team_id: VALID_UUID,
        user_id: VALID_UUID_2,
        role: "admin",
        joined_at: "2026-02-18T00:00:00Z",
      });

      const app = createApp();
      const res = await requestWithBody(
        app,
        "PATCH",
        `/api/teams/${VALID_UUID}/members/${VALID_UUID_2}`,
        { role: "admin" },
      );

      expect(res.status).toBe(200);
      expect(res.body.role).toBe("admin");
      expect(mockUpdateMemberRole).toHaveBeenCalledWith(VALID_UUID, "test-user-id", VALID_UUID_2, "admin");
    });

    it("should return 400 for invalid team UUID", async () => {
      const app = createApp();
      const res = await requestWithBody(app, "PATCH", `/api/teams/bad-id/members/${VALID_UUID_2}`, {
        role: "admin",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid team ID format");
    });

    it("should return 400 for invalid user UUID", async () => {
      const app = createApp();
      const res = await requestWithBody(app, "PATCH", `/api/teams/${VALID_UUID}/members/bad-id`, {
        role: "admin",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid user ID format");
    });

    it("should return 400 for invalid role", async () => {
      const app = createApp();
      const res = await requestWithBody(
        app,
        "PATCH",
        `/api/teams/${VALID_UUID}/members/${VALID_UUID_2}`,
        { role: "superadmin" },
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Role must be 'member' or 'admin'");
    });
  });

  // ─── DELETE /api/teams/:id/members/:userId ───────────────────────────

  describe("DELETE /api/teams/:id/members/:userId", () => {
    it("should remove a member", async () => {
      mockRemoveMember.mockResolvedValueOnce(undefined);

      const app = createApp();
      const res = await request(app, "DELETE", `/api/teams/${VALID_UUID}/members/${VALID_UUID_2}`);

      expect(res.status).toBe(204);
      expect(mockRemoveMember).toHaveBeenCalledWith(VALID_UUID, "test-user-id", VALID_UUID_2);
    });

    it("should return 403 when trying to remove the owner", async () => {
      mockRemoveMember.mockRejectedValueOnce(new Error("Cannot remove the team owner"));

      const app = createApp();
      const res = await request(app, "DELETE", `/api/teams/${VALID_UUID}/members/${VALID_UUID_2}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("Cannot remove the team owner");
    });

    it("should return 400 for invalid team UUID", async () => {
      const app = createApp();
      const res = await request(app, "DELETE", `/api/teams/bad/members/${VALID_UUID_2}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid team ID format");
    });
  });

  // ─── POST /api/teams/:id/invites ─────────────────────────────────────

  describe("POST /api/teams/:id/invites", () => {
    it("should create an invite", async () => {
      mockCreateInvite.mockResolvedValueOnce({
        id: "invite-1",
        team_id: VALID_UUID,
        email: "invited@test.com",
        role: "member",
        expires_at: "2026-02-25T00:00:00Z",
        created_at: "2026-02-18T00:00:00Z",
      });
      mockFindUserById.mockResolvedValueOnce({ email: "test@test.com", email_verified: true });
      mockGetTeam.mockResolvedValueOnce({ name: "Team Alpha" });
      mockSendTeamInviteEmail.mockResolvedValueOnce(undefined);

      const app = createApp();
      const res = await requestWithBody(app, "POST", `/api/teams/${VALID_UUID}/invites`, {
        email: "invited@test.com",
        role: "member",
      });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe("invite-1");
      expect(res.body.email).toBe("invited@test.com");
      expect(res.body.role).toBe("member");
      expect(mockCreateInvite).toHaveBeenCalled();
      expect(mockSendTeamInviteEmail).toHaveBeenCalled();
    });

    it("should return 400 for invalid email", async () => {
      mockIsValidEmail.mockReturnValueOnce(false);

      const app = createApp();
      const res = await requestWithBody(app, "POST", `/api/teams/${VALID_UUID}/invites`, {
        email: "bad",
        role: "member",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid email address");
    });

    it("should return 409 for already a member", async () => {
      mockFindUserById.mockResolvedValueOnce({ email: "test@test.com", email_verified: true });
      mockCreateInvite.mockRejectedValueOnce(new Error("User is already a member of this team"));

      const app = createApp();
      const res = await requestWithBody(app, "POST", `/api/teams/${VALID_UUID}/invites`, {
        email: "existing@test.com",
        role: "member",
      });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain("already a member");
    });
  });

  // ─── GET /api/teams/:id/invites ──────────────────────────────────────

  describe("GET /api/teams/:id/invites", () => {
    it("should list pending invites", async () => {
      mockListInvites.mockResolvedValueOnce([
        {
          id: "invite-1",
          team_id: VALID_UUID,
          email: "invited@test.com",
          role: "member",
          invited_by: "test-user-id",
          expires_at: "2026-02-25T00:00:00Z",
          created_at: "2026-02-18T00:00:00Z",
        },
      ]);

      const app = createApp();
      const res = await request(app, "GET", `/api/teams/${VALID_UUID}/invites`);

      expect(res.status).toBe(200);
      const invites = res.body.invites as Array<Record<string, unknown>>;
      expect(invites).toHaveLength(1);
      expect(invites[0].email).toBe("invited@test.com");
      expect(invites[0].role).toBe("member");
      expect(mockListInvites).toHaveBeenCalledWith(VALID_UUID, "test-user-id");
    });

    it("should return 400 for invalid UUID", async () => {
      const app = createApp();
      const res = await request(app, "GET", "/api/teams/bad-id/invites");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid team ID format");
    });
  });

  // ─── DELETE /api/teams/:id/invites/:inviteId ─────────────────────────

  describe("DELETE /api/teams/:id/invites/:inviteId", () => {
    it("should cancel an invite", async () => {
      mockCancelInvite.mockResolvedValueOnce(undefined);

      const app = createApp();
      const res = await request(app, "DELETE", `/api/teams/${VALID_UUID}/invites/${VALID_UUID_2}`);

      expect(res.status).toBe(204);
      expect(mockCancelInvite).toHaveBeenCalledWith(VALID_UUID, "test-user-id", VALID_UUID_2);
    });

    it("should return 400 for invalid team UUID", async () => {
      const app = createApp();
      const res = await request(app, "DELETE", `/api/teams/bad/invites/${VALID_UUID_2}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid team ID format");
    });

    it("should return 400 for invalid invite UUID", async () => {
      const app = createApp();
      const res = await request(app, "DELETE", `/api/teams/${VALID_UUID}/invites/bad`);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid invite ID format");
    });

    it("should return 404 when invite not found", async () => {
      mockCancelInvite.mockRejectedValueOnce(new Error("Invite not found"));

      const app = createApp();
      const res = await request(app, "DELETE", `/api/teams/${VALID_UUID}/invites/${VALID_UUID_2}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("not found");
    });
  });

  // ─── GET /api/teams/invites/:token ───────────────────────────────────

  describe("GET /api/teams/invites/:token", () => {
    it("should return invite details by token", async () => {
      mockGetInviteByToken.mockResolvedValueOnce({
        id: "invite-1",
        team_id: VALID_UUID,
        team_name: "Team Alpha",
        email: "invited@test.com",
        role: "member",
        expires_at: new Date(Date.now() + 86400000).toISOString(), // future date
        created_at: "2026-02-18T00:00:00Z",
      });

      const app = createApp();
      const res = await request(app, "GET", `/api/teams/invites/${VALID_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe("invite-1");
      expect(res.body.teamName).toBe("Team Alpha");
      // R46 C-3: Public endpoint now masks email PII
      expect(res.body.email).toBe("in***@test.com");
      expect(mockGetInviteByToken).toHaveBeenCalled();
    });

    it("should return 400 for invalid token format", async () => {
      const app = createApp();
      const res = await request(app, "GET", "/api/teams/invites/short-token");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid invite token format");
    });

    it("should return 404 when invite not found", async () => {
      mockGetInviteByToken.mockResolvedValueOnce(null);

      const app = createApp();
      const res = await request(app, "GET", `/api/teams/invites/${VALID_TOKEN}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Invite not found or expired");
    });

    it("should return 410 when invite has expired", async () => {
      mockGetInviteByToken.mockResolvedValueOnce({
        id: "invite-1",
        team_id: VALID_UUID,
        team_name: "Team Alpha",
        email: "invited@test.com",
        role: "member",
        expires_at: new Date(Date.now() - 86400000).toISOString(), // past date
        created_at: "2026-02-18T00:00:00Z",
      });

      const app = createApp();
      const res = await request(app, "GET", `/api/teams/invites/${VALID_TOKEN}`);

      expect(res.status).toBe(410);
      expect(res.body.error).toBe("Invite has expired");
    });
  });

  // ─── POST /api/teams/invites/:token/accept ───────────────────────────

  describe("POST /api/teams/invites/:token/accept", () => {
    it("should accept an invite", async () => {
      mockAcceptInvite.mockResolvedValueOnce({
        id: "member-3",
        team_id: VALID_UUID,
        user_id: "test-user-id",
        role: "member",
        joined_at: "2026-02-18T00:00:00Z",
      });

      const app = createApp();
      const res = await requestWithBody(app, "POST", `/api/teams/invites/${VALID_TOKEN}/accept`, {});

      expect(res.status).toBe(200);
      expect(res.body.teamId).toBe(VALID_UUID);
      expect(res.body.userId).toBe("test-user-id");
      expect(res.body.role).toBe("member");
      expect(mockAcceptInvite).toHaveBeenCalled();
    });

    it("should return 400 for invalid token format", async () => {
      const app = createApp();
      const res = await requestWithBody(app, "POST", "/api/teams/invites/bad/accept", {});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid invite token format");
    });

    it("should return 410 for expired invite", async () => {
      mockAcceptInvite.mockRejectedValueOnce(new Error("Invite has expired"));

      const app = createApp();
      const res = await requestWithBody(app, "POST", `/api/teams/invites/${VALID_TOKEN}/accept`, {});

      expect(res.status).toBe(410);
      expect(res.body.error).toContain("expired");
    });

    it("should return 409 if already a member", async () => {
      mockAcceptInvite.mockRejectedValueOnce(new Error("Already a member of this team"));

      const app = createApp();
      const res = await requestWithBody(app, "POST", `/api/teams/invites/${VALID_TOKEN}/accept`, {});

      expect(res.status).toBe(409);
      expect(res.body.error).toContain("Already a member");
    });
  });

  // ─── POST /api/teams/:id/keys ────────────────────────────────────────

  describe("POST /api/teams/:id/keys", () => {
    it("should create a team API key", async () => {
      mockGenerateApiKey.mockReturnValueOnce({
        raw: "dn_live_abc123",
        hash: "hash123",
        prefix: "dn_live_abc123__",
      });
      mockCreateTeamApiKey.mockResolvedValueOnce({
        id: "key-1",
        key_prefix: "dn_live_abc123__",
        label: "production-key",
        created_at: "2026-02-18T00:00:00Z",
      });

      const app = createApp();
      const res = await requestWithBody(app, "POST", `/api/teams/${VALID_UUID}/keys`, {
        label: "production-key",
      });

      expect(res.status).toBe(201);
      expect(res.body.key).toBe("dn_live_abc123");
      expect(res.body.id).toBe("key-1");
      expect(res.body.label).toBe("production-key");
      expect(mockCreateTeamApiKey).toHaveBeenCalledWith(VALID_UUID, "test-user-id", "hash123", "dn_live_abc123__", "production-key");
    });

    it("should return 400 for empty label", async () => {
      const app = createApp();
      const res = await requestWithBody(app, "POST", `/api/teams/${VALID_UUID}/keys`, {
        label: "",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Label must be 1-100 characters");
    });

    it("should return 400 for invalid UUID", async () => {
      const app = createApp();
      const res = await requestWithBody(app, "POST", "/api/teams/bad/keys", {
        label: "test",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid team ID format");
    });

    it("should return 403 if not owner/admin", async () => {
      mockGenerateApiKey.mockReturnValueOnce({
        raw: "dn_live_abc123",
        hash: "hash123",
        prefix: "dn_live_abc123__",
      });
      mockCreateTeamApiKey.mockRejectedValueOnce(new Error("Only team owners can create API keys"));

      const app = createApp();
      const res = await requestWithBody(app, "POST", `/api/teams/${VALID_UUID}/keys`, {
        label: "test-key",
      });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("Only team owners");
    });
  });

  // ─── GET /api/teams/:id/keys ─────────────────────────────────────────

  describe("GET /api/teams/:id/keys", () => {
    it("should list team API keys", async () => {
      mockListTeamApiKeys.mockResolvedValueOnce([
        {
          id: "key-1",
          user_id: "test-user-id",
          key_prefix: "dn_live_abc123__",
          label: "production",
          team_id: VALID_UUID,
          created_at: "2026-02-18T00:00:00Z",
          revoked_at: null,
        },
      ]);

      const app = createApp();
      const res = await request(app, "GET", `/api/teams/${VALID_UUID}/keys`);

      expect(res.status).toBe(200);
      const keys = res.body.keys as Array<Record<string, unknown>>;
      expect(keys).toHaveLength(1);
      expect(keys[0].id).toBe("key-1");
      expect(keys[0].prefix).toBe("dn_live_abc123__");
      expect(keys[0].label).toBe("production");
      expect(keys[0].teamId).toBe(VALID_UUID);
      expect(mockListTeamApiKeys).toHaveBeenCalledWith(VALID_UUID, "test-user-id");
    });

    it("should return 400 for invalid UUID", async () => {
      const app = createApp();
      const res = await request(app, "GET", "/api/teams/bad-id/keys");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid team ID format");
    });

    it("should return 403 if not a member", async () => {
      mockListTeamApiKeys.mockRejectedValueOnce(new Error("Not a member of this team"));

      const app = createApp();
      const res = await request(app, "GET", `/api/teams/${VALID_UUID}/keys`);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("Not a member");
    });

    it("should return 500 on unexpected error", async () => {
      mockListTeamApiKeys.mockRejectedValueOnce(new Error("DB error"));

      const app = createApp();
      const res = await request(app, "GET", `/api/teams/${VALID_UUID}/keys`);

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to list team API keys");
    });
  });
});
