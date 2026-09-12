// SPDX-License-Identifier: AGPL-3.0
// Author Tables over D1 (TABLE-01 minimal slice, TABLE-02 query/count/batch;
// issues #117, #154): declarations, deny-by-absence per-action grants,
// policy-safe bounded queries, scoped counts, and all-or-denied batch
// mutations, proven against real local D1 in workerd. Applies the full
// migration chain (0001 + 0007 + 0008 + 0009) so the tables schema composes
// with the org-membership gate (AUTH-01): route tests run as the LAB
// fixture identity (OWNER bootstraps to admin of ORG in authenticate), and
// OTHER_USER holds an ordinary membership so table-grant denials read as
// table policy (403/404), never as org strangers (membership 404).
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { Fault } from "../src/domain";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration7 from "../migrations/0007_org_membership.sql?raw";
import migration8 from "../migrations/0008_executions_org_fk.sql?raw";
import migration9 from "../migrations/0009_tables.sql?raw";
import {
  lookupPath,
  parseBatchBody,
  parseDocument,
  parseTableQuery,
  TABLE_BATCH_MAX,
  TABLE_QUERY_ROW_CAP,
} from "../src/tables";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const ORG = "00000000-0000-4000-8000-000000000001";
const OWNER = "00000000-0000-4000-8000-000000000002";
const OTHER_USER = "00000000-0000-4000-8000-000000000003";
const OTHER_ORG = "00000000-0000-4000-8000-000000000009";

function headers(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
}

function call(path: string, method = "GET", body?: unknown, orgId = ORG, userId = OWNER) {
  return worker.fetch(
    new Request(`http://local.test${path}`, {
      method,
      headers: headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { ...bindings, LAB_ORG_ID: orgId, LAB_USER_ID: userId },
  );
}

async function createTable(name = "notes", orgId = ORG, userId = OWNER): Promise<void> {
  const response = await call("/api/tables", "POST", { name }, orgId, userId);
  expect(response.status).toBe(201);
}

function faultCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof Fault) return error.code;
    throw error;
  }
  throw new Error("expected a Fault");
}

async function putDoc(table: string, id: string, data: Record<string, unknown>) {
  return call(`/api/tables/${table}/rows/${id}`, "PUT", { data });
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration7);
  await bindings.DB.exec(migration8);
  await bindings.DB.exec(migration9);
  // AUTH-01 membership gate: the LAB fixture identity (OWNER) bootstraps to
  // admin of ORG inside authenticate on first use. OTHER_USER holds an
  // ordinary membership so table-grant denials prove table policy, not org
  // strangerhood. OTHER_ORG stays unknown: cross-org names answer 404.
  const stamp = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?)").bind(ORG, "Local demo").run();
  await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
    .bind(OTHER_USER, stamp)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(ORG, OTHER_USER, "member", "active", "ordinary", stamp, stamp)
    .run();
});

afterEach(async () => {
  await reset();
});

describe("TABLE-01 minimal slice: declarations and single-row CRUD", () => {
  it("creates, reads, lists, and deletes a table", async () => {
    const created = await call("/api/tables", "POST", { name: "notes" });
    expect(created.status).toBe(201);
    const table = ((await created.json()) as { table: { name: string; ownerUserId: string } }).table;
    expect(table.name).toBe("notes");
    expect(table.ownerUserId).toBe(OWNER);

    const detail = await call("/api/tables/notes");
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ table: { name: "notes" } });

    const listed = await call("/api/tables");
    expect(await listed.json()).toMatchObject({ tables: [{ name: "notes" }] });

    const duplicate = await call("/api/tables", "POST", { name: "notes" });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: { code: "TABLE_CONFLICT" } });

    const deleted = await call("/api/tables/notes", "DELETE");
    expect(deleted.status).toBe(200);
    expect((await call("/api/tables/notes")).status).toBe(404);
    expect(await call("/api/tables").then((res) => res.json())).toEqual({ tables: [] });
  });

  it("rejects bad table names and bodies", async () => {
    expect((await call("/api/tables", "POST", { name: "Nope" })).status).toBe(400);
    expect(await call("/api/tables", "POST", { name: "Nope" }).then((res) => res.json())).toMatchObject({
      error: { code: "INVALID_TABLE" },
    });
    expect((await call("/api/tables", "POST", {})).status).toBe(400);
    expect((await call("/api/tables", "POST", { name: "ok" })).status).toBe(201);
  });

  it("never resolves another Organization's table", async () => {
    await createTable("notes");
    expect((await call("/api/tables/notes", "GET", undefined, OTHER_ORG)).status).toBe(404);
    expect((await putDoc("notes", "a", { v: "x" })).status).toBe(201);
    expect((await call("/api/tables/notes/rows/a", "GET", undefined, OTHER_ORG)).status).toBe(404);
    expect((await call("/api/tables/notes", "DELETE", undefined, OTHER_ORG)).status).toBe(404);
    expect(await call("/api/tables", "GET", undefined, OTHER_ORG).then((res) => res.json())).toEqual({ tables: [] });
  });

  it("inserts, reads, replaces, and deletes single rows", async () => {
    await createTable("notes");
    expect((await putDoc("notes", "a", { title: "first" })).status).toBe(201);
    const read = await call("/api/tables/notes/rows/a");
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ row: { id: "a", data: { title: "first" } } });

    expect((await putDoc("notes", "a", { title: "again" })).status).toBe(409);
    const conflict = await putDoc("notes", "a", { title: "again" });
    expect(await conflict.json()).toMatchObject({ error: { code: "DOCUMENT_CONFLICT" } });

    const updated = await call("/api/tables/notes/rows/a", "PATCH", { data: { title: "second", n: 2 } });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ row: { id: "a", data: { title: "second", n: 2 } } });

    expect((await call("/api/tables/notes/rows/missing", "PATCH", { data: { x: 1 } })).status).toBe(404);
    expect((await call("/api/tables/notes/rows/missing")).status).toBe(404);
    expect((await call("/api/tables/notes/rows/missing", "DELETE")).status).toBe(404);

    expect((await call("/api/tables/notes/rows/a", "DELETE")).status).toBe(200);
    expect((await call("/api/tables/notes/rows/a")).status).toBe(404);
  });

  it("bounds documents and rejects bad row bodies", async () => {
    await createTable("notes");
    const missing = await call("/api/tables/notes/rows/a", "PUT", {});
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: { code: "INVALID_DOCUMENT" } });
    const scalar = await call("/api/tables/notes/rows/a", "PUT", { data: [1, 2] });
    expect(scalar.status).toBe(400);
    const empty = await call("/api/tables/notes/rows/a", "PUT", { data: {} });
    expect(empty.status).toBe(400);
    const big = await call("/api/tables/notes/rows/big", "PUT", { data: { blob: "x".repeat(5000) } });
    // The 4 KB transport bound trips before the document bound: oversized
    // payloads fail closed at the gate with 413, never as partial writes.
    expect(big.status).toBe(413);
    expect(await big.json()).toMatchObject({ error: { code: "BODY_TOO_LARGE" } });
    // A near-limit document (under both bounds) still lands.
    const near = await call("/api/tables/notes/rows/near", "PUT", { data: { blob: "x".repeat(3000) } });
    expect(near.status).toBe(201);
    const badId = await call("/api/tables/notes/rows/batch", "POST", { items: [{ id: "--bad", data: { x: 1 } }] });
    expect(badId.status).toBe(400);
    expect(await badId.json()).toMatchObject({ error: { code: "INVALID_DOCUMENT_ID" } });
  });

  it("documents concurrent-write conflict semantics: second writer loses with 409", async () => {
    await createTable("notes");
    const first = await putDoc("notes", "race", { n: 1 });
    const second = await putDoc("notes", "race", { n: 2 });
    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    const read = await call("/api/tables/notes/rows/race");
    expect(await read.json()).toMatchObject({ row: { data: { n: 1 } } });
  });
});

describe("per-action row policies with deny-by-absence", () => {
  beforeEach(async () => {
    await createTable("notes");
    expect((await putDoc("notes", "a", { title: "hello", meta: { region: "us" } })).status).toBe(201);
  });

  it("denies strangers: reads hide the table, writes fail closed", async () => {
    const read = await call("/api/tables/notes/rows/a", "GET", undefined, ORG, OTHER_USER);
    expect(read.status).toBe(404);
    expect(await read.json()).toMatchObject({ error: { code: "TABLE_NOT_FOUND" } });
    expect((await call("/api/tables/notes/rows", "GET", undefined, ORG, OTHER_USER)).status).toBe(404);
    expect((await call("/api/tables/notes/count", "GET", undefined, ORG, OTHER_USER)).status).toBe(404);
    const write = await call("/api/tables/notes/rows/b", "PUT", { data: { x: 1 } }, ORG, OTHER_USER);
    expect(write.status).toBe(403);
    expect(await write.json()).toMatchObject({ error: { code: "TABLE_FORBIDDEN" } });
    expect((await call("/api/tables/notes/rows/a", "PATCH", { data: { x: 1 } }, ORG, OTHER_USER)).status).toBe(403);
    expect((await call("/api/tables/notes/rows/a", "DELETE", undefined, ORG, OTHER_USER)).status).toBe(403);
    expect(await call("/api/tables", "GET", undefined, ORG, OTHER_USER).then((res) => res.json())).toEqual({
      tables: [],
    });
  });

  it("grants read-only sharing: allowed reads resolve, writes stay denied", async () => {
    const grant = await call("/api/tables/notes/grants", "POST", { action: "read", granteeUserId: OTHER_USER });
    expect(grant.status).toBe(200);
    const read = await call("/api/tables/notes/rows/a", "GET", undefined, ORG, OTHER_USER);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ row: { data: { title: "hello" } } });
    const queried = await call("/api/tables/notes/rows?limit=10", "GET", undefined, ORG, OTHER_USER);
    expect(queried.status).toBe(200);
    const counted = await call("/api/tables/notes/count", "GET", undefined, ORG, OTHER_USER);
    expect(counted.status).toBe(200);
    expect(await counted.json()).toEqual({ total: 1 });
    expect((await call("/api/tables/notes/rows/b", "PUT", { data: { x: 1 } }, ORG, OTHER_USER)).status).toBe(403);
    expect(await call("/api/tables", "GET", undefined, ORG, OTHER_USER).then((res) => res.json())).toMatchObject({
      tables: [{ name: "notes" }],
    });
  });

  it("grants each write action independently and revokes immediately", async () => {
    for (const action of ["insert", "update", "delete"]) {
      const grant = await call("/api/tables/notes/grants", "POST", { action, granteeUserId: OTHER_USER });
      expect(grant.status).toBe(200);
    }
    expect((await putDoc("notes", "b", { x: 1 })).status).toBe(201);
    // The owner already wrote doc b above, so the granted insert on the same
    // ID conflicts; a fresh ID proves the granted insert works.
    expect((await call("/api/tables/notes/rows/b2", "PUT", { data: { x: 2 } }, ORG, OTHER_USER)).status).toBe(201);
    expect((await call("/api/tables/notes/rows/b", "PATCH", { data: { x: 3 } }, ORG, OTHER_USER)).status).toBe(200);
    expect((await call("/api/tables/notes/rows/b", "DELETE", undefined, ORG, OTHER_USER)).status).toBe(200);

    const revoke = await call("/api/tables/notes/grants", "DELETE", { action: "insert", granteeUserId: OTHER_USER });
    expect(revoke.status).toBe(200);
    expect((await call("/api/tables/notes/rows/c", "PUT", { data: { x: 1 } }, ORG, OTHER_USER)).status).toBe(403);
    // Update and delete grants still hold after revoking insert.
    expect((await call("/api/tables/notes/rows/a", "DELETE", undefined, ORG, OTHER_USER)).status).toBe(200);
  });

  it("keeps grant administration owner-only and validates grant bodies", async () => {
    const foreign = await call(
      "/api/tables/notes/grants",
      "POST",
      { action: "read", granteeUserId: OTHER_USER },
      ORG,
      OTHER_USER,
    );
    expect(foreign.status).toBe(403);
    expect(
      (await call("/api/tables/notes/grants", "DELETE", { action: "read", granteeUserId: OTHER_USER }, ORG, OTHER_USER))
        .status,
    ).toBe(403);
    const badAction = await call("/api/tables/notes/grants", "POST", { action: "own", granteeUserId: OTHER_USER });
    expect(badAction.status).toBe(400);
    expect(await badAction.json()).toMatchObject({ error: { code: "INVALID_ACTION" } });
    const badRevokeAction = await call("/api/tables/notes/grants", "DELETE", {
      action: "own",
      granteeUserId: OTHER_USER,
    });
    expect(badRevokeAction.status).toBe(400);
    expect(await badRevokeAction.json()).toMatchObject({ error: { code: "INVALID_ACTION" } });
    expect((await call("/api/tables/notes/grants", "POST", { action: "read" })).status).toBe(400);
    const emptyGrantee = await call("/api/tables/notes/grants", "POST", { action: "read", granteeUserId: "" });
    expect(emptyGrantee.status).toBe(400);
    expect(await emptyGrantee.json()).toMatchObject({ error: { code: "INVALID_GRANTEE" } });
    const nonObjectGrant = await call("/api/tables/notes/grants", "POST", ["read"]);
    expect(nonObjectGrant.status).toBe(400);
    expect(await nonObjectGrant.json()).toMatchObject({ error: { code: "INVALID_GRANT" } });
    // Revoking a grant that was never issued still converges silently.
    const quiet = await call("/api/tables/notes/grants", "DELETE", { action: "delete", granteeUserId: OTHER_USER });
    expect(quiet.status).toBe(200);
    const nonStringRevoke = await call("/api/tables/notes/grants", "DELETE", { action: "delete", granteeUserId: 7 });
    expect(nonStringRevoke.status).toBe(400);
    expect(await nonStringRevoke.json()).toMatchObject({ error: { code: "INVALID_GRANTEE" } });
    expect((await call("/api/tables/notes", "POST", { action: "read", granteeUserId: OTHER_USER })).status).toBe(501);
    expect((await call("/api/tables/nope/grants", "POST", { action: "read", granteeUserId: OTHER_USER })).status).toBe(
      404,
    );
  });

  it("deleting a table drops its rows and grants (retention is explicit deletion)", async () => {
    await call("/api/tables/notes/grants", "POST", { action: "read", granteeUserId: OTHER_USER });
    expect((await call("/api/tables/notes", "DELETE", undefined, ORG, OTHER_USER)).status).toBe(403);
    expect((await call("/api/tables/notes", "DELETE")).status).toBe(200);
    // Recreated under the same name starts empty with no carried grants.
    await createTable("notes");
    expect(await call("/api/tables/notes/count").then((res) => res.json())).toEqual({ total: 0 });
    expect((await call("/api/tables/notes/rows/a", "GET", undefined, ORG, OTHER_USER)).status).toBe(404);
  });
});

describe("TABLE-02 policy-safe querying, counts, and pagination", () => {
  beforeEach(async () => {
    await createTable("orders");
    const docs: Array<[string, Record<string, unknown>]> = [
      ["ord-001", { status: "active", total: 10, meta: { region: "us" } }],
      ["ord-002", { status: "refunded", total: 20, meta: { region: "eu" } }],
      ["ord-003", { status: "active", total: 30, meta: { region: "eu" } }],
      ["inv-004", { status: "active", total: 40, meta: { region: "us" } }],
    ];
    for (const [id, data] of docs) expect((await putDoc("orders", id, data)).status).toBe(201);
  });

  it("filters by top-level and nested JSON fields", async () => {
    const active = await call("/api/tables/orders/rows?filter=status%3D%22active%22", "GET");
    // Ascending document-ID order: inv-004 sorts before ord-*.
    expect(await active.json()).toMatchObject({
      rows: [{ id: "inv-004" }, { id: "ord-001" }, { id: "ord-003" }],
      hasMore: false,
      nextCursor: null,
      total: 3,
    });
    const nested = await call("/api/tables/orders/rows?filter=meta.region%3D%22eu%22", "GET");
    expect(await nested.json()).toMatchObject({ rows: [{ id: "ord-002" }, { id: "ord-003" }], total: 2 });
    const number = await call("/api/tables/orders/rows?filter=total%3D30", "GET");
    expect(await number.json()).toMatchObject({ rows: [{ id: "ord-003" }], total: 1 });
    const combined = await call(
      "/api/tables/orders/rows?filter=status%3D%22active%22&filter=meta.region%3D%22us%22",
      "GET",
    );
    expect(await combined.json()).toMatchObject({ rows: [{ id: "inv-004" }, { id: "ord-001" }], total: 2 });
    const empty = await call("/api/tables/orders/rows?filter=status%3D%22void%22", "GET");
    expect(await empty.json()).toMatchObject({ rows: [], hasMore: false, total: 0 });
    // Null is a first-class filter scalar: rows missing the path never match.
    const nullFilter = await call("/api/tables/orders/rows?filter=archived%3Dnull", "GET");
    expect(await nullFilter.json()).toMatchObject({ rows: [], total: 0 });
    // Prefixed counts agree with prefixed rows.
    const prefixedCount = await call("/api/tables/orders/count?prefix=ord-", "GET");
    expect(await prefixedCount.json()).toEqual({ total: 3 });
    // A prefixed query paged past its cursor still reports the whole-set total.
    const prefixedPage2 = await call("/api/tables/orders/rows?prefix=ord-&limit=1&cursor=ord-001", "GET");
    expect(await prefixedPage2.json()).toMatchObject({ rows: [{ id: "ord-002" }], total: 3 });
  });

  it("scans by document-ID prefix and orders ascending or descending", async () => {
    const prefixed = await call("/api/tables/orders/rows?prefix=ord-", "GET");
    expect(await prefixed.json()).toMatchObject({
      rows: [{ id: "ord-001" }, { id: "ord-002" }, { id: "ord-003" }],
      total: 3,
    });
    const desc = await call("/api/tables/orders/rows?order=desc", "GET");
    expect(await desc.json()).toMatchObject({
      rows: [{ id: "ord-003" }, { id: "ord-002" }, { id: "ord-001" }, { id: "inv-004" }],
      total: 4,
    });
    const both = await call("/api/tables/orders/rows?prefix=ord-&order=desc&filter=status%3D%22active%22", "GET");
    expect(await both.json()).toMatchObject({ rows: [{ id: "ord-003" }, { id: "ord-001" }], total: 2 });
  });

  it("paginates with document-ID keyset cursors and keeps filtered pages continuous", async () => {
    const first = await call("/api/tables/orders/rows?limit=2", "GET");
    const firstBody = (await first.json()) as {
      rows: { id: string }[];
      hasMore: boolean;
      nextCursor: string;
      total: number;
    };
    expect(firstBody.rows.map((row) => row.id)).toEqual(["inv-004", "ord-001"]);
    expect(firstBody.hasMore).toBe(true);
    expect(firstBody.total).toBe(4);

    const second = await call(`/api/tables/orders/rows?limit=2&cursor=${firstBody.nextCursor}`, "GET");
    const secondBody = (await second.json()) as typeof firstBody;
    expect(secondBody.rows.map((row) => row.id)).toEqual(["ord-002", "ord-003"]);
    expect(secondBody.hasMore).toBe(false);
    expect(secondBody.nextCursor).toBeNull();

    // Filtered walk: every active row appears exactly once across pages.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 4; page += 1) {
      const suffix = cursor === null ? "" : `&cursor=${cursor}`;
      const res = await call(`/api/tables/orders/rows?filter=status%3D%22active%22&limit=2${suffix}`, "GET");
      const body = (await res.json()) as { rows: { id: string }[]; hasMore: boolean; nextCursor: string | null };
      seen.push(...body.rows.map((row) => row.id));
      cursor = body.nextCursor;
      if (!body.hasMore) break;
    }
    expect(seen).toEqual(["inv-004", "ord-001", "ord-003"]);
    expect(cursor).toBeNull();
  });

  it("counts scoped matches and skips the scan with skip_count", async () => {
    expect(await call("/api/tables/orders/count").then((res) => res.json())).toEqual({ total: 4 });
    const filtered = await call("/api/tables/orders/count?filter=status%3D%22active%22", "GET");
    expect(await filtered.json()).toEqual({ total: 3 });
    const skipped = await call("/api/tables/orders/count?skip_count=true", "GET");
    expect(await skipped.json()).toEqual({ total: -1 });
    const skippedRows = await call("/api/tables/orders/rows?skip_count=true&limit=2", "GET");
    expect(await skippedRows.json()).toMatchObject({ rows: [{ id: "inv-004" }, { id: "ord-001" }], total: -1 });
    // Web and count routes agree on the same filtered total.
    const rows = await call("/api/tables/orders/rows?filter=meta.region%3D%22eu%22", "GET");
    const counted = await call("/api/tables/orders/count?filter=meta.region%3D%22eu%22", "GET");
    expect(((await rows.json()) as { total: number }).total).toBe(((await counted.json()) as { total: number }).total);
  });

  it("fails closed on unsupported query shapes with explicit codes", async () => {
    const unknown = await call("/api/tables/orders/rows?offset=10", "GET");
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: { code: "UNSUPPORTED_QUERY" } });
    const sort = await call("/api/tables/orders/rows?order=total-desc", "GET");
    expect(sort.status).toBe(400);
    expect(await sort.json()).toMatchObject({ error: { code: "INVALID_ORDER" } });
    const filter = await call("/api/tables/orders/rows?filter=status", "GET");
    expect(filter.status).toBe(400);
    expect(await filter.json()).toMatchObject({ error: { code: "INVALID_FILTER" } });
    const nonScalar = await call("/api/tables/orders/rows?filter=status%3D%5B1%5D", "GET");
    expect(nonScalar.status).toBe(400);
    const limit = await call("/api/tables/orders/rows?limit=500", "GET");
    expect(limit.status).toBe(400);
    expect(await limit.json()).toMatchObject({ error: { code: "INVALID_LIMIT" } });
    const cursor = await call("/api/tables/orders/rows?cursor=", "GET");
    expect(cursor.status).toBe(400);
    expect(await cursor.json()).toMatchObject({ error: { code: "INVALID_CURSOR" } });
    const skip = await call("/api/tables/orders/count?skip_count=yes", "GET");
    expect(skip.status).toBe(400);
    expect(await skip.json()).toMatchObject({ error: { code: "INVALID_SKIP_COUNT" } });
    const countUnknown = await call("/api/tables/orders/count?offset=2", "GET");
    expect(countUnknown.status).toBe(400);
  });
});

describe("TABLE-02 all-or-denied batch mutations", () => {
  beforeEach(async () => {
    await createTable("ledger");
  });

  it("inserts a batch atomically with per-item results", async () => {
    const res = await call("/api/tables/ledger/rows/batch", "POST", {
      items: [
        { id: "a", data: { n: 1 } },
        { id: "b", data: { n: 2 } },
      ],
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      results: [
        { docId: "a", ok: true, error: null },
        { docId: "b", ok: true, error: null },
      ],
    });
    expect(await call("/api/tables/ledger/count").then((r) => r.json())).toEqual({ total: 2 });
  });

  it("returns per-item write errors for operational failures, not whole-batch denial", async () => {
    expect((await putDoc("ledger", "a", { n: 1 })).status).toBe(201);
    const res = await call("/api/tables/ledger/rows/batch", "POST", {
      items: [
        { id: "a", data: { n: 9 } },
        { id: "b", data: { n: 2 } },
      ],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { results: { docId: string; ok: boolean; error: { code: string } | null }[] };
    expect(body.results[0]).toMatchObject({ docId: "a", ok: false, error: { code: "DOCUMENT_CONFLICT" } });
    expect(body.results[1]).toMatchObject({ docId: "b", ok: true, error: null });
    // The surviving write landed.
    expect(await call("/api/tables/ledger/rows/b").then((r) => r.json())).toMatchObject({ row: { data: { n: 2 } } });
    // An all-conflict batch reports per-item conflicts with no writes.
    const allTaken = await call("/api/tables/ledger/rows/batch", "POST", {
      items: [
        { id: "a", data: { n: 11 } },
        { id: "b", data: { n: 22 } },
      ],
    });
    expect(await allTaken.json()).toEqual({
      results: [
        { docId: "a", ok: false, error: { code: "DOCUMENT_CONFLICT", message: 'Document "a" already exists.' } },
        { docId: "b", ok: false, error: { code: "DOCUMENT_CONFLICT", message: 'Document "b" already exists.' } },
      ],
    });
  });

  it("denies the whole batch before any write when the caller holds no grant", async () => {
    const res = await call(
      "/api/tables/ledger/rows/batch",
      "POST",
      {
        items: [
          { id: "a", data: { n: 1 } },
          { id: "b", data: { n: 2 } },
        ],
      },
      ORG,
      OTHER_USER,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "TABLE_BATCH_DENIED" } });
    // Nothing was written: denied batches never partially land.
    expect(await call("/api/tables/ledger/count").then((r) => r.json())).toEqual({ total: 0 });
    const update = await call(
      "/api/tables/ledger/rows/batch-update",
      "PUT",
      { items: [{ id: "a", data: { n: 1 } }] },
      ORG,
      OTHER_USER,
    );
    expect(update.status).toBe(403);
    const remove = await call("/api/tables/ledger/rows/batch-delete", "POST", { ids: ["a"] }, ORG, OTHER_USER);
    expect(remove.status).toBe(403);
  });

  it("updates and deletes batches with per-item missing-row results", async () => {
    const inserted = await call("/api/tables/ledger/rows/batch", "POST", {
      items: [
        { id: "a", data: { n: 1 } },
        { id: "b", data: { n: 2 } },
      ],
    });
    expect(inserted.status).toBe(201);
    const updated = await call("/api/tables/ledger/rows/batch-update", "PUT", {
      items: [
        { id: "a", data: { n: 10 } },
        { id: "ghost", data: { n: 0 } },
      ],
    });
    expect(await updated.json()).toEqual({
      results: [
        { docId: "a", ok: true, error: null },
        { docId: "ghost", ok: false, error: { code: "DOCUMENT_NOT_FOUND", message: "Document not found." } },
      ],
    });
    const removed = await call("/api/tables/ledger/rows/batch-delete", "POST", { ids: ["a", "ghost"] });
    expect(await removed.json()).toEqual({
      results: [
        { docId: "a", ok: true, error: null },
        { docId: "ghost", ok: false, error: { code: "DOCUMENT_NOT_FOUND", message: "Document not found." } },
      ],
    });
    expect(await call("/api/tables/ledger/count").then((r) => r.json())).toEqual({ total: 1 });
    // Ghost-only batches skip the write batch() entirely and still report.
    const ghostUpdate = await call("/api/tables/ledger/rows/batch-update", "PUT", {
      items: [{ id: "ghost", data: { n: 0 } }],
    });
    expect(await ghostUpdate.json()).toEqual({
      results: [{ docId: "ghost", ok: false, error: { code: "DOCUMENT_NOT_FOUND", message: "Document not found." } }],
    });
    const ghostDelete = await call("/api/tables/ledger/rows/batch-delete", "POST", { ids: ["ghost"] });
    expect(await ghostDelete.json()).toEqual({
      results: [{ docId: "ghost", ok: false, error: { code: "DOCUMENT_NOT_FOUND", message: "Document not found." } }],
    });
  });

  it("bounds batches and validates batch bodies", async () => {
    const tooMany = await call("/api/tables/ledger/rows/batch", "POST", {
      items: Array.from({ length: TABLE_BATCH_MAX + 1 }, (_, i) => ({ id: `d${i}`, data: { n: i } })),
    });
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toMatchObject({ error: { code: "INVALID_BATCH" } });
    expect((await call("/api/tables/ledger/rows/batch", "POST", { items: [] })).status).toBe(400);
    expect((await call("/api/tables/ledger/rows/batch", "POST", {})).status).toBe(400);
    expect((await call("/api/tables/ledger/rows/batch-delete", "POST", { ids: [] })).status).toBe(400);
    expect((await call("/api/tables/ledger/rows/batch-delete", "POST", {})).status).toBe(400);
  });

  it("lets a granted caller batch while strangers stay denied", async () => {
    await call("/api/tables/ledger/grants", "POST", { action: "insert", granteeUserId: OTHER_USER });
    const res = await call(
      "/api/tables/ledger/rows/batch",
      "POST",
      { items: [{ id: "shared", data: { n: 1 } }] },
      ORG,
      OTHER_USER,
    );
    expect(res.status).toBe(201);
    // Insert grant alone does not unlock batch update or delete.
    expect(
      (
        await call(
          "/api/tables/ledger/rows/batch-update",
          "PUT",
          { items: [{ id: "shared", data: { n: 2 } }] },
          ORG,
          OTHER_USER,
        )
      ).status,
    ).toBe(403);
  });
});

describe("TABLE-02 large-table bounded-memory regression", () => {
  it("walks 60 rows in bounded pages with exact continuity and totals", async () => {
    await createTable("big");
    for (let batch = 0; batch < 3; batch += 1) {
      const items = Array.from({ length: 20 }, (_, i) => {
        const n = batch * 20 + i;
        return { id: `doc-${String(n).padStart(3, "0")}`, data: { n, parity: n % 2 === 0 ? "even" : "odd" } };
      });
      const res = await call("/api/tables/big/rows/batch", "POST", { items });
      expect(res.status).toBe(201);
    }
    // Full keyset walk: bounded pages, exact continuity, exact total.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const suffix = cursor === null ? "" : `&cursor=${cursor}`;
      const res = await call(`/api/tables/big/rows?limit=15${suffix}`, "GET");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        rows: { id: string }[];
        hasMore: boolean;
        nextCursor: string | null;
        total: number;
      };
      expect(body.rows.length).toBeLessThanOrEqual(15);
      expect(body.total).toBe(60);
      seen.push(...body.rows.map((row) => row.id));
      cursor = body.nextCursor;
      if (!body.hasMore) break;
    }
    expect(cursor).toBeNull();
    const sorted = [...seen].sort();
    expect(new Set(seen).size).toBe(60);
    expect(sorted).toEqual(seen);
    // Filtered walk over the same table stays continuous too.
    const counted = await call("/api/tables/big/count?filter=parity%3D%22even%22", "GET");
    expect(await counted.json()).toEqual({ total: 30 });
    const even: string[] = [];
    let evenCursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const suffix = evenCursor === null ? "" : `&cursor=${evenCursor}`;
      const res = await call(`/api/tables/big/rows?filter=parity%3D%22even%22&limit=15${suffix}`, "GET");
      const body = (await res.json()) as { rows: { id: string }[]; hasMore: boolean; nextCursor: string | null };
      even.push(...body.rows.map((row) => row.id));
      evenCursor = body.nextCursor;
      if (!body.hasMore) break;
    }
    expect(even.length).toBe(30);
    expect(new Set(even).size).toBe(30);
    expect(even.every((id, i) => i === 0 || even[i - 1]! < id)).toBe(true);
  });
});

describe("tables query parser units", () => {
  it("rejects over-filtered, mis-shaped, and non-scalar queries", () => {
    expect(
      faultCode(() =>
        parseTableQuery(
          new URLSearchParams("filter=a%3D1&filter=b%3D2&filter=c%3D3&filter=d%3D4&filter=e%3D5&filter=f%3D6"),
        ),
      ),
    ).toBe("TOO_MANY_FILTERS");
    expect(faultCode(() => parseTableQuery(new URLSearchParams("filter=%3D1")))).toBe("INVALID_FILTER");
    expect(faultCode(() => parseTableQuery(new URLSearchParams("filter=0bad%3D1")))).toBe("INVALID_FILTER");
    expect(faultCode(() => parseTableQuery(new URLSearchParams("filter=a%3Dnotjson{")))).toBe("INVALID_FILTER");
    expect(faultCode(() => parseTableQuery(new URLSearchParams("filter=a%3D%7B%22x%22%3A1%7D")))).toBe(
      "INVALID_FILTER",
    );
    expect(faultCode(() => parseTableQuery(new URLSearchParams("filter=a%3DNaN")))).toBe("INVALID_FILTER");
    expect(faultCode(() => parseTableQuery(new URLSearchParams("prefix=")))).toBe("INVALID_PREFIX");
    expect(faultCode(() => parseTableQuery(new URLSearchParams("order=up")))).toBe("INVALID_ORDER");
    expect(faultCode(() => parseTableQuery(new URLSearchParams("limit=0")))).toBe("INVALID_LIMIT");
    expect(faultCode(() => parseTableQuery(new URLSearchParams("cursor=--bad")))).toBe("INVALID_DOCUMENT_ID");
  });

  it("parses documents, batches, and nested lookups with explicit bounds", () => {
    expect(faultCode(() => parseDocument([]))).toBe("INVALID_DOCUMENT");
    expect(faultCode(() => parseDocument({}))).toBe("INVALID_DOCUMENT");
    expect(faultCode(() => parseDocument("nope"))).toBe("INVALID_DOCUMENT");
    expect(faultCode(() => parseDocument(null))).toBe("INVALID_DOCUMENT");
    expect(faultCode(() => parseDocument(Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, i]))))).toBe(
      "INVALID_DOCUMENT",
    );
    expect(faultCode(() => parseDocument({ "0bad": 1 }))).toBe("INVALID_DOCUMENT");
    expect(faultCode(() => parseDocument({ blob: "x".repeat(5000) }))).toBe("DOCUMENT_TOO_LARGE");
    expect(faultCode(() => parseBatchBody({ items: [] }))).toBe("INVALID_BATCH");
    expect(faultCode(() => parseBatchBody({}))).toBe("INVALID_BATCH");
    expect(faultCode(() => parseBatchBody({ items: ["nope"] }))).toBe("INVALID_BATCH");
    expect(faultCode(() => parseBatchBody({ items: [{ id: "ok" }] }))).toBe("INVALID_DOCUMENT");
    expect(lookupPath({ a: { b: 1 } }, "a.b")).toBe(1);
    expect(lookupPath({ a: { b: 1 } }, "a.missing")).toBeUndefined();
    expect(lookupPath({ a: [1, 2] }, "a.0")).toBeUndefined();
    expect(TABLE_BATCH_MAX).toBe(25);
    expect(TABLE_QUERY_ROW_CAP).toBe(1000);
  });
});
