import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { acc, m, renderPage } from "../test-helpers";

vi.mock("../../api/admin", async (orig) => {
  const actual = await orig<typeof import("../../api/admin")>();
  return {
    ...actual,
    adminApi: {
      overview: vi.fn(), revenue: vi.fn(), topRequesters: vi.fn(), topNodeOwners: vi.fn(), geo: vi.fn(), health: vi.fn(),
    },
  };
});
import { adminApi, RAILS, IP_CLASSES } from "../../api/admin";
import OverviewPage from "./OverviewPage";
import RevenuePage, { revenueCsv } from "./RevenuePage";
import NetworkPage from "./NetworkPage";
import HealthPage from "./HealthPage";

const api = vi.mocked(adminApi);
const ca = (count: number, usd: number) => ({ count, amount: m(usd) });
const byRail = () => Object.fromEntries(RAILS.map((r) => [r, acc(r === "wallet" ? 1.5 : 0)])) as never;
const byClass = () => Object.fromEntries(IP_CLASSES.map((c) => [c, acc(c === "residential" ? 1.5 : 0)])) as never;
const revenue = {
  from: "2026-10-07T00:00:00.000Z", to: "2026-11-06T00:00:00.000Z", bucket: "day" as const,
  series: [{ t: "2026-11-01T00:00:00.000Z", ...acc(1.5, 2, 3), byRail: byRail(), byClass: byClass() }],
  totals: { ...acc(1.5, 2, 3), byRail: byRail(), byClass: byClass() },
};

beforeEach(() => {
  vi.clearAllMocks();
  api.revenue.mockResolvedValue(revenue);
  api.topRequesters.mockResolvedValue({ period: "30d", limit: 10, offset: 0, total: 1, items: [
    { userId: "u1", email: "agent@x.io", walletAddress: null, ...acc(1.5), lastChargeAt: "2026-11-01T00:00:00Z" },
  ] });
  api.topNodeOwners.mockResolvedValue({ period: "30d", limit: 10, offset: 0, total: 0, items: [] });
});

describe("OverviewPage", () => {
  it("renders KPI tiles from the overview", async () => {
    api.overview.mockResolvedValue({
      generatedAt: "2026-11-06T00:00:00Z",
      nodes: { total: 12, online: 9, byStatus: {} as never, quarantined: 2, uniquePrefixesOnline: 7, uniqueAsnsOnline: 4 },
      agents: { requestersActive24h: 5, requestersActive7d: 8, requestersActive30d: 11, nodeOwners: 3, nodeOwnersWithActiveNode: 2 },
      traffic: { "24h": acc(0.25), "7d": acc(3), "30d": acc(12.5, 4.2, 99), all: acc(20) },
      credits: { accounts: 3, frozenAccounts: 1, pending: m(4), available: m(6.5), frozenBalance: m(1) },
      payouts: { pending: ca(2, 10), heldTax: ca(1, 1), heldFrozen: ca(0, 0), submitted: ca(0, 0), confirmed30d: ca(4, 40), failed30d: ca(0, 0), reversed30d: ca(1, 2) },
      disputes: { open: 3, nodesWithOpen: 2 },
    });
    renderPage(<OverviewPage />);
    expect(await screen.findByText("Nodes online")).toBeInTheDocument();
    expect(screen.getByText("9")).toBeInTheDocument();
    expect(screen.getByText("12 total")).toBeInTheDocument();
    expect(screen.getAllByText("$12.50").length).toBeGreaterThan(0);
    expect(screen.getAllByText("4.20 GB").length).toBeGreaterThan(0);
    expect(screen.getByText("Open disputes").closest("div")!.parentElement!).toHaveTextContent("3");
    expect(screen.getByRole("link", { name: "2" })).toHaveAttribute("href", "/admin/nodes?status=quarantined");
    // sub-dollar amounts keep precision
    expect(screen.getByText("$0.2500")).toBeInTheDocument();
  });

  it("shows an error with retry", async () => {
    api.overview.mockRejectedValue(new Error("Overview failed"));
    renderPage(<OverviewPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Overview failed");
  });
});

describe("RevenuePage", () => {
  it("loads totals and refetches when the bucket changes", async () => {
    renderPage(<RevenuePage />);
    expect(await screen.findByText("Gross = platform + node share")).toBeInTheDocument();
    expect(await screen.findByText("agent@x.io")).toBeInTheDocument();
    expect(api.revenue).toHaveBeenLastCalledWith(expect.objectContaining({ bucket: "day" }));
    await userEvent.click(within(screen.getByRole("group", { name: "Bucket" })).getByRole("button", { name: "hour" }));
    expect(api.revenue).toHaveBeenLastCalledWith(expect.objectContaining({ bucket: "hour" }));
    // hour bucket clamps the range to an allowed option
    expect(within(screen.getByRole("group", { name: "Range" })).getByRole("button", { name: "2d" })).toHaveAttribute("aria-pressed", "true");
  });

  it("changes the leaderboard period", async () => {
    renderPage(<RevenuePage />);
    await screen.findByText("agent@x.io");
    await userEvent.click(within(screen.getByRole("group", { name: "Leaderboard period" })).getByRole("button", { name: "7d" }));
    expect(api.topRequesters).toHaveBeenLastCalledWith({ period: "7d", limit: 10, offset: 0 });
  });

  it("builds a CSV with rails and classes", () => {
    const csv = revenueCsv(revenue);
    const [header, row] = csv.trim().split("\r\n");
    expect(header).toContain("gross_wallet_usd");
    expect(header).toContain("gross_residential_usd");
    expect(row.startsWith("2026-11-01T00:00:00.000Z,1.500000,")).toBe(true);
  });
});

describe("NetworkPage", () => {
  it("lists countries and ASNs", async () => {
    const row = { nodes: 3, activeNodes: 2, onlineNodes: 2, bytes: "1000000000", gb: "1.000000", gross: m(1), nodeEarnings: m(0.3) };
    api.geo.mockResolvedValue({ period: "30d", byCountry: [{ country: "DE", ...row }, { country: "unknown", ...row }], byAsn: [{ asn: 3320, ...row }, { asn: null, ...row }] });
    renderPage(<NetworkPage />);
    expect(await screen.findByText("Germany")).toBeInTheDocument();
    expect(screen.getByText("AS3320")).toBeInTheDocument();
    expect(screen.getAllByText("Unknown").length).toBe(2);
    await userEvent.click(within(screen.getByRole("group", { name: "Period" })).getByRole("button", { name: "7d" }));
    expect(api.geo).toHaveBeenLastCalledWith({ period: "7d" });
  });
});

describe("HealthPage", () => {
  it("highlights stale jobs and shows queue depth", async () => {
    api.health.mockResolvedValue({
      generatedAt: "2026-11-06T00:00:00Z",
      jobs: [
        { name: "maturity", instanceId: "gw-1", lastStartedAt: null, lastFinishedAt: "2026-11-06T00:00:00Z", lastOk: true, lastError: null, lastDurationMs: 12, lastSuccessAt: "2026-11-06T00:00:00Z", runCount: 5, failCount: 0, expectedIntervalMs: 60_000, stale: false },
        { name: "payouts", instanceId: null, lastStartedAt: null, lastFinishedAt: null, lastOk: null, lastError: null, lastDurationMs: null, lastSuccessAt: null, runCount: 0, failCount: 0, expectedIntervalMs: 3_600_000, stale: true },
      ],
      settleRetryQueue: { pending: 4, due: 1, dead: 0, oldestPendingAt: null, maxAttempts: 10 },
      gateway: { liveInstances: 2, connectedNodes: 9, lastHeartbeatAt: null },
      dbPool: { total: 10, idle: 8, waiting: 0 },
    });
    renderPage(<HealthPage />);
    const stale = await screen.findByText("payouts", { selector: "span" });
    expect(stale.className).toContain("text-red-600");
    expect(screen.getByText("stale")).toBeInTheDocument();
    expect(screen.getByText("ok")).toBeInTheDocument();
    expect(screen.getByText("Settle-retry queue").closest("div")!.parentElement!).toHaveTextContent("4");
    expect(screen.getByText("10 conn")).toBeInTheDocument();
  });
});
