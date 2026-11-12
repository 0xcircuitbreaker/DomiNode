import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { Crosshair, CURSOR_ATTR, GrainCanvas } from ".";

function mockMedia(matches: Record<string, boolean>) {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: matches[q.replace(/\s/g, "")] ?? false, media: q,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute(CURSOR_ATTR);
});

describe("DDG Crosshair", () => {
  it("activates on a fine pointer and restores the cursor on blur and unmount", () => {
    mockMedia({ "(pointer:fine)": true });
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 1; });
    const { unmount } = render(<Crosshair />);
    const el = screen.getByTestId("ddg-crosshair");
    expect(el).toHaveAttribute("aria-hidden", "true");
    act(() => { window.dispatchEvent(Object.assign(new MouseEvent("pointermove", { clientX: 40, clientY: 50 }), { pointerType: "mouse" })); });
    expect(el.dataset.active).toBe("true");
    expect(el.textContent).toBe("X 40\nY 50");
    expect(document.documentElement.getAttribute(CURSOR_ATTR)).toBe("on");
    act(() => { window.dispatchEvent(new Event("blur")); });
    expect(el.dataset.active).toBe("false");
    expect(document.documentElement.hasAttribute(CURSOR_ATTR)).toBe(false);
    act(() => { window.dispatchEvent(Object.assign(new MouseEvent("pointermove", { clientX: 1, clientY: 1 }), { pointerType: "mouse" })); });
    unmount();
    expect(document.documentElement.hasAttribute(CURSOR_ATTR)).toBe(false);
  });

  it("stays off with reduced motion or a coarse pointer", () => {
    mockMedia({ "(pointer:fine)": true, "(prefers-reduced-motion:reduce)": true });
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 1; });
    render(<Crosshair />);
    act(() => { window.dispatchEvent(Object.assign(new MouseEvent("pointermove", { clientX: 4, clientY: 5 }), { pointerType: "mouse" })); });
    expect(screen.getByTestId("ddg-crosshair").dataset.active).toBe("false");
    expect(document.documentElement.hasAttribute(CURSOR_ATTR)).toBe(false);
  });
});

describe("DDG GrainCanvas", () => {
  it("draws noise, schedules redraws and clears the timer on unmount", () => {
    mockMedia({});
    const put = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      putImageData: put,
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    } as unknown as CanvasRenderingContext2D);
    const setI = vi.spyOn(window, "setInterval");
    const clearI = vi.spyOn(window, "clearInterval");
    const { unmount } = render(<GrainCanvas opacity={0.1} />);
    expect(screen.getByTestId("ddg-grain")).toHaveStyle({ opacity: "0.1" });
    expect(put).toHaveBeenCalledTimes(1);
    const img = put.mock.calls[0]![0] as { data: Uint8ClampedArray };
    expect(img.data[3]).toBe(80);
    expect(setI).toHaveBeenCalledWith(expect.any(Function), 100);
    unmount();
    expect(clearI).toHaveBeenCalled();
  });

  it("does not animate with reduced motion", () => {
    mockMedia({ "(prefers-reduced-motion:reduce)": true });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      putImageData: vi.fn(), createImageData: () => ({ data: new Uint8ClampedArray(4) }),
    } as unknown as CanvasRenderingContext2D);
    const setI = vi.spyOn(window, "setInterval");
    render(<GrainCanvas />);
    expect(setI).not.toHaveBeenCalledWith(expect.any(Function), 100);
  });
});
