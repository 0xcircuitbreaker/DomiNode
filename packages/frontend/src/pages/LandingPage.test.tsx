import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "../context/ThemeContext";
import LandingPage from "./LandingPage";
import { SNIPPETS } from "../landing/snippets";
import { musdToUsd } from "../landing/publicApi";

function renderLanding() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <ThemeProvider>
        <LandingPage />
      </ThemeProvider>
    </MemoryRouter>,
  );
}

const textRes = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, text: async () => JSON.stringify(body) }) as unknown as Response;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LandingPage", () => {
  it("renders every section", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    renderLanding();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/relay network/i);
    for (const id of ["buy", "earn", "live", "safety", "integrations"]) {
      expect(document.getElementById(id)).not.toBeNull();
    }
    expect(screen.getByRole("link", { name: /Daedalus Development Group/ })).toHaveAttribute("href", "https://daedalusdevelopmentgroup.com");
  });

  it("has no login, signup or admin link", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    renderLanding();
    for (const a of screen.getAllByRole("link")) {
      const href = a.getAttribute("href") ?? "";
      expect(href).not.toMatch(/\/(login|admin|register|signup|forgot-password)/i);
      expect(a.textContent ?? "").not.toMatch(/log ?in|sign ?(in|up)|dashboard|portal/i);
    }
  });

  it("shows fallback text when the public API is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    renderLanding();
    await waitFor(() => expect(screen.getByText(/Live pricing is unavailable/)).toBeInTheDocument());
    expect(screen.getByText(/Live stats is unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/Live policy is unavailable/)).toBeInTheDocument();
    // no price figure appears without the API
    expect(document.body.textContent).not.toMatch(/\$\d+(\.\d+)?\s*\/\s*GB/);
  });

  it("falls back on a non-OK or malformed response", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) => (u.includes("pricing") ? textRes({ error: "x" }, 503) : textRes({ nope: 1 }))));
    renderLanding();
    await waitFor(() => expect(screen.getByText(/Live pricing is unavailable/)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/Live stats is unavailable/)).toBeInTheDocument());
  });

  it("renders live pricing, stats and policy from the API", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      if (u.endsWith("/v1/pricing")) return textRes({
        currency: "USD", unit: "musd_per_gb",
        prices: [{ ipClass: "residential", pricePerGbMusd: "123000" }],
        nodeShare: [{ tier: "partner", rank: 5, nodeShareBps: 5000 }, { tier: "probation", rank: 0, nodeShareBps: 2500 }],
        buyerDiscounts: [{ tier: "partner", rank: 5, buyerDiscountBps: 2500 }, { tier: "probation", rank: 0, buyerDiscountBps: 0 }],
        rails: ["x402", "wallet"],
      });
      if (u.endsWith("/v1/network/stats")) return textRes({ onlineNodes: 42, byClass: { dc: 30 }, byCountry: [{ country: "US", online: 9 }], otherCountries: 3, generatedAt: "" });
      return textRes({ version: 7, sha256: "a".repeat(64), floorGuarantees: ["Ports 25 are always denied."] });
    }));
    renderLanding();
    const pricing = await screen.findByTestId("live-pricing");
    expect(within(pricing).getByText("$0.12")).toBeInTheDocument();
    expect(within(pricing).getByText("50%")).toBeInTheDocument();
    expect(within(pricing).getByRole("columnheader", { name: "Buyer discount" })).toBeInTheDocument();
    expect(within(pricing).getByText("0%")).toBeInTheDocument();
    expect(within(pricing).getAllByText("25%")).toHaveLength(2); // probation share + partner discount
    expect(within(await screen.findByTestId("live-stats")).getByText("42")).toBeInTheDocument();
    expect(within(await screen.findByTestId("live-policy")).getByText(/Ports 25/)).toBeInTheDocument();
  });

  it("quickstarts use placeholder keys only", () => {
    for (const s of SNIPPETS) {
      expect(s.code).not.toMatch(/dn_(live|test|node)_(?!YOUR_KEY)[A-Za-z0-9]/);
    }
  });

  it("musdToUsd rejects non-integers", () => {
    expect(musdToUsd("500000")).toBe("$0.50");
    expect(musdToUsd("-1")).toBeNull();
    expect(musdToUsd("1e9")).toBeNull();
  });
});
