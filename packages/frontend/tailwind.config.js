/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["selector", "[data-theme=\"dark\"]"],
  theme: {
    extend: {
      screens: {
        xs: "375px",
      },
    },
  },
  plugins: [],
};
