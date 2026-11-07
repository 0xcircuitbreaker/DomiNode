import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");

describe("MCP listing assets", () => {
  const pkg = JSON.parse(read("package.json")) as Record<string, unknown>;
  const server = JSON.parse(read("server.json")) as {
    name: string; version: string; description: string; $schema: string;
    packages: Array<{ registryType: string; identifier: string; version: string; transport: { type: string }; environmentVariables: Array<{ name: string; isSecret?: boolean }> }>;
  };

  it("server.json name matches package.json mcpName and versions agree", () => {
    expect(pkg["mcpName"]).toBe("io.github.0xcircuitbreaker/dominusnode");
    expect(server.name).toBe(pkg["mcpName"]);
    expect(server.version).toBe(pkg["version"]);
    expect(server.packages[0].version).toBe(pkg["version"]);
    expect(server.packages[0].identifier).toBe(pkg["name"]);
    expect(server.packages[0].registryType).toBe("npm");
    expect(server.packages[0].transport.type).toBe("stdio");
    expect(server.$schema).toMatch(/^https:\/\/static\.modelcontextprotocol\.io\/schemas\/\d{4}-\d{2}-\d{2}\/server\.schema\.json$/);
    expect(server.description.length).toBeLessThanOrEqual(100);
  });

  it("the API key is a secret env var and no asset contains a credential", () => {
    const key = server.packages[0].environmentVariables.find((e) => e.name === "DOMINUSNODE_API_KEY");
    expect(key?.isSecret).toBe(true);
    for (const f of ["server.json", "smithery.yaml", "Dockerfile"]) {
      expect(read(f)).not.toMatch(/dn_(live|test|node|proxy)_[A-Za-z0-9]{8,}/);
    }
  });

  it("Dockerfile runs as non-root and bakes in no secrets", () => {
    const d = read("Dockerfile");
    expect(d).toMatch(/^USER node$/m);
    expect(d).not.toMatch(/^\s*(ENV|ARG)\s+DOMINUSNODE_API_KEY/m);
    expect(d).not.toMatch(/^\s*COPY\s+.*\.(key|env)\b/m);
    expect(read(".dockerignore")).toMatch(/\.env\*/);
  });
});
