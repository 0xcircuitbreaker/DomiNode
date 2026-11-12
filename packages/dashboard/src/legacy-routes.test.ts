import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const here = __dirname;

describe("legacy plan/slot/waitlist routes", () => {
  it("are not mounted (agents buy relay bandwidth from network_pricing)", () => {
    const server = readFileSync(join(here, "server.ts"), "utf8");
    for (const p of ["/api/plans", "/api/slots", "/api/waitlist"]) {
      expect(server).not.toContain(`"${p}"`);
    }
    for (const f of ["plans.ts", "slots.ts", "waitlist.ts"]) {
      expect(existsSync(join(here, "routes", f))).toBe(false);
    }
  });
});
