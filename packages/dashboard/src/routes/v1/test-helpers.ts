import type express from "express";
import type { AddressInfo } from "node:net";

export interface TestResponse {
  status: number;
  headers: Headers;
  body: Record<string, unknown>;
}

/** Issue one request against an ephemeral listener (test-only helper). */
export async function call(
  app: express.Express,
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<TestResponse> {
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try { body = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { body = {}; }
    return { status: res.status, headers: res.headers, body };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}
