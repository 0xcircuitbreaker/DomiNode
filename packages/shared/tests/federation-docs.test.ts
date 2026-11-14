import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildPolicyDocument, DEFAULT_POLICY } from "../src/index.js";

const DOCS = path.resolve(__dirname, "../../../docs/agent-network");

// The unpublished default policy is version 0, which buildPolicyDocument
// rejects, so the federation documents 503 until an admin publishes one.
describe("federation documents before the first policy", () => {
  it("version 0 cannot be signed", () => {
    expect(() => buildPolicyDocument(0, DEFAULT_POLICY)).toThrow();
  });

  for (const doc of ["DEPLOYMENT.md", "FEDERATION.md"]) {
    it(`${doc} says the documents return 503 until the first policy is published`, () => {
      const text = fs.readFileSync(path.join(DOCS, doc), "utf8");
      expect(text).toContain("Until the first network policy is published");
      expect(text).toContain("PUT /api/admin/network/policy");
    });
  }
});
