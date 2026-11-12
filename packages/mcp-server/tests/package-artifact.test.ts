import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };

/** Tool modules that src/register.ts actually imports. */
function registeredToolModules(): Set<string> {
  const reg = readFileSync(join(root, "src/register.ts"), "utf8");
  return new Set([...reg.matchAll(/from "\.\/tools\/([a-z0-9-]+)\.js"/g)].map((m) => m[1]));
}

describe("published package contents", () => {
  it("prepack cleans dist before building so stale files never ship", () => {
    expect(pkg.scripts["prepack"]).toMatch(/rmSync\('dist'/);
    expect(pkg.scripts["prepack"]).toMatch(/npm run build/);
    expect(pkg.scripts["prepublishOnly"]).toMatch(/rmSync\('dist'/);
  });

  it("every src/tools module is registered", () => {
    const registered = registeredToolModules();
    const srcTools = readdirSync(join(root, "src/tools")).filter((f) => f.endsWith(".ts")).map((f) => f.slice(0, -3));
    expect(srcTools.sort()).toEqual([...registered].sort());
  });

  it.skipIf(!existsSync(join(root, "dist/src/index.js")))(
    "the packed tarball contains no unregistered tool files (npm pack --dry-run)",
    () => {
      const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const files = (JSON.parse(out) as Array<{ files: Array<{ path: string }> }>)[0].files.map((f) => f.path);
      const registered = registeredToolModules();
      const toolFiles = files.filter((f) => f.startsWith("dist/src/tools/"));
      expect(toolFiles.length).toBeGreaterThan(0);
      const stray = toolFiles.filter((f) => !registered.has(f.replace(/^dist\/src\/tools\//, "").replace(/\.(d\.ts|js)$/, "")));
      // A failure here locally usually means a stale dist/: run `npm run clean && npm run build`.
      expect(stray).toEqual([]);
      for (const legacy of ["plans", "slots", "stripe", "paypal"]) {
        expect(files.some((f) => f.includes(`/${legacy}.`))).toBe(false);
      }
      expect(files.some((f) => f.endsWith(".map"))).toBe(false);
    },
    60_000,
  );
});
