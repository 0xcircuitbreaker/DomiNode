import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { DEFAULT_ORIGIN, rewriteOrigin, writeDiscovery } from "./discovery/generate.mjs";

function publicOrigin(raw: string | undefined): string {
  if (!raw) return DEFAULT_ORIGIN;
  const u = new URL(raw); // throws on a malformed VITE_PUBLIC_ORIGIN: fail the build, not the site
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("VITE_PUBLIC_ORIGIN must be http(s)");
  return (u.origin + u.pathname).replace(/\/+$/, "");
}

/**
 * Public-site discovery: rewrites canonical/OG URLs in index.html and regenerates
 * llms.txt, llms-full.txt, robots.txt, sitemap.xml, docs/*.md and
 * .well-known/mcp/server.json in the output dir for VITE_PUBLIC_ORIGIN.
 */
function discovery(origin: string): Plugin {
  let outDir = "dist";
  return {
    name: "dominusnode-discovery",
    configResolved(c) {
      outDir = path.resolve(c.root, c.build.outDir);
    },
    transformIndexHtml(html) {
      return rewriteOrigin(html, origin);
    },
    writeBundle() {
      writeDiscovery(outDir, origin);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const origin = publicOrigin(env["VITE_PUBLIC_ORIGIN"]);
  return {
    plugins: [react(), discovery(origin)],
    build: {
      // Explicitly disable source maps in production to prevent source code exposure
      sourcemap: false,
    },
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: "http://localhost:3000",
          changeOrigin: true,
        },
      },
    },
  };
});
