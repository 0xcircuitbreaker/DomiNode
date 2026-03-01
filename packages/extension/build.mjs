import { build } from "esbuild";
import { cpSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const browser = process.env.BROWSER_TARGET || "chrome";
const outdir = resolve(__dirname, `dist/${browser}`);
const isProd = process.env.NODE_ENV === "production";

// Warn if building without NODE_ENV=production to prevent sourcemap leakage
if (!isProd) {
  console.warn("⚠ WARNING: Building in development mode (sourcemaps enabled).");
  console.warn("  For release builds, set NODE_ENV=production");
}

async function main() {
  // Build background + content scripts
  await build({
    entryPoints: {
      background: resolve(__dirname, "src/background/index.ts"),
      "content/webrtc-block": resolve(__dirname, "src/content/webrtc-block.ts"),
    },
    bundle: true,
    outdir,
    format: "esm",
    target: "es2022",
    minify: isProd,
    sourcemap: !isProd,
  });

  // Build popup + options (Preact JSX)
  await build({
    entryPoints: {
      "popup/popup": resolve(__dirname, "src/popup/index.tsx"),
      "options/options": resolve(__dirname, "src/options/index.tsx"),
    },
    bundle: true,
    outdir,
    format: "esm",
    target: "es2022",
    minify: isProd,
    sourcemap: !isProd,
    jsx: "automatic",
    jsxImportSource: "preact",
  });

  // Copy manifest
  mkdirSync(outdir, { recursive: true });
  cpSync(
    resolve(__dirname, `manifests/${browser}.json`),
    resolve(outdir, "manifest.json"),
  );

  // Copy HTML files
  mkdirSync(resolve(outdir, "popup"), { recursive: true });
  mkdirSync(resolve(outdir, "options"), { recursive: true });
  mkdirSync(resolve(outdir, "icons"), { recursive: true });

  cpSync(
    resolve(__dirname, "src/popup/index.html"),
    resolve(outdir, "popup/index.html"),
  );
  cpSync(
    resolve(__dirname, "src/options/index.html"),
    resolve(outdir, "options/index.html"),
  );

  // Copy shared CSS
  cpSync(
    resolve(__dirname, "src/ui/styles.css"),
    resolve(outdir, "styles.css"),
  );

  // Copy icon assets
  for (const size of [16, 48, 128]) {
    cpSync(
      resolve(__dirname, `src/assets/icons/icon-${size}.png`),
      resolve(outdir, `icons/icon-${size}.png`),
    );
  }

  console.log(`Built for ${browser} -> ${outdir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
