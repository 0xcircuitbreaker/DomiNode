import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as os from "node:os";

type FloorMod = typeof import("./floor.js");
type DiscMod = typeof import("./self-discovery.js");
type MainMod = typeof import("./main.js");

let floor: FloorMod;
let disc: DiscMod;
let mainMod: MainMod;

beforeEach(async () => {
  vi.resetModules();
  floor = await import("./floor.js");
  disc = await import("./self-discovery.js");
  mainMod = await import("./main.js");
});

const ifaces = (): NodeJS.Dict<os.NetworkInterfaceInfo[]> => ({
  lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }],
  eth0: [
    { address: "81.2.69.7", netmask: "255.255.255.0", family: "IPv4", mac: "aa:bb:cc:dd:ee:ff", internal: false, cidr: "81.2.69.7/24" },
    { address: "2a01:4f8:1:2::5", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "aa:bb:cc:dd:ee:ff", internal: false, cidr: "2a01:4f8:1:2::5/64", scopeid: 0 },
    { address: "2a01:4f9:aa:bb::9", netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", family: "IPv6", mac: "aa:bb:cc:dd:ee:ff", internal: false, cidr: "2a01:4f9:aa:bb::9/128", scopeid: 0 },
  ],
});

function echoFetch(ip: string): typeof fetch {
  return (async (url: string | URL) => {
    const nonce = new URL(String(url)).searchParams.get("nonce");
    return new Response(JSON.stringify({ ip, nonce }), { status: 200 });
  }) as unknown as typeof fetch;
}

const ROUTE4 = "Iface\tDestination\tGateway\tFlags\nwlan0\t00000000\t0101A8C0\t0003\nwlan0\t0001A8C0\t00000000\t0001\n";
const ROUTE6 = `${"0".repeat(32)} 00 ${"0".repeat(32)} 00 fe800000000000000000000000000001 00000400 eth0\n`;

describe("self discovery", () => {
  it("floor is closed (all IPs blocked) until discovery completes", async () => {
    expect(floor.floorAllowsIp("93.184.216.34")).toBe(false);
    const { dial } = await import("./dialer.js");
    expect(await dial("93.184.216.34", 443, { allowedPorts: () => [443] })).toEqual({ ok: false, code: "FLOOR_BLOCKED" });
  });

  it("stays closed when public IP lookup fails", async () => {
    const failing = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    expect(await disc.runSelfDiscovery({ apiUrl: "https://api.example", fetchFn: failing, ifaces, readFile: () => null })).toBe(false);
    expect(floor.floorAllowsIp("93.184.216.34")).toBe(false);
  });

  it("rejects echo with wrong nonce", async () => {
    const bad = (async () => new Response(JSON.stringify({ ip: "198.51.100.1", nonce: "x" }))) as unknown as typeof fetch;
    await expect(disc.discoverPublicIp("https://api.example", bad)).rejects.toThrow();
  });

  it("blocks interfaces, v6 prefixes (>= /64), public IP and gateway", async () => {
    const ok = await disc.runSelfDiscovery({
      apiUrl: "https://api.example", fetchFn: echoFetch("5.9.10.20"), ifaces,
      readFile: (p) => (p.endsWith("ipv6_route") ? ROUTE6 : ROUTE4),
    });
    expect(ok).toBe(true);
    expect(floor.floorAllowsIp("93.184.216.34")).toBe(true);
    expect(floor.floorAllowsIp("5.9.10.20")).toBe(false); // public egress
    expect(floor.floorAllowsIp("81.2.69.7")).toBe(false); // iface
    expect(floor.floorAllowsIp("81.2.69.99")).toBe(false); // same public /24
    expect(floor.floorAllowsIp("81.2.70.1")).toBe(true); // other subnet
    expect(floor.floorAllowsIp("2a01:4f8:1:2::5")).toBe(false);
    expect(floor.floorAllowsIp("2a01:4f8:1:2:dead:beef::1")).toBe(false); // same /64 neighbour
    expect(floor.floorAllowsIp("2a01:4f9:aa:bb:1::1")).toBe(false); // /128 widened to /64
    expect(floor.floorAllowsIp("2a01:4f8:1:3::5")).toBe(true); // other /64
    expect(disc.parseDefaultGateways(ROUTE4, ROUTE6)).toEqual(["192.168.1.1", "fe80:0000:0000:0000:0000:0000:0000:0001"]);
  });

  it("main startFloorDiscovery populates the self-block set and re-runs periodically", async () => {
    let calls = 0;
    const f = (async (url: string | URL) => {
      calls++;
      const nonce = new URL(String(url)).searchParams.get("nonce");
      return new Response(JSON.stringify({ ip: calls === 1 ? "5.9.10.30" : "5.9.10.31", nonce }));
    }) as unknown as typeof fetch;
    vi.useFakeTimers();
    try {
      const d = mainMod.startFloorDiscovery("https://api.example", { fetchFn: f, ifaces, readFile: () => null, intervalMs: 1000 });
      expect(await d.ready).toBe(true);
      const snap = floor.selfBlockSnapshot();
      expect(snap.addresses).toEqual(expect.arrayContaining(["81.2.69.7", "2a01:4f8:1:2::5", "5.9.10.30", "127.0.0.1"]));
      expect(snap.prefixes.length).toBeGreaterThanOrEqual(3);
      expect(floor.floorAllowsIp("5.9.10.31")).toBe(true);
      await vi.advanceTimersByTimeAsync(1100);
      expect(floor.floorAllowsIp("5.9.10.31")).toBe(false);
      d.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("dual-stack: learns the NATed IPv4 WAN address even when the IPv6 echo succeeds", async () => {
    const ok = await disc.runSelfDiscovery({
      apiUrl: "https://api.example", ifaces, readFile: (p) => (p.endsWith("ipv6_route") ? ROUTE6 : ROUTE4),
      fetchForFamily: (f) => echoFetch(f === 4 ? "198.51.100.77" : "2a01:4f8:1:2::5"),
    });
    expect(ok).toBe(true);
    expect(floor.floorAllowsIp("198.51.100.77")).toBe(false); // WAN IPv4 (on no interface)
    expect(floor.floorAllowsIp("93.184.216.34")).toBe(true);
  });

  it("keeps the floor closed when an IPv4 default route exists but the IPv4 echo fails", async () => {
    const failing = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    const ok = await disc.runSelfDiscovery({
      apiUrl: "https://api.example", ifaces, readFile: (p) => (p.endsWith("ipv6_route") ? ROUTE6 : ROUTE4),
      fetchForFamily: (f) => (f === 4 ? failing : echoFetch("2a01:4f8:1:2::5")),
    });
    expect(ok).toBe(false);
    expect(floor.floorAllowsIp("93.184.216.34")).toBe(false);
    // IPv6-only host (no IPv4 default route): the IPv6 answer is enough.
    const ok6 = await disc.runSelfDiscovery({
      apiUrl: "https://api.example", ifaces, readFile: () => null,
      fetchForFamily: (f) => (f === 4 ? failing : echoFetch("2a01:4f8:1:2::5")),
    });
    expect(ok6).toBe(true);
  });

  it("familyFetch pins the address family", async () => {
    const http = await import("node:http");
    const srv = http.createServer((req, res) => {
      const nonce = new URL(req.url ?? "/", "http://x").searchParams.get("nonce");
      res.end(JSON.stringify({ ip: req.socket.remoteAddress, nonce }));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    try {
      const port = (srv.address() as { port: number }).port;
      expect(await disc.discoverPublicIp(`http://localhost:${port}`, disc.familyFetch(4))).toBe("127.0.0.1");
    } finally { srv.close(); }
  });
});
