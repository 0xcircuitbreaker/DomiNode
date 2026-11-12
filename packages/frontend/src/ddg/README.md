# DDG design system

Shared look for Daedalus Development Group sites, ported from jacode.io (no hotlinking, no inline scripts: everything ships in the bundle, so a strict `script-src 'self'` CSP holds).

## Files

| File | What |
|---|---|
| `tokens.ts` | Palette, fonts, grain constants (also mirrored as CSS vars in `ddg.css` and Tailwind `ddg-*` colours) |
| `ddg.css` | CSS variables, grain/crosshair styles, gold `:focus-visible`, `.ddg-label` (mono uppercase tracking label) |
| `GrainCanvas.tsx` | Fixed full-screen noise canvas: grey noise, alpha 80, redrawn every 100 ms, `mix-blend-mode: soft-light`, opacity .15 (prop), pointer-events none. Paused when the tab is hidden or `prefers-reduced-motion`; listeners and timer removed on unmount |
| `Crosshair.tsx` | Cursor replacement: 13 px gold cross, faint full-viewport axes (`#d4a8533d`), mono X/Y readout. Only for `(pointer: fine)` and no reduced motion. Hides the native cursor via `html[data-ddg-cursor="on"]` only while active; restored on leave, blur, touch, media change or unmount |
| `DdgEffects.tsx` | Mounts both; `grainOpacity` lets admin consoles tone the grain down |

## Palette

| Token | Hex |
|---|---|
| cosmic-navy | `#1A1A2E` |
| cosmic-deep | `#0A101F` |
| cosmic-surface | `#111827` |
| gold | `#d4a853` |
| gold-light | `#f0c674` |
| text-primary | `#f1f5f9` |
| text-secondary | `#94a3b8` |
| text-muted | `#8b9ab0` |

Fonts: Inter (UI), JetBrains Mono (code, labels), with system fallbacks. Self-host the woff2 files under `/fonts` if you want exact glyphs (`font-src 'self'`). Style: square corners, 1 px borders (`border-white/10`), mono uppercase labels, gold accents.

## Use in another site

1. Copy this folder. `import "./ddg/ddg.css"` once.
2. Add the Tailwind colours from `tokens.ts` (`theme.extend.colors.ddg`) and set `fontFamily.sans`/`mono` from `DDG_FONTS`.
3. Wrap the layout in `className="ddg"` and render `<DdgEffects />` once (`<DdgEffects grainOpacity={0.06} />` for dense admin UIs).
