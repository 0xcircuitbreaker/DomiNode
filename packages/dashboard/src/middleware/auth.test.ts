import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import http from "http";
import cookieParser from "cookie-parser";

// ─── Mocks ─────────────────────────────────────────────────────────────

const mockVerifyJwt = vi.fn();
const mockFindUserById = vi.fn();

vi.mock("@dominusnode/shared", () => ({
  verifyJwt: (...args: unknown[]) => mockVerifyJwt(...args),
  userRepo: {
    findUserById: (...args: unknown[]) => mockFindUserById(...args),
  },
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Import the module under test AFTER mocks
import { requireAuth } from "./auth.js";

// ─── Helpers ──────────────────────────────────────────────────────────

function createApp(): express.Express {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  // Protected route using requireAuth
  app.get("/api/protected", requireAuth, (req, res) => {
    const user = (req as unknown as { user: { userId: string; email: string; isAdmin: boolean } }).user;
    res.json({ userId: user.userId, email: user.email, isAdmin: user.isAdmin });
  });

  return app;
}

function request(
  app: express.Express,
  method: string,
  path: string,
  headers?: Record<string, string>,
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
        headers: { "Content-Type": "application/json", ...headers },
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

// ─── Tests ──────────────────────────────────────────────────────────────

describe("requireAuth middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return 401 when no token is provided", async () => {
    const app = createApp();
    const res = await request(app, "GET", "/api/protected");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Authentication required");
  });

  it("should extract token from Bearer authorization header", async () => {
    mockVerifyJwt.mockReturnValueOnce({ userId: "user-123", email: "test@test.com", isAdmin: false });
    mockFindUserById.mockResolvedValueOnce({
      id: "user-123",
      email: "test@test.com",
      status: "active",
      is_admin: false,
    });

    const app = createApp();
    const res = await request(app, "GET", "/api/protected", {
      Authorization: "Bearer valid-jwt-token",
    });

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe("user-123");
    expect(mockVerifyJwt).toHaveBeenCalledWith("valid-jwt-token");
    expect(mockFindUserById).toHaveBeenCalledWith("user-123");
  });

  it("should extract token from dominusnode_access cookie", async () => {
    mockVerifyJwt.mockReturnValueOnce({ userId: "cookie-user", email: "cookie@test.com", isAdmin: false });
    mockFindUserById.mockResolvedValueOnce({
      id: "cookie-user",
      email: "cookie@test.com",
      status: "active",
      is_admin: true,
    });

    const app = createApp();
    const res = await request(app, "GET", "/api/protected", {
      Cookie: "dominusnode_access=cookie-jwt-token",
    });

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe("cookie-user");
    // isAdmin should be refreshed from DB
    expect(res.body.isAdmin).toBe(true);
    expect(mockVerifyJwt).toHaveBeenCalledWith("cookie-jwt-token");
  });

  it("should return 401 for expired/invalid JWT", async () => {
    mockVerifyJwt.mockReturnValueOnce(null);

    const app = createApp();
    const res = await request(app, "GET", "/api/protected", {
      Authorization: "Bearer expired-token",
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid or expired token");
  });

  it("should return 401 for suspended user", async () => {
    mockVerifyJwt.mockReturnValueOnce({ userId: "suspended-user", email: "sus@test.com", isAdmin: false });
    mockFindUserById.mockResolvedValueOnce({
      id: "suspended-user",
      email: "sus@test.com",
      status: "suspended",
      is_admin: false,
    });

    const app = createApp();
    const res = await request(app, "GET", "/api/protected", {
      Authorization: "Bearer valid-token-for-suspended",
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Account is no longer active");
  });

  it("should return 500 when DB lookup fails", async () => {
    mockVerifyJwt.mockReturnValueOnce({ userId: "db-err-user", email: "dberr@test.com", isAdmin: false });
    mockFindUserById.mockRejectedValueOnce(new Error("DB connection lost"));

    const app = createApp();
    const res = await request(app, "GET", "/api/protected", {
      Authorization: "Bearer valid-token",
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Authentication check failed");
  });
});
