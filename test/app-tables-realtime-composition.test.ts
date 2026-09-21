// SPDX-License-Identifier: AGPL-3.0
// APP-02 tables-realtime composition (issue #160, remainder 2026-09-21):
// the browser runtime subscription is rewired from tableRevision polling to
// the ADR 045 changes feed shape (table-bound sync tokens, per-poll grant
// re-resolution) with SEC-01 scrub egress (#578). One composed worker-level
// proof against real workerd/D1: token-scoped poll with exactly-once
// resume, hidden-reference 404s, revocation mid-subscription, and scrubbed
// rows with D1 truth preserved. No new primitive, no DDL, no push
// transport. Fixture sentinel only, matching the vitest miniflare
// NINJA_CLIENT_SECRET binding.
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { SCRUB_PLACEHOLDER } from "../src/secrets";
import { useWorkflowHarness } from "./helpers/workflow-harness";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const ORG = "00000000-0000-4000-8000-000000000001";
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
    { ...bindings, LAB_ORG_ID: ORG },
  );
}

async function createApp(name = "storefront", slug = "storefront") {
  const response = await call("/api/apps", "POST", { name, slug });
  expect(response.status).toBe(201);
  return ((await response.json()) as { app: { id: string } }).app.id as string;
}

async function grant(appId: string, kind: string, ref: string, permission: string) {
  const response = await call(`/api/apps/${appId}/grants`, "POST", { kind, ref, permission });
  expect(response.status).toBe(201);
  return ((await response.json()) as { grant: { id: string } }).grant;
}

async function declareTable(appId: string, name: string, visibility: "visible" | "hidden" = "visible") {
  const response = await call(`/api/apps/${appId}/tables`, "POST", { name, visibility });
  expect(response.status).toBe(201);
}

async function insertRow(appId: string, table: string, data: Record<string, unknown>) {
  const response = await call(`/api/apps/${appId}/runtime/tables/${table}/rows`, "POST", { data });
  expect(response.status).toBe(201);
  return ((await response.json()) as { row: { id: string } }).row;
}

interface Feed {
  readonly changes: { readonly id: string; readonly change: string }[];
  readonly hasMore: boolean;
  readonly syncToken: string | null;
  readonly tableRevision: number;
}

async function poll(appId: string, table: string, query: string) {
  return call(`/api/apps/${appId}/runtime/tables/${table}/changes${query}`);
}

useWorkflowHarness(bindings.DB);

it("composes token-scoped poll, hidden-ref 404s, mid-subscription revocation, and scrubbed rows", async () => {
  const appId = await createApp();
  await declareTable(appId, "orders");
  await declareTable(appId, "vault", "hidden");
  await declareTable(appId, "other");
  await grant(appId, "table", "orders", "read");
  await grant(appId, "table", "orders", "write");
  // Hidden and unknown refs carry read grants so the 404 proves
  // non-disclosure, not a missing grant row.
  await grant(appId, "table", "vault", "read");
  await grant(appId, "table", "nope", "read");
  await grant(appId, "table", "other", "read");
  await grant(appId, "table", "other", "write");

  // Hidden-reference 404s: the grant exists, yet the hidden table and the
  // unknown name answer like a missing table — never a leak, even to a
  // well-formed poll. An ungranted table answers 403 instead.
  for (const table of ["vault", "nope"]) {
    const denied = await poll(appId, table, "?since=1970-01-01T00:00:00.000Z");
    expect(denied.status).toBe(404);
    expect(await denied.json()).toMatchObject({ error: { code: "APP_TABLE_NOT_FOUND" } });
  }
  await declareTable(appId, "closed");
  const closed = await poll(appId, "closed", "?since=1970-01-01T00:00:00.000Z");
  expect(closed.status).toBe(403);
  expect(await closed.json()).toMatchObject({ error: { code: "APP_TABLE_FORBIDDEN" } });

  // Token-scoped poll: seed, subscribe, confirm the resume position is
  // quiet before anything new lands.
  const seed = await insertRow(appId, "orders", { status: "open" });
  const subscribed = await poll(appId, "orders", "?since=1970-01-01T00:00:00.000Z");
  expect(subscribed.status).toBe(200);
  const subscribedBody = (await subscribed.json()) as Feed;
  expect(subscribedBody.changes.map((change) => change.id)).toEqual([seed.id]);
  expect(subscribedBody.changes.every((change) => change.change === "upsert")).toBe(true);
  expect(subscribedBody.hasMore).toBe(false);
  const cursor = subscribedBody.syncToken;
  expect(typeof cursor).toBe("string");
  const quiet = (await (
    await poll(appId, "orders", `?sync_token=${encodeURIComponent(cursor as string)}`)
  ).json()) as Feed;
  expect(quiet.changes).toEqual([]);

  // A secret-carrying write lands after the cursor was issued: the next
  // resume poll delivers it exactly once, scrubbed, and advances the
  // cursor past it.
  const planted = { callback: `https://vendor.invalid/hook?secret=${SECRET}&next=/` };
  const leaked = await insertRow(appId, "orders", planted);
  const resumed = await poll(appId, "orders", `?sync_token=${encodeURIComponent(cursor as string)}`);
  expect(resumed.status).toBe(200);
  const resumedText = await resumed.text();
  expect(resumedText).not.toContain(SECRET);
  expect(resumedText).toContain(SCRUB_PLACEHOLDER);
  const resumedBody = JSON.parse(resumedText) as Feed;
  expect(resumedBody.changes.map((change) => change.id)).toEqual([leaked.id]);
  expect(resumedBody.changes.every((change) => change.change === "upsert")).toBe(true);
  expect(resumedBody.syncToken).not.toBe(cursor);
  const settled = (await (
    await poll(appId, "orders", `?sync_token=${encodeURIComponent(resumedBody.syncToken as string)}`)
  ).json()) as Feed;
  expect(settled.changes).toEqual([]);

  // Table-bound tokens: a cursor minted for "other" fails closed on
  // "orders" instead of silently filtering the wrong row set — as does a
  // garbage token. The caller re-lists and resubscribes.
  const foreignRow = await insertRow(appId, "other", { status: "foreign" });
  const foreign = (await (await poll(appId, "other", "?since=1970-01-01T00:00:00.000Z")).json()) as Feed;
  expect(typeof foreign.syncToken).toBe("string");
  const cross = await poll(appId, "orders", `?sync_token=${encodeURIComponent(foreign.syncToken as string)}`);
  expect(cross.status).toBe(400);
  expect(await cross.json()).toMatchObject({ error: { code: "RESYNC_REQUIRED" } });
  const garbage = await poll(appId, "orders", "?sync_token=!!!");
  expect(garbage.status).toBe(400);
  expect(await garbage.json()).toMatchObject({ error: { code: "RESYNC_REQUIRED" } });
  // Quiet-page tokens bind too: a cursor minted by subscribing to an empty
  // table carries that table's instance id, so replaying it against
  // "orders" fails closed instead of silently subscribing.
  await declareTable(appId, "hushed");
  await grant(appId, "table", "hushed", "read");
  await grant(appId, "table", "hushed", "write");
  const hushed = (await (await poll(appId, "hushed", "?since=1970-01-01T00:00:00.000Z")).json()) as Feed;
  expect(hushed.changes).toEqual([]);
  expect(typeof hushed.syncToken).toBe("string");
  const hushedCross = await poll(appId, "orders", `?sync_token=${encodeURIComponent(hushed.syncToken as string)}`);
  expect(hushedCross.status).toBe(400);
  expect(await hushedCross.json()).toMatchObject({ error: { code: "RESYNC_REQUIRED" } });

  // Bare polls (no since/token): a table with rows answers the full window
  // with a bound token; an empty table answers quiet with a null token —
  // nothing exists to resume from yet.
  const bare = (await (await poll(appId, "other", "")).json()) as Feed;
  expect(bare.changes.map((change) => change.id)).toEqual([foreignRow.id]);
  expect(typeof bare.syncToken).toBe("string");
  const bareEmpty = (await (await poll(appId, "hushed", "")).json()) as Feed;
  expect(bareEmpty.changes).toEqual([]);
  expect(bareEmpty.syncToken).toBeNull();

  // Monotonic stamps: a row planted with a future updated_at forces the
  // next write past it (max+1ms), so the (updated_at, id) cursor still
  // surfaces the late write in commit order instead of missing it.
  const hushedTable = await bindings.DB.prepare("SELECT id FROM app_tables WHERE app_id=? AND name=?")
    .bind(appId, "hushed")
    .first<{ id: string }>();
  const stamp = new Date().toISOString();
  await bindings.DB.prepare(
    "INSERT INTO app_rows(id, table_id, app_id, org_id, data_json, table_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      crypto.randomUUID(),
      hushedTable?.id ?? "",
      appId,
      ORG,
      '{"v":"planted"}',
      0,
      stamp,
      "2999-01-01T00:00:00.000Z",
    )
    .run();
  const bumped = await insertRow(appId, "hushed", { v: "late" });
  const bumpedFeed = (await (await poll(appId, "hushed", "?since=1970-01-01T00:00:00.000Z")).json()) as {
    changes: { id: string; updatedAt: string }[];
  };
  const bumpedRow = bumpedFeed.changes.find((change) => change.id === bumped.id);
  // Same-shape ISO instants compare lexicographically: the late write was
  // stamped past the planted future peak (max+1ms).
  expect((bumpedRow?.updatedAt ?? "") > "2999-01-01T00:00:00.000Z").toBe(true);

  // Corrupt-stamp guard: an unparseable max(updated_at) falls back to now
  // instead of poisoning the write — the feed keeps serving.
  const otherTable = await bindings.DB.prepare("SELECT id FROM app_tables WHERE app_id=? AND name=?")
    .bind(appId, "other")
    .first<{ id: string }>();
  await bindings.DB.prepare(
    "INSERT INTO app_rows(id, table_id, app_id, org_id, data_json, table_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(crypto.randomUUID(), otherTable?.id ?? "", appId, ORG, '{"v":"corrupt"}', 0, stamp, "not-a-date")
    .run();
  await insertRow(appId, "other", { v: "after-corrupt" });
  const corruptFeed = await poll(appId, "other", "?since=1970-01-01T00:00:00.000Z");
  expect(corruptFeed.status).toBe(200);

  // Revocation mid-subscription: the grant enforced on every poll denies
  // the very next resume on the previously valid cursor — no snapshot
  // survives across polls.
  const listed = (await (await call(`/api/apps/${appId}/grants`)).json()) as {
    grants: { id: string; ref: string; permission: string }[];
  };
  const readGrantId = listed.grants.find((entry) => entry.ref === "orders" && entry.permission === "read")?.id;
  expect(typeof readGrantId).toBe("string");
  const revoked = await call(`/api/apps/${appId}/grants/${readGrantId}/revoke`, "POST");
  expect(revoked.status).toBe(200);
  const afterRevoke = await poll(appId, "orders", `?sync_token=${encodeURIComponent(resumedBody.syncToken as string)}`);
  expect(afterRevoke.status).toBe(403);
  expect(await afterRevoke.json()).toMatchObject({ error: { code: "APP_TABLE_FORBIDDEN" } });

  // D1 still holds the author bytes: scrub is egress-only, truth preserved.
  const stored = await bindings.DB.prepare("SELECT data_json FROM app_rows WHERE id=?")
    .bind(leaked.id)
    .first<{ data_json: string }>();
  expect(stored?.data_json ?? "").toContain(SECRET);
});
