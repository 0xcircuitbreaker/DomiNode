import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import http from "http";

// ─── Mocks ─────────────────────────────────────────────────────────────

const mockListUsers = vi.fn();
const mockGetUserDetails = vi.fn();
const mockSuspendUser = vi.fn();
const mockReactivateUser = vi.fn();
const mockDeleteUser = vi.fn();
const mockGetRevenueStats = vi.fn();
const mockGetDailyRevenue = vi.fn();
const mockGetSystemStats = vi.fn();
const mockFindUserById = vi.fn();
const mockRevokeAllApiKeys = vi.fn();
const mockRevokeAllForUser = vi.fn();
const mockDeleteMfaConfig = vi.fn();
const mockClientQuery = vi.fn(async (sql: string) =>
  sql.includes("SELECT admin_role FROM users") ? { rows: [{ admin_role: "root_admin" }] } : { rows: [], rowCount: 1 });
const REASON = { reason: "abuse report #42" };

vi.mock("@dominusnode/shared", () => ({
  adminRepo: {
    listUsers: (...args: unknown[]) => mockListUsers(...args),
    getUserDetails: (...args: unknown[]) => mockGetUserDetails(...args),
    suspendUser: (...args: unknown[]) => mockSuspendUser(...args),
    reactivateUser: (...args: unknown[]) => mockReactivateUser(...args),
    deleteUser: (...args: unknown[]) => mockDeleteUser(...args),
    getRevenueStats: (...args: unknown[]) => mockGetRevenueStats(...args),
    getDailyRevenue: (...args: unknown[]) => mockGetDailyRevenue(...args),
    getSystemStats: (...args: unknown[]) => mockGetSystemStats(...args),
    isRootAdmin: (u: { admin_role?: string } | null) => u?.admin_role === "root_admin",
    setAdminRole: vi.fn(),
  },
  userRepo: {
    findUserById: (...args: unknown[]) => mockFindUserById(...args),
    revokeAllApiKeys: (...args: unknown[]) => mockRevokeAllApiKeys(...args),
  },
  refreshTokenRepo: {
    revokeAllForUser: (...args: unknown[]) => mockRevokeAllForUser(...args),
  },
  mfaRepo: {
    deleteMfaConfig: (...args: unknown[]) => mockDeleteMfaConfig(...args),
  },
  hasMinRole: (userRole: string, requiredRole: string) => {
    const ranks: Record<string, number> = { none: 0, admin: 1, cybersecurity_admin: 2, root_admin: 3 };
    return (ranks[userRole] ?? 0) >= (ranks[requiredRole] ?? 0);
  },
  getPool: () => ({ connect: async () => ({ query: mockClientQuery, release: vi.fn() }) }),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock the requireAuth middleware to inject a user into the request
let mockUserId = "admin-user-id";
let mockCallerRole = "admin";
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    (req as unknown as { user: { userId: string; email: string; isAdmin: boolean; adminRole: string } }).user = {
      userId: mockUserId,
      email: "admin@example.com",
      isAdmin: true,
      adminRole: mockCallerRole,
    };
    next();
  },
}));

// Mock the admin middleware to just call next (all role checks pass in tests)
vi.mock("../middleware/admin.js", () => {
  const pt = (_req: unknown, _res: unknown, next: () => void) => { next(); };
  return {
    requireAdmin: pt,
    requireCybersecurityAdmin: pt,
    requireRootAdmin: pt,
  };
});

import adminRouter from "./admin.js";

// ─── Helper to make requests ────────────────────────────────────────────

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminRouter);
  return app;
}

function request(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
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
        headers: {
          "Content-Type": "application/json",
          "Content-Length": body === undefined ? 0 : Buffer.byteLength(JSON.stringify(body)),
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
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────

const VALID_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("admin routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserId = "admin-user-id";
  });

  // ─── Suspend: admin-to-admin protection ──────────────────────────

  describe("PUT /api/admin/users/:id/suspend", () => {
    it("should return 403 when target user is an admin", async () => {
      mockFindUserById.mockResolvedValueOnce({
        id: VALID_UUID,
        email: "other-admin@example.com",
        status: "active",
        is_admin: true,
        admin_role: "admin",
        password_hash: "",
        created_at: new Date(),
        password_changed_at: null,
      });

      const app = createApp();
      const res = await request(app, "PUT", `/api/admin/users/${VALID_UUID}/suspend`, REASON);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Only root admin can suspend another admin account");
      expect(mockSuspendUser).not.toHaveBeenCalled();
    });

    it("should refuse to suspend the root admin even for a root caller", async () => {
      mockCallerRole = "root_admin";
      mockFindUserById.mockResolvedValueOnce({
        id: VALID_UUID,
        email: "root@example.com",
        status: "active",
        is_admin: true,
        admin_role: "root_admin",
        password_hash: "",
        created_at: new Date(),
        password_changed_at: null,
      });
      try {
        const app = createApp();
        const res = await request(app, "PUT", `/api/admin/users/${VALID_UUID}/suspend`, REASON);
        expect(res.status).toBe(403);
        expect(res.body.error).toBe("Root admin account cannot be suspended");
        expect(mockSuspendUser).not.toHaveBeenCalled();
      } finally {
        mockCallerRole = "admin";
      }
    });

    it("should suspend a non-admin user successfully", async () => {
      mockFindUserById.mockResolvedValueOnce({
        id: VALID_UUID,
        email: "user@example.com",
        status: "active",
        is_admin: false,
        admin_role: "none",
        password_hash: "",
        created_at: new Date(),
        password_changed_at: null,
      });
      mockSuspendUser.mockResolvedValueOnce(undefined);
      mockRevokeAllApiKeys.mockResolvedValueOnce(2);
      mockRevokeAllForUser.mockResolvedValueOnce(1);

      const app = createApp();
      const res = await request(app, "PUT", `/api/admin/users/${VALID_UUID}/suspend`, REASON);

      expect(res.status).toBe(200);
      expect(res.body.message).toBe("User suspended");
      expect(mockSuspendUser).toHaveBeenCalledWith(VALID_UUID, expect.anything());
      expect(mockRevokeAllApiKeys).toHaveBeenCalledWith(VALID_UUID, expect.anything());
      expect(mockRevokeAllForUser).toHaveBeenCalledWith(VALID_UUID, expect.anything());
    });

    it("should return 400 when trying to suspend yourself", async () => {
      mockUserId = VALID_UUID;

      const app = createApp();
      const res = await request(app, "PUT", `/api/admin/users/${VALID_UUID}/suspend`, REASON);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Cannot suspend your own account");
      expect(mockSuspendUser).not.toHaveBeenCalled();
    });

    it("should return 400 for invalid UUID format", async () => {
      const app = createApp();
      const res = await request(app, "PUT", "/api/admin/users/not-a-uuid/suspend");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid user ID format");
    });
  });

  // ─── Delete: admin-to-admin protection ───────────────────────────

  describe("DELETE /api/admin/users/:id", () => {
    it("should return 403 when target user is an admin", async () => {
      mockFindUserById.mockResolvedValueOnce({
        id: VALID_UUID,
        email: "other-admin@example.com",
        status: "active",
        is_admin: true,
        admin_role: "admin",
        password_hash: "",
        created_at: new Date(),
        password_changed_at: null,
      });

      const app = createApp();
      const res = await request(app, "DELETE", `/api/admin/users/${VALID_UUID}`, REASON);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Only root admin can delete another admin account");
      expect(mockDeleteUser).not.toHaveBeenCalled();
    });

    it("should delete a non-admin user successfully", async () => {
      mockFindUserById.mockResolvedValueOnce({
        id: VALID_UUID,
        email: "user@example.com",
        status: "active",
        is_admin: false,
        admin_role: "none",
        password_hash: "",
        created_at: new Date(),
        password_changed_at: null,
      });
      mockDeleteUser.mockResolvedValueOnce(undefined);

      const app = createApp();
      const res = await request(app, "DELETE", `/api/admin/users/${VALID_UUID}`, REASON);

      expect(res.status).toBe(200);
      expect(res.body.message).toBe("User deleted");
      expect(mockDeleteUser).toHaveBeenCalledWith(VALID_UUID, expect.anything());
    });

    it("should return 400 when trying to delete yourself", async () => {
      mockUserId = VALID_UUID;

      const app = createApp();
      const res = await request(app, "DELETE", `/api/admin/users/${VALID_UUID}`, REASON);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Cannot delete your own account");
      expect(mockDeleteUser).not.toHaveBeenCalled();
    });

    it("should return 400 for invalid UUID format", async () => {
      const app = createApp();
      const res = await request(app, "DELETE", "/api/admin/users/bad-id");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid user ID format");
    });
  });
});
