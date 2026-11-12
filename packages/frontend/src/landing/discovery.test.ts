/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { AI_CRAWLERS, DEFAULT_ORIGIN, DOCS, PUBLIC_DIR, generateDiscovery } from "../../discovery/generate.mjs";
import { isPrivatePath } from "../components/RobotsMeta";

const SPA_ROUTES = new Set(["/", "/quickstart", "/run-a-node", "/self-host", "/pricing", "/report-abuse", "/terms", "/privacy", "/aup"]);
const TEXT_EXT = /\.(txt|md|json|xml)$/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(PUBLIC_DIR).filter((f) => TEXT_EXT.test(f));
const read = (rel: string) => readFileSync(join(PUBLIC_DIR, rel), "utf8");

describe("discovery files", () => {
  it("exist", () => {
    for (const f of ["llms.txt", "llms-full.txt", "robots.txt", "sitemap.xml", ".well-known/mcp/server.json", ...DOCS.map((d) => d.path.slice(1))]) {
      expect(existsSync(join(PUBLIC_DIR, f)), f).toBe(true);
    }
  });

  it("are up to date with the generator", () => {
    for (const [rel, content] of Object.entries(generateDiscovery())) {
      expect(read(rel), `${rel} is stale: run node packages/frontend/discovery/generate.mjs`).toBe(content);
    }
  });

  it("JSON files parse", () => {
    for (const f of files.filter((x) => x.endsWith(".json"))) {
      expect(() => JSON.parse(readFileSync(f, "utf8")), f).not.toThrow();
    }
    const mcp = JSON.parse(read(".well-known/mcp/server.json"));
    expect(mcp.packages[0].identifier).toBe("@dominusnode/mcp-server");
  });

  it("llms.txt follows llmstxt.org: H1, blockquote, H2 sections of links", () => {
    const lines = read("llms.txt").split("\n");
    expect(lines[0]).toMatch(/^# \S/);
    expect(lines.find((l) => l.trim() !== "" && !l.startsWith("# "))).toMatch(/^> /);
    expect(lines.filter((l) => l.startsWith("## ")).length).toBeGreaterThanOrEqual(2);
    expect(lines.filter((l) => /^- \[.+\]\(https?:\/\/.+\)/.test(l)).length).toBeGreaterThan(5);
  });

  it("sitemap is well-formed XML", () => {
    const doc = new DOMParser().parseFromString(read("sitemap.xml"), "application/xml");
    expect(doc.getElementsByTagName("parsererror").length).toBe(0);
    expect(doc.getElementsByTagName("loc").length).toBeGreaterThan(3);
  });

  it("robots.txt allows AI crawlers and disallows /admin", () => {
    const r = read("robots.txt");
    for (const bot of ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended", "CCBot"]) {
      expect(AI_CRAWLERS).toContain(bot);
      expect(r).toContain(`User-agent: ${bot}`);
    }
    expect(r).toMatch(/Disallow: \/admin/);
    expect(r).toContain(`Sitemap: ${DEFAULT_ORIGIN}/sitemap.xml`);
    expect(isPrivatePath("/admin/nodes")).toBe(true);
    expect(isPrivatePath("/")).toBe(false);
  });

  it("contain no secrets", () => {
    for (const f of files) {
      const t = readFileSync(f, "utf8");
      expect(t, f).not.toMatch(/dn_(live|test|node|proxy)_(?!YOUR_KEY)[A-Za-z0-9]{6,}/);
      expect(t, f).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/);
      expect(t, f).not.toMatch(/0x[0-9a-fA-F]{64}/);
      expect(t, f).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    }
  });

  it("contain no hardcoded per-GB prices", () => {
    for (const f of files) {
      const t = readFileSync(f, "utf8");
      expect(t, f).not.toMatch(/\$\s?\d+(\.\d+)?\s*(\/|per)\s*GB/i);
      expect(t, f).not.toMatch(/\$0\.(50|20|005|002)\b/);
    }
  });

  it("every same-origin link resolves to a public file or SPA route", () => {
    const linkRe = /\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)|<loc>([^<]+)<\/loc>|"(https?:\/\/[^"]+)"/g;
    for (const f of files) {
      const t = readFileSync(f, "utf8");
      for (const m of t.matchAll(linkRe)) {
        const raw = m[1] ?? m[2] ?? m[3]!;
        let p: string;
        if (raw.startsWith("/")) p = raw;
        else if (raw.startsWith(DEFAULT_ORIGIN)) p = raw.slice(DEFAULT_ORIGIN.length) || "/";
        else continue; // external URL
        p = p.split(/[?#]/)[0]!;
        const ok = SPA_ROUTES.has(p) || existsSync(join(PUBLIC_DIR, p));
        expect(ok, `${relative(PUBLIC_DIR, f)} links to missing ${p}`).toBe(true);
      }
    }
  });
});
