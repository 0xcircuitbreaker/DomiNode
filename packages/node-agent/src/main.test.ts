import { afterEach, describe, expect, it, vi } from "vitest";
import { EMBEDDED_COORD_PUBKEYS } from "./coord-pins.js";
import { main, NO_COORD_PINS_MESSAGE, resolveRunCoordPins } from "./main.js";

const PIN = "a".repeat(64);

describe("run without coordinator pins", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
  });

  it("resolveRunCoordPins merges configured pins with the embedded ones", () => {
    expect(resolveRunCoordPins({ coordPins: [PIN] })).toContain(PIN);
    expect(resolveRunCoordPins({ coordPins: [PIN], coordPinsExclusive: true })).toEqual([PIN]);
  });

  // A source build (npm run build) embeds no pins: `run` must stop with an actionable
  // message instead of dialing and rejecting every CHALLENGE forever.
  it.skipIf(EMBEDDED_COORD_PUBKEYS.length > 0)("exits 2 with the fixes instead of retrying forever", async () => {
    for (const k of Object.keys(process.env)) if (k.startsWith("DN_NODE_")) delete process.env[k];
    process.env["DN_NODE_KEY_FILE"] = "/nonexistent/dominusnode-node.json";
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(main(["run"])).resolves.toBe(2);
    const out = err.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain(NO_COORD_PINS_MESSAGE);
    expect(out).toContain("ghcr.io/0xcircuitbreaker/dominusnode-node");
    expect(out).toContain("DN_NODE_COORD_PINS");
    expect(out).toContain("--trust sha256:");
  });
});
