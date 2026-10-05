// SPDX-License-Identifier: AGPL-3.0
// SEC-01 planted-secret-never-renders (issue #576, ADR 046): table row
// payloads are author data scrubbed at read-time egress only. A row carrying
// the deployment-secret sentinel as nested substrings (URL, header-shaped
// value, object key) must never render through GET rows, single-row read,
// batch-write echoes, or the ADR 045 bounded-poll changes feed — while D1
// keeps the author bytes and clean rows pass through byte-identical
// (realtime behavior unchanged). Fixture sentinel only, matching the
// vitest miniflare NINJA_CLIENT_SECRET binding.
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

it("never renders a planted deployment secret on any row-payload surface", async () => {
  expect((await call("/api/tables", "POST", { name: "planted" })).status).toBe(201);
  // Value carriers only: document keys must match [a-zA-Z][a-zA-Z0-9_]*,
  // so the dashed sentinel can never be a key — substrings in URLs,
  // header-shaped values, and nested vendor text are the realistic shape.
  const planted = {
    callback: `https://vendor.invalid/hook?secret=${SECRET}&next=/`,
    headers: { Authorization: `Bearer ${SECRET}` },
    nested: { err: `vendor says ${SECRET}` },
  };
  // Single-row write echo redacts.
  const put = await call("/api/tables/planted/rows/leak", "PUT", { data: planted });
  expect(put.status).toBe(201);
  const putText = await put.text();
  expect(putText).not.toContain(SECRET);
  expect(putText).toContain(SCRUB_PLACEHOLDER);
  // Clean rows are unaffected.
  expect((await call("/api/tables/planted/rows/clean", "PUT", { data: { v: "clean" } })).status).toBe(201);

  // Single-row read redacts.
  const single = await (await call("/api/tables/planted/rows/leak")).text();
  expect(single).not.toContain(SECRET);
  expect(single).toContain(SCRUB_PLACEHOLDER);

  // GET rows redacts the planted row and passes the clean row through
  // byte-identical.
  const rows = (await (await call("/api/tables/planted/rows")).json()) as {
    rows: { id: string; data: Record<string, unknown> }[];
  };
  expect(JSON.stringify(rows)).not.toContain(SECRET);
  expect(rows.rows.find((row) => row.id === "clean")?.data).toEqual({ v: "clean" });
  const leaked = rows.rows.find((row) => row.id === "leak")?.data as Record<string, unknown>;
  expect(JSON.stringify(leaked)).toContain(SCRUB_PLACEHOLDER);

  // Batch-write echo redacts.
  const batch = await call("/api/tables/planted/rows/batch", "POST", {
    write_mode: "insert",
    items: [{ id: "batched", data: { err: `vendor says ${SECRET}` } }],
  });
  expect(batch.status).toBe(201);
  expect(await batch.text()).not.toContain(SECRET);

  // Bounded-poll feed redacts on subscribe (since) and on resume
  // (sync_token) with cursor semantics intact.
  const feed = await call("/api/tables/planted/changes?since=1970-01-01T00:00:00.000Z");
  expect(feed.status).toBe(200);
  const feedBody = (await feed.json()) as {
    changes: { id: string; data: Record<string, unknown>; change: string }[];
    hasMore: boolean;
    syncToken: string;
  };
  expect(JSON.stringify(feedBody)).not.toContain(SECRET);
  expect(feedBody.changes.every((change) => change.change === "upsert")).toBe(true);
  expect(feedBody.changes.map((change) => change.id).sort()).toEqual(["batched", "clean", "leak"]);
  const resumed = await call(`/api/tables/planted/changes?sync_token=${encodeURIComponent(feedBody.syncToken)}`);
  expect(resumed.status).toBe(200);
  const resumedBody = (await resumed.json()) as { changes: unknown[]; syncToken: string };
  expect(resumedBody.changes).toEqual([]);
  expect(typeof resumedBody.syncToken).toBe("string");

  // D1 still holds the author bytes: scrub is egress-only, truth preserved.
  const stored = await bindings.DB.prepare("SELECT data_json FROM table_rows WHERE doc_id=?")
    .bind("leak")
    .first<{ data_json: string }>();
  expect(stored?.data_json ?? "").toContain(SECRET);
});
