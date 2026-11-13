import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as tls from "node:tls";

vi.mock("@dominusnode/shared", async () => ({
  EXIT_CLASSES: ["residential", "mobile", "dc", "masked"],
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  hashApiKey: vi.fn(),
  userRepo: {},
  planRepo: {},
  pqTlsOptions: (await import("@dominusnode/shared/dist/src/tls-pq.js")).pqTlsOptions,
}));
vi.mock("./geo-check.js", () => ({ initGeoCheck: vi.fn(async () => {}), checkSanctionedCountry: vi.fn(() => null), checkClientCountry: vi.fn(() => null) }));

import { startSocks5Server } from "./socks5.js";

const fx = path.join(__dirname, "__fixtures__");
const creds = { cert: fs.readFileSync(path.join(fx, "test-proxy-tls.crt")), key: fs.readFileSync(path.join(fx, "test-proxy-tls.key")) };
const relay = { selector: { select: vi.fn() }, getPolicy: () => ({}), nodeCount: () => 0 };

let server: net.Server | null = null;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
});

async function listen(s: net.Server): Promise<number> {
  if (!s.listening) await new Promise((r) => s.once("listening", r));
  const a = s.address();
  return typeof a === "object" && a ? a.port : 0;
}

describe("SOCKS5 over TLS", () => {
  it("runs the SOCKS5 handshake inside TLS and asks for username/password auth", async () => {
    server = await startSocks5Server(0, relay as any, { tls: creds, plaintextAuth: () => false });
    const port = await listen(server);
    const sock = tls.connect({ host: "127.0.0.1", port, ca: creds.cert, servername: "localhost" });
    await new Promise<void>((r, j) => { sock.once("secureConnect", () => r()); sock.once("error", j); });
    sock.write(Buffer.from([0x05, 0x01, 0x02]));
    const reply = await new Promise<Buffer>((r) => sock.once("data", r));
    expect([...reply]).toEqual([0x05, 0x02]);
    sock.destroy();
  });

  it("plaintext listener closes connections when the guard refuses", async () => {
    const guard = vi.fn(() => false);
    server = await startSocks5Server(0, relay as any, { plaintextAuth: guard });
    const port = await listen(server);
    const sock = net.connect(port, "127.0.0.1");
    sock.on("error", () => {});
    sock.write(Buffer.from([0x05, 0x01, 0x02]));
    await new Promise((r) => sock.once("close", r));
    expect(guard).toHaveBeenCalledWith("socks5");
  });
});
