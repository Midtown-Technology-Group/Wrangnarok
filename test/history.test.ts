// SPDX-License-Identifier: AGPL-3.0
// Phase 2 (issue #76): ExecutionHistory querying — status/sagaId filters plus
// cursor pagination over org-scoped summaries. Runs in real workerd with a
// real D1 binding; rows are inserted directly to control order and status.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { echoSaga, executionId, ninjaSaga } from "../src/domain";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import seed from "../scripts/seed-local.sql?raw";
const bindings = env as unknown as Bindings;
const principal = { orgId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" };
const auth = { Authorization: `Bearer ${"a".repeat(64)}` };
// Five rows, oldest first: mixed statuses and sagas, distinct timestamps so
// (created_at DESC, id DESC) order is total.
const ROWS = [
  { key: "history-row-0001", sagaId: echoSaga.id, status: "Succeeded", createdAt: "2026-09-01T00:00:00.000Z" },
  { key: "history-row-0002", sagaId: echoSaga.id, status: "Failed", createdAt: "2026-09-02T00:00:00.000Z" },
  { key: "history-row-0003", sagaId: ninjaSaga.id, status: "Succeeded", createdAt: "2026-09-03T00:00:00.000Z" },
  { key: "history-row-0004", sagaId: echoSaga.id, status: "Running", createdAt: "2026-09-04T00:00:00.000Z" },
  { key: "history-row-0005", sagaId: ninjaSaga.id, status: "Failed", createdAt: "2026-09-05T00:00:00.000Z" },
] as const;
const ids = new Map<string, string>();
function listRequest(query = "") {
  return new Request(`https://local.test/api/executions${query}`, { method: "GET", headers: { ...auth } });
}
async function listBody(query = "") {
  const response = await worker.fetch(listRequest(query), bindings);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
beforeEach(async () => {
  // Real local D1 SQL statements, not an in-memory repository double.
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(seed);
  ids.clear();
  for (const row of ROWS) {
    const id = await executionId(principal, row.key);
    ids.set(row.key, id);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        id,
        row.sagaId,
        "historyprobe",
        "historyprobe-v1",
        principal.orgId,
        principal.userId,
        JSON.stringify({ message: "seed" }),
        1,
        row.status,
        row.createdAt,
      )
      .run();
  }
});
afterEach(async () => {
  await reset();
});
function executionIds(body: Record<string, unknown>): string[] {
  return ((body.executions ?? []) as { executionId: string }[]).map((row) => row.executionId);
}
it("lists history newest-first with hasMore and a null cursor when complete", async () => {
  const { status, body } = await listBody();
  expect(status).toBe(200);
  expect(executionIds(body)).toEqual([
    ids.get("history-row-0005"),
    ids.get("history-row-0004"),
    ids.get("history-row-0003"),
    ids.get("history-row-0002"),
    ids.get("history-row-0001"),
  ]);
  expect(body.hasMore).toBe(false);
  expect(body.nextCursor).toBeNull();
  // Summaries only: input/result never ride the list.
  expect(JSON.stringify(body)).not.toContain("seed");
});
it("filters by status", async () => {
  const failed = await listBody("?status=Failed");
  expect(failed.status).toBe(200);
  expect(executionIds(failed.body)).toEqual([ids.get("history-row-0005"), ids.get("history-row-0002")]);
  const succeeded = await listBody("?status=Succeeded");
  expect(executionIds(succeeded.body)).toEqual([ids.get("history-row-0003"), ids.get("history-row-0001")]);
  const running = await listBody("?status=Running");
  expect(executionIds(running.body)).toEqual([ids.get("history-row-0004")]);
});
it("filters by multi-status, saga name, and date bounds", async () => {
  const multi = await listBody("?status=Failed,Running");
  expect(multi.status).toBe(200);
  expect(executionIds(multi.body)).toEqual([
    ids.get("history-row-0005"),
    ids.get("history-row-0004"),
    ids.get("history-row-0002"),
  ]);
  const named = await listBody("?sagaName=historyprobe");
  expect(named.status).toBe(200);
  expect(executionIds(named.body)).toHaveLength(5);
  const unknownName = await listBody("?sagaName=no-such-saga");
  expect(unknownName.status).toBe(200);
  expect(executionIds(unknownName.body)).toEqual([]);
  const window = await listBody("?startDate=2026-09-02&endDate=2026-09-04");
  expect(window.status).toBe(200);
  expect(executionIds(window.body)).toEqual([
    ids.get("history-row-0004"),
    ids.get("history-row-0003"),
    ids.get("history-row-0002"),
  ]);
  const combined = await listBody("?status=Succeeded&startDate=2026-09-03");
  expect(executionIds(combined.body)).toEqual([ids.get("history-row-0003")]);
  // Cursor traversal preserves filters: the second page continues the same query.
  const first = await listBody("?status=Succeeded,Failed&limit=2");
  expect(executionIds(first.body)).toEqual([ids.get("history-row-0005"), ids.get("history-row-0003")]);
  const second = await listBody(
    `?status=Succeeded,Failed&limit=2&cursor=${encodeURIComponent(first.body.nextCursor as string)}`,
  );
  expect(executionIds(second.body)).toEqual([ids.get("history-row-0002"), ids.get("history-row-0001")]);
  expect(second.body.hasMore).toBe(false);
});
it("filters by saga and combines both filters", async () => {
  const ninja = await listBody(`?sagaId=${ninjaSaga.id}`);
  expect(ninja.status).toBe(200);
  expect(executionIds(ninja.body)).toEqual([ids.get("history-row-0005"), ids.get("history-row-0003")]);
  const combined = await listBody(`?status=Failed&sagaId=${echoSaga.id}`);
  expect(executionIds(combined.body)).toEqual([ids.get("history-row-0002")]);
  // Well-formed but unknown Saga IDs return an empty page, never a leak.
  const unknown = await listBody("?sagaId=aaaaaaaa-1111-4111-8111-111111111111");
  expect(unknown.status).toBe(200);
  expect(executionIds(unknown.body)).toEqual([]);
  expect(unknown.body.hasMore).toBe(false);
});
it("paginates with limit plus opaque cursors and no overlap", async () => {
  const first = await listBody("?limit=2");
  expect(first.status).toBe(200);
  expect(executionIds(first.body)).toEqual([ids.get("history-row-0005"), ids.get("history-row-0004")]);
  expect(first.body.hasMore).toBe(true);
  expect(typeof first.body.nextCursor).toBe("string");
  // The cursor is opaque to clients: it carries no readable row content.
  expect(String(first.body.nextCursor)).not.toContain("history-row");
  const second = await listBody(`?limit=2&cursor=${encodeURIComponent(first.body.nextCursor as string)}`);
  expect(executionIds(second.body)).toEqual([ids.get("history-row-0003"), ids.get("history-row-0002")]);
  expect(second.body.hasMore).toBe(true);
  const third = await listBody(`?limit=2&cursor=${encodeURIComponent(second.body.nextCursor as string)}`);
  expect(executionIds(third.body)).toEqual([ids.get("history-row-0001")]);
  expect(third.body.hasMore).toBe(false);
  expect(third.body.nextCursor).toBeNull();
});
it("rejects bad filters with machine-readable codes", async () => {
  expect((await listBody("?status=Bogus")).status).toBe(400);
  expect(await (await worker.fetch(listRequest("?status=Bogus"), bindings)).json()).toMatchObject({
    error: { code: "INVALID_STATUS" },
  });
  expect(await (await worker.fetch(listRequest("?sagaId=not-a-uuid"), bindings)).json()).toMatchObject({
    error: { code: "INVALID_SAGA_ID" },
  });
  expect(await (await worker.fetch(listRequest("?sagaName="), bindings)).json()).toMatchObject({
    error: { code: "INVALID_SAGA_NAME" },
  });
  expect(await (await worker.fetch(listRequest("?startDate=nope"), bindings)).json()).toMatchObject({
    error: { code: "INVALID_START_DATE" },
  });
  expect(await (await worker.fetch(listRequest("?endDate=nope"), bindings)).json()).toMatchObject({
    error: { code: "INVALID_END_DATE" },
  });
  expect(
    await (await worker.fetch(listRequest("?startDate=2026-09-10&endDate=2026-09-01"), bindings)).json(),
  ).toMatchObject({
    error: { code: "INVALID_DATE_RANGE" },
  });
  for (const badLimit of ["0", "51", "abc", "-1"]) {
    expect(await (await worker.fetch(listRequest(`?limit=${badLimit}`), bindings)).json()).toMatchObject({
      error: { code: "INVALID_LIMIT" },
    });
  }
  expect(await (await worker.fetch(listRequest("?cursor=!!!"), bindings)).json()).toMatchObject({
    error: { code: "INVALID_CURSOR" },
  });
  // Unknown keys stay deny-by-default, even on the history route.
  expect(await (await worker.fetch(listRequest("?foo=1"), bindings)).json()).toMatchObject({
    error: { code: "UNSUPPORTED_QUERY" },
  });
});
it("still rejects query strings on every other route", async () => {
  const sagas = await worker.fetch(new Request("https://local.test/api/sagas?x=1", { headers: { ...auth } }), bindings);
  expect(sagas.status).toBe(400);
  expect(await sagas.json()).toMatchObject({ error: { code: "UNSUPPORTED_QUERY" } });
  const submit = await worker.fetch(
    new Request("https://local.test/api/executions?x=1", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "history-query-guard-001" },
      body: JSON.stringify({ sagaId: echoSaga.id, input: { message: "hello" } }),
    }),
    bindings,
  );
  expect(submit.status).toBe(400);
  expect(await submit.json()).toMatchObject({ error: { code: "UNSUPPORTED_QUERY" } });
});
