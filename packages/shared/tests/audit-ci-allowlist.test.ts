import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The audit gate may only skip the single dev-tooling picomatch advisory.
// Anything else added to the allowlist must fail this test so the gate can't
// silently widen.
const ROOT = resolve(__dirname, "../../..");

function stripJsonComments(src: string): string {
  return src.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[\]}])/g, "$1");
}

describe("audit-ci allowlist", () => {
  const config = JSON.parse(
    stripJsonComments(readFileSync(resolve(ROOT, "audit-ci.jsonc"), "utf8")),
  ) as { allowlist?: unknown; high?: unknown };

  it("allowlists only GHSA-fc5q-39xc-vjpf", () => {
    expect(config.allowlist).toEqual(["GHSA-fc5q-39xc-vjpf"]);
  });

  it("keeps the high severity gate on", () => {
    expect(config.high).toBe(true);
  });

  it("CI runs audit-ci with this config", () => {
    const wf = readFileSync(
      resolve(ROOT, ".github/workflows/security.yml"),
      "utf8",
    );
    expect(wf).toMatch(/npx audit-ci --high --config audit-ci\.jsonc/);
  });
});
