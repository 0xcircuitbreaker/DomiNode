import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";

/**
 * scripts/smoke/relay-smoke.sh against a fake TLS proxy: the refusal checks
 * must pass only on the expected policy code, never on an unrelated 403 such
 * as the gateway's "TLS required" answer.
 */
const ROOT = path.resolve(__dirname, "../../..");
const SCRIPT = path.join(ROOT, "scripts/smoke/relay-smoke.sh");
const has = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
const can = has("openssl", ["version"]) && has("curl", ["--version"]) && has("jq", ["--version"]);

type Mode = "tls-required" | "policy";

describe.runIf(can)("relay-smoke.sh refusal checks", () => {
  let dir: string;
  let server: tls.Server;
  let port = 0;
  let mode: Mode = "tls-required";

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dn-smoke-"));
    const r = spawnSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
      "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-days", "1", "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
    expect(r.status).toBe(0);
    server = tls.createServer({ key: fs.readFileSync(path.join(dir, "k.pem")), cert: fs.readFileSync(path.join(dir, "c.pem")) }, (sock) => {
      sock.on("error", () => undefined);
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString("latin1");
        if (!buf.includes("\r\n\r\n")) return;
        const [method, target] = buf.split(" ");
        let reply: string;
        if (mode === "tls-required") {
          reply = "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nTLS required";
        } else if (target.includes("169.254.169.254")) {
          reply = "HTTP/1.1 403 Forbidden\r\nX-DominusNode-Error: TARGET_BLOCKED\r\nConnection: close\r\n\r\n";
        } else if (method !== "CONNECT") {
          reply = "HTTP/1.1 400 Bad Request\r\nX-DominusNode-Error: PLAINTEXT_DISABLED\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
        } else {
          reply = "HTTP/1.1 502 Bad Gateway\r\nX-DominusNode-Error: NO_NODES\r\nConnection: close\r\n\r\n";
        }
        sock.end(reply);
      });
    });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (): Promise<{ status: number | null; log: string }> =>
    new Promise((resolve) => {
      const env = {
        PATH: process.env.PATH ?? "", HOME: dir,
        API_URL: "http://127.0.0.1:9", GATEWAY_HOST: "localhost", GATEWAY_TLS_PORT: String(port),
        GATEWAY_TLS_CA: path.join(dir, "c.pem"), REQUESTER_API_KEY: "dn_test_smoke", CREDIT_WAIT_S: "0", WITHDRAW: "no",
      };
      const p = spawn("bash", [SCRIPT], { env });
      let log = "";
      p.stderr.on("data", (d) => { log += d.toString(); });
      p.stdout.on("data", (d) => { log += d.toString(); });
      p.on("close", (status) => resolve({ status, log }));
    });

  it("fails the refusal checks when every answer is the unrelated 'TLS required' 403", async () => {
    mode = "tls-required";
    const r = await run();
    expect(r.status).not.toBe(0);
    expect(r.log).toMatch(/FAIL plaintext http without allowhttp-1: refused for another reason/);
    expect(r.log).toMatch(/FAIL metadata IP over HTTPS: refused for another reason/);
    expect(r.log).not.toMatch(/PASS .*refused/);
    expect(r.log).toMatch(/SKIP plaintext HTTP proxy and SOCKS5 ports/);
  }, 30_000);

  it("passes the refusal checks only on the expected policy codes", async () => {
    mode = "policy";
    const r = await run();
    expect(r.log).toMatch(/PASS plaintext http without allowhttp-1 refused with PLAINTEXT_DISABLED/);
    expect(r.log).toMatch(/PASS metadata IP over HTTPS refused with TARGET_BLOCKED/);
    expect(r.log).toMatch(/PASS metadata IP over plaintext \(allowhttp-1\) refused with TARGET_BLOCKED/);
    expect(r.log).not.toContain("dn_test_smoke");
  }, 30_000);
});
