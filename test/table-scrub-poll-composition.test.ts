// SPDX-License-Identifier: AGPL-3.0
// TABLE-02 composition verification (issue #154; ADR 045 realtime poll plus
// ADR 046 SEC-01 read-time scrub): a secret-carrying row written AFTER a
// realtime poll cursor is established must arrive on the next resume poll
// scrubbed — exactly once, with cursor semantics intact. This exercises the
// single composed path (bounded-poll scan plus route-egress scrub); it adds
// no code path, no DDL, and no primitive. Fixture sentinel only, matching
// the vitest miniflare NINJA_CLIENT_SECRET binding.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration7 from "../migrations/0007_org_membership.sql?raw";
import migration8 from "../migrations/0008_executions_org_fk.sql?raw";
import migration9 from "../migrations/0009_tables.sql?raw";
import { SCRUB_PLACEHOLDER } from "../src/secrets";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const ORG = "00000000-0000-4000-8000-000000000001";
const OWNER = "00000000-0000-4000-8000-000000000002";
// Must equal the vitest miniflare NINJA_CLIENT_SECRET binding so the Worker
// HTTP isolate scrubs it via deploymentSecretsFromEnv.
const SECRET = "test-client-secret-sentinel";

function call(path: string, method = "GET", body?: unknown) {
  return worker.fetch(
    new Request(`https://local.test${path}`, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { ...bindings, LAB_ORG_ID: ORG, LAB_USER_ID: OWNER },
  );
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration7);
  await bindings.DB.exec(migration8);
  await bindings.DB.exec(migration9);
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?)").bind(ORG, "Local demo").run();
});

afterEach(async () => {
  await reset();
});

it("scrubs a secret-carrying write arriving under an active realtime poll", async () => {
  expect((await call("/api/tables", "POST", { name: "composed" })).status).toBe(201);
  expect((await call("/api/tables/composed/rows/seed", "PUT", { data: { v: "seed" } })).status).toBe(201);

  // Establish a poll cursor, then confirm the resume position is quiet.
  const subscribed = (await (await call("/api/tables/composed/changes?since=1970-01-01T00:00:00.000Z")).json()) as {
    changes: { id: string }[];
    hasMore: boolean;
    syncToken: string;
  };
  expect(subscribed.changes.map((change) => change.id)).toEqual(["seed"]);
  const cursor = subscribed.syncToken;
  expect(typeof cursor).toBe("string");
  const quiet = (await (
    await call(`/api/tables/composed/changes?sync_token=${encodeURIComponent(cursor)}`)
  ).json()) as { changes: unknown[]; hasMore: boolean; syncToken: string };
  expect(quiet.changes).toEqual([]);

  // A secret-carrying write lands after the cursor was issued.
  const planted = { callback: `https://vendor.invalid/hook?secret=${SECRET}&next=/` };
  expect((await call("/api/tables/composed/rows/leak", "PUT", { data: planted })).status).toBe(201);

  // The next resume poll delivers the planted row exactly once, scrubbed,
  // and advances the cursor past it.
  const resumed = await call(`/api/tables/composed/changes?sync_token=${encodeURIComponent(cursor)}`);
  expect(resumed.status).toBe(200);
  const resumedText = await resumed.text();
  expect(resumedText).not.toContain(SECRET);
  expect(resumedText).toContain(SCRUB_PLACEHOLDER);
  const resumedBody = JSON.parse(resumedText) as {
    changes: { id: string; change: string }[];
    hasMore: boolean;
    syncToken: string;
  };
  expect(resumedBody.changes.map((change) => change.id)).toEqual(["leak"]);
  expect(resumedBody.changes.every((change) => change.change === "upsert")).toBe(true);
  expect(resumedBody.syncToken).not.toBe(cursor);

  // Resuming on the advanced cursor is quiet again: exactly-once delivery.
  const settled = (await (
    await call(`/api/tables/composed/changes?sync_token=${encodeURIComponent(resumedBody.syncToken)}`)
  ).json()) as { changes: unknown[] };
  expect(settled.changes).toEqual([]);

  // D1 still holds the author bytes: scrub is egress-only, truth preserved.
  const stored = await bindings.DB.prepare("SELECT data_json FROM table_rows WHERE doc_id=?")
    .bind("leak")
    .first<{ data_json: string }>();
  expect(stored?.data_json ?? "").toContain(SECRET);
});
