import { vi } from "vitest";
import { ClientProvider } from "../src/core.js";

export const TEST_KEY = "dn_live_testkey1234567890abcdef";

export function mockClient() {
  const state = { connected: false };
  const client = {
    get isConnected() {
      return state.connected;
    },
    connectWithKey: vi.fn(async () => {
      state.connected = true;
      return { mfaRequired: false, userId: "u1" };
    }),
    disconnect: vi.fn(async () => {
      state.connected = false;
    }),
    proxy: {
      fetch: vi.fn(async () => ({
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/plain" },
        body: Buffer.from("hello"),
        truncated: false,
        text: () => "hello",
      })),
      buildUrl: vi.fn((o: { protocol?: string }) => `${o.protocol ?? "http"}://country-US:${TEST_KEY}@proxy.dominusnode.com:8080`),
      buildUsername: vi.fn(() => "country-US"),
    },
    network: {
      policy: vi.fn(async () => ({ version: 3 })),
      pricing: vi.fn(async () => ({ currency: "USD", prices: [] })),
      stats: vi.fn(async () => ({ onlineNodes: 7 })),
    },
    wallet: {
      getBalance: vi.fn(async () => ({ balanceCents: 500 })),
      getTransactions: vi.fn(async () => ({ transactions: [] })),
      topUpCrypto: vi.fn(async () => ({ invoiceId: "inv" })),
      getCryptoStatus: vi.fn(async () => ({ status: "waiting" })),
    },
    usage: { get: vi.fn(async () => ({ summary: {} })) },
    sessions: {
      getActive: vi.fn(async () => ({ sessions: [] })),
      report: vi.fn(async () => ({ reportId: "r" })),
    },
    nodes: { list: vi.fn(async () => ({ nodes: [] })), tier: vi.fn(async () => ({ tier: "probation" })) },
    credits: { balance: vi.fn(async () => ({ available: {} })), convert: vi.fn(async () => ({ converted: {} })) },
    payouts: { list: vi.fn(async () => ({ payouts: [] })) },
    x402: { getInfo: vi.fn(async () => ({ supported: true })) },
  };
  return client;
}

export function provider(client = mockClient()) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client, provider: new ClientProvider({ apiKey: TEST_KEY, client: client as any }) };
}

