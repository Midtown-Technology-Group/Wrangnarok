import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        r2Buckets: ["ARTIFACTS"],
        bindings: {
          LAB_ENABLED: "true",
          LAB_TOKEN: "a".repeat(64),
          LAB_ORG_ID: "00000000-0000-4000-8000-000000000001",
          LAB_USER_ID: "00000000-0000-4000-8000-000000000002",
          NINJA_CLIENT_ID: "test-client-id",
          NINJA_CLIENT_SECRET: "test-client-secret-sentinel",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "lcov", "json"],
      include: ["src/**/*.ts"],
      exclude: ["test/**", "client/**", "**/*.d.ts", ".opencode/**", "scripts/**"],
      // Coverage habit: every metric stays at or above 95%. Vitest exits
      // non-zero below any threshold, so both local runs and the CI runtime
      // gate fail closed on regressions.
      thresholds: { lines: 95, functions: 95, branches: 95, statements: 95 },
    },
  },
});
