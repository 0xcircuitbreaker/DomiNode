import { useEffect, useRef } from "react";

export const CURSOR_ATTR = "data-ddg-cursor";

/**
 * Crosshair cursor replacement (jacode.io): a 13px gold cross, faint
 * full-viewport axis lines and a mono X/Y readout. Only for fine pointers and
 * when motion is allowed. The native cursor is hidden (via an attribute on
 * <html>) only while the crosshair is active, and restored on leave/blur,
 * touch input, or unmount. Keyboard focus rings are untouched.
 */
export default function Crosshair() {
  const ref = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof window === "undefined" || !window.matchMedia) return;
    const fine = window.matchMedia("(pointer: fine)");
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const root = document.documentElement;
    let raf = 0;
    let x = 0;
    let y = 0;

    const off = () => {
      cancelAnimationFrame(raf);
      raf = 0;
      el.dataset.active = "false";
      root.removeAttribute(CURSOR_ATTR);
    };
    const move = (e: PointerEvent) => {
      if (!fine.matches || reduce.matches || e.pointerType === "touch") { off(); return; }
      x = e.clientX;
      y = e.clientY;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        el.style.transform = `translate3d(${x}px,${y}px,0)`;
        if (label.current) label.current.textContent = `X ${Math.round(x)}\nY ${Math.round(y)}`;
        el.dataset.active = "true";
        root.setAttribute(CURSOR_ATTR, "on");
      });
    };
    const out = (e: MouseEvent) => { if (!e.relatedTarget) off(); };

    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("blur", off);
    document.addEventListener("mouseleave", off);
    root.addEventListener("mouseout", out);
    fine.addEventListener?.("change", off);
    reduce.addEventListener?.("change", off);
    return () => {
      off();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("blur", off);
      document.removeEventListener("mouseleave", off);
      root.removeEventListener("mouseout", out);
      fine.removeEventListener?.("change", off);
      reduce.removeEventListener?.("change", off);
    };
  }, []);

  return (
    <div ref={ref} className="ddg-crosshair" aria-hidden="true" data-active="false" data-testid="ddg-crosshair">
      <i className="ddg-axis-x" />
      <i className="ddg-axis-y" />
      <i className="ddg-center" />
      <span ref={label} />
    </div>
  );
}
