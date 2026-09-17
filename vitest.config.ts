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
          CLOUDFLARE_API_TOKEN: "test-cloudflare-token-sentinel",
          SECRETS_KEK: "test-secrets-kek-sentinel-fixture-only",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    // Unhandled-rejection guard (issues #332/#333): records every rejection
    // escaping a test with an explicit allowlist for asserted stress paths
    // and a HARD-FAIL marker for anything unexpected. See the header comment
    // in test/setup-unhandled-guard.ts before broadening the allowlist.
    setupFiles: ["./test/setup-unhandled-guard.ts"],
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
