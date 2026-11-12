import { describe, it, expect, beforeAll } from "vitest";
import * as tls from "node:tls";
import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pqTlsOptions, pqHybridSupported, openSslAtLeast35, parseOpenSslVersion, PQ_HYBRID_GROUP, reportTlsCapability, _resetTlsCapabilityForTest } from "./tls-pq.js";

let cert: Buffer;
let key: Buffer;

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tlspq-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
      "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-subj", "/CN=localhost", "-days", "1"], { stdio: "ignore" });
    cert = fs.readFileSync(path.join(dir, "c.pem"));
    key = fs.readFileSync(path.join(dir, "k.pem"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function handshake(client: tls.ConnectionOptions): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const server = tls.createServer({ cert, key, ...pqTlsOptions() }, (s) => s.end());
    server.on("tlsClientError", () => undefined);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      const c = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false, ...client }, () => {
        const proto = c.getProtocol();
        c.destroy();
        server.close();
        resolve(proto);
      });
      c.on("error", (e) => { server.close(); reject(e); });
    });
  });
}

const supported = openSslAtLeast35(process.versions.openssl);

describe("tls-pq", () => {
  it("parses OpenSSL versions", () => {
    expect(parseOpenSslVersion("3.5.1")).toEqual([3, 5]);
    expect(parseOpenSslVersion("x")).toBeNull();
    expect(openSslAtLeast35("3.0.13+quic")).toBe(false);
    expect(openSslAtLeast35("3.5.0")).toBe(true);
    expect(openSslAtLeast35("4.0.0")).toBe(true);
  });

  it("uses TLS 1.3 and the hybrid group first", () => {
    const o = pqTlsOptions();
    expect(o.minVersion).toBe("TLSv1.3");
    if (supported) expect(o.ecdhCurve).toBe(`${PQ_HYBRID_GROUP}:X25519`);
  });

  it.runIf(supported)("negotiates X25519MLKEM768 (client offers only the hybrid)", async () => {
    expect(pqHybridSupported()).toBe(true);
    // A client offering only the hybrid group can only complete if the server picked it.
    await expect(handshake({ ecdhCurve: PQ_HYBRID_GROUP, minVersion: "TLSv1.3" })).resolves.toBe("TLSv1.3");
  });

  it("still accepts a classical X25519-only TLS 1.3 client", async () => {
    await expect(handshake({ ecdhCurve: "X25519" })).resolves.toBe("TLSv1.3");
  });

  it("refuses TLS 1.2", async () => {
    await expect(handshake({ maxVersion: "TLSv1.2" })).rejects.toThrow();
  });

  it("reports capability once", () => {
    _resetTlsCapabilityForTest();
    const lines: string[] = [];
    const log = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push("W:" + m) };
    reportTlsCapability(log, "test");
    reportTlsCapability(log, "test");
    expect(lines.filter((l) => l === "TLS capability")).toHaveLength(1);
    if (supported) expect(lines.some((l) => l.startsWith("W:"))).toBe(false);
    expect(crypto.getCurves().length).toBeGreaterThan(0);
  });
});
