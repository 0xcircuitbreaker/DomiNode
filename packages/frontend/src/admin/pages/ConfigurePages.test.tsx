import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderPage } from "../test-helpers";
import { ApiError } from "../../api/client";

vi.mock("../../api/admin", async (orig) => {
  const actual = await orig<typeof import("../../api/admin")>();
  return {
    ...actual,
    adminApi: {
      policy: vi.fn(), publishPolicy: vi.fn(), pricing: vi.fn(), setPricing: vi.fn(), setTierWeight: vi.fn(), split: vi.fn(), addSplit: vi.fn(), tiers: vi.fn(), updateTier: vi.fn(),
    },
    launchApi: {
      ...actual.launchApi,
      discountSettings: vi.fn().mockResolvedValue({ enabled: true, minPlatformMarginBps: 2500, updatedAt: null }),
      updateDiscountSettings: vi.fn().mockResolvedValue({ updated: {} }),
    },
  };
});
import { adminApi, type NetworkPolicy } from "../../api/admin";
import PolicyPage, { buildPolicy } from "./PolicyPage";
import PricingPage, { pctToBps, tierPatch, usdToMusd } from "./PricingPage";

const api = vi.mocked(adminApi);
const body: NetworkPolicy = {
  ports: [80, 443], categoriesVersion: 1, denyCategories: [], denyDomains: ["bad.example"],
  nodeDefaults: { maxStreams: 32, maxGbDay: 5 }, requesterLimits: { reqPerSec: 20, dailySpendMusd: 50_000_000 },
  sanctionedCountries: ["CU", "IR", "KP", "RU", "SY"], attestation: { minVersion: 1, text: "I agree" },
  plaintext: "opt_in", logRetentionDays: 90, nodeCapsPerPrefix: { per32: 2, per24: 8, perAsn: 500 }, freeTierRelay: false,
  requireContribution: false, contributionWindowDays: 30, allowAnonymousPayers: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.policy.mockResolvedValue({ version: 3, sha256: "a".repeat(64), body, createdAt: "2026-11-01T00:00:00Z" });
});

describe("PolicyPage", () => {
  it("shows the active version and the read-only floor", async () => {
    renderPage(<PolicyPage />);
    expect(await screen.findByText("3")).toBeInTheDocument();
    expect(screen.getByText("Node floor (read-only)")).toBeInTheDocument();
    expect(screen.getByText("22, 23, 25, 465, 587, 3389, 6667")).toBeInTheDocument();
    expect(screen.getByLabelText("Deny domains")).toHaveValue("bad.example");
  });

  it("publishes edits after confirmation and adds sanctions without removing any", async () => {
    api.publishPolicy.mockResolvedValue({ version: 4, sha256: "b".repeat(64), body, createdAt: null, previousVersion: 3, attestationRaised: false });
    renderPage(<PolicyPage />);
    await userEvent.selectOptions(await screen.findByLabelText("Plaintext HTTP (port 80)"), "deny");
    await userEvent.click(screen.getByRole("checkbox", { name: "80" }));
    await userEvent.type(screen.getByLabelText("Add codes"), "by");
    await userEvent.click(screen.getByRole("button", { name: "Publish new version…" }));
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Publish" }));
    const sent = api.publishPolicy.mock.calls[0][0];
    expect(sent.plaintext).toBe("deny");
    expect(sent.ports).toEqual([443]);
    expect(sent.sanctionedCountries).toEqual(["BY", "CU", "IR", "KP", "RU", "SY"]);
    expect(sent.requesterLimits.dailySpendMusd).toBe(50_000_000);
    expect(await screen.findByText(/Published version 4/)).toBeInTheDocument();
  });

  it("shows server-side validation details", async () => {
    api.publishPolicy.mockRejectedValue(new ApiError("Invalid policy", 400, ["logRetentionDays: must be an integer in [1, 3650]"]));
    renderPage(<PolicyPage />);
    const f = await screen.findByLabelText(/Abuse log retention/);
    await userEvent.clear(f);
    await userEvent.type(f, "0");
    await userEvent.click(screen.getByRole("button", { name: "Publish new version…" }));
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Publish" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Invalid policy");
    expect(alert).toHaveTextContent("logRetentionDays: must be an integer in [1, 3650]");
  });

  it("buildPolicy keeps non-numeric input for the server to reject", () => {
    const f = { plaintext: "allow", ports: [443], denyDomains: "A.com\n b.com ", denyCategories: "", categoriesVersion: "1",
      maxStreams: "abc", maxGbDay: "5", reqPerSec: "20", dailySpendUsd: "1.5", per32: "2", per24: "8", perAsn: "500",
      addCountries: "", attestationMinVersion: "2", attestationText: "t", freeTierRelay: true, logRetentionDays: "30",
      requireContribution: true, contributionWindowDays: "14", allowAnonymousPayers: false } as const;
    const p = buildPolicy({ ...f, ports: [443] }, body);
    expect(p.denyDomains).toEqual(["a.com", "b.com"]);
    expect(p.nodeDefaults.maxStreams).toBe("abc");
    expect(p.requesterLimits.dailySpendMusd).toBe(1_500_000);
    expect(p.attestation.minVersion).toBe(2);
    expect([p.requireContribution, p.contributionWindowDays, p.allowAnonymousPayers]).toEqual([true, 14, false]);
  });
});

describe("PricingPage", () => {
  beforeEach(() => {
    api.pricing.mockResolvedValue({ pricing: [
      { ipClass: "residential", pricePerGbMusd: "5000000", updatedAt: "2026-11-01T00:00:00Z" },
      { ipClass: "dc", pricePerGbMusd: "3000000", updatedAt: "2026-11-01T00:00:00Z" },
    ] });
    api.split.mockResolvedValue({ current: { id: 1, nodeShareBps: 3000, maturationHours: 72, effectiveFrom: "2026-10-01T00:00:00Z", note: null }, history: [] });
    api.tiers.mockResolvedValue({ tiers: [{ id: 1, name: "bronze", rank: 1, nodeShareBps: 3000, minTenureDays: 0, minUptimeBps: 0, minActiveIps: 0, minReputation: 0, noClawbackDays: 30, holdDays: 7, maxNodes: 5, dailyWithdrawLimitMusd: "100000000", buyerDiscountBps: 500 }] });
  });

  it("updates the dc price after confirmation", async () => {
    api.setPricing.mockResolvedValue({ ipClass: "dc", pricePerGbMusd: "2500000", updatedAt: "2026-11-06T00:00:00Z" });
    renderPage(<PricingPage />);
    const dc = await screen.findByLabelText("dc (USD/GB)");
    expect(dc).toHaveValue("3");
    await userEvent.clear(dc);
    await userEvent.type(dc, "2.5");
    await userEvent.click(within(dc.closest("form")!).getByRole("button", { name: "Save" }));
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Save price" }));
    expect(api.setPricing).toHaveBeenCalledWith("dc", 2_500_000);
    expect(await screen.findByText("dc price set to $2.50/GB.")).toBeInTheDocument();
  });

  it("sets a masked tier weight with a required reason", async () => {
    api.pricing.mockResolvedValue({ pricing: [
      { ipClass: "residential", pricePerGbMusd: "500000", tierWeightBps: 10000, updatedAt: "2026-11-01T00:00:00Z" },
      { ipClass: "masked", pricePerGbMusd: "100000", tierWeightBps: 2500, updatedAt: "2026-11-01T00:00:00Z" },
    ] });
    api.setTierWeight.mockResolvedValue({ ipClass: "masked", pricePerGbMusd: "100000", tierWeightBps: 2000, updatedAt: "2026-11-06T00:00:00Z" });
    renderPage(<PricingPage />);
    const w = await screen.findByLabelText("masked weight (%)");
    expect(w).toHaveValue("25");
    await userEvent.clear(w);
    await userEvent.type(w, "20");
    await userEvent.click(within(w.closest("form")!).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Enter a reason (at least 3 characters).")).toBeInTheDocument();
    expect(api.setTierWeight).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText("Reason (required, audited)"), "WARP exits burn faster");
    await userEvent.click(within(w.closest("form")!).getByRole("button", { name: "Save" }));
    expect(api.setTierWeight).toHaveBeenCalledWith("masked", 2000, "WARP exits burn faster");
  });

  it("rejects a split above 50% client-side", async () => {
    renderPage(<PricingPage />);
    const share = await screen.findByLabelText("Node share (%)");
    await userEvent.clear(share);
    await userEvent.type(share, "60");
    await userEvent.click(screen.getByRole("button", { name: "Append split…" }));
    expect(await screen.findByText("Node share must be between 0% and 50%.")).toBeInTheDocument();
    expect(api.addSplit).not.toHaveBeenCalled();
  });

  it("edits a tier and sends only changed fields", async () => {
    api.updateTier.mockResolvedValue({ tier: {} as never });
    renderPage(<PricingPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const dlg = screen.getByRole("alertdialog");
    const share = within(dlg).getByLabelText("Node share (%)");
    await userEvent.clear(share);
    await userEvent.type(share, "35");
    await userEvent.click(within(dlg).getByRole("button", { name: "Save tier" }));
    await waitFor(() => expect(api.updateTier).toHaveBeenCalledWith(1, { nodeShareBps: 3500 }));
  });

  it("tier share above 50% is refused", () => {
    const t = { id: 1, name: "b", rank: 1, nodeShareBps: 3000, minTenureDays: 0, minUptimeBps: 0, minActiveIps: 0, minReputation: 0, noClawbackDays: 0, holdDays: 0, maxNodes: 1, dailyWithdrawLimitMusd: "0", buyerDiscountBps: 0 };
    const vals = { nodeShareBps: "51", minTenureDays: "0", minUptimeBps: "0", minActiveIps: "0", minReputation: "0", noClawbackDays: "0", holdDays: "0", maxNodes: "1", dailyWithdrawLimitMusd: "0", buyerDiscountBps: "0" };
    expect(tierPatch(t, vals).error).toMatch(/maximum is 50%/);
    expect(usdToMusd("$1.25")).toBe(1_250_000);
    expect(usdToMusd("1e3")).toBeNull();
    expect(pctToBps("12.5%")).toBe(1250);
  });
});
