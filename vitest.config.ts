import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["packages/*/src/**/*.test.ts", "packages/*/tests/**/*.test.ts"],
    exclude: ["packages/frontend/**", "packages/extension/**", "**/node_modules/**", "**/dist/**"],
    environment: "node",
    env: {
      JWT_SECRET: "test-secret-key-that-is-at-least-32-characters-long-for-testing",
      LOG_LEVEL: "error",
    },
    coverage: {
      provider: "v8",
      include: [
        "packages/shared/src/**/*.ts",
        "packages/metering/src/**/*.ts",
        "packages/billing/src/**/*.ts",
        "packages/proxy-gateway/src/**/*.ts",
        "packages/dashboard/src/**/*.ts",
        "packages/mcp-server/src/**/*.ts",
      ],
      exclude: [
        "**/*.test.ts",
        "**/index.ts",
        "**/main.ts",
        "**/migrate.ts",
        "**/dist/**",
        "packages/shared/src/db.ts",
        "packages/shared/src/logger.ts",
        "packages/proxy-gateway/src/socks5.ts",
      ],
    },
  },
});
