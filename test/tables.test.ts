// SPDX-License-Identifier: AGPL-3.0
// Author Tables over D1 (TABLE-01 minimal slice, TABLE-02 query/count/
// canonical-batch; issues #117, #154): declarations, deny-by-absence
// per-action grants, policy-safe bounded queries, scoped counts, and the
// canonical write_mode batch contract (insert, merge_upsert, replace_upsert
// over 0-25 documents), proven against real local D1 in workerd. Applies the full
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
import type { Principal } from "../src/domain";
import { defineSaga } from "../src/saga";
import type { SagaEventContext, SagaStep } from "../src/saga";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration7 from "../migrations/0007_org_membership.sql?raw";
import migration8 from "../migrations/0008_executions_org_fk.sql?raw";
import migration9 from "../migrations/0009_tables.sql?raw";
import {
  createTable as declareTable,
  decodeChangesToken,
  insertRow,
  loadTable,
  lookupPath,
  parseBatchRequest,
  parseChangesQuery,
  parseDocument,
  parseTableQuery,
  readRow,
  TABLE_BATCH_BODY_LIMIT,
  TABLE_BATCH_MAX,
  TABLE_DOC_MAX_BYTES,
  TABLE_DOCUMENT_IDS_MAX,
  TABLE_DOCUMENT_ID_QUERY_MAX,
  TABLE_FILTER_MAX,
  TABLE_QUERY_LIMIT_MAX,
  TABLE_QUERY_ROW_CAP,
  updateRow,
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
    new Request(`https://local.test${path}`, {
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

/** Column names of one CREATE TABLE statement in definition order:
 * top-level comma-separated definitions, table constraints skipped. */
function topLevelColumns(createTableSql: string): string[] {
  const inner = createTableSql.slice(createTableSql.indexOf("(") + 1, createTableSql.lastIndexOf(")"));
  const defs: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of inner) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      defs.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  defs.push(current);
  const columns: string[] = [];
  for (const def of defs) {
    // Leading identifier, not the whitespace token: constraints read
    // UNIQUE(...) / PRIMARY KEY(...) with no space after the keyword.
    const first = def.trim().match(/^([A-Za-z_]+)/)?.[1] ?? "";
    if (["PRIMARY", "FOREIGN", "UNIQUE", "CHECK", "CONSTRAINT"].includes(first.toUpperCase())) continue;
    columns.push(first);
  }
  return columns;
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

  it("hides the table detail from non-grantees (issue #353)", async () => {
    await createTable("notes");
    // Owner sees the detail with owner identity metadata.
    const owned = await call("/api/tables/notes");
    expect(owned.status).toBe(200);
    expect(await owned.json()).toMatchObject({ table: { name: "notes", ownerUserId: OWNER } });
    // Same-org member without a grant: 404, never the UUID/owner/timestamp.
    const hidden = await call("/api/tables/notes", "GET", undefined, ORG, OTHER_USER);
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual({ error: { code: "NOT_FOUND", message: "Not found." } });
    // Any grant restores the same visibility the list applies.
    await call("/api/tables/notes/grants", "POST", { action: "read", granteeUserId: OTHER_USER });
    const granted = await call("/api/tables/notes", "GET", undefined, ORG, OTHER_USER);
    expect(granted.status).toBe(200);
    expect(await granted.json()).toMatchObject({ table: { name: "notes" } });
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

describe("TABLE-02 physical document_ids batch filter (issue #154)", () => {
  beforeEach(async () => {
    await createTable("docs");
    const docs: Array<[string, Record<string, unknown>]> = [
      ["ord-1", { status: "active", n: 1 }],
      ["ord-2", { status: "archived", n: 2 }],
      ["ord-3", { status: "active", n: 3 }],
      ["inv-1", { status: "active", n: 4 }],
    ];
    for (const [id, data] of docs) expect((await putDoc("docs", id, data)).status).toBe(201);
  });

  const idsQuery = (ids: string[]): string => ids.map((id) => `document_ids=${encodeURIComponent(id)}`).join("&");

  it("matches one and several IDs in normal order, deduping repeats", async () => {
    const one = await call("/api/tables/docs/rows?document_ids=ord-1", "GET");
    expect(await one.json()).toMatchObject({ rows: [{ id: "ord-1" }], hasMore: false, total: 1 });
    // Input order is reversed: results still answer in document-ID order.
    const several = await call(`/api/tables/docs/rows?${idsQuery(["ord-3", "ord-1"])}`, "GET");
    expect(await several.json()).toMatchObject({
      rows: [{ id: "ord-1" }, { id: "ord-3" }],
      hasMore: false,
      total: 2,
    });
    const dupes = await call(`/api/tables/docs/rows?${idsQuery(["ord-3", "ord-1", "ord-3", "ord-1"])}`, "GET");
    expect(await dupes.json()).toMatchObject({
      rows: [{ id: "ord-1" }, { id: "ord-3" }],
      total: 2,
    });
    const counted = await call(`/api/tables/docs/count?${idsQuery(["ord-3", "ord-1", "ord-3"])}`, "GET");
    expect(await counted.json()).toEqual({ total: 2 });
  });

  it("lets unknown IDs silently match nothing", async () => {
    const ghost = await call("/api/tables/docs/rows?document_ids=ghost", "GET");
    expect(await ghost.json()).toMatchObject({ rows: [], hasMore: false, nextCursor: null, total: 0 });
    const mixed = await call(`/api/tables/docs/rows?${idsQuery(["ghost", "ord-1"])}`, "GET");
    expect(await mixed.json()).toMatchObject({ rows: [{ id: "ord-1" }], total: 1 });
    const ghostCount = await call("/api/tables/docs/count?document_ids=ghost", "GET");
    expect(await ghostCount.json()).toEqual({ total: 0 });
  });

  it("ANDs the allowlist with JSON filters, prefix, and cursor", async () => {
    const filtered = await call(
      `/api/tables/docs/rows?filter=status%3D%22active%22&${idsQuery(["ord-1", "ord-2", "ord-3"])}`,
      "GET",
    );
    expect(await filtered.json()).toMatchObject({ rows: [{ id: "ord-1" }, { id: "ord-3" }], total: 2 });
    const prefixed = await call(`/api/tables/docs/rows?prefix=ord-&${idsQuery(["ord-1", "inv-1"])}`, "GET");
    expect(await prefixed.json()).toMatchObject({ rows: [{ id: "ord-1" }], total: 1 });
    // Cursor keyset pagination applies inside the constrained set.
    const first = await call(`/api/tables/docs/rows?limit=2&${idsQuery(["ord-1", "ord-2", "ord-3"])}`, "GET");
    const firstBody = (await first.json()) as { rows: { id: string }[]; hasMore: boolean; nextCursor: string };
    expect(firstBody.rows.map((row) => row.id)).toEqual(["ord-1", "ord-2"]);
    expect(firstBody.hasMore).toBe(true);
    const second = await call(
      `/api/tables/docs/rows?limit=2&cursor=${firstBody.nextCursor}&${idsQuery(["ord-1", "ord-2", "ord-3"])}`,
      "GET",
    );
    expect(await second.json()).toMatchObject({ rows: [{ id: "ord-3" }], hasMore: false, total: 3 });
  });

  it("keeps ordering and pagination normal under the allowlist and honors skip_count", async () => {
    const desc = await call(`/api/tables/docs/rows?order=desc&${idsQuery(["ord-1", "ord-3", "inv-1"])}`, "GET");
    expect(await desc.json()).toMatchObject({
      rows: [{ id: "ord-3" }, { id: "ord-1" }, { id: "inv-1" }],
      total: 3,
    });
    const skippedRows = await call(`/api/tables/docs/rows?skip_count=true&${idsQuery(["ord-1", "ord-3"])}`, "GET");
    expect(await skippedRows.json()).toMatchObject({ rows: [{ id: "ord-1" }, { id: "ord-3" }], total: -1 });
    const skippedCount = await call(`/api/tables/docs/count?skip_count=true&${idsQuery(["ord-1"])}`, "GET");
    expect(await skippedCount.json()).toEqual({ total: -1 });
    const filtered = await call(
      `/api/tables/docs/count?filter=status%3D%22active%22&${idsQuery(["ord-1", "ord-2", "ord-3"])}`,
      "GET",
    );
    expect(await filtered.json()).toEqual({ total: 2 });
  });

  it("fails closed on 26, blank, and oversized IDs", async () => {
    expect(TABLE_DOCUMENT_IDS_MAX).toBe(25);
    expect(TABLE_DOCUMENT_ID_QUERY_MAX).toBe(255);
    const tooMany = Array.from({ length: 26 }, (_, i) => `document_ids=d${i}`).join("&");
    const rejected = await call(`/api/tables/docs/rows?${tooMany}`, "GET");
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: { code: "TOO_MANY_DOCUMENT_IDS" } });
    const rejectedCount = await call(`/api/tables/docs/count?${tooMany}`, "GET");
    expect(rejectedCount.status).toBe(400);
    expect(await rejectedCount.json()).toMatchObject({ error: { code: "TOO_MANY_DOCUMENT_IDS" } });
    // 26 identical IDs evade nothing: the raw key count is bounded pre-dedup.
    const dupesTooMany = Array.from({ length: 26 }, () => "document_ids=ord-1").join("&");
    const dupRejected = await call(`/api/tables/docs/rows?${dupesTooMany}`, "GET");
    expect(dupRejected.status).toBe(400);
    expect(await dupRejected.json()).toMatchObject({ error: { code: "TOO_MANY_DOCUMENT_IDS" } });
    // The 25-ID boundary still lands.
    const boundary = Array.from({ length: 25 }, (_, i) => `document_ids=d${i}`).join("&");
    expect((await call(`/api/tables/docs/rows?${boundary}`, "GET")).status).toBe(200);
    for (const blank of ["document_ids=", "document_ids=%20"]) {
      const res = await call(`/api/tables/docs/rows?${blank}`, "GET");
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "INVALID_DOCUMENT_IDS" } });
    }
    const oversized = await call(`/api/tables/docs/rows?document_ids=${"x".repeat(256)}`, "GET");
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toMatchObject({ error: { code: "INVALID_DOCUMENT_IDS" } });
    // A 255-char unknown ID is valid input that silently matches nothing.
    const longest = await call(`/api/tables/docs/rows?document_ids=${"x".repeat(255)}`, "GET");
    expect(await longest.json()).toMatchObject({ rows: [], total: 0 });
  });

  it("preserves Organization isolation and read-denied 404 behavior", async () => {
    expect((await call("/api/tables/docs/rows?document_ids=ord-1", "GET", undefined, OTHER_ORG)).status).toBe(404);
    expect((await call("/api/tables/docs/count?document_ids=ord-1", "GET", undefined, OTHER_ORG)).status).toBe(404);
    const denied = await call("/api/tables/docs/rows?document_ids=ord-1", "GET", undefined, ORG, OTHER_USER);
    expect(denied.status).toBe(404);
    expect(await denied.json()).toMatchObject({ error: { code: "TABLE_NOT_FOUND" } });
    expect((await call("/api/tables/docs/count?document_ids=ord-1", "GET", undefined, ORG, OTHER_USER)).status).toBe(
      404,
    );
    // A read grant restores the allowlist for the grantee, scoped to this org.
    await call("/api/tables/docs/grants", "POST", { action: "read", granteeUserId: OTHER_USER });
    const granted = await call("/api/tables/docs/rows?document_ids=ord-1", "GET", undefined, ORG, OTHER_USER);
    expect(await granted.json()).toMatchObject({ rows: [{ id: "ord-1" }], total: 1 });
  });

  it("binds IDs instead of interpolating them", async () => {
    // Quote, percent, and backslash ride as bound values: no SQL error, no
    // LIKE expansion, just a silent non-match. The table is untouched.
    const hostile = await call(`/api/tables/docs/rows?${idsQuery(["o'rd-%\\_1"])}`, "GET");
    expect(hostile.status).toBe(200);
    expect(await hostile.json()).toMatchObject({ rows: [], total: 0 });
    expect(await call("/api/tables/docs/count").then((res) => res.json())).toEqual({ total: 4 });
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
      count: 2,
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
    const body = (await res.json()) as {
      results: { docId: string; ok: boolean; error: { code: string } | null }[];
      count: number;
    };
    expect(body.results[0]).toMatchObject({ docId: "a", ok: false, error: { code: "DOCUMENT_CONFLICT" } });
    expect(body.results[1]).toMatchObject({ docId: "b", ok: true, error: null });
    expect(body.count).toBe(1);
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
      count: 0,
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
      count: 1,
    });
    const removed = await call("/api/tables/ledger/rows/batch-delete", "POST", { ids: ["a", "ghost"] });
    expect(await removed.json()).toEqual({
      results: [
        { docId: "a", ok: true, error: null },
        { docId: "ghost", ok: false, error: { code: "DOCUMENT_NOT_FOUND", message: "Document not found." } },
      ],
      count: 1,
    });
    expect(await call("/api/tables/ledger/count").then((r) => r.json())).toEqual({ total: 1 });
    // Ghost-only batches skip the write batch() entirely and still report.
    const ghostUpdate = await call("/api/tables/ledger/rows/batch-update", "PUT", {
      items: [{ id: "ghost", data: { n: 0 } }],
    });
    expect(await ghostUpdate.json()).toEqual({
      results: [{ docId: "ghost", ok: false, error: { code: "DOCUMENT_NOT_FOUND", message: "Document not found." } }],
      count: 0,
    });
    const ghostDelete = await call("/api/tables/ledger/rows/batch-delete", "POST", { ids: ["ghost"] });
    expect(await ghostDelete.json()).toEqual({
      results: [{ docId: "ghost", ok: false, error: { code: "DOCUMENT_NOT_FOUND", message: "Document not found." } }],
      count: 0,
    });
  });

  it("counts duplicate delete ids once: repeats report DOCUMENT_NOT_FOUND", async () => {
    // One physical row deleted twice must not count twice. The first
    // occurrence deletes; later ones report DOCUMENT_NOT_FOUND like ghosts
    // (mirroring the insert path, where a repeat of an id the same request
    // wrote reports DOCUMENT_CONFLICT). The scoped count proves only one
    // row left the table.
    const inserted = await call("/api/tables/ledger/rows/batch", "POST", {
      items: [{ id: "a", data: { n: 1 } }],
    });
    expect(inserted.status).toBe(201);
    const removed = await call("/api/tables/ledger/rows/batch-delete", "POST", {
      ids: ["a", "a", "ghost", "a"],
    });
    expect(await removed.json()).toEqual({
      results: [
        { docId: "a", ok: true, error: null },
        { docId: "a", ok: false, error: { code: "DOCUMENT_NOT_FOUND", message: "Document not found." } },
        { docId: "ghost", ok: false, error: { code: "DOCUMENT_NOT_FOUND", message: "Document not found." } },
        { docId: "a", ok: false, error: { code: "DOCUMENT_NOT_FOUND", message: "Document not found." } },
      ],
      count: 1,
    });
    expect(await call("/api/tables/ledger/count").then((r) => r.json())).toEqual({ total: 0 });
  });

  it("bounds batches and validates batch bodies", async () => {
    const tooMany = await call("/api/tables/ledger/rows/batch", "POST", {
      items: Array.from({ length: TABLE_BATCH_MAX + 1 }, (_, i) => ({ id: `d${i}`, data: { n: i } })),
    });
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toMatchObject({ error: { code: "INVALID_BATCH" } });
    // Nothing was written: oversized batches are rejected before any write.
    expect(await call("/api/tables/ledger/count").then((r) => r.json())).toEqual({ total: 0 });
    // Empty batches are valid 0-document writes, not validation failures.
    const empty = await call("/api/tables/ledger/rows/batch", "POST", { items: [] });
    expect(empty.status).toBe(201);
    expect(await empty.json()).toEqual({ results: [], count: 0 });
    const emptyDelete = await call("/api/tables/ledger/rows/batch-delete", "POST", { ids: [] });
    expect(emptyDelete.status).toBe(200);
    expect(await emptyDelete.json()).toEqual({ results: [], count: 0 });
    expect((await call("/api/tables/ledger/rows/batch", "POST", {})).status).toBe(400);
    expect((await call("/api/tables/ledger/rows/batch-delete", "POST", {})).status).toBe(400);
    expect((await call("/api/tables/ledger/rows/batch", "POST", { write_mode: "bogus", items: [] })).status).toBe(400);
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

describe("TABLE-02 canonical write_mode batch contract (upstream #735)", () => {
  beforeEach(async () => {
    await createTable("contracts");
  });

  type BatchBody = {
    results: { docId: string; ok: boolean; error: { code: string; message: string } | null }[];
    count: number;
  };

  it("upserts with merge_upsert: inserts missing rows, replaces present ones", async () => {
    expect((await putDoc("contracts", "kept", { n: 1 })).status).toBe(201);
    const res = await call("/api/tables/contracts/rows/batch", "POST", {
      write_mode: "merge_upsert",
      items: [
        { id: "kept", data: { n: 2 } },
        { id: "fresh", data: { n: 3 } },
      ],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as BatchBody;
    expect(body).toEqual({
      results: [
        { docId: "kept", ok: true, error: null },
        { docId: "fresh", ok: true, error: null },
      ],
      count: 2,
    });
    expect(await call("/api/tables/contracts/rows/kept").then((r) => r.json())).toMatchObject({
      row: { data: { n: 2 } },
    });
    expect(await call("/api/tables/contracts/rows/fresh").then((r) => r.json())).toMatchObject({
      row: { data: { n: 3 } },
    });
  });

  it("treats replace_upsert like merge_upsert: wholesale replace, same count", async () => {
    expect((await putDoc("contracts", "r", { n: 1 })).status).toBe(201);
    const res = await call("/api/tables/contracts/rows/batch", "POST", {
      write_mode: "replace_upsert",
      items: [
        { id: "r", data: { n: 9 } },
        { id: "new", data: { n: 1 } },
      ],
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      results: [
        { docId: "r", ok: true, error: null },
        { docId: "new", ok: true, error: null },
      ],
      count: 2,
    });
    expect(await call("/api/tables/contracts/rows/r").then((r) => r.json())).toMatchObject({
      row: { data: { n: 9 } },
    });
  });

  it("maps legacy upsert:true to merge_upsert and permits idless rows", async () => {
    const res = await call("/api/tables/contracts/rows/batch", "POST", {
      upsert: true,
      items: [{ data: { n: 1 } }, { id: "named", data: { n: 2 } }],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as BatchBody;
    expect(body.count).toBe(2);
    expect(body.results[1]).toEqual({ docId: "named", ok: true, error: null });
    const generated = body.results[0]!.docId;
    expect(typeof generated).toBe("string");
    expect(generated.length).toBeGreaterThan(0);
    expect(body.results[0]).toEqual({ docId: generated, ok: true, error: null });
    // The generated id reads back like any other row.
    expect(await call(`/api/tables/contracts/rows/${generated}`).then((r) => r.status)).toBe(200);
  });

  it("answers count-only when return_documents is false", async () => {
    const res = await call("/api/tables/contracts/rows/batch", "POST", {
      write_mode: "merge_upsert",
      return_documents: false,
      items: [
        { id: "a", data: { n: 1 } },
        { id: "b", data: { n: 2 } },
      ],
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ results: [], count: 2 });
    expect(await call("/api/tables/contracts/count").then((r) => r.json())).toEqual({ total: 2 });
  });

  it("requires both insert and update grants for upsert modes", async () => {
    await call("/api/tables/contracts/grants", "POST", { action: "insert", granteeUserId: OTHER_USER });
    const insertOnly = await call(
      "/api/tables/contracts/rows/batch",
      "POST",
      { write_mode: "merge_upsert", items: [{ id: "x", data: { n: 1 } }] },
      ORG,
      OTHER_USER,
    );
    expect(insertOnly.status).toBe(403);
    expect(await insertOnly.json()).toMatchObject({ error: { code: "TABLE_BATCH_DENIED" } });
    await call("/api/tables/contracts/grants", "POST", { action: "update", granteeUserId: OTHER_USER });
    const both = await call(
      "/api/tables/contracts/rows/batch",
      "POST",
      { write_mode: "merge_upsert", items: [{ id: "x", data: { n: 1 } }] },
      ORG,
      OTHER_USER,
    );
    expect(both.status).toBe(201);
    expect(await both.json()).toMatchObject({ count: 1 });
    // Nothing landed from the denied attempt: the preflight precedes writes.
    expect(await call("/api/tables/contracts/count").then((r) => r.json())).toEqual({ total: 1 });
  });

  it("keeps submission order in per-item results", async () => {
    expect((await putDoc("contracts", "taken", { n: 0 })).status).toBe(201);
    const res = await call("/api/tables/contracts/rows/batch", "POST", {
      write_mode: "insert",
      items: [
        { id: "z-last", data: { n: 1 } },
        { id: "taken", data: { n: 2 } },
        { id: "a-first", data: { n: 3 } },
      ],
    });
    const body = (await res.json()) as BatchBody;
    expect(body.results.map((result) => result.docId)).toEqual(["z-last", "taken", "a-first"]);
    expect(body.results.map((result) => result.ok)).toEqual([true, false, true]);
    expect(body.count).toBe(2);
  });

  it("writes a full 25-document batch through one atomic batch() call", async () => {
    const items = Array.from({ length: TABLE_BATCH_MAX }, (_, i) => ({ id: `w${i}`, data: { n: i } }));
    const res = await call("/api/tables/contracts/rows/batch", "POST", { write_mode: "insert", items });
    expect(res.status).toBe(201);
    const body = (await res.json()) as BatchBody;
    expect(body.count).toBe(TABLE_BATCH_MAX);
    expect(body.results).toHaveLength(TABLE_BATCH_MAX);
    expect(body.results.every((result) => result.ok)).toBe(true);
    // 25 rows sit far below the count scan window, so the scoped count
    // answers the exact total; the keyset walk below proves all 25 landed.
    expect(await call("/api/tables/contracts/count").then((r) => r.json())).toEqual({ total: TABLE_BATCH_MAX });
    const walked: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page += 1) {
      const suffix = cursor === null ? "" : `&cursor=${cursor}`;
      const pageRes = await call(`/api/tables/contracts/rows?limit=50${suffix}`, "GET");
      expect(pageRes.status).toBe(200);
      const pageBody = (await pageRes.json()) as {
        rows: { id: string }[];
        hasMore: boolean;
        nextCursor: string | null;
      };
      walked.push(...pageBody.rows.map((row) => row.id));
      cursor = pageBody.nextCursor;
      if (!pageBody.hasMore) break;
    }
    expect(new Set(walked).size).toBe(TABLE_BATCH_MAX);
    // Spot-read the boundaries of the single-transaction write path.
    expect(await call("/api/tables/contracts/rows/w0").then((r) => r.json())).toMatchObject({
      row: { data: { n: 0 } },
    });
    expect(await call(`/api/tables/contracts/rows/w${TABLE_BATCH_MAX - 1}`).then((r) => r.json())).toMatchObject({
      row: { data: { n: TABLE_BATCH_MAX - 1 } },
    });
  });

  it("rejects duplicates within one insert request as conflicts", async () => {
    const res = await call("/api/tables/contracts/rows/batch", "POST", {
      items: [
        { id: "dup", data: { n: 1 } },
        { id: "dup", data: { n: 2 } },
      ],
    });
    expect(await res.json()).toEqual({
      results: [
        { docId: "dup", ok: true, error: null },
        { docId: "dup", ok: false, error: { code: "DOCUMENT_CONFLICT", message: 'Document "dup" already exists.' } },
      ],
      count: 1,
    });
    expect(await call("/api/tables/contracts/rows/dup").then((r) => r.json())).toMatchObject({
      row: { data: { n: 1 } },
    });
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

describe("TABLE-02 retention-posture pins (explicit deletion only, issue #154)", () => {
  it("deleteTable drops rows from every batch path plus grants, leaving no orphans", async () => {
    await createTable("ledger");
    // Grants that must die with the table.
    for (const action of ["read", "insert", "update", "delete"]) {
      const granted = await call("/api/tables/ledger/grants", "POST", { action, granteeUserId: OTHER_USER });
      expect(granted.status).toBe(200);
    }
    // Rows enter through the canonical batch endpoint ...
    const inserted = await call("/api/tables/ledger/rows/batch", "POST", {
      write_mode: "insert",
      items: [
        { id: "a", data: { n: 1 } },
        { id: "b", data: { n: 2 } },
        { id: "c", data: { n: 3 } },
      ],
    });
    expect(inserted.status).toBe(201);
    // ... are rewritten through the batch-update alias ...
    const updated = await call("/api/tables/ledger/rows/batch-update", "PUT", {
      items: [{ id: "b", data: { n: 20 } }],
    });
    expect(await updated.json()).toMatchObject({ count: 1 });
    expect(await call("/api/tables/ledger/rows/b").then((r) => r.json())).toMatchObject({
      row: { data: { n: 20 } },
    });
    // ... and leave through the batch-delete alias before the table itself goes.
    const removed = await call("/api/tables/ledger/rows/batch-delete", "POST", { ids: ["c"] });
    expect(await removed.json()).toMatchObject({ count: 1 });
    expect((await call("/api/tables/ledger/rows/c")).status).toBe(404);
    expect(await call("/api/tables/ledger/count").then((r) => r.json())).toEqual({ total: 2 });

    const table = (await loadTable(bindings.DB, ORG, "ledger"))!;
    const deleted = await call("/api/tables/ledger", "DELETE");
    expect(deleted.status).toBe(200);
    // The declaration is gone on every route surface ...
    expect((await call("/api/tables/ledger")).status).toBe(404);
    expect((await call("/api/tables/ledger/rows/a")).status).toBe(404);
    expect((await call("/api/tables/ledger/count")).status).toBe(404);
    // ... and no rows, grants, or declaration survive under the old id.
    const rows = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM table_rows WHERE table_id=?")
      .bind(table.id)
      .first<{ n: number }>();
    const grants = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM table_grants WHERE table_id=?")
      .bind(table.id)
      .first<{ n: number }>();
    const tables = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM tables WHERE id=?")
      .bind(table.id)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
    expect(grants?.n).toBe(0);
    expect(tables?.n).toBe(0);
    // A reused name starts empty: nothing resurrects from orphan rows.
    await createTable("ledger");
    expect(await call("/api/tables/ledger/count").then((r) => r.json())).toEqual({ total: 0 });
  });

  it("applied tables schema carries no TTL/partition columns, only explicit-deletion state", async () => {
    const schema = await bindings.DB.prepare(
      "SELECT name, sql FROM sqlite_schema WHERE type='table' AND name IN ('tables','table_rows','table_grants')",
    ).all<{ name: string; sql: string }>();
    expect(schema.results.map((row) => row.name).sort()).toEqual(["table_grants", "table_rows", "tables"]);
    const ddl = schema.results.map((row) => row.sql).join("\n");
    // No background-expiry surface anywhere in the applied DDL: retention is
    // explicit deletion (deleteTable / row deletes) or nothing.
    expect(ddl).not.toMatch(/\b(ttl|expir(e[sd]?|y|ation)?|partition|retention)\b/i);
    // The per-document bound answers to D1 itself, not only to TypeScript.
    expect(ddl).toContain("CHECK(length(data_json) <= 4096)");
    // Exact applied columns: rows carry identity, attribution, payload, and
    // timestamps — no expiry/partition columns to drift in silently.
    const rowsSql = schema.results.find((row) => row.name === "table_rows")!.sql;
    expect(topLevelColumns(rowsSql)).toEqual([
      "table_id",
      "org_id",
      "doc_id",
      "owner_user_id",
      "data_json",
      "created_at",
      "updated_at",
    ]);
  });

  it("D1 CHECK rejects oversized data_json below the transport bound", async () => {
    await createTable("ledger");
    const table = (await loadTable(bindings.DB, ORG, "ledger"))!;
    const stamp = new Date().toISOString();
    const insertDirect = (docId: string, dataJson: string) =>
      bindings.DB.prepare(
        "INSERT INTO table_rows(table_id, org_id, doc_id, owner_user_id, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(table.id, ORG, docId, OWNER, dataJson, stamp, stamp)
        .run();
    // Straight past boundedJson and parseDocument: only the DDL CHECK stands
    // between this insert and the page. 5000 chars trips length() <= 4096.
    await expect(insertDirect("oversized", "x".repeat(5000))).rejects.toThrow(/CHECK constraint failed/i);
    expect(await call("/api/tables/ledger/count").then((r) => r.json())).toEqual({ total: 0 });
    // The bound is exactly 4096 characters: a boundary document lands and
    // reads back like any other row.
    const boundary = JSON.stringify({ blob: "x".repeat(4085) });
    expect(boundary.length).toBe(4096);
    await insertDirect("boundary", boundary);
    expect(await call("/api/tables/ledger/rows/boundary").then((r) => r.json())).toMatchObject({
      row: { id: "boundary", data: { blob: "x".repeat(4085) } },
    });
  });

  it("batch body byte cap trips over TABLE_BATCH_BODY_LIMIT and passes under it", async () => {
    await createTable("ledger");
    // Under the cap (~200 KB): transport passes the body through, so the
    // oversized documents fail at domain validation (400), never at the
    // gate. Against the 4 KB default this same body would 413.
    const underItems = Array.from({ length: TABLE_BATCH_MAX }, (_, i) => ({
      id: `u${i}`,
      data: { blob: "x".repeat(8000) },
    }));
    const underBody = JSON.stringify({ write_mode: "insert", items: underItems });
    expect(underBody.length).toBeGreaterThan(100_000);
    expect(underBody.length).toBeLessThan(TABLE_BATCH_BODY_LIMIT);
    const under = await call("/api/tables/ledger/rows/batch", "POST", JSON.parse(underBody));
    expect(under.status).toBe(400);
    expect(await under.json()).toMatchObject({ error: { code: "DOCUMENT_TOO_LARGE" } });
    expect(await call("/api/tables/ledger/count").then((r) => r.json())).toEqual({ total: 0 });
    // Over the cap (~263 KB): the gate fails closed with 413 before any
    // parse or write, naming the exact bound.
    const overItems = Array.from({ length: TABLE_BATCH_MAX }, (_, i) => ({
      id: `o${i}`,
      data: { blob: "x".repeat(10_500) },
    }));
    const overBody = JSON.stringify({ write_mode: "insert", items: overItems });
    expect(overBody.length).toBeGreaterThan(TABLE_BATCH_BODY_LIMIT);
    const over = await call("/api/tables/ledger/rows/batch", "POST", JSON.parse(overBody));
    expect(over.status).toBe(413);
    expect(await over.json()).toMatchObject({
      error: { code: "BODY_TOO_LARGE", message: `The body exceeds ${TABLE_BATCH_BODY_LIMIT} bytes.` },
    });
    expect(await call("/api/tables/ledger/count").then((r) => r.json())).toEqual({ total: 0 });
  });
});

describe("TABLE-02 large-table retention-policy slice (issue #154)", () => {
  // One scan window plus margin: over-cap by construction, small enough to
  // seed through a few direct D1 batch() calls.
  const LARGE_ROWS = TABLE_QUERY_ROW_CAP + 100;

  interface ListBody {
    rows: { id: string }[];
    hasMore: boolean;
    nextCursor: string | null;
    total: number;
  }

  function docId(i: number): string {
    return `d${String(i).padStart(5, "0")}`;
  }

  async function seedLarge(name: string, rows = LARGE_ROWS): Promise<void> {
    await createTable(name);
    const table = (await loadTable(bindings.DB, ORG, name))!;
    const stamp = new Date().toISOString();
    const statements = [];
    for (let i = 0; i < rows; i += 1) {
      statements.push(
        bindings.DB.prepare(
          "INSERT INTO table_rows(table_id, org_id, doc_id, owner_user_id, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).bind(table.id, ORG, docId(i), OWNER, JSON.stringify({ grp: i % 10, n: i }), stamp, stamp),
      );
    }
    for (let start = 0; start < statements.length; start += 100) {
      await bindings.DB.batch(statements.slice(start, start + 100));
    }
  }

  it("pages an over-cap table bounded with total=-2 and walks gap-free", async () => {
    await seedLarge("big");
    expect(await call("/api/tables/big/count").then((r) => r.json())).toEqual({ total: -2 });
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 40; page += 1) {
      const query = cursor === null ? "?limit=50" : `?limit=50&cursor=${cursor}`;
      const res = await call(`/api/tables/big/rows${query}`, "GET");
      expect(res.status).toBe(200);
      const body = (await res.json()) as ListBody;
      // Bounded memory: one page plus lookahead, never the whole table.
      expect(body.rows.length).toBeLessThanOrEqual(50);
      expect(body.total).toBe(-2);
      seen.push(...body.rows.map((row) => row.id));
      cursor = body.nextCursor;
      if (!body.hasMore) break;
    }
    expect(seen).toHaveLength(LARGE_ROWS);
    expect(new Set(seen).size).toBe(LARGE_ROWS);
    // Zero-padded ids sort lexicographically, so an in-order walk is sorted.
    expect([...seen].sort()).toEqual(seen);
    expect(seen[0]).toBe(docId(0));
    expect(seen[seen.length - 1]).toBe(docId(LARGE_ROWS - 1));
  });

  it("keeps filtered pages continuous across the full keyset at scale", async () => {
    await seedLarge("bigf");
    // grp=3 matches every tenth row across the whole keyset, so every page
    // boundary lands mid-span and any gap or dupe shows in the walk.
    const expected = Array.from({ length: LARGE_ROWS }, (_, i) => i)
      .filter((i) => i % 10 === 3)
      .map(docId);
    expect(expected.length).toBeGreaterThan(100);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const query = cursor === null ? "?limit=25&filter=grp%3D3" : `?limit=25&cursor=${cursor}&filter=grp%3D3`;
      const res = await call(`/api/tables/bigf/rows${query}`, "GET");
      expect(res.status).toBe(200);
      const body = (await res.json()) as ListBody;
      expect(body.rows.length).toBeLessThanOrEqual(25);
      seen.push(...body.rows.map((row) => row.id));
      cursor = body.nextCursor;
      if (!body.hasMore) break;
    }
    expect(seen).toEqual(expected);
    // The filtered count over an over-cap table stays honest: bounded, not
    // an invented exact total.
    expect(await call("/api/tables/bigf/count?filter=grp%3D3").then((r) => r.json())).toEqual({ total: -2 });
  });

  it("bounds sparse matches to the scan window and reports total=-2", async () => {
    await seedLarge("sparse");
    // A filter whose only match sits past the 1000-row scan window (n=1099
    // lives in row d01099, outside the first window): the bounded walk
    // answers what the window holds and reports total=-2 instead of an
    // invented exact total. Full sparse-match continuation past a filled
    // window is an explicit blocker (docs/upstream-parity.md TABLE-02
    // retention/partitioning policy), not silent success: the -2 says
    // bounded, and list/count pagination semantics stay unchanged.
    const res = await call(`/api/tables/sparse/rows?limit=50&filter=n%3D${LARGE_ROWS - 1}`, "GET");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.rows).toEqual([]);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
    expect(body.total).toBe(-2);
    // Control: an in-window match stays reachable, so the pin targets the
    // window edge, not filtering itself.
    const near = await call("/api/tables/sparse/rows?limit=50&filter=n%3D5", "GET");
    expect(near.status).toBe(200);
    expect(((await near.json()) as ListBody).rows.map((row) => row.id)).toEqual([docId(5)]);
  });

  it("pins the retention-policy bounds behind the recorded decision", async () => {
    // Concrete byte/row/query bounds from the TABLE-02 retention/
    // partitioning policy (docs/upstream-parity.md): any change reopens the
    // recorded decision, so the pins fail closed here first.
    expect(TABLE_DOC_MAX_BYTES).toBe(4096);
    expect(TABLE_QUERY_ROW_CAP).toBe(1000);
    expect(TABLE_BATCH_MAX).toBe(25);
    expect(TABLE_BATCH_BODY_LIMIT).toBe(256_000);
    expect(TABLE_QUERY_LIMIT_MAX).toBe(50);
    expect(TABLE_FILTER_MAX).toBe(5);
    expect(TABLE_DOCUMENT_IDS_MAX).toBe(25);
    expect(TABLE_DOCUMENT_ID_QUERY_MAX).toBe(255);
  });

  it("retains rows without expiry and reclaims only through explicit deletion", async () => {
    await createTable("ledger");
    const first = await call("/api/tables/ledger/rows/batch", "POST", {
      write_mode: "insert",
      items: Array.from({ length: 25 }, (_, i) => ({ id: `k${i}`, data: { n: i } })),
    });
    expect(first.status).toBe(201);
    // Unrelated writes never sweep earlier rows: no TTL, no background purge.
    const second = await call("/api/tables/ledger/rows/batch", "POST", {
      write_mode: "insert",
      items: Array.from({ length: 25 }, (_, i) => ({ id: `j${i}`, data: { n: i } })),
    });
    expect(second.status).toBe(201);
    expect(await call("/api/tables/ledger/count").then((r) => r.json())).toEqual({ total: 50 });
    expect(await call("/api/tables/ledger/rows/k0").then((r) => r.status)).toBe(200);
    // Explicit row deletion reclaims: counts drop and the ids stay gone.
    const removed = await call("/api/tables/ledger/rows/batch-delete", "POST", {
      ids: Array.from({ length: 25 }, (_, i) => `k${i}`),
    });
    expect(await removed.json()).toMatchObject({ count: 25 });
    expect(await call("/api/tables/ledger/count").then((r) => r.json())).toEqual({ total: 25 });
    expect(await call("/api/tables/ledger/rows/k0").then((r) => r.status)).toBe(404);
  });

  it("deleteTable drops every row of an over-cap table", async () => {
    await seedLarge("bulk");
    expect(await call("/api/tables/bulk/count").then((r) => r.json())).toEqual({ total: -2 });
    const table = (await loadTable(bindings.DB, ORG, "bulk"))!;
    expect((await call("/api/tables/bulk", "DELETE")).status).toBe(200);
    const rows = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM table_rows WHERE table_id=?")
      .bind(table.id)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
    expect((await call("/api/tables/bulk/count")).status).toBe(404);
  });
});

describe("TABLE-02 realtime bounded-poll subscriptions (issue #154, ADR 045)", () => {
  interface ChangesBody {
    changes: { id: string; data: Record<string, unknown>; createdAt: string; updatedAt: string; change: string }[];
    hasMore: boolean;
    syncToken: string | null;
  }

  async function poll(query = "", orgId = ORG, userId = OWNER) {
    return call(`/api/tables/live/changes${query}`, "GET", undefined, orgId, userId);
  }

  async function grant(action: string) {
    const res = await call("/api/tables/live/grants", "POST", { action, granteeUserId: OTHER_USER });
    expect(res.status).toBe(200);
  }

  async function revoke(action: string) {
    const res = await call("/api/tables/live/grants", "DELETE", { action, granteeUserId: OTHER_USER });
    expect(res.status).toBe(200);
  }

  async function setRole(role: string) {
    await bindings.DB.prepare("UPDATE org_memberships SET role=? WHERE org_id=? AND user_id=?")
      .bind(role, ORG, OTHER_USER)
      .run();
  }

  beforeEach(async () => {
    await createTable("live");
    for (const id of ["a", "b", "c"]) {
      expect((await putDoc("live", id, { v: id })).status).toBe(201);
    }
  });

  it("walks the revision order across reconnects with no gaps or dupes", async () => {
    // Bounded pages in (updated_at, doc_id) order: ties share a millisecond
    // but the keyset stays exact, so three rows walk 2 + 1 with no overlap.
    const seen: string[] = [];
    let token: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const suffix = token === null ? "?limit=2" : `?sync_token=${encodeURIComponent(token)}&limit=2`;
      const res = await poll(suffix);
      expect(res.status).toBe(200);
      const body = (await res.json()) as ChangesBody;
      expect(body.changes.every((change) => change.change === "upsert")).toBe(true);
      seen.push(...body.changes.map((change) => change.id));
      token = body.syncToken;
      if (!body.hasMore) break;
    }
    expect(new Set(seen).size).toBe(3);
    expect([...seen].sort()).toEqual(["a", "b", "c"]);
    expect(token).not.toBeNull();
    // Reconnecting on the final token is quiet but stays resumable: the
    // empty page echoes the request token instead of null.
    const quiet = await poll(`?sync_token=${encodeURIComponent(token!)}`);
    expect(quiet.status).toBe(200);
    const quietBody = (await quiet.json()) as ChangesBody;
    expect(quietBody.changes).toEqual([]);
    expect(quietBody.hasMore).toBe(false);
    expect(quietBody.syncToken).toBe(token);
    // A write after the quiet poll arrives on the next resume, exactly once.
    expect((await putDoc("live", "d", { v: "d" })).status).toBe(201);
    const resumed = await poll(`?sync_token=${encodeURIComponent(token!)}`);
    expect(((await resumed.json()) as ChangesBody).changes.map((change) => change.id)).toEqual(["d"]);
    // Garbage tokens fail closed: resync from authoritative state, never an
    // invented position.
    const garbage = await poll("?sync_token=not-a-token");
    expect(garbage.status).toBe(400);
    expect(await garbage.json()).toMatchObject({ error: { code: "RESYNC_REQUIRED" } });
    expect(faultCode(() => decodeChangesToken("!!!"))).toBe("RESYNC_REQUIRED");
  });

  it("stamps writes monotonically so no post-cursor write falls behind", async () => {
    // Rapid sequential writes share clock milliseconds but must still sort
    // in commit order: updatedAt strictly increases down the poll order.
    for (const id of ["m1", "m2", "m3", "m4", "m5"]) {
      expect((await putDoc("live", id, { v: id })).status).toBe(201);
    }
    const walked = await poll("?limit=50");
    expect(walked.status).toBe(200);
    const walkedBody = (await walked.json()) as ChangesBody;
    expect(walkedBody.changes).toHaveLength(8);
    const stamps = walkedBody.changes.map((change) => change.updatedAt);
    expect(stamps.every((stamp, i) => i === 0 || stamps[i - 1]! < stamp)).toBe(true);
    // The reported shape: a later single write with a smaller doc_id than
    // the cursor ("late" < "m5") still surfaces on resume — same-millisecond
    // ties can no longer hide it behind the cursor.
    expect((await putDoc("live", "late", { v: "late" })).status).toBe(201);
    const resumed = await poll(`?sync_token=${encodeURIComponent(walkedBody.syncToken!)}`);
    expect(((await resumed.json()) as ChangesBody).changes.map((change) => change.id)).toEqual(["late"]);
  });

  it("binds sync tokens to their table instance", async () => {
    const first = await poll("");
    expect(first.status).toBe(200);
    const token = ((await first.json()) as ChangesBody).syncToken!;
    // Another table rejects the foreign token instead of silently filtering
    // its own rows through a borrowed position.
    await createTable("other");
    expect((await putDoc("other", "z", { v: 1 })).status).toBe(201);
    const foreign = await call(`/api/tables/other/changes?sync_token=${encodeURIComponent(token)}`, "GET");
    expect(foreign.status).toBe(400);
    expect(await foreign.json()).toMatchObject({ error: { code: "RESYNC_REQUIRED" } });
    // Delete-and-recreate under the same name mints a new table id, so the
    // old token fails closed instead of skipping the fresh rows.
    expect((await call("/api/tables/live", "DELETE")).status).toBe(200);
    await createTable("live");
    const stale = await poll(`?sync_token=${encodeURIComponent(token)}`);
    expect(stale.status).toBe(400);
    expect(await stale.json()).toMatchObject({ error: { code: "RESYNC_REQUIRED" } });
    // A pre-binding marker shape (no version/table) fails closed as well.
    const legacy = btoa(JSON.stringify({ updatedAt: new Date().toISOString(), docId: "a" }))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    const legacyRes = await poll(`?sync_token=${encodeURIComponent(legacy)}`);
    expect(legacyRes.status).toBe(400);
    expect(await legacyRes.json()).toMatchObject({ error: { code: "RESYNC_REQUIRED" } });
  });

  it("subscribes from since and fails closed on bad poll strings", async () => {
    const since = new Date(Date.now() - 60_000).toISOString();
    const res = await poll(`?since=${encodeURIComponent(since)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChangesBody;
    // Inclusive of the instant: every row written after T-60s arrives.
    expect(body.changes.map((change) => change.id).sort()).toEqual(["a", "b", "c"]);
    expect(body.syncToken).not.toBeNull();
    const badSince = await poll("?since=not-a-date");
    expect(badSince.status).toBe(400);
    expect(await badSince.json()).toMatchObject({ error: { code: "INVALID_SINCE" } });
    expect(faultCode(() => parseChangesQuery(new URLSearchParams("since=not-a-date")))).toBe("INVALID_SINCE");
    const both = await poll(`?since=${encodeURIComponent(since)}&sync_token=${encodeURIComponent(body.syncToken!)}`);
    expect(both.status).toBe(400);
    expect(await both.json()).toMatchObject({ error: { code: "INVALID_POLL" } });
    const unknown = await poll("?order=asc");
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: { code: "UNSUPPORTED_QUERY" } });
    const badLimit = await poll("?limit=0");
    expect(badLimit.status).toBe(400);
    expect(await badLimit.json()).toMatchObject({ error: { code: "INVALID_LIMIT" } });
    const emptyToken = await poll("?sync_token=");
    expect(emptyToken.status).toBe(400);
    expect(await emptyToken.json()).toMatchObject({ error: { code: "RESYNC_REQUIRED" } });
  });

  it("revokes on the very next poll and re-enters as current state", async () => {
    await grant("read");
    const first = await poll("", ORG, OTHER_USER);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as ChangesBody;
    expect(firstBody.changes).toHaveLength(3);
    const token = firstBody.syncToken!;
    // Leave: revocation denies the next poll like a missing table (404),
    // never an empty feed that confirms the table exists.
    await revoke("read");
    const denied = await poll(`?sync_token=${encodeURIComponent(token)}`, ORG, OTHER_USER);
    expect(denied.status).toBe(404);
    expect(await denied.json()).toMatchObject({ error: { code: "TABLE_NOT_FOUND" } });
    // Enter: a fresh grant returns current state as upserts on resubscribe.
    await grant("read");
    const reentered = await poll("", ORG, OTHER_USER);
    expect(reentered.status).toBe(200);
    expect(((await reentered.json()) as ChangesBody).changes.map((change) => change.id).sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("never broadcasts hidden rows to strangers or other orgs", async () => {
    // Same-org stranger: 404 with the table code, never an empty feed.
    const stranger = await poll("", ORG, OTHER_USER);
    expect(stranger.status).toBe(404);
    expect(await stranger.json()).toMatchObject({ error: { code: "TABLE_NOT_FOUND" } });
    // Cross-Organization names never resolve: the generic 404, never a leak.
    const foreign = await poll("", OTHER_ORG, OWNER);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: { code: "NOT_FOUND", message: "Not found." } });
    // Unknown tables answer the same 404 as hidden ones: no existence oracle.
    expect((await call("/api/tables/missing/changes", "GET")).status).toBe(404);
  });

  it("re-resolves claims every poll: role and grant flips land immediately", async () => {
    await grant("read");
    await grant("insert");
    // Member with grants: writes land and polls read.
    expect((await call("/api/tables/live/rows/fresh", "PUT", { data: { v: 1 } }, ORG, OTHER_USER)).status).toBe(201);
    // Flip to viewer: the ceiling re-resolves on the next evaluation, so no
    // stale member claim permits the write — while the read poll still holds
    // on the intact read grant.
    await setRole("viewer");
    const write = await call("/api/tables/live/rows/fresh2", "PUT", { data: { v: 2 } }, ORG, OTHER_USER);
    expect(write.status).toBe(403);
    expect(await write.json()).toMatchObject({ error: { code: "TABLE_FORBIDDEN" } });
    expect((await poll("", ORG, OTHER_USER)).status).toBe(200);
    // Back to member but with the read grant revoked: the next poll denies
    // on the missing grant — fail closed, no stale read claim.
    await setRole("member");
    await revoke("read");
    expect((await poll("", ORG, OTHER_USER)).status).toBe(404);
  });
});

describe("TABLE-01 Saga exit proof: a Saga reads and writes author rows", () => {
  // Exit criterion for issue #117: a ported Saga can actually use the slice.
  // The fixture is a real code-first Saga definition (stable UUID identity,
  // every durable effect inside step.do) run against real local D1 in workerd
  // with an inline step runner; the Organization context is the Saga
  // caller's own Principal (org-scoped, deny-by-absence), mirroring how the
  // Workflow adapter threads OrgCtx from the immutable Execution row.
  const TABLE_SAGA_ID = "12345678-1234-4234-8234-1234567890ab";
  const inlineStep: SagaStep = {
    do: async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn(),
    sleep: async () => {},
  };

  interface LedgerOutput {
    readonly written: string;
    readonly readBack: Record<string, unknown>;
  }

  const ledgerSaga = defineSaga<LedgerOutput>({
    id: TABLE_SAGA_ID,
    name: "table-ledger-fixture",
    revision: "table-01-proof",
    description: "TABLE-01 exit fixture: write then read one author row.",
    requiredIntegrations: [],
    parse: (value: unknown) => value,
    run: async (ctx: SagaEventContext, step: SagaStep): Promise<LedgerOutput> => {
      const caller: Principal = { orgId: ORG, userId: OWNER };
      const written = await step.do("write-row-v1", async () => {
        const table = await loadTable(ctx.db, caller.orgId, "ledger");
        if (!table) throw new Error("Table ledger is missing.");
        const doc = await insertRow(ctx.db, caller, table, "entry-1", { amount: 7 });
        return doc.id;
      });
      const readBack = await step.do("read-row-v1", async () => {
        const table = await loadTable(ctx.db, caller.orgId, "ledger");
        if (!table) throw new Error("Table ledger is missing.");
        return (await readRow(ctx.db, caller, table, written)).data;
      });
      return { written, readBack };
    },
  });

  it("writes then reads an author row through step.do over real D1", async () => {
    const caller: Principal = { orgId: ORG, userId: OWNER };
    await declareTable(bindings.DB, caller, "ledger");
    const ctx = { executionId: "test-execution", db: bindings.DB, integrations: {}, secrets: {} };
    const output = await ledgerSaga.run(ctx as unknown as SagaEventContext, inlineStep);
    expect(output).toEqual({ written: "entry-1", readBack: { amount: 7 } });
    // The row survives the Saga: a direct domain read sees the same document.
    const table = (await loadTable(bindings.DB, ORG, "ledger"))!;
    expect((await readRow(bindings.DB, caller, table, "entry-1")).data).toEqual({ amount: 7 });
  });

  it("replaces a row through a second Saga pass and keeps deny-by-absence", async () => {
    const caller: Principal = { orgId: ORG, userId: OWNER };
    await declareTable(bindings.DB, caller, "ledger");
    const ctx = { executionId: "test-execution", db: bindings.DB, integrations: {}, secrets: {} };
    await ledgerSaga.run(ctx as unknown as SagaEventContext, inlineStep);
    const revised = await inlineStep.do("replace-row-v1", async () => {
      const table = (await loadTable(bindings.DB, ORG, "ledger"))!;
      return updateRow(bindings.DB, caller, table, "entry-1", { amount: 8 });
    });
    expect(revised.data).toEqual({ amount: 8 });
    // A stranger with no grant still cannot read the Saga's row.
    const stranger: Principal = { orgId: ORG, userId: OTHER_USER };
    const table = (await loadTable(bindings.DB, ORG, "ledger"))!;
    await expect(readRow(bindings.DB, stranger, table, "entry-1")).rejects.toMatchObject({
      code: "TABLE_NOT_FOUND",
    });
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
    expect(faultCode(() => parseBatchRequest({}))).toBe("INVALID_BATCH");
    expect(faultCode(() => parseBatchRequest({ items: ["nope"] }))).toBe("INVALID_BATCH");
    expect(faultCode(() => parseBatchRequest({ items: [{ id: "ok" }] }))).toBe("INVALID_DOCUMENT");
    // Empty batches are valid 0-document canonical writes.
    expect(parseBatchRequest({ items: [] })).toEqual({ mode: "insert", items: [], returnDocuments: true });
    expect(parseBatchRequest({ items: [], write_mode: "replace_upsert" }).mode).toBe("replace_upsert");
    expect(parseBatchRequest({ items: [], upsert: true }).mode).toBe("merge_upsert");
    expect(parseBatchRequest({ items: [], write_mode: "merge_upsert", upsert: false }).mode).toBe("merge_upsert");
    expect(faultCode(() => parseBatchRequest({ items: [], write_mode: "bogus" }))).toBe("INVALID_WRITE_MODE");
    expect(faultCode(() => parseBatchRequest({ items: [], upsert: "yes" }))).toBe("INVALID_BATCH");
    expect(faultCode(() => parseBatchRequest({ items: [], return_documents: "no" }))).toBe("INVALID_BATCH");
    expect(parseBatchRequest({ items: [], return_documents: false }).returnDocuments).toBe(false);
    // Idless rows parse with a null id; the update shim still requires ids.
    expect(parseBatchRequest({ items: [{ data: { n: 1 } }] }).items).toEqual([{ docId: null, data: { n: 1 } }]);
    expect(faultCode(() => parseBatchRequest({ items: [{ data: { n: 1 } }] }, "update"))).toBe("INVALID_BATCH");
    expect(parseBatchRequest({ items: [{ id: "a", data: { n: 1 } }] }, "update").mode).toBe("update");
    expect(lookupPath({ a: { b: 1 } }, "a.b")).toBe(1);
    expect(lookupPath({ a: { b: 1 } }, "a.missing")).toBeUndefined();
    expect(lookupPath({ a: [1, 2] }, "a.0")).toBeUndefined();
    // 25, not upstream's 1000: one request must fit a single batch()
    // transaction inside the 50-query Free invocation budget counting every
    // batched statement (see src/tables.ts header and TABLE-02 parity note).
    expect(TABLE_BATCH_MAX).toBe(25);
    expect(TABLE_QUERY_ROW_CAP).toBe(1000);
  });
});
