import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import FaqPage, { FAQ_ITEMS } from "./FaqPage";
import TermsPage from "./TermsPage";
import AUPPage from "./AUPPage";
import PrivacyPage from "./PrivacyPage";
import { CONTACT_EMAIL } from "../landing/site";

describe("FaqPage", () => {
  it("renders every question", () => {
    render(<MemoryRouter><FaqPage /></MemoryRouter>);
    for (const item of FAQ_ITEMS) expect(screen.getByText(item.q)).toBeTruthy();
  });
  it("hardcodes no prices and no human signup flows", () => {
    const { container } = render(<MemoryRouter><FaqPage /></MemoryRouter>);
    const t = container.textContent ?? "";
    expect(t).not.toMatch(/\$\d/);
    expect(t).not.toMatch(/Stripe|PayPal/);
    expect(t).toContain("/v1/pricing");
    expect(t).not.toMatch(/@/);
  });
  it.each([["Terms", TermsPage], ["AUP", AUPPage]])("is linked from the %s footer", (_n, Page) => {
    const { container } = render(<MemoryRouter><Page /></MemoryRouter>);
    expect(container.querySelector('a[href="/faq"]')).not.toBeNull();
  });
  it.each([["Terms", TermsPage], ["AUP", AUPPage], ["Privacy", PrivacyPage]])("%s takes its contact from the shared site config", (_n, Page) => {
    const { container } = render(<MemoryRouter><Page /></MemoryRouter>);
    const mails = Array.from(container.querySelectorAll('a[href^="mailto:"]')).map((a) => a.getAttribute("href"));
    expect(mails.length).toBeGreaterThan(0);
    for (const m of mails) expect(m).toBe(`mailto:${CONTACT_EMAIL}`);
  });
});
