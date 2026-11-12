import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { m, renderPage, UUID1 } from "../test-helpers";

vi.mock("../../api/admin", async (orig) => {
  const actual = await orig<typeof import("../../api/admin")>();
  const fns = Object.fromEntries(Object.keys(actual.launchApi).map((k) => [k, vi.fn()]));
  return { ...actual, launchApi: fns };
});
import { launchApi } from "../../api/admin";
import LaunchPage, { usdToMusdString, starterCurrent } from "./LaunchPage";

const api = vi.mocked(launchApi);
const paged = <T,>(items: T[]) => ({ limit: 50, offset: 0, total: items.length, items });
const side = { total: 4, online: 3, countries: 2, asns: 2, paidBytes24h: "1000000000", paid24h: m(0.5), paidBytes30d: "0", paid30d: m(0) };
const starter = {
  enabled: false, amount: m(0.5), dailyBudget: m(50), perPrefixCap: 1, perFundingSourceCap: 1, capWindowDays: 30, expiryDays: 30,
  seedNodesOnly: true, seedOnlyDays: 30, updatedAt: null, grantedToday: { count: 0, amount: m(0) },
};

beforeEach(() => {
  vi.clearAllMocks();
  api.seedSummary.mockResolvedValue({ seed: side, community: { ...side, online: 9, total: 10 } });
  api.starterSettings.mockResolvedValue(starter);
  api.starterGrants.mockResolvedValue(paged([]));
  api.genesisSettings.mockResolvedValue({ enabled: true, maxOwners: 200, bonusBps: 500, boostDays: 90, credit: m(5), creditThresholdBytes: "5000000000", members: 3, updatedAt: null });
  api.genesisMembers.mockResolvedValue(paged([]));
  api.incidents.mockResolvedValue(paged([]));
  api.announcements.mockResolvedValue(paged([]));
  api.unmetDemand.mockResolvedValue({ days: 7, groups: [{ country: "BR", ipClass: "residential", requests: 12, lastHour: "2026-11-06T10:00:00Z" }], daily: [] });
  api.abuseReports.mockResolvedValue(paged([]));
  api.allowlist.mockResolvedValue(paged([]));
});

describe("LaunchPage", () => {
  it("renders seed vs community, genesis slots and unmet demand", async () => {
    renderPage(<LaunchPage />, "/admin/launch");
    expect(await screen.findByText("Seed vs community nodes")).toBeInTheDocument();
    expect(await screen.findByText("9 / 10")).toBeInTheDocument();
    expect(await screen.findByText(/3 of 200 slots used/)).toBeInTheDocument();
    expect(await screen.findByText("BR")).toBeInTheDocument();
  });

  it("saves only changed starter-credit fields, converting USD to µUSD", async () => {
    api.updateStarterSettings.mockResolvedValue(starter);
    renderPage(<LaunchPage />, "/admin/launch");
    const box = await screen.findByLabelText("Grants enabled");
    await userEvent.click(box);
    const amt = screen.getByLabelText("Amount per grant (USD)");
    await userEvent.clear(amt);
    await userEvent.type(amt, "0.75");
    await userEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
    await waitFor(() => expect(api.updateStarterSettings).toHaveBeenCalledWith({ enabled: true, amountMusd: "750000" }));
  });

  it("edits the funding precondition and genesis payer threshold", async () => {
    api.updateStarterSettings.mockResolvedValue(starter);
    api.updateGenesisSettings.mockResolvedValue({} as never);
    renderPage(<LaunchPage />, "/admin/launch");
    await userEvent.click(await screen.findByLabelText("Require prior Base tx or paid top-up"));
    const min = screen.getByLabelText("Minimum qualifying top-up (cents)");
    await userEvent.clear(min);
    await userEvent.type(min, "200");
    await userEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
    await waitFor(() => expect(api.updateStarterSettings).toHaveBeenCalledWith({ requireFunding: false, minTopupCents: 200 }));
    const payers = screen.getByLabelText("Distinct unlinked paying principals to enter");
    await userEvent.clear(payers);
    await userEvent.type(payers, "5");
    await userEvent.click(screen.getAllByRole("button", { name: "Save" })[1]);
    await waitFor(() => expect(api.updateGenesisSettings).toHaveBeenCalledWith({ minDistinctPayers: 5 }));
  });

  it("publishes, unpublishes and validates announcements", async () => {
    api.announcements.mockResolvedValue(paged([{ id: UUID1, title: "Old note", body: "", category: "news", url: null, published: true, publishedAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" }]));
    api.createAnnouncement.mockResolvedValue({ id: UUID1 });
    api.updateAnnouncement.mockResolvedValue({ id: UUID1 });
    renderPage(<LaunchPage />, "/admin/launch");
    await userEvent.type(await screen.findByLabelText("Announcement title"), "DC price change");
    await userEvent.type(screen.getByLabelText("Link (https, optional)"), "http://bad");
    await userEvent.click(screen.getByRole("button", { name: "Publish announcement" }));
    expect(await screen.findByText("Link must be an https URL")).toBeInTheDocument();
    expect(api.createAnnouncement).not.toHaveBeenCalled();
    await userEvent.clear(screen.getByLabelText("Link (https, optional)"));
    await userEvent.click(screen.getByRole("button", { name: "Publish announcement" }));
    await waitFor(() => expect(api.createAnnouncement).toHaveBeenCalledWith({ title: "DC price change", body: "", category: "news" }));
    await userEvent.click(await screen.findByRole("button", { name: "Unpublish" }));
    await waitFor(() => expect(api.updateAnnouncement).toHaveBeenCalledWith(UUID1, { published: false }));
  });

  it("flags a node as operator-run", async () => {
    api.setOperatorRun.mockResolvedValue({ nodeId: UUID1, operatorRun: true, previous: false });
    renderPage(<LaunchPage />, "/admin/launch");
    await userEvent.type(await screen.findByLabelText("Node id"), UUID1);
    await userEvent.click(screen.getByRole("button", { name: "Flag operator-run" }));
    await waitFor(() => expect(api.setOperatorRun).toHaveBeenCalledWith(UUID1, true));
  });

  it("helpers", () => {
    expect(usdToMusdString("$5")).toBe("5000000");
    expect(usdToMusdString("0.000001")).toBe("1");
    expect(usdToMusdString("1e3")).toBeNull();
    expect(starterCurrent(starter as never)).toMatchObject({ amountUsd: "0.5", dailyBudgetUsd: "50" });
  });
});
