// SPDX-License-Identifier: AGPL-3.0
// Production-build Worker smoke via createTestHarness() (issue #249).
//
// This file runs in the `harness` Vitest project (plain Node, never workerd):
// it boots the production-built Worker from wrangler.jsonc in a local harness
// server and exercises one real API route over HTTP. No src/* imports — the
// production bundle is the system under test, so assertions observe runtime
// and binding behavior (routing, LAB auth gate, D1 journal read), not a
// mocked Node handler.
//
// Credential-free and isolated by construction: LAB vars arrive as test-only
// `vars`/`secrets` overrides (fixture values, never .dev.vars), D1/R2/DO are
// the harness's ephemeral local storage, and nothing here contacts remote
// Cloudflare resources. `applyD1Migrations("DB")` applies the repo's own
// migrations_dir, so the version journal reflects the real schema chain.
//
// wrangler.jsonc serves ./client/dist as Static Assets and the harness fails
// closed when the directory is missing. /api/* routes run the Worker first,
// so an empty directory suffices for API-only coverage: beforeAll creates it
// when no `npm run build:ui` output is present (client/dist is gitignored,
// so this leaves no tracked residue either way).
//
// Explicitly out of scope: migrating existing suites onto this harness, and
// running the hostile/fake provider (#248) as a second Worker — that
// composition is future work, noted only.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestHarness } from "wrangler";

const TOKEN = "a".repeat(64);
const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";

const server = createTestHarness({
  workers: [
    {
      configPath: "./wrangler.jsonc",
      vars: { LAB_ENABLED: "true", LAB_ORG_ID: ORG_ID, LAB_USER_ID: USER_ID },
      secrets: { LAB_TOKEN: TOKEN },
    },
  ],
});

beforeAll(async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  mkdirSync(join(root, "client", "dist"), { recursive: true });
  await server.listen();
  await server.getWorker().applyD1Migrations("DB");
});

afterAll(async () => {
  await server.close();
});

test("serves GET /api/ops/version from the production Worker build", async () => {
  const response = await server.fetch("/api/ops/version", {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    version: {
      sdkVersion: string;
      sagaCatalog: { count: number; revision: string };
      migrationsApplied: string[];
    };
  };
  expect(body.version.sdkVersion).toBe("1");
  expect(body.version.sagaCatalog.count).toBeGreaterThan(0);
  expect(body.version.migrationsApplied.length).toBeGreaterThan(0);

  // The production auth gate holds too: no credential, no version payload.
  const denied = await server.fetch("/api/ops/version");
  expect(denied.status).toBe(401);
});
