import { describe, it, expect, vi, afterEach } from "vitest";
import { signalGatewayTerminate, terminateProxyTokenSessions } from "./gateway-signal.js";

const TID = "22222222-2222-4222-8222-222222222222";

afterEach(() => { vi.unstubAllEnvs(); });

describe("gateway termination signal", () => {
  it("POSTs the token path with the stats secret and returns the count", async () => {
    vi.stubEnv("PROXY_STATS_SECRET", "s3cret");
    vi.stubEnv("PROXY_INTERNAL_HOST", "gw.internal.example.org");
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ terminated: 3 }) });
    expect(await terminateProxyTokenSessions(TID, f as unknown as typeof fetch)).toBe(3);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(new RegExp(`^http://gw\\.internal\\.example\\.org:\\d+/internal/terminate-token-sessions/${TID}$`));
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer s3cret");
  });
  it("returns null when refused or unreachable", async () => {
    expect(await signalGatewayTerminate("/x", vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch)).toBeNull();
    expect(await signalGatewayTerminate("/x", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch)).toBeNull();
  });
});
