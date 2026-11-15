import { describe, it, expect, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import express from "express";
import router, { normalizeIp, _resetProbeLimiter } from "./probe.js";
import { call } from "./test-helpers.js";

function app() {
  const a = express();
  a.use("/v1", router);
  return a;
}

describe("GET /v1/probe/echo", () => {
  beforeEach(() => _resetProbeLimiter());

  it("echoes caller IP and nonce, uncached", async () => {
    const r = await call(app(), "GET", "/v1/probe/echo?nonce=abcdefghijklmnop_1");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ip: "127.0.0.1", nonce: "abcdefghijklmnop_1" });
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("tells an authenticated gateway probe that its signature was accepted", async () => {
    const prev = process.env["PROBE_AUTH_SECRET"];
    process.env["PROBE_AUTH_SECRET"] = "p".repeat(40);
    try {
      const nonce = "abcdefghijklmnop_2";
      const sig = createHmac("sha256", "p".repeat(40)).update(nonce).digest("hex");
      const ok = await call(app(), "GET", `/v1/probe/echo?nonce=${nonce}`, { headers: { "X-DN-Probe-Auth": sig } });
      expect(ok.body).toEqual({ ip: "127.0.0.1", nonce, gateway: true });
      const other = createHmac("sha256", "q".repeat(40)).update(nonce).digest("hex");
      const bad = await call(app(), "GET", `/v1/probe/echo?nonce=${nonce}`, { headers: { "X-DN-Probe-Auth": other } });
      expect(bad.body).toEqual({ ip: "127.0.0.1", nonce });
    } finally {
      if (prev === undefined) delete process.env["PROBE_AUTH_SECRET"]; else process.env["PROBE_AUTH_SECRET"] = prev;
    }
  });

  it("rejects missing, short or unsafe nonces", async () => {
    expect((await call(app(), "GET", "/v1/probe/echo")).status).toBe(400);
    expect((await call(app(), "GET", "/v1/probe/echo?nonce=short")).status).toBe(400);
    expect((await call(app(), "GET", "/v1/probe/echo?nonce=" + encodeURIComponent("<script>alert(1)</script>xx"))).status).toBe(400);
    expect((await call(app(), "GET", "/v1/probe/echo?nonce=a&nonce=b")).status).toBe(400);
  });

  it("normalizes mapped and zoned addresses", () => {
    expect(normalizeIp("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(normalizeIp("fe80::1%eth0")).toBe("fe80::1");
    expect(normalizeIp(undefined)).toBe("");
  });
});
