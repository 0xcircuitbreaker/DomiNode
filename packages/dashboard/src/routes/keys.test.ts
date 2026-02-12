import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import http from "http";

// ─── Mocks ─────────────────────────────────────────────────────────────

const mockCountActiveKeys = vi.fn();
const mockCreateApiKey = vi.fn();
const mockListApiKeys = vi.fn();
const mockRevokeApiKey = vi.fn();
const mockGenerateApiKey = vi.fn();
const mockSanitizeString = vi.fn((s: string, _max?: number) => s);

vi.mock("@dominode/shared", () => ({
  userRepo: {
    countActiveKeys: (...args: unknown[]) => mockCountActiveKeys(...args),
    createApiKey: (...args: unknown[]) => mockCreateApiKey(...args),
    listApiKeys: (...args: unknown[]) => mockListApiKeys(...args),
    revokeApiKey: (...args: unknown[]) => mockRevokeApiKey(...args),
  },
  generateApiKey: (...args: unknown[]) => mockGenerateApiKey(...args),
  sanitizeString: (s: string, max?: number) => mockSanitizeString(s, max),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
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

import keysRouter from "./keys.js";

// ─── Helpers ──────────────────────────────────────────────────────────

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/keys", keysRouter);
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

const VALID_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("keys routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── POST /api/keys ────────────────────────────────────────────────

  describe("POST /api/keys", () => {
    it("should create a new API key (201)", async () => {
      mockCountActiveKeys.mockResolvedValueOnce(5);
      mockSanitizeString.mockReturnValueOnce("My Key");
      mockGenerateApiKey.mockReturnValueOnce({
        raw: "dn_live_abc123",
        hash: "hash123",
        prefix: "dn_live_abc",
      });
      mockCreateApiKey.mockResolvedValueOnce({
        id: VALID_UUID,
        key_prefix: "dn_live_abc",
        label: "My Key",
        created_at: "2025-01-01T00:00:00Z",
      });

      const app = createApp();
      const res = await requestWithBody(app, "POST", "/api/keys", { label: "My Key" });

      expect(res.status).toBe(201);
      expect(res.body.key).toBe("dn_live_abc123");
      expect(res.body.id).toBe(VALID_UUID);
      expect(res.body.prefix).toBe("dn_live_abc");
      expect(res.body.label).toBe("My Key");
      expect(mockCountActiveKeys).toHaveBeenCalledWith("test-user-id");
      expect(mockCreateApiKey).toHaveBeenCalledWith("test-user-id", "hash123", "dn_live_abc", "My Key");
    });

    it("should create a key with default label when none provided", async () => {
      mockCountActiveKeys.mockResolvedValueOnce(0);
      mockSanitizeString.mockReturnValueOnce("Default");
      mockGenerateApiKey.mockReturnValueOnce({
        raw: "dn_live_xyz",
        hash: "hash_xyz",
        prefix: "dn_live_x",
      });
      mockCreateApiKey.mockResolvedValueOnce({
        id: VALID_UUID,
        key_prefix: "dn_live_x",
        label: "Default",
        created_at: "2025-01-01T00:00:00Z",
      });

      const app = createApp();
      const res = await requestWithBody(app, "POST", "/api/keys", {});

      expect(res.status).toBe(201);
      expect(res.body.key).toBe("dn_live_xyz");
    });

    it("should return 400 when max 50 keys reached", async () => {
      mockCountActiveKeys.mockResolvedValueOnce(50);

      const app = createApp();
      const res = await requestWithBody(app, "POST", "/api/keys", { label: "One more" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Maximum 50 active API keys allowed");
      expect(mockGenerateApiKey).not.toHaveBeenCalled();
    });

    it("should return 500 when DB error occurs during creation", async () => {
      mockCountActiveKeys.mockResolvedValueOnce(0);
      mockSanitizeString.mockReturnValueOnce("Test");
      mockGenerateApiKey.mockReturnValueOnce({
        raw: "dn_live_err",
        hash: "hash_err",
        prefix: "dn_live_e",
      });
      mockCreateApiKey.mockRejectedValueOnce(new Error("DB connection failed"));

      const app = createApp();
      const res = await requestWithBody(app, "POST", "/api/keys", { label: "Test" });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to create API key");
    });
  });

  // ─── GET /api/keys ─────────────────────────────────────────────────

  describe("GET /api/keys", () => {
    it("should list API keys", async () => {
      const keys = [
        {
          id: VALID_UUID,
          key_prefix: "dn_live_abc",
          label: "Production",
          created_at: "2025-01-01T00:00:00Z",
          revoked_at: null,
        },
        {
          id: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
          key_prefix: "dn_live_xyz",
          label: "Testing",
          created_at: "2025-01-02T00:00:00Z",
          revoked_at: "2025-01-03T00:00:00Z",
        },
      ];
      mockListApiKeys.mockResolvedValueOnce(keys);

      const app = createApp();
      const res = await request(app, "GET", "/api/keys");

      expect(res.status).toBe(200);
      expect(res.body.keys).toHaveLength(2);
      expect((res.body.keys as Array<Record<string, unknown>>)[0]).toEqual({
        id: VALID_UUID,
        prefix: "dn_live_abc",
        label: "Production",
        created_at: "2025-01-01T00:00:00Z",
        revoked_at: null,
      });
    });

    it("should return empty array when no keys exist", async () => {
      mockListApiKeys.mockResolvedValueOnce([]);

      const app = createApp();
      const res = await request(app, "GET", "/api/keys");

      expect(res.status).toBe(200);
      expect(res.body.keys).toHaveLength(0);
    });

    it("should return 500 when listing fails", async () => {
      mockListApiKeys.mockRejectedValueOnce(new Error("DB error"));

      const app = createApp();
      const res = await request(app, "GET", "/api/keys");

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to list API keys");
    });
  });

  // ─── DELETE /api/keys/:id ──────────────────────────────────────────

  describe("DELETE /api/keys/:id", () => {
    it("should revoke an API key (204)", async () => {
      mockRevokeApiKey.mockResolvedValueOnce(true);

      const app = createApp();
      const res = await request(app, "DELETE", `/api/keys/${VALID_UUID}`);

      expect(res.status).toBe(204);
      expect(mockRevokeApiKey).toHaveBeenCalledWith(VALID_UUID, "test-user-id");
    });

    it("should return 400 for invalid UUID format", async () => {
      const app = createApp();
      const res = await request(app, "DELETE", "/api/keys/not-a-uuid");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid API key ID format");
    });

    it("should return 404 when key not found or already revoked", async () => {
      mockRevokeApiKey.mockResolvedValueOnce(false);

      const app = createApp();
      const res = await request(app, "DELETE", `/api/keys/${VALID_UUID}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("API key not found or already revoked");
    });
  });
});
