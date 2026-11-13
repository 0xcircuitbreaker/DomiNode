import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = process.env.PUSH_SCRIPT_UNDER_TEST ?? resolve(__dirname, "../../../scripts/push-to-github.sh");
const script = readFileSync(SCRIPT_PATH, "utf8");

describe("scripts/push-to-github.sh", () => {
  it("bypasses global credential helpers on push so the token is never stored", () => {
    const pushes = script
      .split("\n")
      .filter((l) => /\bgit\b.*\bpush\b/.test(l) && !l.trim().startsWith("#"));
    expect(pushes.length).toBeGreaterThan(0);
    for (const l of pushes) expect(l).toMatch(/git -c credential\.helper= push/);
  });

  it("exits on INT/TERM instead of continuing the push loop", () => {
    expect(script).not.toMatch(/trap cleanup[^\n]*\b(INT|TERM)\b/);
    expect(script).toMatch(/trap 'exit 130' INT/);
    expect(script).toMatch(/trap 'exit 143' TERM/);
  });
});
