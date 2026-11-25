import { describe, expect, it } from "vitest";
import { contactEmail } from "./site";

describe("contactEmail", () => {
  it("accepts a plain or mailto: address", () => {
    expect(contactEmail("ops@example.org")).toBe("ops@example.org");
    expect(contactEmail(" MAILTO:ops@example.org ")).toBe("ops@example.org");
  });
  it("falls back to the placeholder for unset or unsafe values", () => {
    for (const bad of [undefined, "", "javascript:alert(1)", "a@b.org?subject=x", "a b@example.org", "https://example.org", "x@y"]) {
      expect(contactEmail(bad)).toBe("contact@example.org");
    }
  });
});
