import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  checkClockSkew,
  checkGatewayTls,
  checkKeyFormat,
  checkOutboundDial,
  exitCodeFor,
  formatResults,
  MAX_CLOCK_SKEW_MS,
  runSelfcheck,
} from "./selfcheck.js";
import { readNodeFile } from "./register.js";
import { selfcheckCommand } from "./cli.js";

const KEY = "dn_node_" + "ab".repeat(32);
const NODE = { nodeKey: KEY, nodeId: "22222222-2222-4222-8222-222222222222" };

describe("checkKeyFormat", () => {
  it("passes a valid key without echoing it", () => {
    const r = checkKeyFormat("/k", () => NODE);
    expect(r.status).toBe("pass");
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
  it("fails a non-dn_node_ key", () => {
    expect(checkKeyFormat("/k", () => ({ ...NODE, nodeKey: "dn_live_" + "a".repeat(64) })).status).toBe("fail");
  });
  it("points to register when the file is missing", () => {
    const r = checkKeyFormat(path.join(os.tmpdir(), "dn-selfcheck-missing.json"), readNodeFile);
    expect(r.status).toBe("fail");
    expect(r.remediation).toMatch(/register/);
  });
  it.skipIf(process.platform === "win32")("suggests chmod for a world-readable file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dn-sc-"));
    const f = path.join(dir, "node.json");
    fs.writeFileSync(f, JSON.stringify(NODE), { mode: 0o644 });
    fs.chmodSync(f, 0o644);
    const r = checkKeyFormat(f, readNodeFile);
    fs.rmSync(dir, { recursive: true });
    expect(r.status).toBe("fail");
    expect(r.remediation).toMatch(/chmod 600/);
  });
});

describe("checkGatewayTls", () => {
  it("passes when the verified handshake succeeds", async () => {
    const seen: Array<[string, number]> = [];
    const r = await checkGatewayTls("wss://gw.example.org/v1/tunnel", async (h, p) => {
      seen.push([h, p]);
      return "TLSv1.3";
    });
    expect(r.status).toBe("pass");
    expect(seen).toEqual([["gw.example.org", 443]]);
  });
  it("fails plaintext URLs without probing", async () => {
    let probed = false;
    const r = await checkGatewayTls("ws://gw.example.org/v1/tunnel", async () => {
      probed = true;
      return "x";
    });
    expect(r.status).toBe("fail");
    expect(probed).toBe(false);
  });
  it("fails with remediation on a certificate or network error", async () => {
    const r = await checkGatewayTls("wss://gw.example.org:8443/t", async () => {
      throw new Error("self-signed certificate");
    });
    expect(r).toMatchObject({ status: "fail" });
    expect(r.detail).toContain(":8443");
    expect(r.remediation).toBeTruthy();
  });
});

describe("checkClockSkew", () => {
  const T = 1_800_000_000_000;
  it("passes a small skew", async () => {
    expect((await checkClockSkew("https://api.example.org", async () => T - 2000, () => T)).status).toBe("pass");
  });
  it("warns at half the limit and fails beyond it", async () => {
    expect((await checkClockSkew("u", async () => T - (MAX_CLOCK_SKEW_MS / 2 + 1000), () => T)).status).toBe("warn");
    const r = await checkClockSkew("u", async () => T + MAX_CLOCK_SKEW_MS + 1000, () => T);
    expect(r.status).toBe("fail");
    expect(r.remediation).toMatch(/time sync/);
  });
  it("fails when the API has no Date header or is unreachable", async () => {
    expect((await checkClockSkew("u", async () => null, () => T)).status).toBe("fail");
    expect((await checkClockSkew("u", async () => { throw new Error("ECONNREFUSED"); }, () => T)).status).toBe("fail");
  });
});

describe("checkOutboundDial", () => {
  it("passes on connect and fails otherwise", async () => {
    expect((await checkOutboundDial("example.com", async () => true)).status).toBe("pass");
    expect((await checkOutboundDial("example.com", async () => false)).status).toBe("fail");
    expect((await checkOutboundDial("example.com", async () => { throw new Error("EAI_AGAIN"); })).status).toBe("fail");
  });
});

describe("runSelfcheck / output", () => {
  const ok = {
    readNodeFile: () => NODE,
    tlsProbe: async () => "TLSv1.3",
    serverTime: async () => 1000,
    now: () => 1000,
    outboundDial: async () => true,
  };
  const opts = { keyFile: "/k", gatewayUrl: "wss://gw.example.org/v1/tunnel", apiUrl: "https://api.example.org" };

  it("exits 0 when every check passes", async () => {
    const r = await runSelfcheck(opts, ok);
    expect(r.map((x) => x.status)).toEqual(["pass", "pass", "pass", "pass"]);
    expect(exitCodeFor(r)).toBe(0);
    expect(formatResults(r)).toContain("all checks passed");
  });

  it("exits non-zero and prints the fix on any failure", async () => {
    const r = await runSelfcheck(opts, { ...ok, outboundDial: async () => false });
    expect(exitCodeFor(r)).toBe(1);
    const out = formatResults(r);
    expect(out).toContain("[FAIL] outbound dial");
    expect(out).toContain("fix:");
    expect(out).toContain("1 check(s) failed");
  });

  it("warnings do not fail the run", () => {
    expect(exitCodeFor([{ name: "x", status: "warn", detail: "" }])).toBe(0);
  });

  it("scrubs secrets from error detail", async () => {
    const r = await runSelfcheck(opts, { ...ok, tlsProbe: async () => { throw new Error(`bad ${KEY}`); } });
    expect(formatResults(r)).not.toContain(KEY);
  });

  it("cli rejects a malformed dial target and returns the exit code", async () => {
    let out = "";
    const cfg = { ...opts, denyDomains: [] };
    expect(await selfcheckCommand(cfg, { "dial-target": "a b" }, (s) => { out += s; }, ok)).toBe(2);
    out = "";
    expect(await selfcheckCommand(cfg, {}, (s) => { out += s; }, ok)).toBe(0);
    expect(out).toContain("[PASS] node key");
  });
});
