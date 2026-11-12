/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["selector", "[data-theme=\"dark\"]"],
  theme: {
    extend: {
      screens: {
        xs: "375px",
      },
      // DDG palette (src/ddg/tokens.ts).
      colors: {
        ddg: {
          navy: "#1A1A2E",
          deep: "#0A101F",
          surface: "#111827",
          gold: "#d4a853",
          "gold-light": "#f0c674",
          text: "#f1f5f9",
          "text-2": "#94a3b8",
          muted: "#8b9ab0",
        },
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "Cascadia Code", "Menlo", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
