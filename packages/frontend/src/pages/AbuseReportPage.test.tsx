/// <reference types="node" />
import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "../context/ThemeContext";
import AbuseReportPage, { validateReport } from "./AbuseReportPage";
import { leadingZeroBits, sha256Words, solvePow } from "../landing/pow";

const hex = (w: Uint32Array) => Array.from(w, (x) => (x >>> 0).toString(16).padStart(8, "0")).join("");

afterEach(() => vi.unstubAllGlobals());

describe("pow", () => {
  it("sha256 matches node:crypto", () => {
    for (const m of ["", "abc", "a".repeat(55), "a".repeat(56), "x".repeat(130), "0123456789abcdef0123456789abcdefz9"]) {
      expect(hex(sha256Words(m))).toBe(createHash("sha256").update(m).digest("hex"));
    }
  });

  it("finds a nonce the server would accept", async () => {
    const prefix = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const nonce = await solvePow(prefix, 12);
    expect(nonce.length).toBeLessThanOrEqual(32);
    const d = createHash("sha256").update(prefix + nonce).digest();
    expect(leadingZeroBits(new Uint32Array([d.readUInt32BE(0), d.readUInt32BE(4)]))).toBeGreaterThanOrEqual(12);
  });

  it("rejects malformed challenges", async () => {
    await expect(solvePow("not hex!", 10)).rejects.toThrow();
    await expect(solvePow("abcd", 99)).rejects.toThrow();
  });
});

describe("AbuseReportPage", () => {
  const ok = { destHost: "shop.example.com", windowStart: "2026-11-06T10:00", windowEnd: "2026-11-06T11:00", description: "Credential stuffing burst" };

  it("validates like the API", () => {
    expect(validateReport(ok)).toBeNull();
    expect(validateReport({ ...ok, destHost: "https://x.com/a" })).toMatch(/bare hostname/);
    expect(validateReport({ ...ok, destHost: "1.2.3.4" })).toMatch(/bare hostname/);
    expect(validateReport({ ...ok, windowEnd: "2026-11-06T09:00" })).toMatch(/before/);
    expect(validateReport({ ...ok, description: "short" })).toMatch(/10 to 4000/);
  });

  it("runs challenge, PoW and submit", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      const body = url.endsWith("/challenge")
        ? { challengeId: "11111111-1111-1111-1111-111111111111", prefix: "00ff", difficulty: 8, algorithm: "sha256" }
        : { id: "rep-1", status: "new", responseTarget: "24h" };
      return { ok: true, status: url.endsWith("/challenge") ? 200 : 201, text: async () => JSON.stringify(body) } as unknown as Response;
    }));
    render(<MemoryRouter><ThemeProvider><AbuseReportPage /></ThemeProvider></MemoryRouter>);
    fireEvent.change(screen.getByLabelText("Target host"), { target: { value: ok.destHost } });
    fireEvent.change(screen.getByLabelText("Window start"), { target: { value: ok.windowStart } });
    fireEvent.change(screen.getByLabelText("Window end"), { target: { value: ok.windowEnd } });
    fireEvent.change(screen.getByLabelText("What happened"), { target: { value: ok.description } });
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    await waitFor(() => expect(screen.getByText("Report received.")).toBeInTheDocument());
    expect(calls).toHaveLength(2);
    const sub = calls[1]!.body as { pow: { nonce: string }; destHost: string };
    expect(sub.destHost).toBe("shop.example.com");
    const d = createHash("sha256").update("00ff" + sub.pow.nonce).digest();
    expect(d[0]).toBe(0);
  });

  it("shows the API error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 429, text: async () => JSON.stringify({ error: "Too many challenge requests." }) }) as unknown as Response));
    render(<MemoryRouter><ThemeProvider><AbuseReportPage /></ThemeProvider></MemoryRouter>);
    fireEvent.change(screen.getByLabelText("Target host"), { target: { value: ok.destHost } });
    fireEvent.change(screen.getByLabelText("Window start"), { target: { value: ok.windowStart } });
    fireEvent.change(screen.getByLabelText("Window end"), { target: { value: ok.windowEnd } });
    fireEvent.change(screen.getByLabelText("What happened"), { target: { value: ok.description } });
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Too many challenge requests/);
  });
});
