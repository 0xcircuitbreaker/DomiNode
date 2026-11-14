import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderPage, UUID1 } from "../test-helpers";

vi.mock("../../api/admin", async (orig) => {
  const actual = await orig<typeof import("../../api/admin")>();
  return { ...actual, killSwitchApi: { state: vi.fn(), set: vi.fn(), drain: vi.fn(), undrain: vi.fn() } };
});
import { killSwitchApi, KILL_SWITCH_KEYS } from "../../api/admin";
import KillSwitchesPage, { SWITCH_LABELS } from "./KillSwitchesPage";

const api = vi.mocked(killSwitchApi);
const state = () => ({
  pollIntervalMs: 5000,
  switches: KILL_SWITCH_KEYS.map((key) => ({ key, engaged: key === "rail_x402", reason: key === "rail_x402" ? "facilitator outage" : null, updatedBy: null, updatedAt: "1970-01-01T00:00:00Z" })),
  drainedNodes: { limit: 100, offset: 0, total: 1, items: [{ nodeId: UUID1, reason: "upgrade", createdBy: null, createdAt: "2026-11-01T00:00:00Z", status: "active" as const, ipClass: "dc" as const, country: "DE" }] },
});

beforeEach(() => {
  vi.clearAllMocks();
  api.state.mockResolvedValue(state());
});

describe("KillSwitchesPage", () => {
  it("labels every switch the API exposes", () => {
    for (const k of KILL_SWITCH_KEYS) expect(SWITCH_LABELS[k]).toBeDefined();
  });

  it("shows engaged switches and drained nodes", async () => {
    renderPage(<KillSwitchesPage />, "/admin/kill-switches");
    expect(await screen.findByText("facilitator outage")).toBeInTheDocument();
    expect(screen.getByText(/1 switch engaged: x402 rail/)).toBeInTheDocument();
    expect(screen.getByText("upgrade")).toBeInTheDocument();
  });

  it("pauses a switch with a required reason", async () => {
    api.set.mockResolvedValue({ key: "payouts", engaged: true, reason: "audit", updatedBy: null, updatedAt: "", previous: false, changed: true, effectWithinMs: 5000 });
    renderPage(<KillSwitchesPage />, "/admin/kill-switches");
    await userEvent.click(await screen.findByRole("button", { name: "Pause Payouts and withdrawals" }));
    await userEvent.type(screen.getByLabelText(/Reason/), "treasury audit");
    await userEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(api.set).toHaveBeenCalledWith("payouts", true, "treasury audit"));
    expect(await screen.findByText("Payouts and withdrawals paused.")).toBeInTheDocument();
  });

  it("resumes an engaged switch and undrains a node", async () => {
    api.set.mockResolvedValue({ key: "rail_x402", engaged: false, reason: "ok", updatedBy: null, updatedAt: "", previous: true, changed: true, effectWithinMs: 5000 });
    api.undrain.mockResolvedValue({ nodeId: UUID1, drained: false, changed: true });
    renderPage(<KillSwitchesPage />, "/admin/kill-switches");
    await userEvent.click(await screen.findByRole("button", { name: "Resume x402 rail" }));
    await userEvent.type(screen.getByLabelText(/Reason/), "fixed");
    await userEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(api.set).toHaveBeenCalledWith("rail_x402", false, "fixed"));
    await userEvent.click(screen.getByRole("button", { name: "Undrain" }));
    await userEvent.type(screen.getByLabelText(/Reason/), "upgraded");
    await userEvent.click(screen.getAllByRole("button", { name: "Undrain" }).at(-1)!);
    await waitFor(() => expect(api.undrain).toHaveBeenCalledWith(UUID1, "upgraded"));
  });

  it("drains a node by id", async () => {
    api.drain.mockResolvedValue({ nodeId: UUID1, drained: true, changed: true });
    renderPage(<KillSwitchesPage />, "/admin/kill-switches");
    await userEvent.click(await screen.findByRole("button", { name: "Drain a node" }));
    await userEvent.type(screen.getByLabelText("Node id"), UUID1);
    await userEvent.type(screen.getByLabelText(/Reason/), "maintenance");
    await userEvent.click(screen.getByRole("button", { name: "Drain" }));
    await waitFor(() => expect(api.drain).toHaveBeenCalledWith(UUID1, "maintenance"));
  });
});
