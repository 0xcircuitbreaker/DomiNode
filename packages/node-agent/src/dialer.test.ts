import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import * as net from "node:net";
import { dial, type Connector } from "./dialer.js";

const ports = () => [80, 443];

describe("dialer", () => {
  let server: net.Server;
  let port: number;
  beforeAll(async () => {
    server = net.createServer((s) => { s.on("error", () => undefined); s.end("hi"); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as net.AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const toLocal = (spoof?: string): Connector => () => {
    const s = net.connect({ host: "127.0.0.1", port });
    if (spoof) Object.defineProperty(s, "remoteAddress", { get: () => spoof });
    return s;
  };

  it("refuses non-floor ports and ports outside the allowed set", async () => {
    expect(await dial("example.com", 25, { allowedPorts: () => [25, 80] })).toEqual({ ok: false, code: "PORT_BLOCKED" });
    expect(await dial("example.com", 80, { allowedPorts: () => [443] })).toEqual({ ok: false, code: "PORT_BLOCKED" });
  });

  it("refuses blocked literals and names without resolving", async () => {
    const resolver = vi.fn(async () => ["93.184.216.34"]);
    for (const h of ["127.0.0.1", "169.254.169.254", "::ffff:127.0.0.1", "[::1]", "localhost", "0x7f000001"]) {
      expect(await dial(h, 80, { allowedPorts: ports, resolver })).toEqual({ ok: false, code: "FLOOR_BLOCKED" });
    }
    expect(resolver).not.toHaveBeenCalled();
  });

  it("rejects when ANY resolved record is private (rebinding)", async () => {
    const connector = vi.fn(toLocal());
    const r = await dial("evil.example", 443, { allowedPorts: ports, resolver: async () => ["93.184.216.34", "10.0.0.5"], connector });
    expect(r).toEqual({ ok: false, code: "FLOOR_BLOCKED" });
    expect(connector).not.toHaveBeenCalled();
  });

  it("DNS failure / empty -> DNS_FAIL; deny domain -> FLOOR_BLOCKED", async () => {
    expect(await dial("x.example", 80, { allowedPorts: ports, resolver: async () => [] })).toEqual({ ok: false, code: "DNS_FAIL" });
    expect(await dial("x.example", 80, { allowedPorts: ports, resolver: async () => { throw new Error("x"); } }))
      .toEqual({ ok: false, code: "DNS_FAIL" });
    expect(await dial("a.bank.example", 80, { allowedPorts: ports, denyDomains: ["bank.example"], resolver: async () => ["93.184.216.34"] }))
      .toEqual({ ok: false, code: "FLOOR_BLOCKED" });
  });

  it("connects to the checked IP literal", async () => {
    const seen: string[] = [];
    const connector: Connector = (ip, p) => { seen.push(`${ip}:${p}`); return toLocal("93.184.216.34")(ip, p); };
    const r = await dial("ok.example", 443, { allowedPorts: ports, resolver: async () => ["93.184.216.34"], connector });
    expect(r.ok).toBe(true);
    expect(seen).toEqual(["93.184.216.34:443"]);
    if (r.ok) r.socket.destroy();
  });

  it("re-checks remoteAddress after connect (loopback landing is refused)", async () => {
    const r = await dial("ok.example", 443, { allowedPorts: ports, resolver: async () => ["93.184.216.34"], connector: toLocal() });
    expect(r).toEqual({ ok: false, code: "FLOOR_BLOCKED" });
    const r2 = await dial("ok.example", 443, { allowedPorts: ports, resolver: async () => ["93.184.216.34"], connector: toLocal("1.1.1.1") });
    expect(r2).toEqual({ ok: false, code: "FLOOR_BLOCKED" });
  });

  it("connect failure -> DIAL_FAIL", async () => {
    const connector: Connector = () => net.connect({ host: "127.0.0.1", port: 1 });
    expect(await dial("ok.example", 80, { allowedPorts: ports, resolver: async () => ["93.184.216.34"], connector, timeoutMs: 2000 }))
      .toEqual({ ok: false, code: "DIAL_FAIL" });
  });
});
