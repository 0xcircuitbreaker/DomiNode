import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Guards the exit-node image publish path: node operators pull :latest onto
// residential IPs, so only reviewed master code may ever reach it.
function repoRoot(): string {
  let dir = resolve(process.cwd());
  for (;;) {
    if (existsSync(join(dir, ".github", "workflows", "node-image.yml"))) return dir;
    const up = dirname(dir);
    if (up === dir) throw new Error("repo root not found");
    dir = up;
  }
}

const wf = readFileSync(join(repoRoot(), ".github", "workflows", "node-image.yml"), "utf8");

describe("node-image workflow", () => {
  it("gates publishing behind the release environment", () => {
    expect(wf).toMatch(/^\s+environment: release\s*$/m);
  });

  it("restricts the job to node-v* tags or master dispatch", () => {
    expect(wf).toContain("startsWith(github.ref, 'refs/tags/node-v')");
    expect(wf).toContain("github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/master'");
  });

  it("refuses commits that are not on master history", () => {
    expect(wf).toMatch(/git merge-base --is-ancestor "\$GITHUB_SHA" origin\/master/);
  });

  it("moves :latest only on tag builds", () => {
    expect(wf).not.toMatch(/^\s+\$\{\{ env\.IMAGE \}\}:latest\s*$/m);
    expect(wf).toContain("steps.tag.outputs.latest");
  });

  it("pins every action by full commit SHA", () => {
    const uses = [...wf.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
    expect(wf).not.toMatch(/TODO: pin/);
  });
});
