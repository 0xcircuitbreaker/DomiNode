import { describe, it, expect, beforeEach } from "vitest";
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
