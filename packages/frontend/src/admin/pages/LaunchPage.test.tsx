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
