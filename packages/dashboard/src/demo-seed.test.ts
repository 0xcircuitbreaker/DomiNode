import { describe, it, expect } from "vitest";
import { assertDemoEnv, DEMO_BANNER } from "./demo-seed.js";

describe("demo seed guard", () => {
  it("runs only with DEMO_MODE=1 and NODE_ENV=development", () => {
    expect(() => assertDemoEnv({ DEMO_MODE: "1", NODE_ENV: "development" })).not.toThrow();
    expect(() => assertDemoEnv({ DEMO_MODE: "1", NODE_ENV: "production" })).toThrow(/refuses/);
    expect(() => assertDemoEnv({ NODE_ENV: "development" })).toThrow(/refuses/);
    expect(() => assertDemoEnv({})).toThrow(/refuses/);
  });
  it("prints a loud banner", () => {
    expect(DEMO_BANNER).toContain("DEMO, NOT FOR PRODUCTION");
  });
});
