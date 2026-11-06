import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveCoordPins, EMBEDDED_COORD_PUBKEYS } from "./coord-pins.js";

const SCRIPT = join(__dirname, "..", "scripts", "gen-coord-pins.mjs");
const A = "a".repeat(64);
const B = "0123456789abcdef".repeat(4);

function gen(env: string | undefined, ...args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "pins-"));
  const out = join(dir, "pins.ts");
  const e = { ...process.env };
  delete e["DN_COORD_PUBKEYS"];
  if (env !== undefined) e["DN_COORD_PUBKEYS"] = env;
  const r = spawnSync(process.execPath, [SCRIPT, "--out", out, ...args], { env: e, encoding: "utf8" });
  let text = "";
  try { text = readFileSync(out, "utf8"); } catch { /* not written */ }
  rmSync(dir, { recursive: true, force: true });
  return { status: r.status, text };
}

describe("coord pins", () => {
  it("dev build embeds an empty list", () => {
    expect(EMBEDDED_COORD_PUBKEYS).toEqual([]);
    expect(effectiveCoordPins([A, "junk"])).toEqual([A]);
  });

  it("generator embeds validated, deduped, lowercased pins", () => {
    const r = gen(` ${A.toUpperCase()},${B},${A} `);
    expect(r.status).toBe(0);
    expect(r.text).toContain(JSON.stringify([A, B]));
  });

  it("generator rejects invalid hex and requires pins for release", () => {
    expect(gen("abc").status).toBe(1);
    expect(gen("", "--require").status).toBe(1);
    expect(gen(undefined).text).toContain("= [];");
  });
});
