import { describe, it, expect } from "vitest";
import { renderLiveSection, renderStatusPage, renderHealthSection } from "./status-page.js";
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

describe("status page health section", () => {
  const health = {
    status: "operational" as const,
    coordinator: { status: "operational" as const, policyVersion: 3 },
    gateway: { status: "operational" as const, instancesOnline: 1, lastHeartbeatAt: "2026-11-14T10:00:00.000Z" },
    availability: { last24h: 99.93, last7d: null },
    nodes: null, incidents: [], generatedAt: "2026-11-14T10:00:30.000Z",
  };
  it("shows gateway/coordinator health and 24h/7d availability", () => {
    const html = renderHealthSection(health);
    expect(html).toContain("1 instance live");
    expect(html).toContain("policy v3");
    expect(html).toContain("99.93%");
    expect(html).toContain("n/a (no heartbeats yet)");
    expect(renderHealthSection(null)).toContain("unavailable");
  });
  it("uses the summary status as the page headline and links /v1/status", () => {
    const html = renderStatusPage([], [], null, new Date(), null, { ...health, status: "down" });
    expect(html).toContain("Network status: Outage");
    expect(html).toContain('href="/v1/status"');
  });
});
