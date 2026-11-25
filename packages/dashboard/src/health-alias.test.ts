import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("GET /health", () => {
  it("is the same handler as /api/health (alias, no extra data)", () => {
    const server = readFileSync(join(__dirname, "server.ts"), "utf8");
    expect(server).toContain('app.get(["/api/health", "/health"], async (_req, res) => {');
    expect(server.match(/"\/health"/g)).toHaveLength(1);
    expect(server.match(/"\/api\/health"/g)).toHaveLength(1);
  });
});
