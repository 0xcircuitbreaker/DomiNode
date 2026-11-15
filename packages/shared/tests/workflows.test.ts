import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const wf = (n: string) => fs.readFileSync(path.join(ROOT, ".github/workflows", n), "utf8");

describe("CI workflows", () => {
  it("the dependency audit runs on pull requests into master (the default branch)", () => {
    const pr = wf("security.yml").match(/^\s{2}pull_request:\n((?:\s{4}.*\n)*)/m);
    expect(pr).not.toBeNull();
    const branches = pr![1].match(/branches:\s*\[([^\]]*)\]/);
    if (branches) expect(branches[1].split(",").map((b) => b.trim())).toContain("master");
    expect(wf("security.yml")).toContain("audit-ci --high");
  });

  it("the production migration runs with TLS and refuses a URL that disables it", () => {
    const y = wf("deploy.yml");
    const step = y.slice(y.indexOf("name: Run database migration"));
    expect(step).toMatch(/NODE_ENV: production/);
    expect(step).not.toMatch(/DB_SSL:\s*"?false/);
    expect(step).toMatch(/sslmode=disable/);
    expect(step).toMatch(/exit 1/);
  });
});
