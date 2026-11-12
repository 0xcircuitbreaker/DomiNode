import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { m, renderPage, UUID1, UUID2 } from "../test-helpers";

vi.mock("../../api/admin", async (orig) => {
  const actual = await orig<typeof import("../../api/admin")>();
  return { ...actual, collusionApi: { flags: vi.fn(), resolve: vi.fn(), settings: vi.fn(), updateSettings: vi.fn() } };
});
import { collusionApi } from "../../api/admin";
import CollusionPage from "./CollusionPage";

const api = vi.mocked(collusionApi);
const flag = {
  id: UUID1, kind: "concentration", ownerUserId: UUID2, ownerEmail: null, nodeId: UUID1, requesterUserId: UUID2, requesterEmail: null,
  shareBps: 9100, volume: m(9.1), total: m(10), windowDays: 30, status: "open", autoFrozen: false, ownerCreditsFrozen: false,
  resolvedBy: null, resolutionNote: null, firstSeenAt: "2026-11-01T00:00:00Z", lastSeenAt: "2026-11-10T00:00:00Z", resolvedAt: null,
};
const settings = {
  windowDays: 30, minNodeVolume: m(5), concentrationBps: 8000, clusterSize: 3, clusterBps: 9000, circularMin: m(2),
  autoFreeze: false, freezeBps: 9500, freezeMinVolume: m(50), updatedBy: null, updatedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.flags.mockResolvedValue({ limit: 50, offset: 0, total: 1, items: [flag] });
  api.settings.mockResolvedValue(settings);
});

describe("CollusionPage", () => {
  it("lists flags and settings", async () => {
    renderPage(<CollusionPage />);
    expect(await screen.findByText("concentration")).toBeInTheDocument();
    expect(screen.getByText("91.00%")).toBeInTheDocument();
    expect(await screen.findByText("30 days")).toBeInTheDocument();
    expect(api.flags).toHaveBeenCalledWith(expect.objectContaining({ status: "open" }));
  });

  it("dismisses a flag through the confirm dialog with a note", async () => {
    api.resolve.mockResolvedValue({ id: UUID1, status: "dismissed" });
    renderPage(<CollusionPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    await userEvent.type(screen.getByLabelText(/Reason/), "known reseller");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss flag" }));
    await waitFor(() => expect(api.resolve).toHaveBeenCalledWith(UUID1, "dismiss", "known reseller"));
    expect(await screen.findByText(/dismissed\./)).toBeInTheDocument();
  });

  it("shows an error state", async () => {
    api.flags.mockRejectedValue(new Error("Forbidden"));
    renderPage(<CollusionPage />);
    expect(await screen.findByText(/Forbidden/)).toBeInTheDocument();
  });
});
