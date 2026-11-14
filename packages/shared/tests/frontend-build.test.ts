import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");
const FRONTEND = path.join(ROOT, "packages/frontend");

// The frontend Dockerfile runs `tsc -b && vite build`, which type-checks every
// file the tsconfig includes. Test files run under vitest only, so they must
// stay out of the build tsconfig (a test using an ES2022 API broke the image).
describe("frontend build tsconfig", () => {
  const tsconfig = JSON.parse(fs.readFileSync(path.join(FRONTEND, "tsconfig.json"), "utf8")) as {
    include?: string[];
    exclude?: string[];
  };

  it("excludes test files from the production type-check", () => {
    expect(tsconfig.exclude).toEqual(expect.arrayContaining(["src/**/*.test.ts", "src/**/*.test.tsx", "src/test-setup.ts"]));
  });

  it("CI builds the frontend image from the self-host Dockerfile on PRs", () => {
    const wf = fs.readFileSync(path.join(ROOT, ".github/workflows/frontend-image.yml"), "utf8");
    expect(wf).toContain("pull_request:");
    expect(wf).toContain('"packages/frontend/**"');
    expect(wf).toContain('"infra/docker/**"');
    expect(wf).toContain("docker build -f infra/docker/frontend.Dockerfile");
    const compose = fs.readFileSync(path.join(ROOT, "docker-compose.selfhost.yml"), "utf8");
    expect(compose).toContain("dockerfile: infra/docker/frontend.Dockerfile");
    const ci = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain("npm run build --workspace=packages/frontend");
  });
});
