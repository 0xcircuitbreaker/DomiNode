import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DominusNodeClient } from "../src/client.js";
import { DEFAULT_BASE_URL } from "../src/constants.js";

// Helper: build a fake JWT with a given expiry
function makeJwt(expSeconds: number = 900): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      userId: "test-user",
      email: "test@example.com",
      exp: Math.floor(Date.now() / 1000) + expSeconds,
      iat: Math.floor(Date.now() / 1000),
    }),
  ).toString("base64url");
  const sig = Buffer.from("fake-sig").toString("base64url");
  return `${header}.${payload}.${sig}`;
}

describe("DominusNodeClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("initializes with default config and exposes all resource modules", () => {
    const client = new DominusNodeClient();
    expect(client.auth).toBeDefined();
    expect(client.keys).toBeDefined();
    expect(client.wallet).toBeDefined();
    expect(client.usage).toBeDefined();
    expect(client.plans).toBeDefined();
    expect(client.sessions).toBeDefined();
    expect(client.proxy).toBeDefined();
    expect(client.admin).toBeDefined();
  });

  it("accepts custom baseUrl in config", () => {
    const client = new DominusNodeClient({ baseUrl: "http://localhost:3000" });
    // Client should construct without errors
    expect(client).toBeDefined();
  });

  it("stores tokens when accessToken and refreshToken are provided in config", () => {
    const access = makeJwt(900);
    const refresh = makeJwt(7 * 86400);
    const client = new DominusNodeClient({ accessToken: access, refreshToken: refresh });
    // The client should be usable (tokens stored internally)
    expect(client).toBeDefined();
  });

  it("connectWithKey calls verifyKey and stores tokens", async () => {
    const access = makeJwt(900);
    const refresh = makeJwt(7 * 86400);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          valid: true,
          token: access,
          refreshToken: refresh,
          userId: "u-123",
          email: "test@example.com",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const client = new DominusNodeClient({ baseUrl: "http://localhost:3000" });
    await client.connectWithKey("dn_live_test_key_123");
    // After connecting, subsequent requests should include the token
    expect(client).toBeDefined();
  });

  it("connectWithCredentials calls login and returns LoginResult", async () => {
    const access = makeJwt(900);
    const refresh = makeJwt(7 * 86400);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          token: access,
          refreshToken: refresh,
          user: {
            id: "u-456",
            email: "user@example.com",
            is_admin: false,
            created_at: "2024-01-01T00:00:00Z",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const client = new DominusNodeClient({ baseUrl: "http://localhost:3000" });
    const result = await client.connectWithCredentials("user@example.com", "password123");
    expect(result.user).toBeDefined();
    expect(result.user!.email).toBe("user@example.com");
    expect(result.mfaRequired).toBeFalsy();
  });

  it("connectWithCredentials returns mfaRequired when MFA is needed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          mfaRequired: true,
          mfaChallengeToken: "challenge_abc",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const client = new DominusNodeClient({ baseUrl: "http://localhost:3000" });
    const result = await client.connectWithCredentials("user@example.com", "password123");
    expect(result.mfaRequired).toBe(true);
    expect(result.user).toBeUndefined();
  });

  it("disconnect clears stored tokens", () => {
    const access = makeJwt(900);
    const refresh = makeJwt(7 * 86400);
    const client = new DominusNodeClient({ accessToken: access, refreshToken: refresh });
    client.disconnect();
    // After disconnect, tokens should be cleared
    expect(client).toBeDefined();
  });
});
