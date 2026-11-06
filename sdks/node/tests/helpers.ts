import { vi } from "vitest";
import { DominusNodeClient } from "../src/client.js";

export const API_KEY = "dn_live_" + "a".repeat(32);
export const WALLET = "0x" + "1".repeat(40);
export const OTHER_WALLET = "0x" + "2".repeat(40);
export const USER_ID = "11111111-2222-4333-8444-555555555555";
export const UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
export const SIG = "0x" + "ab".repeat(65);
export const NONCE = "f".repeat(64);

export function makeJwt(expSeconds = 900): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "HS256" })}.${enc({ userId: "u", exp: Math.floor(Date.now() / 1000) + expSeconds })}.c2ln`;
}

export interface Call { url: string; method: string; headers: Record<string, string>; body: unknown; redirect?: string }

/** Queue-based fetch mock. Each reply: [status, body(object|string), headers?]. Responses expose text(). */
export function mockFetch(...replies: Array<[number, unknown, Record<string, string>?]>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({
      url, method: String(init.method), headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined, redirect: init.redirect,
    });
    const next = replies.shift();
    if (!next) throw new Error("unexpected fetch " + url);
    const [status, body, headers] = next;
    return new Response(status === 204 || status === 304 ? null : typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

export function signerFor(address = WALLET, sig = SIG) {
  const signed: string[] = [];
  return { signer: { address, signMessage: async (m: string) => { signed.push(m); return sig; } }, signed };
}

/** Client connected with API_KEY (verify-key reply consumed). */
export async function connected(...replies: Array<[number, unknown, Record<string, string>?]>) {
  const m = mockFetch([200, { valid: true, token: makeJwt(), refreshToken: makeJwt(86400), userId: USER_ID, email: "x@y" }], ...replies);
  const client = new DominusNodeClient({ baseUrl: "http://api.test", fetch: m.fn });
  await client.connectWithKey(API_KEY);
  m.calls.shift();
  return { client, calls: m.calls };
}
