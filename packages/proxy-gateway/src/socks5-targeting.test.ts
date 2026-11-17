import { describe, it, expect, vi, afterEach } from "vitest";
import * as net from "node:net";

const findUserByApiKey = vi.fn();
const getUserPlan = vi.fn();
vi.mock("@dominusnode/shared", async () => ({
  EXIT_CLASSES: ["residential", "mobile", "dc", "masked"],
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  hashApiKey: vi.fn(),
  userRepo: { findUserByApiKey: (...a: unknown[]) => findUserByApiKey(...a) },
  planRepo: { getUserPlan: (...a: unknown[]) => getUserPlan(...a), getTeamPlan: (...a: unknown[]) => getUserPlan(...a) },
  pqTlsOptions: () => ({}),
}));
vi.mock("./geo-check.js", () => ({ initGeoCheck: vi.fn(async () => {}), checkSanctionedCountry: vi.fn(() => null), checkClientCountry: vi.fn(() => null) }));
const recordAuthFailure = vi.fn();
vi.mock("./auth-rate-limit.js", () => ({ checkAuthRateLimit: () => false, recordAuthFailure: (...a: unknown[]) => recordAuthFailure(...a) }));

import { startSocks5Server } from "./socks5.js";

const relay = { selector: { select: vi.fn() }, getPolicy: () => ({}), nodeCount: () => 0 };
let server: net.Server | null = null;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
  vi.clearAllMocks();
});

/** Run greeting + RFC 1929 auth; resolve with the 2-byte auth reply. */
async function authReply(port: number, username: string): Promise<Buffer> {
  const sock = net.connect(port, "127.0.0.1");
  await new Promise<void>((r, j) => { sock.once("connect", () => r()); sock.once("error", j); });
  const chunks: Buffer[] = [];
  sock.on("data", (d: Buffer) => chunks.push(d));
  const closed = new Promise<void>((r) => sock.once("close", () => r()));
  sock.write(Buffer.from([0x05, 0x01, 0x02]));
  const u = Buffer.from(username);
  const p = Buffer.from("dn_live_testkey");
  sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
  await closed;
  return Buffer.concat(chunks).subarray(2, 4);
}

describe("SOCKS5 unsupported targeting flags", () => {
  for (const user of ["country-US-city-losangeles", "state-california", "class-dc-city-paris"]) {
    it(`fails auth for ${user}`, async () => {
      findUserByApiKey.mockResolvedValue({ user: { id: "u1", status: "active", email_verified: true }, apiKey: { team_id: null } });
      server = await startSocks5Server(0, relay as any);
      if (!server.listening) await new Promise((r) => server!.once("listening", r));
      const port = (server.address() as net.AddressInfo).port;
      const reply = await authReply(port, user);
      expect([...reply]).toEqual([0x01, 0x01]);
      expect(findUserByApiKey).toHaveBeenCalledTimes(1);
      expect(getUserPlan).not.toHaveBeenCalled();
      expect(relay.selector.select).not.toHaveBeenCalled();
    });
  }
});
