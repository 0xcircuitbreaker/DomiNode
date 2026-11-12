import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import RunNodePage from "./RunNodePage";
import SelfHostPage from "./SelfHostPage";
import PricingPublicPage from "./PricingPublicPage";
import QuickstartPage from "./QuickstartPage";

afterEach(() => vi.unstubAllGlobals());

const PAGES = [
  ["run-a-node", RunNodePage, /Contribute an IP/],
  ["self-host", SelfHostPage, /one command/i],
  ["pricing", PricingPublicPage, /Pay per GB/],
  ["quickstart", QuickstartPage, /relayed request/],
] as const;

describe("public pages", () => {
  for (const [name, Page, h1] of PAGES) {
    it(`${name}: renders, no login/admin links, no hardcoded price, footer contact`, async () => {
      vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
      render(<MemoryRouter><Page /></MemoryRouter>);
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(h1);
      for (const a of screen.getAllByRole("link")) {
        expect(a.getAttribute("href") ?? "").not.toMatch(/\/(login|admin|register|signup)/i);
      }
      expect(document.body.textContent).not.toMatch(/\$\d+(\.\d+)?\s*\/\s*GB/);
      expect(screen.getByRole("link", { name: "0xcircuitbreaker@protonmail.com" })).toHaveAttribute("href", "mailto:0xcircuitbreaker@protonmail.com");
    });
  }

  it("run-a-node names the pinned node image", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<MemoryRouter><RunNodePage /></MemoryRouter>);
    expect(document.body.textContent).toContain("ghcr.io/0xcircuitbreaker/dominusnode-node:0.1.1");
  });
});
