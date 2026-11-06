// ESLint 9 flat config for the TypeScript workspace packages.
// CommonJS because the root package.json is not "type": "module".
const js = require("@eslint/js");
const globals = require("globals");
const tseslint = require("typescript-eslint");
const reactHooks = require("eslint-plugin-react-hooks");

module.exports = tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/*.d.ts",
      "**/__fixtures__/**",
      "**/fixtures/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["packages/*/src/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
    linterOptions: { reportUnusedDisableDirectives: "warn" },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
          ignoreRestSiblings: true,
        },
      ],
      // Pervasive in request/DB plumbing; strict tsc already guards types.
      "@typescript-eslint/no-explicit-any": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Security validators intentionally match control characters.
      "no-control-regex": "off",
    },
  },
  {
    files: ["packages/{frontend,extension}/src/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser, chrome: "readonly" } },
  },
  {
    files: ["packages/frontend/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["**/*.test.{ts,tsx}", "**/__tests__/**", "**/tests/**"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
