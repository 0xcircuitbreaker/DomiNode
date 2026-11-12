import { describe, it, expect } from "vitest";
import { encodeCursor, decodeCursor } from "./cursor.js";

describe("keyset cursor", () => {
  const id = "0a1b2c3d-0000-4000-8000-000000000001";
  it("round-trips", () => {
    const at = new Date("2026-03-04T05:06:07.890Z");
    expect(decodeCursor(encodeCursor(at, id))).toEqual({ createdAt: at, id });
  });
  it("rejects malformed input", () => {
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("a+b/")).toBeNull();
    expect(decodeCursor(Buffer.from("2026-01-01T00:00:00.000Z|not-a-uuid").toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from(`yesterday|${id}`).toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from(`2026-01-01T00:00:00.000Z|${id}|x`).toString("base64url"))).toBeNull();
    expect(decodeCursor(["x"])).toBeNull();
  });
});
