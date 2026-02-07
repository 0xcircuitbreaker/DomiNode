import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["packages/*/src/**/*.test.ts"],
    exclude: ["packages/frontend/**", "**/node_modules/**", "**/dist/**"],
    environment: "node",
    env: {
      JWT_SECRET: "test-secret-key-that-is-at-least-32-characters-long-for-testing",
      PACKETSTREAM_USERNAME: "testuser",
      PACKETSTREAM_PASSWORD: "testpass",
      PACKETSTREAM_GATEWAY_HOST: "gw.test.io",
      PACKETSTREAM_GATEWAY_PORT: "31112",
      LOG_LEVEL: "error",
    },
    coverage: {
      provider: "v8",
      include: [
        "packages/shared/src/**/*.ts",
        "packages/metering/src/**/*.ts",
        "packages/pool-manager/src/**/*.ts",
        "packages/billing/src/**/*.ts",
        "packages/proxy-gateway/src/**/*.ts",
      ],
      exclude: [
        "**/*.test.ts",
        "**/index.ts",
        "**/main.ts",
        "**/migrate.ts",
        "**/dist/**",
        "packages/shared/src/db.ts",
        "packages/shared/src/logger.ts",
        "packages/proxy-gateway/src/server.ts",
        "packages/proxy-gateway/src/socks5.ts",
      ],
    },
  },
});
