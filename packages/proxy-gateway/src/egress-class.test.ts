import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseAsnTsv } from "./asn-db.js";
import {
  classifyEgress, IpRangeSet, isTransitionTunnel, loadAnonymizerLists, makeEgressVerifier,
  parseAnonymizerAsnJson, parseAsnCsv, DEFAULT_ANONYMIZER_ASNS, ipToBig,
} from "./egress-class.js";
import { parseProxyOptions } from "./auth.js";
import { nodeMatchesQuotedClass, toX402Class, selectClassFor } from "./x402-handler.js";

vi.mock("@dominusnode/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dominusnode/shared")>();
  return { ...actual, createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) };
});

const db = parseAsnTsv([
  "104.28.0.0\t104.28.255.255\t13335\tUS\tCLOUDFLARENET",      // WARP egress
  "52.0.0.0\t52.255.255.255\t16509\tUS\tAMAZON-02",            // hosting
  "73.0.0.0\t73.255.255.255\t7922\tUS\tCOMCAST-7922",          // residential ISP
  "185.65.134.0\t185.65.135.255\t39351\tSE\t31173 Services AB", // Mullvad
  "2a09:bac0::\t2a09:bacf:ffff:ffff:ffff:ffff:ffff:ffff\t13335\tUS\tCLOUDFLARENET",
  "2601::\t2601:ffff:ffff:ffff:ffff:ffff:ffff:ffff\t7922\tUS\tCOMCAST-7922",
  "2600:1f00::\t2600:1fff:ffff:ffff:ffff:ffff:ffff:ffff\t16509\tUS\tAMAZON-02",
].join("\n"));

const data = (ips: string[] = []) => ({ db, anonymizerIps: IpRangeSet.from(ips) });

describe("classifyEgress", () => {
  it("classifies residential, dc and masked by ASN (IPv4)", () => {
    expect(classifyEgress("73.1.2.3", data())).toMatchObject({ ipClass: "residential", asn: 7922, reason: "access_asn" });
    expect(classifyEgress("52.1.2.3", data())).toMatchObject({ ipClass: "dc", asn: 16509, reason: "hosting_asn" });
    expect(classifyEgress("104.28.10.20", data())).toMatchObject({ ipClass: "masked", asn: 13335, reason: "anonymizer_asn" });
    expect(classifyEgress("185.65.134.7", data())).toMatchObject({ ipClass: "masked", asn: 39351 });
  });

  it("anonymizer ASN wins over the hosting list (Cloudflare is in both)", () => {
    expect(classifyEgress("104.28.10.20", { ...data(), hostingAsns: new Set([13335]) }).ipClass).toBe("masked");
  });

  it("classifies IPv6 the same way, incl. v4-mapped addresses", () => {
    expect(classifyEgress("2601:1:2::3", data()).ipClass).toBe("residential");
    expect(classifyEgress("2600:1f00::1", data()).ipClass).toBe("dc");
    expect(classifyEgress("2a09:bac1::1", data()).ipClass).toBe("masked");
    expect(classifyEgress("::ffff:104.28.1.1", data()).ipClass).toBe("masked");
    expect(classifyEgress("2601:1:2::3%eth0", data()).ipClass).toBe("residential");
  });

  it("IPv6 transition tunnels (Teredo, 6to4) are masked even without ASN data", () => {
    expect(isTransitionTunnel("2001:0:4136:e378:8000:63bf:3fff:fdd2")).toBe(true);
    expect(isTransitionTunnel("2002:4928:0101::1")).toBe(true);
    expect(isTransitionTunnel("2001:db8::1")).toBe(false);
    expect(isTransitionTunnel("1.2.3.4")).toBe(false);
    expect(classifyEgress("2001:0:4136:e378:8000:63bf:3fff:fdd2", data())).toMatchObject({ ipClass: "masked", reason: "ipv6_tunnel" });
    expect(classifyEgress("2002:4928:0101::1", { db: null })).toMatchObject({ ipClass: "masked" });
  });

  it("unknown ASN, no DB or garbage input -> unknown (conservative)", () => {
    expect(classifyEgress("8.8.8.8", data())).toMatchObject({ ipClass: "unknown", asn: null, reason: "no_asn" });
    expect(classifyEgress("2a00::1", data()).ipClass).toBe("unknown");
    expect(classifyEgress("73.1.2.3", { db: null }).ipClass).toBe("unknown");
    expect(classifyEgress("not-an-ip", data())).toMatchObject({ ipClass: "unknown", reason: "invalid_ip" });
    const throwing = { db: { v4Count: 0, v6Count: 0, lookup: () => null, lookupInfo: () => { throw new Error("x"); } } };
    expect(classifyEgress("73.1.2.3", throwing).ipClass).toBe("unknown");
  });

  it("anonymizer IP list (Tor exit, iCloud Private Relay range) masks residential-ASN addresses", () => {
    const d = data(["73.5.5.5", "73.200.0.0/16", "2601:aaaa::/32", "# comment", ""]);
    expect(classifyEgress("73.5.5.5", d)).toMatchObject({ ipClass: "masked", reason: "anonymizer_ip" });
    expect(classifyEgress("73.200.9.9", d).ipClass).toBe("masked");
    expect(classifyEgress("2601:aaaa:1::1", d).ipClass).toBe("masked");
    expect(classifyEgress("73.5.5.6", d).ipClass).toBe("residential");
  });
});

describe("IpRangeSet", () => {
  it("merges ranges and ignores invalid or absurdly wide entries", () => {
    const s = IpRangeSet.from(["10.0.0.0/24", "10.0.0.128/25", "10.0.1.0/24", "0.0.0.0/0", "1.0.0.0/7", "::/0", "999.1.1.1", "1.2.3.4/33", "x/1"]);
    expect(s.size).toBe(1); // 10.0.0.0-10.0.1.255 merged; /0 and /7 refused
    expect(s.has("10.0.1.200")).toBe(true);
    expect(s.has("10.0.2.0")).toBe(false);
    expect(s.has("8.8.8.8")).toBe(false);
    expect(s.has("garbage")).toBe(false);
  });
  it("ipToBig normalises v4-mapped v6", () => {
    expect(ipToBig("::ffff:1.2.3.4")).toEqual(ipToBig("1.2.3.4"));
    expect(ipToBig("1.2.3")).toBeNull();
  });
});

describe("anonymizer list loading (offline-safe)", () => {
  it("the versioned repo file parses and includes the built-ins", () => {
    const file = path.resolve(__dirname, "../../../data/anonymizer-asns.json");
    const doc = JSON.parse(fs.readFileSync(file, "utf8")) as { version: number };
    expect(doc.version).toBeGreaterThanOrEqual(1);
    const asns = parseAnonymizerAsnJson(fs.readFileSync(file, "utf8"));
    for (const a of DEFAULT_ANONYMIZER_ASNS) expect(asns.has(a)).toBe(true);
  });

  it("missing files fall back to built-ins; env extends; bad files warn", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anon-"));
    const warn = vi.fn();
    const none = loadAnonymizerLists({ ANONYMIZER_ASNS_FILE: path.join(dir, "nope.json"), ANONYMIZER_IPS_FILE: path.join(dir, "nope.txt"), ANONYMIZER_ASNS: "64500, x, 0, 64501" }, warn);
    expect(none.asnSource).toBe("builtin");
    expect(none.asns.has(13335)).toBe(true);
    expect(none.asns.has(64500) && none.asns.has(64501)).toBe(true);
    expect(none.asns.has(0)).toBe(false);
    expect(none.ips.size).toBe(0);

    fs.writeFileSync(path.join(dir, "bad.json"), "{not json");
    fs.writeFileSync(path.join(dir, "ips.txt"), "198.51.100.7\n203.0.113.0/24\n");
    const bad = loadAnonymizerLists({ ANONYMIZER_ASNS_FILE: path.join(dir, "bad.json"), ANONYMIZER_IPS_FILE: path.join(dir, "ips.txt") }, warn);
    expect(warn).toHaveBeenCalled();
    expect(bad.asns.has(13335)).toBe(true);
    expect(bad.ips.has("203.0.113.9")).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("parseAnonymizerAsnJson rejects a doc without asns[] and skips bad entries", () => {
    expect(() => parseAnonymizerAsnJson("{}")).toThrow();
    expect([...parseAnonymizerAsnJson('{"asns":[{"asn":64500},{"asn":"x"},64501,-1,{"asn":4294967296}]}')]).toEqual([64500, 64501]);
    expect(parseAsnCsv(undefined)).toEqual([]);
  });
});

describe("makeEgressVerifier (probe re-verification)", () => {
  it("downgrades a residential node whose probe egress is masked, immediately and persistently", async () => {
    const live = { ipClass: "residential" as const as "residential" | "masked" | "dc" | "mobile" | "unknown", egressVerifiedAt: undefined as number | undefined };
    const record = vi.fn().mockResolvedValue(undefined);
    const v = makeEgressVerifier({ getNode: () => live, classify: (ip) => classifyEgress(ip, data()), record, now: () => 42 });
    expect(await v("n1", "2a09:bac1::5")).toBe("masked"); // other-family egress through WARP
    expect(live.ipClass).toBe("masked");
    expect(live.egressVerifiedAt).toBe(42);
    expect(record).toHaveBeenCalledWith("n1", "masked", { probeClass: "masked", connectClass: null });
  });

  it("first probe on a connection starts from the peer class (unknown until then); later probes only tighten", async () => {
    type C = "residential" | "masked" | "dc" | "mobile" | "unknown";
    const live = { ipClass: "unknown" as C, peerClass: "residential" as C, egressVerifiedAt: undefined as number | undefined };
    const record = vi.fn().mockResolvedValue(undefined);
    let obs: C = "residential";
    const v = makeEgressVerifier({ getNode: () => live, classify: () => ({ ipClass: obs }), record, now: () => 1 });
    expect(await v("n1", "73.1.1.1")).toBe("residential");
    expect(record).toHaveBeenLastCalledWith("n1", "residential", { probeClass: "residential", connectClass: "residential" });
    obs = "masked";
    expect(await v("n1", "104.28.1.1")).toBe("masked");
    obs = "residential";
    expect(await v("n1", "73.1.1.1")).toBe("masked"); // no upgrade within the connection
    // Raw verdict is persisted each time, so a reconnect starts from it.
    expect(record).toHaveBeenLastCalledWith("n1", "masked", { probeClass: "residential", connectClass: "residential" });
  });

  it("never upgrades within a connection and is a no-op when unchanged", async () => {
    const live = { ipClass: "masked" as "residential" | "masked" | "dc" | "mobile" | "unknown" };
    const record = vi.fn();
    const v = makeEgressVerifier({ getNode: () => live, classify: () => ({ ipClass: "residential" }), record });
    expect(await v("n1", "73.1.1.1")).toBe("masked");
    expect(record).toHaveBeenCalledWith("n1", "masked", { probeClass: "residential", connectClass: null });
    const gone = makeEgressVerifier({ getNode: () => undefined, classify: () => ({ ipClass: "dc" }), record });
    expect(await gone("n2", "52.1.1.1")).toBeNull();
  });
});

describe("class-masked username flag and x402 class matching", () => {
  it("parses class-masked; unflagged stays unset", () => {
    expect(parseProxyOptions("country-US-class-masked").ipClass).toBe("masked");
    expect(parseProxyOptions("class-masked-session-abc").ipClass).toBe("masked");
    expect(parseProxyOptions("relay").ipClass).toBeUndefined();
    expect(parseProxyOptions("class-maskedx").ipClass).toBeUndefined();
  });
  it("x402: masked nodes need an explicit masked quote", () => {
    expect(nodeMatchesQuotedClass("any", "masked")).toBe(false);
    expect(nodeMatchesQuotedClass("any", "residential")).toBe(true);
    expect(nodeMatchesQuotedClass("masked", "masked")).toBe(true);
    expect(nodeMatchesQuotedClass("residential", "masked")).toBe(false);
    expect(nodeMatchesQuotedClass("masked", "residential")).toBe(false);
    expect(toX402Class("masked")).toBe("masked");
    expect(toX402Class("unknown")).toBe("any");
    expect(selectClassFor("masked")).toBe("masked");
  });
});
