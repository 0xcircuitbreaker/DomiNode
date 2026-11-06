import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "../context/ThemeContext";
import type { Money } from "../lib/format";

export function m(usd: number): Money {
  return { musd: String(Math.round(usd * 1_000_000)), usd: usd.toFixed(6) };
}

export function acc(usd: number, gb = 1, charges = 1) {
  return { gross: m(usd), platform: m(usd * 0.7), node: m(usd * 0.3), bytes: String(gb * 1e9), gb: gb.toFixed(6), charges };
}

export function renderPage(ui: ReactElement, path = "/admin") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ThemeProvider>{ui}</ThemeProvider>
    </MemoryRouter>,
  );
}

export const UUID1 = "11111111-1111-4111-8111-111111111111";
export const UUID2 = "22222222-2222-4222-8222-222222222222";
