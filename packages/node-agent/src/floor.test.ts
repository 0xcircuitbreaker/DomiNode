import { describe, it, expect } from "vitest";
import { markSelfDiscoveryComplete } from "./floor.js";
import { addSelfAddress, effectivePorts, floorAllowsHost, floorAllowsIp, floorAllowsPort, floorHash, FLOOR_PORTS } from "./floor.js";
import { loadConfig } from "./config.js";

markSelfDiscoveryComplete();

describe("node floor", () => {
  it("only ever allows 80/443", () => {
    for (const p of [22, 23, 25, 465, 587, 3389, 6667, 8080, 0, 65536, -1, 1.5, NaN]) expect(floorAllowsPort(p)).toBe(false);
    expect(floorAllowsPort(80)).toBe(true);
    expect(floorAllowsPort(443)).toBe(true);
  });

  it("effective ports = floor ∩ policy ∩ local", () => {
    expect(effectivePorts([80, 443, 25, 8080], [80, 443, 25])).toEqual([80, 443]);
    expect(effectivePorts([443], [80, 443])).toEqual([443]);
    expect(effectivePorts([25, 22, 3389], [25, 22, 3389])).toEqual([]);
    expect(effectivePorts(["80", null, 443.0], [80, 443])).toEqual([443]);
  });

  it("blocks loopback, metadata, mapped and private literals", () => {
    for (const ip of ["127.0.0.1", "169.254.169.254", "::ffff:127.0.0.1", "::1", "10.0.0.1", "192.168.1.1",
      "100.64.0.1", "fd00:ec2::254", "::127.0.0.1", "2002:7f00:1::", "0.0.0.0"]) {
      expect(floorAllowsIp(ip)).toBe(false);
      expect(floorAllowsHost(ip)).toBe(false);
    }
    for (const h of ["localhost", "a.localhost", "x.local", "metadata.internal", "1.0.0.127.in-addr.arpa",
      "0x7f000001", "2130706433", "0177.0.0.1", "127.1", "[::1]"]) {
      expect(floorAllowsHost(h)).toBe(false);
    }
    expect(floorAllowsHost("example.com")).toBe(true);
    expect(floorAllowsIp("93.184.216.34")).toBe(true);
  });

  it("self addresses are add-only blocks", () => {
    expect(floorAllowsIp("8.8.4.4")).toBe(true);
    addSelfAddress("8.8.4.4");
    expect(floorAllowsIp("8.8.4.4")).toBe(false);
    expect(floorAllowsIp("::ffff:8.8.4.4")).toBe(false);
  });

  it("FLOOR_PORTS is frozen", () => {
    expect(Object.isFrozen(FLOOR_PORTS)).toBe(true);
    expect(() => (FLOOR_PORTS as number[]).push(25)).toThrow();
    expect(floorAllowsPort(25)).toBe(false);
  });

  it("floorHash is stable and version-bound", () => {
    expect(floorHash("1")).toMatch(/^[0-9a-f]{64}$/);
    expect(floorHash("1")).toBe(floorHash("1"));
    expect(floorHash("1")).not.toBe(floorHash("2"));
  });

  it("no env or flag loosens the floor", () => {
    const hostileEnv = {
      DN_NODE_PORTS: "25,22,80,8080,3389", DN_NODE_FLOOR: "off", DN_NODE_ALLOW_PRIVATE: "1",
      DN_NODE_HARD_DENY_PORTS: "", DN_NODE_SSRF: "false", DN_NODE_MAX_STREAMS: "5",
    };
    const cfg = loadConfig(hostileEnv, { ports: "25,80", "allow-private": "1" });
    expect(cfg.ports).toEqual([80]);
    expect(effectivePorts([25, 80, 443], cfg.ports)).toEqual([80]);
    expect(floorAllowsPort(25)).toBe(false);
    expect(floorAllowsIp("127.0.0.1")).toBe(false);
    expect(floorAllowsIp("169.254.169.254")).toBe(false);
    expect(floorAllowsIp("::ffff:127.0.0.1")).toBe(false);
  });
});
