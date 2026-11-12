import { describe, it, expect, vi } from "vitest";
import { resolveRequestId, runWithRequestId, currentRequestId } from "./request-id.js";
import { createLogger } from "./logger.js";

describe("request ids", () => {
  it("accepts a well-formed incoming id up to 64 chars", () => {
    expect(resolveRequestId("abc-123_X.y:z")).toBe("abc-123_X.y:z");
    expect(resolveRequestId("a".repeat(64))).toBe("a".repeat(64));
    expect(resolveRequestId(["first", "second"])).toBe("first");
  });

  it("replaces invalid, oversized or missing ids with a UUID", () => {
    const uuid = /^[0-9a-f-]{36}$/;
    expect(resolveRequestId("a".repeat(65))).toMatch(uuid);
    expect(resolveRequestId("bad id\r\nX-Injected: 1")).toMatch(uuid);
    expect(resolveRequestId("")).toMatch(uuid);
    expect(resolveRequestId(undefined)).toMatch(uuid);
  });

  it("binds the id to log lines inside runWithRequestId", async () => {
    const prevLevel = process.env["LOG_LEVEL"];
    process.env["LOG_LEVEL"] = "info";
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const log = createLogger("t");
    await runWithRequestId("req-42", async () => {
      await Promise.resolve();
      expect(currentRequestId()).toBe("req-42");
      log.info("hello");
    });
    log.info("outside");
    const lines = spy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
    spy.mockRestore();
    process.env["LOG_LEVEL"] = prevLevel;
    expect(lines[0]).toMatchObject({ msg: "hello", requestId: "req-42" });
    expect(lines[1]).not.toHaveProperty("requestId");
  });
});
