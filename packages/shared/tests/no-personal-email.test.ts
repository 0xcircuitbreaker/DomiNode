import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Hardcoded contacts must be placeholders (example.org); real addresses come from config.
const ROOT = join(__dirname, "..", "..", "..");
const PERSONAL = /[a-z0-9._%+-]+@(?:gmail|googlemail|protonmail|proton)\.(?:com|me|ch)\b/i;

let inGit = true;
try { execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ROOT, stdio: "ignore" }); } catch { inGit = false; }

describe("tracked files", () => {
  it.skipIf(!inGit)("contain no gmail/protonmail addresses", () => {
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, maxBuffer: 64 << 20 })
      .toString().split("\0").filter(Boolean);
    const hits: string[] = [];
    for (const f of files) {
      let text: string;
      try { text = readFileSync(join(ROOT, f), "utf8"); } catch { continue; }
      const m = PERSONAL.exec(text);
      if (m) hits.push(`${f}: ${m[0]}`);
    }
    expect(hits).toEqual([]);
  });
});
