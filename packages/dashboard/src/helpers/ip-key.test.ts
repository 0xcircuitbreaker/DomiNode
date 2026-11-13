import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { ipRateKey } from "./ip-key.js";
import { createKeyedLimiter } from "../routes/v1/limiter.js";
import { isGatewayProbe } from "../routes/v1/probe.js";

describe("ipRateKey", () => {
  it("keys IPv6 by /64 and leaves IPv4 and non-IP keys alone", () => {
    expect(ipRateKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(ipRateKey("2001:db8:1:2::1")).toBe(ipRateKey("2001:0db8:0001:0002:ffff::9"));
    expect(ipRateKey("2001:db8:1:3::1")).not.toBe(ipRateKey("2001:db8:1:2::1"));
    expect(ipRateKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(ipRateKey("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(ipRateKey("::1")).toBe("0:0:0:0::/64");
    expect(ipRateKey("203.0.113.9")).toBe("203.0.113.9");
    expect(ipRateKey("11111111-1111-1111-1111-111111111111")).toBe("11111111-1111-1111-1111-111111111111");
  });
});

describe("createKeyedLimiter", () => {
  it("shares one budget across a /64 (address rotation does not help)", () => {
    const l = createKeyedLimiter(3, 60_000);
    for (let i = 1; i <= 3; i++) expect(l.hit(`2001:db8:0:1::${i.toString(16)}`)).toBe(true);
    expect(l.hit("2001:db8:0:1::ffff")).toBe(false);
    expect(l.hit("2001:db8:0:2::1")).toBe(true);
    l.stop();
  });

  it("evicts the oldest key when full instead of refusing every new client", () => {
    const l = createKeyedLimiter(5, 60_000, 3);
    for (let i = 0; i < 10; i++) l.hit(`10.0.0.${i}`);
    expect(l.hit("198.51.100.1")).toBe(true);
    l.stop();
  });
});

describe("gateway probe authentication", () => {
  const secret = "s".repeat(40);
  const nonce = "abcdefghijklmnop";
  it("accepts only the HMAC of the nonce under PROBE_AUTH_SECRET", () => {
    const good = createHmac("sha256", secret).update(nonce).digest("hex");
    expect(isGatewayProbe(nonce, good, secret)).toBe(true);
    expect(isGatewayProbe(nonce + "x", good, secret)).toBe(false);
    expect(isGatewayProbe(nonce, good, undefined)).toBe(false);
    expect(isGatewayProbe(nonce, good, "short")).toBe(false);
    expect(isGatewayProbe(nonce, "zz", secret)).toBe(false);
  });
});
