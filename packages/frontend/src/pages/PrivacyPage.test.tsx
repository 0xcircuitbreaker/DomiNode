import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import PrivacyPage from "./PrivacyPage";

function text(): string {
  const { container } = render(<MemoryRouter><PrivacyPage /></MemoryRouter>);
  return container.textContent ?? "";
}

describe("PrivacyPage", () => {
  it("discloses the metadata-only relay abuse log, its fields and retention", () => {
    const t = text();
    expect(t).toMatch(/metadata-only abuse log/i);
    expect(t).toMatch(/destination hostname/i);
    expect(t).toMatch(/90 days by default/i);
    expect(t).toMatch(/logRetentionDays/);
  });

  it("does not make false no-logging claims", () => {
    const t = text();
    expect(t).not.toMatch(/we save no traffic logs/i);
    expect(t).not.toMatch(/because they do not exist/i);
    expect(t).not.toMatch(/we do not record which websites you visit/i);
    expect(t).not.toMatch(/we do not log which websites/i);
  });

  it("discloses that Cloudflare terminates TLS for the site and API", () => {
    const t = text();
    expect(t).not.toMatch(/connection routing data only, never traffic content/i);
    expect(t).toMatch(/Cloudflare — terminates TLS for this website and the API/);
    expect(t).toMatch(/including API keys/);
    expect(t).toMatch(/Relay and proxy traffic .* does not pass through Cloudflare/);
  });
});
