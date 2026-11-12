import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement } from "react";
import PrivacyPage from "./PrivacyPage";
import TermsPage from "./TermsPage";

function text(el: ReactElement): string {
  const { container } = render(<MemoryRouter>{el}</MemoryRouter>);
  return container.textContent ?? "";
}

describe("PrivacyPage", () => {
  it("does not describe email/password accounts, Stripe or PayPal", () => {
    const t = text(<PrivacyPage />);
    expect(t).not.toMatch(/Stripe/);
    expect(t).not.toMatch(/password/i);
    expect(t).not.toMatch(/PayPal/);
  });
  it("names the real third-party processors", () => {
    const t = text(<PrivacyPage />);
    for (const p of ["Coinbase CDP", "PayAI", "NOWPayments", "Tempo", "Base", "ip2asn", "GitHub", "Cloudflare"]) {
      expect(t).toContain(p);
    }
    expect(t).toContain("SHA-256");
  });
});

describe("TermsPage", () => {
  it("does not list admin-only rails or email notice", () => {
    const t = text(<TermsPage />);
    expect(t).not.toMatch(/Stripe/);
    expect(t).not.toMatch(/PayPal/);
    expect(t).not.toMatch(/via email/i);
  });
  it("lists the agent payment rails", () => {
    const t = text(<TermsPage />);
    for (const p of ["x402", "MPP", "Tempo", "NOWPayments"]) expect(t).toContain(p);
    expect(t).toContain("/v1/policy");
  });
});
