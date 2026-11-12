import { describe, it, expect } from "vitest";
import { renderLiveSection, renderStatusPage } from "./status-page.js";
import type { NetworkStats } from "./v1/public.js";

const live: NetworkStats = {
  onlineNodes: 9,
  byClass: { residential: 6, dc: 3 },
  byCountry: [{ country: "US", online: 5 }, { country: "DE", online: 3 }],
  otherCountries: 1,
  countriesAvailable: 3,
  seed: { online: 4, paidBytes24h: "0" },
  community: { online: 5, paidBytes24h: "0" },
  generatedAt: "2026-11-12T00:00:00.000Z",
};

describe("status page live section", () => {
  it("shows the operator-run vs community split and countries available", () => {
    const html = renderLiveSection(live);
    expect(html).toContain("Operator-run nodes / community nodes");
    expect(html).toContain("4 / 5");
    expect(html).toContain("Countries available");
    expect(html).toContain("US, DE");
  });

  it("degrades when live stats are unavailable", () => {
    expect(renderLiveSection(null)).toContain("unavailable");
  });

  it("is included in the full page", () => {
    const html = renderStatusPage([], [], null, new Date(), live);
    expect(html).toContain("Live now");
    expect(html).toContain("4 / 5");
  });
});
