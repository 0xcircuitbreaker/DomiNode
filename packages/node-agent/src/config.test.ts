import { describe, it, expect } from "vitest";
import { loadConfig, ConfigError, parseIntStrict, isDeniedDomain, MAXIMA } from "./config.js";
import { Limits } from "./limits.js";

describe("config", () => {
  it("defaults are safe", () => {
    const c = loadConfig({});
    expect(c.ports).toEqual([80, 443]);
    expect(c.gatewayUrl.startsWith("wss://")).toBe(true);
    expect(c.maxStreams).toBe(32);
  });

  it("rejects NaN / out-of-range numbers", () => {
    expect(() => loadConfig({ DN_NODE_MAX_STREAMS: "abc" })).toThrow(ConfigError);
    expect(() => loadConfig({ DN_NODE_MAX_STREAMS: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ DN_NODE_MAX_STREAMS: String(MAXIMA.maxStreams + 1) })).toThrow(ConfigError);
    expect(() => loadConfig({ DN_NODE_REQ_PER_SEC: "1e3" })).toThrow(ConfigError);
    expect(parseIntStrict("x", undefined, 1, 2)).toBeUndefined();
  });

  it("ports can only be a subset of the floor", () => {
    expect(loadConfig({ DN_NODE_PORTS: "443" }).ports).toEqual([443]);
    expect(() => loadConfig({ DN_NODE_PORTS: "25,8080" })).toThrow(ConfigError);
  });

  it("insecure / credentialed URLs are refused", () => {
    expect(() => loadConfig({ DN_NODE_GATEWAY_URL: "ws://relay.example.com/v1/tunnel" })).toThrow(ConfigError);
    expect(() => loadConfig({ DN_NODE_API_URL: "http://api.example.com" })).toThrow(ConfigError);
    expect(() => loadConfig({ DN_NODE_GATEWAY_URL: "wss://u:p@relay.example.com" })).toThrow(ConfigError);
  });

  it("deny domains match subdomains", () => {
    const c = loadConfig({ DN_NODE_DENY_DOMAINS: "Bank.example, other.org" });
    expect(isDeniedDomain("www.bank.example", c.denyDomains)).toBe(true);
    expect(isDeniedDomain("notbank.example", c.denyDomains)).toBe(false);
    expect(() => loadConfig({ DN_NODE_DENY_DOMAINS: "bad domain" })).toThrow(ConfigError);
  });
});

describe("limits", () => {
  it("caps streams, req/s and GB/day; tighten only lowers", () => {
    let t = 0;
    const l = new Limits({ maxStreams: 2, reqPerSec: 3, gbPerDay: 1 }, () => t);
    expect(l.tryOpenStream()).toBe(true);
    expect(l.tryOpenStream()).toBe(true);
    expect(l.tryOpenStream()).toBe(false); // streams
    l.release(); l.release();
    expect(l.tryOpenStream()).toBe(true);
    l.release();
    expect(l.tryOpenStream()).toBe(false); // tokens exhausted
    t += 1000;
    expect(l.tryOpenStream()).toBe(true);
    l.release();
    l.tighten({ maxStreams: 100, reqPerSec: 1, gbPerDay: NaN });
    expect(l.values).toEqual({ maxStreams: 2, reqPerSec: 1, gbPerDay: 1 });
    expect(l.addBytes(999_999_999)).toBe(true);
    expect(l.addBytes(2)).toBe(false);
    t += 1000;
    expect(l.tryOpenStream()).toBe(false); // daily cap
    t += 86_400_000;
    expect(l.tryOpenStream()).toBe(true);
  });
});
