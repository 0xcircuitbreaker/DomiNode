import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { nodeSetupGuide, type GuideOs } from "./node-guide.js";

const IMAGE = "ghcr.io/0xcircuitbreaker/dominusnode-node";

describe("node setup guide", () => {
  for (const os of ["linux", "mac", "win"] as GuideOs[]) {
    it(`${os}: runs the published image, not a pinless source build`, () => {
      const cmds = nodeSetupGuide(os).flatMap((s) => s.commands ?? []).join("\n");
      expect(cmds).toContain(`${IMAGE} register`);
      expect(cmds).not.toMatch(/npm (ci|run build)|git clone|main\.js/);
      // Agents run commands without a terminal: `-t` would fail with "input device is not a TTY".
      expect(cmds).not.toMatch(/docker run[^\n]* -i?t\b/);
      // The owner wallet key must not be left on the node host after registration.
      const reg = cmds.split("\n").findIndex((l) => l.includes(" register"));
      expect(cmds.split("\n").slice(reg + 1).join("\n")).toMatch(/(rm|Remove-Item) \S*wallet\.key/);
    });
  }

  it("MCP README example does not run the node from a source build", () => {
    const readme = readFileSync(new URL("../../../mcp-server/README.md", import.meta.url), "utf8");
    expect(readme).not.toMatch(/node-agent\/dist\/src\/main\.js/);
    expect(readme).toContain(IMAGE);
  });
});
