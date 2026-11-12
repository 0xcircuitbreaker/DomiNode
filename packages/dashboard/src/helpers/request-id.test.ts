import { describe, it, expect } from "vitest";
import express from "express";
import { call } from "../routes/v1/test-helpers.js";
import { requestIdMiddleware } from "./request-id.js";

function app() {
  const a = express();
  a.use(requestIdMiddleware);
  a.get("/ok", (_req, res) => { res.json({ ok: true }); });
  a.get("/err", (_req, res) => { res.status(400).json({ error: "bad", code: "X" }); });
  return a;
}

describe("X-Request-Id", () => {
  it("echoes a valid incoming id and adds it to JSON error bodies", async () => {
    const r = await call(app(), "GET", "/err", { headers: { "X-Request-Id": "client-id-1" } });
    expect(r.status).toBe(400);
    expect(r.headers.get("x-request-id")).toBe("client-id-1");
    expect(r.body).toEqual({ error: "bad", code: "X", requestId: "client-id-1" });
  });

  it("generates an id when the incoming one is invalid; success bodies are unchanged", async () => {
    const r = await call(app(), "GET", "/ok", { headers: { "X-Request-Id": "x".repeat(65) } });
    expect(r.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.body).toEqual({ ok: true });
  });
});
