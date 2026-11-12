import { useEffect, useRef } from "react";
import { GRAIN } from "./tokens";

/**
 * Living grain: a fixed full-screen canvas of random grey noise, redrawn every
 * 100 ms and blended soft-light. Paused while the tab is hidden or the user
 * prefers reduced motion (one static frame is still drawn). Cleans up on unmount.
 */
export default function GrainCanvas({ opacity = GRAIN.opacity, intervalMs = GRAIN.intervalMs }: { opacity?: number; intervalMs?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || typeof window === "undefined") return;
    let ctx: CanvasRenderingContext2D | null = null;
    try { ctx = canvas.getContext("2d"); } catch { ctx = null; }
    if (!ctx) return;
    const c2d = ctx;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let img: ImageData | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;

    const draw = () => {
      if (!img) return;
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const v = (Math.random() * 256) | 0;
        d[i] = d[i + 1] = d[i + 2] = v;
        d[i + 3] = GRAIN.alpha;
      }
      c2d.putImageData(img, 0, 0);
    };
    const resize = () => {
      canvas.width = Math.max(1, window.innerWidth);
      canvas.height = Math.max(1, window.innerHeight);
      img = c2d.createImageData(canvas.width, canvas.height);
      draw();
    };
    const schedule = () => {
      clearInterval(timer);
      timer = undefined;
      if (!reduce?.matches && !document.hidden) timer = setInterval(draw, intervalMs);
    };

    resize();
    schedule();
    window.addEventListener("resize", resize, { passive: true });
    document.addEventListener("visibilitychange", schedule);
    reduce?.addEventListener?.("change", schedule);
    return () => {
      clearInterval(timer);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", schedule);
      reduce?.removeEventListener?.("change", schedule);
    };
  }, [intervalMs]);

  return <canvas ref={ref} className="ddg-grain" aria-hidden="true" style={{ opacity }} data-testid="ddg-grain" />;
}
