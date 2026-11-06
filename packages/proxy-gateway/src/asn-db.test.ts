import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("geoip-lite", () => ({ default: { lookup: () => ({ country: "us" }) } }));
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { loadAsnDbFile, parseAsnTsv, classifyAsn, parseHostingAsns } from "./asn-db.js";
import { lookupPeerGeo, setAsnDb } from "./geo-check.js";

const FIXTURE = path.join(__dirname, "__fixtures__", "ip2asn-tiny.tsv");

describe("asn-db", () => {
  afterEach(() => setAsnDb(null));

  it("looks up IPv4 ranges by binary search and skips AS 0", () => {
    const db = loadAsnDbFile(FIXTURE)!;
    expect(db.v4Count).toBe(3);
    expect(db.lookup("1.0.0.1")).toBe(13335);
    expect(db.lookup("8.8.8.8")).toBe(15169);
    expect(db.lookup("8.8.9.0")).toBeNull();
    expect(db.lookup("10.1.2.3")).toBeNull();
    expect(db.lookup("0.0.0.1")).toBeNull();
    expect(db.lookup("::ffff:81.2.69.142")).toBe(20712);
  });

  it("looks up IPv6 ranges", () => {
    const db = loadAsnDbFile(FIXTURE)!;
    expect(db.v6Count).toBe(3);
    expect(db.lookup("2001:4860:4860::8888")).toBe(15169);
    expect(db.lookup("2003:e1:1234::1")).toBe(3320);
    expect(db.lookup("2003:4000::1")).toBeNull();
    expect(db.lookup("2a00:1450:4001:80b::200e")).toBe(15169);
    expect(db.lookup("not-an-ip")).toBeNull();
  });

  it("sorts unsorted input and ignores malformed rows", () => {
    const db = parseAsnTsv("9.0.0.0\t9.0.0.255\t3\n1.0.0.0\t1.0.0.255\t1\ngarbage\n5.0.0.9\t5.0.0.1\t2\n");
    expect(db.v4Count).toBe(2);
    expect(db.lookup("9.0.0.5")).toBe(3);
    expect(db.lookup("1.0.0.5")).toBe(1);
  });

  it("reads gzip and returns null for a missing file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asn-"));
    const gz = path.join(dir, "db.tsv.gz");
    fs.writeFileSync(gz, zlib.gzipSync(fs.readFileSync(FIXTURE)));
    expect(loadAsnDbFile(gz)!.lookup("8.8.8.8")).toBe(15169);
    expect(loadAsnDbFile(path.join(dir, "missing.tsv.gz"))).toBeNull();
    fs.rmSync(dir, { recursive: true });
  });

  it("classifies hosting ASNs as dc and others as residential", () => {
    expect(classifyAsn(15169)).toBe("dc");
    expect(classifyAsn(3320)).toBe("residential");
    expect(classifyAsn(null)).toBe("unknown");
    const h = parseHostingAsns("3320, x, -1");
    expect(classifyAsn(3320, h)).toBe("dc");
    expect(h.has(15169)).toBe(true);
  });

  it("lookupPeerGeo returns the real ASN and class once a db is installed", async () => {
    delete process.env["SKIP_GEOIP"];
    const { initGeoCheck } = await import("./geo-check.js");
    await initGeoCheck();
    expect(lookupPeerGeo("8.8.8.8")).toEqual({ country: "US", asn: null, ipClass: null });
    setAsnDb(loadAsnDbFile(FIXTURE));
    expect(lookupPeerGeo("8.8.8.8")).toMatchObject({ asn: 15169, ipClass: "dc" });
    expect(lookupPeerGeo("81.2.69.142")).toMatchObject({ asn: 20712, ipClass: "residential" });
  });
});
