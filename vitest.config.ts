import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
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
    // Two projects, disjoint file sets (issue #249): the existing workerd
    // suite plus one Node-based production-harness file. `npm test` and
    // `npm run test:coverage` run both; explicit file filters route each
    // file to its owning project.
    projects: [
      {
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
          name: "workers",
          include: ["test/**/*.test.{ts,tsx}"],
          exclude: ["test/production-harness.test.ts"],
          // Unhandled-rejection guard (issues #332/#333): records every rejection
          // escaping a test with an explicit allowlist for asserted stress paths
          // and a HARD-FAIL marker for anything unexpected. See the header comment
          // in test/setup-unhandled-guard.ts before broadening the allowlist.
          setupFiles: ["./test/setup-unhandled-guard.ts"],
        },
      },
      {
        // Production-build harness (issue #249): boots wrangler.jsonc via
        // createTestHarness() from plain Node. Must NOT inherit the workerd
        // plugin or the unhandled-guard setup — both are workerd-only. Raised
        // timeouts are CI headroom for the production build + D1 migrations
        // (locally ~3s; shared runners spike).
        test: {
          name: "harness",
          include: ["test/production-harness.test.ts"],
          environment: "node",
          hookTimeout: 60000,
          testTimeout: 30000,
        },
      },
    ],
  },
});
