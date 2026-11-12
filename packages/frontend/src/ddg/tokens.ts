/**
 * DDG (Daedalus Development Group) design tokens, ported from jacode.io.
 * Copy this folder into any DDG site; see README.md.
 */
export const DDG_COLORS = {
  "cosmic-navy": "#1A1A2E",
  "cosmic-deep": "#0A101F",
  "cosmic-surface": "#111827",
  gold: "#d4a853",
  "gold-light": "#f0c674",
  "text-primary": "#f1f5f9",
  "text-secondary": "#94a3b8",
  "text-muted": "#8b9ab0",
} as const;

/** Faint axis-line colour of the crosshair (gold at ~24% alpha). */
export const DDG_AXIS = "#d4a8533d";

export const DDG_FONTS = {
  sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
  mono: ["JetBrains Mono", "ui-monospace", "Cascadia Code", "Menlo", "Consolas", "monospace"],
};

/** Grain defaults (jacode.io): alpha per pixel, redraw period, layer opacity. */
export const GRAIN = { alpha: 80, intervalMs: 100, opacity: 0.15 } as const;
