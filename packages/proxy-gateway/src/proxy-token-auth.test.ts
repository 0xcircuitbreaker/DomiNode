import { describe, it, expect, vi, beforeEach } from "vitest";
import * as http from "node:http";
import * as crypto from "node:crypto";

const m = vi.hoisted(() => ({ findUsable: vi.fn(), recordUsage: vi.fn(), findUserById: vi.fn(), findUserByApiKey: vi.fn(), verifyLegacy: vi.fn() }));

vi.mock("@dominusnode/shared", () => ({
  verifyProxySessionToken: (...a: unknown[]) => m.verifyLegacy(...a),
  proxyTokenRepo: {
    OPAQUE_PROXY_TOKEN_RE: /^dn_proxy_[A-Za-z0-9_-]{43}$/,
    hashProxyToken: (t: string) => crypto.createHash("sha256").update(t).digest("hex"),
    findUsableByHash: (...a: unknown[]) => m.findUsable(...a),
    recordUsage: (...a: unknown[]) => m.recordUsage(...a),
  },
  userRepo: { findUserById: (...a: unknown[]) => m.findUserById(...a), findUserByApiKey: (...a: unknown[]) => m.findUserByApiKey(...a) },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { authenticateRequest, verifyProxyCredential, recordProxyTokenUsage, clearProxyTokenCache, PROXY_TOKEN_CACHE_TTL_MS } from "./auth.js";

const TOKEN = "dn_proxy_" + "A".repeat(43);
const TID = "22222222-2222-4222-8222-222222222222";
const UID = "11111111-1111-4111-8111-111111111111";
const user = { id: UID, status: "active", email_verified: true, wallet_address: null };
const tokenRow = { id: TID, userId: UID, expiresAt: new Date(Date.now() + 3_600_000) };

function req(pass: string, userName = "country-US"): http.IncomingMessage {
  const r = new http.IncomingMessage(null as never);
  r.headers["proxy-authorization"] = `Basic ${Buffer.from(`${userName}:${pass}`).toString("base64")}`;
  return r;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
  clearProxyTokenCache();
});

describe("opaque dn_proxy_ tokens", () => {
  it("authenticates by hash and carries the token id", async () => {
    m.findUsable.mockResolvedValue(tokenRow);
    m.findUserById.mockResolvedValue(user);
    const r = await authenticateRequest(req(TOKEN));
    expect(r).not.toBeNull();
    expect(r!.proxyTokenId).toBe(TID);
    expect(r!.teamId).toBeNull();
    expect(r!.proxyOptions.country).toBe("US");
    expect(m.findUsable).toHaveBeenCalledWith(crypto.createHash("sha256").update(TOKEN).digest("hex"));
    expect(m.verifyLegacy).not.toHaveBeenCalled();
  });

  it("refuses an unknown, revoked, expired or exhausted token (repo returns null)", async () => {
    m.findUsable.mockResolvedValue(null);
    expect(await authenticateRequest(req(TOKEN))).toBeNull();
    expect(m.findUserById).not.toHaveBeenCalled();
  });

  it("refuses when the owner is suspended or unverified", async () => {
    m.findUsable.mockResolvedValue(tokenRow);
    m.findUserById.mockResolvedValueOnce({ ...user, status: "suspended" });
    expect(await verifyProxyCredential(TOKEN)).toBeNull();
    m.findUserById.mockResolvedValueOnce({ ...user, email_verified: false });
    expect(await verifyProxyCredential(TOKEN)).toBeNull();
    m.findUserById.mockResolvedValueOnce(null);
    expect(await verifyProxyCredential(TOKEN)).toBeNull();
  });

  it("caches a lookup briefly; revocation applies after the TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    m.findUsable.mockResolvedValueOnce(tokenRow).mockResolvedValue(null);
    m.findUserById.mockResolvedValue(user);
    expect(await verifyProxyCredential(TOKEN)).not.toBeNull();
    expect(await verifyProxyCredential(TOKEN)).not.toBeNull();
    expect(m.findUsable).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + PROXY_TOKEN_CACHE_TTL_MS + 1);
    expect(await verifyProxyCredential(TOKEN)).toBeNull();
  });

  it("drops the cache entry when a cap is reached so the next request is refused", async () => {
    m.findUsable.mockResolvedValueOnce(tokenRow).mockResolvedValue(null);
    m.findUserById.mockResolvedValue(user);
    expect(await verifyProxyCredential(TOKEN)).not.toBeNull();
    m.recordUsage.mockResolvedValue({ withinCaps: false });
    await recordProxyTokenUsage(TID, 5000n, 25n);
    expect(m.recordUsage).toHaveBeenCalledWith(TID, 5000n, 25n);
    expect(await verifyProxyCredential(TOKEN)).toBeNull();
  });

  it("keeps the cache when usage is within caps, and never throws on DB error", async () => {
    m.findUsable.mockResolvedValueOnce(tokenRow);
    m.findUserById.mockResolvedValue(user);
    await verifyProxyCredential(TOKEN);
    m.recordUsage.mockResolvedValueOnce({ withinCaps: true });
    await recordProxyTokenUsage(TID, 1n, 1n);
    expect(await verifyProxyCredential(TOKEN)).not.toBeNull();
    m.recordUsage.mockRejectedValueOnce(new Error("db down"));
    await expect(recordProxyTokenUsage(TID, 1n, 1n)).resolves.toBeUndefined();
  });

  it("still accepts legacy HMAC tokens (contain a dot) via the stateless verifier", async () => {
    m.verifyLegacy.mockReturnValue({ userId: UID, walletAddress: "0xabc", expiresAt: Date.now() + 1000, nonce: "n" });
    m.findUserById.mockResolvedValue({ ...user, wallet_address: "0xABC" });
    const r = await verifyProxyCredential("dn_proxy_payload.sig");
    expect(r).not.toBeNull();
    expect(r!.proxyTokenId).toBeNull();
    expect(m.findUsable).not.toHaveBeenCalled();
  });

  it("refuses other prefixes", async () => {
    expect(await verifyProxyCredential("dn_node_abc")).toBeNull();
  });
});
