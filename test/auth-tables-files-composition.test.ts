// SPDX-License-Identifier: AGPL-3.0
// AUTH-02 tables/files spine composition (issue #143): allowed/denied caller
// matrices across the tables leg (TABLE-01/02) and the files leg (FILE-01),
// hidden-reference 404s, revocation across both legs, and failure/recovery
// proofs. Runs in real workerd with real D1 + R2 bindings; the only doubles
// are LAB fixture identities and the admin list.
//
// Composition rule pinned here (narrow profile, shipped via #522):
// live membership (outer gate) -> org-role ceiling (viewer read-only) ->
// resource policy (table_grants per action / file_policies per location) ->
// deny by absence. The saga/form/app grant engine (`can`, migration 0013)
// is untouched: table/file kinds stay out of it, and listings never grant.
//
// Explicit limits recorded (not fixed by this lane):
// L1. Table grant administration is owner-only: org admins and instance
//     admins hold no implicit table scope and there is no break-glass. An
//     owner who leaves strands their tables; recovery is out of scope here.
// L2. File policy rows are org-wide toggles administered by any active
//     member (ADR 036 v1: no separate author role). The ceiling narrows use,
//     not administration; a viewer toggling a policy row stays inert at use.
// L3. The tables/files legs do not consult membership kind: external members
//     with a grant/policy read and write exactly like operators. External
//     callers can never be admins (outer gate), and viewers stay read-only.
// L4. Revocation converges on the next request. Already-delivered bytes are
//     unaffected; policy revocation deletes the matching capability rows so
//     outstanding tokens answer unknown (401) at use time. A capability row
//     that survives policy loss still re-checks policy on every use
//     (upload 403, download 404 non-disclosure).
// L5. Realtime is bounded revision polling only (ADR 045): every poll
//     re-resolves the stack fresh, denied polls answer 404 like a missing
//     table, deletes never emit. No push transport and no TRG-03 event-log
//     writes (deferred to TRG-03/OBS-02).
// L6. Retention is explicit deletion only (delete table / delete file /
//     delete location): no TTL, partition, or sweeper redesign (deferred).
// L7. Free-tier fit: Worker + D1 + the provisioned FILES R2 bucket only;
//     per-request point reads, bounded batches (25 table docs, 100 file
//     entries), no new primitive.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration4 from "../migrations/0004_solutions_install.sql?raw";
import migration5 from "../migrations/0005_forms.sql?raw";
import migration6 from "../migrations/0006_apps.sql?raw";
import migration7 from "../migrations/0007_org_membership.sql?raw";
import migration8 from "../migrations/0008_executions_org_fk.sql?raw";
import migrationTables from "../migrations/0009_tables.sql?raw";
import migrationPolicies from "../migrations/0012_saga_policies.sql?raw";
import migrationRoles from "../migrations/0013_resource_roles.sql?raw";
import migrationFiles from "../migrations/0019_files.sql?raw";
import migrationOrgRoles from "../migrations/0039_org_roles.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const ORG_A = "00000000-0000-4000-8000-000000000001";
const ORG_B = "00000000-0000-4000-8000-00000000000b";
const USER_ADMIN = "00000000-0000-4000-8000-000000000002";
const USER_OWNER = "00000000-0000-4000-8000-000000000021";
const USER_OP = "00000000-0000-4000-8000-000000000022";
const USER_VIEWER = "00000000-0000-4000-8000-000000000023";
const USER_EXT = "00000000-0000-4000-8000-000000000024";
const USER_B = "00000000-0000-4000-8000-000000000025";
const USER_STRANGER = "00000000-0000-4000-8000-000000000026";
const USER_INSTANCE = "00000000-0000-4000-8000-000000000027";
const ADMINS = `${USER_ADMIN},${USER_INSTANCE}`;

type Body = Record<string, unknown>;

function authed(path: string, method: string, body?: unknown, orgId?: string) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    ...(orgId === undefined ? {} : { "X-Organization-Id": orgId }),
  };
  return new Request(`https://local.test${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function call(path: string, method: string, userId: string, body?: unknown, orgId: string = ORG_A) {
  const b = { ...bindings, LAB_USER_ID: userId, LAB_FIXTURE_USER_ID: USER_ADMIN, ADMIN_USER_IDS: ADMINS };
  const res = await worker.fetch(authed(path, method, body, orgId), b);
  return { status: res.status, body: (await res.json()) as Body };
}

async function invite(userId: string, role: string, kind?: string) {
  const res = await call(
    `/api/orgs/${ORG_A}/members`,
    "POST",
    USER_ADMIN,
    kind === undefined ? { userId, role } : { userId, role, kind },
  );
  expect(res.status).toBe(201);
}

async function grantTable(table: string, action: string, grantee: string, owner: string = USER_OWNER) {
  const res = await call(`/api/tables/${table}/grants`, "POST", owner, { action, granteeUserId: grantee });
  expect(res.status).toBe(200);
}

interface SlotEntry {
  readonly path: string;
  readonly allowed: boolean;
  readonly token?: string;
  readonly expiresAt?: string;
  readonly code?: string;
}

async function issuance(
  route: "/api/files/uploads" | "/api/files/downloads",
  userId: string,
  entries: { location: string; path: string }[],
  orgId: string = ORG_A,
): Promise<{ status: number; entries: SlotEntry[] }> {
  const res = await call(route, "POST", userId, { entries }, orgId);
  return { status: res.status, entries: (res.body.entries ?? []) as SlotEntry[] };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(migration4);
  await bindings.DB.exec(seed);
  await bindings.DB.exec(migration5);
  await bindings.DB.exec(migration6);
  await bindings.DB.exec(migration7);
  await bindings.DB.exec(migration8);
  await bindings.DB.exec(migrationTables);
  await bindings.DB.exec(migrationPolicies);
  await bindings.DB.exec(migrationRoles);
  await bindings.DB.exec(migrationFiles);
  await bindings.DB.exec(migrationOrgRoles);
  // Second organization for cross-org hidden-reference proofs. USER_B is an
  // operator there and nowhere else; USER_INSTANCE stays an instance admin
  // with no membership anywhere (recovery scope, limit L1).
  const stamp = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?)").bind(ORG_B, "Second org").run();
  for (const user of [USER_B]) {
    await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
      .bind(user, stamp)
      .run();
  }
  await bindings.DB.prepare(
    "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?, 'operator','active','ordinary',?,?)",
  )
    .bind(ORG_B, USER_B, stamp, stamp)
    .run();
  // Matrix identities in ORG_A. USER_ADMIN is org admin (LAB bootstrap) and
  // instance admin (ADMIN_USER_IDS). Stranger and instance rows are never
  // invited: stranger stays unknown, instance stays membership-free.
  await invite(USER_OWNER, "operator");
  await invite(USER_OP, "operator");
  await invite(USER_VIEWER, "viewer");
  await invite(USER_EXT, "operator", "external");
});

afterEach(async () => {
  await reset();
});

it("tables allowed/denied matrix: grants open every path, absence closes it", async () => {
  expect(await call("/api/tables", "POST", USER_OWNER, { name: "mx" })).toMatchObject({ status: 201 });
  // Owner holds every action implicitly: single row, query, count, batch,
  // and the bounded poll all serve.
  expect(await call("/api/tables/mx/rows/r1", "PUT", USER_OWNER, { data: { v: 1 } })).toMatchObject({ status: 201 });
  expect(await call("/api/tables/mx/rows/r1", "GET", USER_OWNER)).toMatchObject({
    status: 200,
    body: { row: { data: { v: 1 } } },
  });
  expect(await call("/api/tables/mx/rows", "GET", USER_OWNER)).toMatchObject({
    status: 200,
    body: { total: 1 },
  });
  expect(await call("/api/tables/mx/count", "GET", USER_OWNER)).toMatchObject({
    status: 200,
    body: { total: 1 },
  });
  expect(
    await call("/api/tables/mx/rows/batch", "POST", USER_OWNER, {
      write_mode: "insert",
      items: [{ id: "b1", data: { v: 2 } }],
    }),
  ).toMatchObject({ status: 201, body: { count: 1 } });
  const poll = await call("/api/tables/mx/changes", "GET", USER_OWNER);
  expect(poll.status).toBe(200);
  expect((poll.body.changes as unknown[]).length).toBeGreaterThan(0);
  expect(typeof poll.body.syncToken).toBe("string");
  // Zero grants: writes deny closed on the known reference, reads deny as
  // missing, and the batch denies before writing anything.
  expect(await call("/api/tables/mx/rows/r9", "PUT", USER_OP, { data: { v: 9 } })).toMatchObject({
    status: 403,
    body: { error: { code: "TABLE_FORBIDDEN" } },
  });
  expect(await call("/api/tables/mx/rows/r1", "GET", USER_OP)).toMatchObject({
    status: 404,
    body: { error: { code: "TABLE_NOT_FOUND" } },
  });
  expect(await call("/api/tables/mx/rows", "GET", USER_OP)).toMatchObject({ status: 404 });
  expect(await call("/api/tables/mx/count", "GET", USER_OP)).toMatchObject({ status: 404 });
  expect(await call("/api/tables/mx/changes", "GET", USER_OP)).toMatchObject({ status: 404 });
  expect(
    await call("/api/tables/mx/rows/batch", "POST", USER_OP, {
      write_mode: "insert",
      items: [{ id: "b9", data: { v: 9 } }],
    }),
  ).toMatchObject({ status: 403, body: { error: { code: "TABLE_BATCH_DENIED" } } });
  expect(await call("/api/tables/mx", "GET", USER_OP)).toMatchObject({
    status: 404,
    body: { error: { code: "NOT_FOUND" } },
  });
  expect(await call("/api/tables/mx", "DELETE", USER_OP)).toMatchObject({
    status: 403,
    body: { error: { code: "TABLE_FORBIDDEN" } },
  });
  expect(
    await call("/api/tables/mx/grants", "POST", USER_OP, { action: "read", granteeUserId: USER_OP }),
  ).toMatchObject({ status: 403, body: { error: { code: "TABLE_FORBIDDEN" } } });
  // Listings never grant: the ungranted operator's list omits the table.
  const listed = await call("/api/tables", "GET", USER_OP);
  expect(listed.status).toBe(200);
  expect((listed.body.tables as { name: string }[]).map((t) => t.name)).not.toContain("mx");
  // The denied batch wrote nothing: the owner still counts exactly r1 + b1.
  expect(await call("/api/tables/mx/count", "GET", USER_OWNER)).toMatchObject({
    status: 200,
    body: { total: 2 },
  });
  // Per-action grants open exactly their paths: read, insert, update, delete.
  for (const action of ["read", "insert", "update", "delete"]) await grantTable("mx", action, USER_OP);
  expect(await call("/api/tables/mx/rows/r2", "PUT", USER_OP, { data: { v: 3 } })).toMatchObject({ status: 201 });
  expect(await call("/api/tables/mx/rows/r2", "GET", USER_OP)).toMatchObject({ status: 200 });
  expect(await call("/api/tables/mx/rows/r2", "PATCH", USER_OP, { data: { v: 4 } })).toMatchObject({ status: 200 });
  expect(await call("/api/tables/mx/rows", "GET", USER_OP)).toMatchObject({ status: 200 });
  expect(await call("/api/tables/mx/count", "GET", USER_OP)).toMatchObject({ status: 200 });
  expect(
    await call("/api/tables/mx/rows/batch", "POST", USER_OP, {
      write_mode: "insert",
      items: [{ id: "b2", data: { v: 5 } }],
    }),
  ).toMatchObject({ status: 201, body: { count: 1 } });
  expect(await call("/api/tables/mx/changes", "GET", USER_OP)).toMatchObject({ status: 200 });
  expect(await call("/api/tables/mx", "GET", USER_OP)).toMatchObject({ status: 200 });
  expect(await call("/api/tables/mx/rows/r2", "DELETE", USER_OP)).toMatchObject({ status: 200 });
});

it("tables admin/external/instance rows plus hidden-reference 404s", async () => {
  expect(await call("/api/tables", "POST", USER_OWNER, { name: "mx" })).toMatchObject({ status: 201 });
  expect(await call("/api/tables/mx/rows/r1", "PUT", USER_OWNER, { data: { v: 1 } })).toMatchObject({ status: 201 });
  await grantTable("mx", "read", USER_EXT);
  // Org admin without a grant: no implicit scope on the tables leg (L1).
  // Writes deny closed, reads deny as missing, the list omits the table.
  expect(await call("/api/tables/mx/rows/rx", "PUT", USER_ADMIN, { data: { v: 1 } })).toMatchObject({
    status: 403,
    body: { error: { code: "TABLE_FORBIDDEN" } },
  });
  expect(await call("/api/tables/mx/rows/r1", "GET", USER_ADMIN)).toMatchObject({ status: 404 });
  expect(await call("/api/tables/mx", "GET", USER_ADMIN)).toMatchObject({ status: 404 });
  const adminList = await call("/api/tables", "GET", USER_ADMIN);
  expect((adminList.body.tables as { name: string }[]).map((t) => t.name)).not.toContain("mx");
  // Instance admin with no membership: recovery scope is org management, not
  // implicit table scope (L1). Same denials, never a leak.
  expect(await call("/api/tables/mx/rows/rx", "PUT", USER_INSTANCE, { data: { v: 1 } })).toMatchObject({
    status: 403,
  });
  expect(await call("/api/tables/mx/rows/r1", "GET", USER_INSTANCE)).toMatchObject({ status: 404 });
  // External members use the same grant path as operators (L3): the read
  // grant serves, the missing insert grant denies closed.
  expect(await call("/api/tables/mx/rows/r1", "GET", USER_EXT)).toMatchObject({ status: 200 });
  expect(await call("/api/tables/mx/rows/rx", "PUT", USER_EXT, { data: { v: 1 } })).toMatchObject({
    status: 403,
    body: { error: { code: "TABLE_FORBIDDEN" } },
  });
  // Viewer ceiling precedes the grant layer: a read grant serves reads and
  // the poll, while writes stay denied even with an explicit grant row.
  await grantTable("mx", "read", USER_VIEWER);
  await grantTable("mx", "insert", USER_VIEWER);
  expect(await call("/api/tables/mx/rows/r1", "GET", USER_VIEWER)).toMatchObject({ status: 200 });
  expect(await call("/api/tables/mx/changes", "GET", USER_VIEWER)).toMatchObject({ status: 200 });
  expect(await call("/api/tables/mx/rows/rx", "PUT", USER_VIEWER, { data: { v: 1 } })).toMatchObject({
    status: 403,
    body: { error: { code: "TABLE_FORBIDDEN" } },
  });
  // Hidden references: unknown names 404, cross-org access 404s at the
  // outer membership gate, and same-named tables stay org-isolated.
  expect(await call("/api/tables/no-such-table", "GET", USER_OP)).toMatchObject({
    status: 404,
    body: { error: { code: "NOT_FOUND" } },
  });
  expect(await call("/api/tables/mx/rows/r1", "GET", USER_OP, undefined, ORG_B)).toMatchObject({ status: 404 });
  expect(await call("/api/tables/mx", "GET", USER_B, undefined, ORG_A)).toMatchObject({ status: 404 });
  expect(await call("/api/tables", "POST", USER_B, { name: "mx" }, ORG_B)).toMatchObject({ status: 201 });
  expect(await call("/api/tables/mx/rows/r1", "GET", USER_B, undefined, ORG_B)).toMatchObject({ status: 404 });
  expect(await call("/api/tables/mx/rows/r1", "GET", USER_STRANGER)).toMatchObject({ status: 404 });
  expect(await call("/api/tables", "GET", USER_STRANGER)).toMatchObject({ status: 404 });
});

it("tables revocation converges on the next request, including the poll", async () => {
  expect(await call("/api/tables", "POST", USER_OWNER, { name: "rev" })).toMatchObject({ status: 201 });
  expect(await call("/api/tables/rev/rows/r1", "PUT", USER_OWNER, { data: { v: 1 } })).toMatchObject({ status: 201 });
  await grantTable("rev", "read", USER_OP);
  await grantTable("rev", "insert", USER_OP);
  expect(await call("/api/tables/rev/rows/r1", "GET", USER_OP)).toMatchObject({ status: 200 });
  expect(await call("/api/tables/rev/changes", "GET", USER_OP)).toMatchObject({ status: 200 });
  // Revoking read denies reads, query, count, detail, and the next poll —
  // no snapshot survives across polls — while the retained insert grant
  // keeps serving (per-action granularity).
  expect(await call("/api/tables/rev/grants", "DELETE", USER_OWNER, { action: "read", granteeUserId: USER_OP }))
    .toMatchObject({ status: 200, body: { revoked: true } });
  expect(await call("/api/tables/rev/rows/r1", "GET", USER_OP)).toMatchObject({ status: 404 });
  expect(await call("/api/tables/rev/rows", "GET", USER_OP)).toMatchObject({ status: 404 });
  expect(await call("/api/tables/rev/count", "GET", USER_OP)).toMatchObject({ status: 404 });
  expect(await call("/api/tables/rev/changes", "GET", USER_OP)).toMatchObject({ status: 404 });
  // Detail visibility follows any-grant (issue #353): the retained insert
  // grant still shows the declaration even though reads deny as missing.
  expect(await call("/api/tables/rev", "GET", USER_OP)).toMatchObject({ status: 200 });
  expect(await call("/api/tables/rev/rows/r2", "PUT", USER_OP, { data: { v: 2 } })).toMatchObject({ status: 201 });
  // Revoking insert denies single and batch writes without touching rows,
  // and the last grant takes detail visibility with it.
  expect(await call("/api/tables/rev/grants", "DELETE", USER_OWNER, { action: "insert", granteeUserId: USER_OP }))
    .toMatchObject({ status: 200, body: { revoked: true } });
  expect(await call("/api/tables/rev", "GET", USER_OP)).toMatchObject({ status: 404 });
  expect(await call("/api/tables/rev/rows/r3", "PUT", USER_OP, { data: { v: 3 } })).toMatchObject({
    status: 403,
    body: { error: { code: "TABLE_FORBIDDEN" } },
  });
  expect(
    await call("/api/tables/rev/rows/batch", "POST", USER_OP, {
      write_mode: "insert",
      items: [{ id: "b3", data: { v: 3 } }],
    }),
  ).toMatchObject({ status: 403, body: { error: { code: "TABLE_BATCH_DENIED" } } });
  expect(await call("/api/tables/rev/count", "GET", USER_OWNER)).toMatchObject({
    status: 200,
    body: { total: 2 },
  });
  // Non-owners cannot revoke, and revoking a missing grant converges
  // silently instead of inventing a distinguisher.
  expect(await call("/api/tables/rev/grants", "DELETE", USER_OP, { action: "read", granteeUserId: USER_OP }))
    .toMatchObject({ status: 403, body: { error: { code: "TABLE_FORBIDDEN" } } });
  expect(await call("/api/tables/rev/grants", "DELETE", USER_OWNER, { action: "read", granteeUserId: USER_OP }))
    .toMatchObject({ status: 200, body: { revoked: true } });
  // Owner deletion purges rows and grants: recreating the name starts from
  // deny-by-absence with no grant residue.
  expect(await call("/api/tables/rev", "DELETE", USER_OWNER)).toMatchObject({ status: 200 });
  expect(await call("/api/tables/rev", "GET", USER_OWNER)).toMatchObject({ status: 404 });
  expect(await call("/api/tables", "POST", USER_OWNER, { name: "rev" })).toMatchObject({ status: 201 });
  expect(await call("/api/tables/rev/rows", "GET", USER_OP)).toMatchObject({ status: 404 });
  expect(await call("/api/tables/rev/count", "GET", USER_OWNER)).toMatchObject({
    status: 200,
    body: { total: 0 },
  });
});

it("tables failure/recovery: oversized batches fail closed, conflicts recover", async () => {
  expect(await call("/api/tables", "POST", USER_OWNER, { name: "fx" })).toMatchObject({ status: 201 });
  // 26 documents exceed the 25-document bound: the whole request fails
  // before policy preflight and persists nothing (L7).
  const oversized = Array.from({ length: 26 }, (_, i) => ({ id: `d${i}`, data: { v: i } }));
  expect(await call("/api/tables/fx/rows/batch", "POST", USER_OWNER, { write_mode: "insert", items: oversized }))
    .toMatchObject({ status: 400, body: { error: { code: "INVALID_BATCH" } } });
  expect(await call("/api/tables/fx/count", "GET", USER_OWNER)).toMatchObject({
    status: 200,
    body: { total: 0 },
  });
  // Conflicting single insert reports 409; update recovers; delete closes.
  expect(await call("/api/tables/fx/rows/d1", "PUT", USER_OWNER, { data: { v: 1 } })).toMatchObject({ status: 201 });
  expect(await call("/api/tables/fx/rows/d1", "PUT", USER_OWNER, { data: { v: 2 } })).toMatchObject({
    status: 409,
    body: { error: { code: "DOCUMENT_CONFLICT" } },
  });
  expect(await call("/api/tables/fx/rows/d1", "PATCH", USER_OWNER, { data: { v: 2 } })).toMatchObject({
    status: 200,
    body: { row: { data: { v: 2 } } },
  });
  expect(await call("/api/tables/fx/rows/d1", "DELETE", USER_OWNER)).toMatchObject({ status: 200 });
  expect(await call("/api/tables/fx/rows/d1", "GET", USER_OWNER)).toMatchObject({
    status: 404,
    body: { error: { code: "DOCUMENT_NOT_FOUND" } },
  });
  expect(await call("/api/tables/fx/rows/d1", "PATCH", USER_OWNER, { data: { v: 3 } })).toMatchObject({
    status: 404,
  });
  expect(await call("/api/tables/fx/rows/d1", "DELETE", USER_OWNER)).toMatchObject({ status: 404 });
  // Upsert composes both grants fail-closed: insert-only callers must not
  // gain update power through the upsert path, and vice versa.
  await grantTable("fx", "insert", USER_OP);
  expect(
    await call("/api/tables/fx/rows/batch", "POST", USER_OP, {
      write_mode: "merge_upsert",
      items: [{ id: "m1", data: { v: 1 } }],
    }),
  ).toMatchObject({ status: 403, body: { error: { code: "TABLE_BATCH_DENIED" } } });
  expect(await call("/api/tables/fx/count", "GET", USER_OWNER)).toMatchObject({
    status: 200,
    body: { total: 0 },
  });
  await grantTable("fx", "update", USER_OP);
  expect(
    await call("/api/tables/fx/rows/batch", "POST", USER_OP, {
      write_mode: "merge_upsert",
      items: [{ id: "m1", data: { v: 1 } }],
    }),
  ).toMatchObject({ status: 201, body: { count: 1 } });
  // Operational per-item outcomes are not denials: one conflict plus one
  // fresh write reports per-index results with an ok count.
  const mixed = await call("/api/tables/fx/rows/batch", "POST", USER_OP, {
    write_mode: "insert",
    items: [
      { id: "m1", data: { v: 9 } },
      { id: "m2", data: { v: 9 } },
    ],
  });
  expect(mixed.status).toBe(201);
  expect(mixed.body.count).toBe(1);
  const results = mixed.body.results as { docId: string; ok: boolean; error: { code: string } | null }[];
  expect(results[0]).toMatchObject({ docId: "m1", ok: false, error: { code: "DOCUMENT_CONFLICT" } });
  expect(results[1]).toMatchObject({ docId: "m2", ok: true, error: null });
  // Batch delete denies without the delete grant, then deletes exactly once.
  expect(await call("/api/tables/fx/rows/batch-delete", "POST", USER_OP, { ids: ["m1", "m2"] })).toMatchObject({
    status: 403,
    body: { error: { code: "TABLE_BATCH_DENIED" } },
  });
  await grantTable("fx", "delete", USER_OP);
  // The compatibility alias answers 200 (the canonical batch write answers
  // 201); the count still reflects unique physical deletions.
  expect(await call("/api/tables/fx/rows/batch-delete", "POST", USER_OP, { ids: ["m1", "m2", "missing"] }))
    .toMatchObject({ status: 200, body: { count: 2 } });
});

it("files allowed/denied matrix: issuance, delivery, policy, and listing", async () => {
  expect(await call("/api/file-locations", "POST", USER_OP, { name: "mx" })).toMatchObject({ status: 201 });
  // Creation mints the org-wide read/write/delete policy rows.
  const detail = await call("/api/file-locations/mx", "GET", USER_OP);
  expect(detail.status).toBe(200);
  expect(((detail.body.policies ?? []) as { action: string }[]).map((p) => p.action).sort()).toEqual([
    "delete",
    "read",
    "write",
  ]);
  // Upload issuance serves operators, external members, and org admins
  // alike: the files leg keys on policy rows, not ownership (L2/L3).
  for (const user of [USER_OP, USER_EXT, USER_ADMIN]) {
    const slot = await issuance("/api/files/uploads", user, [{ location: "mx", path: `${user.slice(-4)}.txt` }]);
    expect(slot.status).toBe(200);
    expect(slot.entries[0]?.allowed).toBe(true);
    expect(typeof slot.entries[0]?.token).toBe("string");
    expect(Date.parse(slot.entries[0]?.expiresAt ?? "")).toBeGreaterThan(Date.now());
  }
  // Viewers cannot mint upload slots even with the write policy row present.
  const viewerDenied = await issuance("/api/files/uploads", USER_VIEWER, [{ location: "mx", path: "v.txt" }]);
  expect(viewerDenied.status).toBe(207);
  expect(viewerDenied.entries).toEqual([{ path: "v.txt", allowed: false, code: "FORBIDDEN", message: "Forbidden." }]);
  // Unknown locations answer 404 before policy evaluation on both issuance
  // legs, and strangers deny at the outer membership gate.
  const unknownUp = await issuance("/api/files/uploads", USER_OP, [{ location: "no-such-place", path: "a.txt" }]);
  expect(unknownUp.status).toBe(207);
  expect(unknownUp.entries[0]).toMatchObject({ allowed: false, code: "NOT_FOUND" });
  const unknownDown = await issuance("/api/files/downloads", USER_OP, [{ location: "no-such-place", path: "a.txt" }]);
  expect(unknownDown.status).toBe(207);
  expect(unknownDown.entries[0]).toMatchObject({ allowed: false, code: "NOT_FOUND" });
  expect(await call("/api/file-locations/no-such-place", "GET", USER_OP)).toMatchObject({ status: 404 });
  expect((await issuance("/api/files/uploads", USER_STRANGER, [{ location: "mx", path: "s.txt" }])).status).toBe(404);
  expect(await call("/api/file-locations/mx", "GET", USER_STRANGER)).toMatchObject({ status: 404 });
  // Seed one ready row: download issuance serves operators and viewers
  // (read-class under policy), and Bearer delivery returns the bytes.
  const stamp = new Date().toISOString();
  await bindings.DB.prepare(
    "INSERT INTO files(org_id,location,path,version,size,content_type,sha256,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'ready',?,?)",
  )
    .bind(ORG_A, "mx", "ready.txt", 1, 5, "text/plain", "0".repeat(64), stamp, stamp)
    .run();
  for (const user of [USER_OP, USER_VIEWER]) {
    const slot = await issuance("/api/files/downloads", user, [{ location: "mx", path: "ready.txt" }]);
    expect(slot.status).toBe(200);
    expect(slot.entries[0]?.allowed).toBe(true);
  }
  // Structural listing serves under the read policy and stays org-scoped:
  // revoking read hides the listing as 404, re-granting restores it.
  expect(await call("/api/files?location=mx", "GET", USER_OP)).toMatchObject({ status: 200 });
  expect(await call("/api/file-policies", "DELETE", USER_OP, { location: "mx", action: "read" })).toMatchObject({
    status: 200,
  });
  expect(await call("/api/files?location=mx", "GET", USER_OP)).toMatchObject({ status: 404 });
  expect(await call("/api/file-policies", "POST", USER_OP, { location: "mx", action: "read" })).toMatchObject({
    status: 201,
  });
  expect(await call("/api/files?location=mx", "GET", USER_OP)).toMatchObject({ status: 200 });
  // Delete is an action: viewers deny, operators proceed with the version.
  expect(
    await call("/api/files", "DELETE", USER_VIEWER, { location: "mx", path: "ready.txt", expectedVersion: 1 }),
  ).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN" } } });
  expect(
    await call("/api/files", "DELETE", USER_OP, { location: "mx", path: "ready.txt", expectedVersion: 1 }),
  ).toMatchObject({ status: 200 });
});

it("files revocation stops outstanding capabilities at use time, then re-grant recovers", async () => {
  expect(await call("/api/file-locations", "POST", USER_OP, { name: "rk" })).toMatchObject({ status: 201 });
  // Full roundtrip to a ready row, then mint one outstanding slot per leg.
  const bytes = new TextEncoder().encode("revocable");
  const digest = await sha256Hex(bytes);
  const up = await issuance("/api/files/uploads", USER_OP, [{ location: "rk", path: "ready.txt" }]);
  expect(up.status).toBe(200);
  const put = await worker.fetch(
    new Request(`https://local.test/api/files/content?token=${up.entries[0]?.token}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "text/plain" },
      body: bytes as Uint8Array<ArrayBuffer>,
    }),
    { ...bindings, LAB_USER_ID: USER_OP, LAB_FIXTURE_USER_ID: USER_ADMIN, ADMIN_USER_IDS: ADMINS },
  );
  expect(put.status).toBe(200);
  expect(
    await call("/api/files/finalize", "POST", USER_OP, {
      location: "rk",
      path: "ready.txt",
      contentType: "text/plain",
      size: bytes.byteLength,
      sha256: digest,
    }),
  ).toMatchObject({ status: 200 });
  const pending = await issuance("/api/files/uploads", USER_OP, [{ location: "rk", path: "next.txt" }]);
  const down = await issuance("/api/files/downloads", USER_OP, [{ location: "rk", path: "ready.txt" }]);
  expect(pending.status).toBe(200);
  expect(down.status).toBe(200);
  // Revoking write deletes the matching capability rows, so the
  // outstanding upload token is unknown at use time (401) — and new
  // issuance closes with 403 per entry.
  expect(await call("/api/file-policies", "DELETE", USER_OP, { location: "rk", action: "write" })).toMatchObject({
    status: 200,
  });
  const usedPut = await worker.fetch(
    new Request(`https://local.test/api/files/content?token=${pending.entries[0]?.token}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "text/plain" },
      body: bytes as Uint8Array<ArrayBuffer>,
    }),
    { ...bindings, LAB_USER_ID: USER_OP, LAB_FIXTURE_USER_ID: USER_ADMIN, ADMIN_USER_IDS: ADMINS },
  );
  expect(usedPut.status).toBe(401);
  const closedUp = await issuance("/api/files/uploads", USER_OP, [{ location: "rk", path: "next.txt" }]);
  expect(closedUp.status).toBe(207);
  expect(closedUp.entries[0]).toMatchObject({ allowed: false, code: "FORBIDDEN" });
  // Revoking read deletes the download capability the same way (401 at use,
  // 404 non-disclosure on new issuance); the policy access-test agrees
  // without issuing.
  expect(await call("/api/file-policies", "DELETE", USER_OP, { location: "rk", action: "read" })).toMatchObject({
    status: 200,
  });
  const usedGet = await worker.fetch(
    new Request(`https://local.test/api/files/content?token=${down.entries[0]?.token}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${TOKEN}` },
    }),
    { ...bindings, LAB_USER_ID: USER_OP, LAB_FIXTURE_USER_ID: USER_ADMIN, ADMIN_USER_IDS: ADMINS },
  );
  expect(usedGet.status).toBe(401);
  const closedDown = await issuance("/api/files/downloads", USER_OP, [{ location: "rk", path: "ready.txt" }]);
  expect(closedDown.status).toBe(207);
  expect(closedDown.entries[0]).toMatchObject({ allowed: false, code: "NOT_FOUND" });
  expect(
    await call("/api/file-policies/test", "POST", USER_OP, { location: "rk", path: "ready.txt", action: "read" }),
  ).toMatchObject({ status: 200, body: { access: { allowed: false } } });
  // Revocation deletes the matching capability rows (L4): nothing lingers
  // to reactivate on re-grant.
  const caps = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM file_capabilities WHERE org_id=?")
    .bind(ORG_A)
    .first<{ n: number }>();
  expect(caps?.n ?? -1).toBe(0);
  // Defense in depth: a capability row that survives policy loss still
  // re-checks policy on every use. Remove the policy rows directly (no
  // capability cleanup) and prove the surviving tokens stop closed.
  expect(await call("/api/file-policies", "POST", USER_OP, { location: "rk", action: "write" })).toMatchObject({
    status: 201,
  });
  expect(await call("/api/file-policies", "POST", USER_OP, { location: "rk", action: "read" })).toMatchObject({
    status: 201,
  });
  const survivingUp = await issuance("/api/files/uploads", USER_OP, [{ location: "rk", path: "survive.txt" }]);
  const survivingDown = await issuance("/api/files/downloads", USER_OP, [{ location: "rk", path: "ready.txt" }]);
  expect(survivingUp.status).toBe(200);
  expect(survivingDown.status).toBe(200);
  await bindings.DB.prepare("DELETE FROM file_policies WHERE org_id=? AND location=?")
    .bind(ORG_A, "rk")
    .run();
  const stoppedPut = await worker.fetch(
    new Request(`https://local.test/api/files/content?token=${survivingUp.entries[0]?.token}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "text/plain" },
      body: bytes as Uint8Array<ArrayBuffer>,
    }),
    { ...bindings, LAB_USER_ID: USER_OP, LAB_FIXTURE_USER_ID: USER_ADMIN, ADMIN_USER_IDS: ADMINS },
  );
  expect(stoppedPut.status).toBe(403);
  const stoppedGet = await worker.fetch(
    new Request(`https://local.test/api/files/content?token=${survivingDown.entries[0]?.token}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${TOKEN}` },
    }),
    { ...bindings, LAB_USER_ID: USER_OP, LAB_FIXTURE_USER_ID: USER_ADMIN, ADMIN_USER_IDS: ADMINS },
  );
  expect(stoppedGet.status).toBe(404);
  // Re-granting recovers both legs on fresh slots.
  expect(await call("/api/file-policies", "POST", USER_OP, { location: "rk", action: "write" })).toMatchObject({
    status: 201,
  });
  expect(await call("/api/file-policies", "POST", USER_OP, { location: "rk", action: "read" })).toMatchObject({
    status: 201,
  });
  expect((await issuance("/api/files/uploads", USER_OP, [{ location: "rk", path: "next.txt" }])).status).toBe(200);
  expect((await issuance("/api/files/downloads", USER_OP, [{ location: "rk", path: "ready.txt" }])).status).toBe(200);
  expect(
    await call("/api/file-policies/test", "POST", USER_OP, { location: "rk", path: "ready.txt", action: "read" }),
  ).toMatchObject({ status: 200, body: { access: { allowed: true } } });
});

it("files failure/recovery: version fences, finalize mismatch, location lifecycle", async () => {
  expect(await call("/api/file-locations", "POST", USER_OP, { name: "fy", maxBytes: 16 })).toMatchObject({
    status: 201,
  });
  const bytes = new TextEncoder().encode("v1-bytes");
  const digest = await sha256Hex(bytes);
  async function roundtrip(path: string, content: Uint8Array, expectedVersion?: number, user: string = USER_OP) {
    const slot = await issuance("/api/files/uploads", user, [{ location: "fy", path }]);
    expect(slot.status).toBe(200);
    const put = await worker.fetch(
      new Request(`https://local.test/api/files/content?token=${slot.entries[0]?.token}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "text/plain" },
        body: content as Uint8Array<ArrayBuffer>,
      }),
      { ...bindings, LAB_USER_ID: user, LAB_FIXTURE_USER_ID: USER_ADMIN, ADMIN_USER_IDS: ADMINS },
    );
    expect(put.status).toBe(200);
    return call("/api/files/finalize", "POST", user, {
      location: "fy",
      path,
      contentType: "text/plain",
      size: content.byteLength,
      sha256: await sha256Hex(content),
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    });
  }
  expect(await roundtrip("ok.txt", bytes)).toMatchObject({ status: 200, body: { file: { version: 1 } } });
  // Overwriting without the version fences 409; with the version recovers.
  expect(await roundtrip("ok.txt", bytes)).toMatchObject({
    status: 409,
    body: { error: { code: "VERSION_CONFLICT" } },
  });
  expect(await roundtrip("ok.txt", bytes, 1)).toMatchObject({ status: 200, body: { file: { version: 2 } } });
  // Delete fences the same way: stale versions 409, correct deletes, a
  // second delete reports the file missing.
  expect(await call("/api/files", "DELETE", USER_OP, { location: "fy", path: "ok.txt", expectedVersion: 99 }))
    .toMatchObject({ status: 409, body: { error: { code: "VERSION_CONFLICT" } } });
  expect(await call("/api/files", "DELETE", USER_OP, { location: "fy", path: "ok.txt", expectedVersion: 2 }))
    .toMatchObject({ status: 200 });
  expect(await call("/api/files", "DELETE", USER_OP, { location: "fy", path: "ok.txt", expectedVersion: 2 }))
    .toMatchObject({ status: 409, body: { error: { code: "FILE_MISSING" } } });
  // Finalize mismatch discards the staged bytes and the pending row: the
  // retry reports missing, and a clean roundtrip recovers the path.
  const bad = new TextEncoder().encode("bad-bytes");
  const badSlot = await issuance("/api/files/uploads", USER_OP, [{ location: "fy", path: "bad.txt" }]);
  expect(badSlot.status).toBe(200);
  const badPut = await worker.fetch(
    new Request(`https://local.test/api/files/content?token=${badSlot.entries[0]?.token}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "text/plain" },
      body: bad as Uint8Array<ArrayBuffer>,
    }),
    { ...bindings, LAB_USER_ID: USER_OP, LAB_FIXTURE_USER_ID: USER_ADMIN, ADMIN_USER_IDS: ADMINS },
  );
  expect(badPut.status).toBe(200);
  expect(
    await call("/api/files/finalize", "POST", USER_OP, {
      location: "fy",
      path: "bad.txt",
      contentType: "text/plain",
      size: bad.byteLength + 1,
      sha256: digest,
    }),
  ).toMatchObject({ status: 409, body: { error: { code: "COMPLETION_MISMATCH" } } });
  expect(
    await call("/api/files/finalize", "POST", USER_OP, {
      location: "fy",
      path: "bad.txt",
      contentType: "text/plain",
      size: bad.byteLength,
      sha256: await sha256Hex(bad),
    }),
  ).toMatchObject({ status: 409, body: { error: { code: "FILE_MISSING" } } });
  expect(await roundtrip("bad.txt", bad)).toMatchObject({ status: 200, body: { file: { version: 1 } } });
  // Location deletion refuses while files exist (409), then the lifecycle
  // closes: delete files, delete the location, re-create with fresh policy.
  expect(await call("/api/file-locations/fy", "DELETE", USER_OP)).toMatchObject({
    status: 409,
    body: { error: { code: "LOCATION_NOT_EMPTY" } },
  });
  expect(await call("/api/files", "DELETE", USER_OP, { location: "fy", path: "bad.txt", expectedVersion: 1 }))
    .toMatchObject({ status: 200 });
  expect(await call("/api/file-locations/fy", "DELETE", USER_OP)).toMatchObject({ status: 200 });
  expect(await call("/api/file-locations/fy", "GET", USER_OP)).toMatchObject({ status: 404 });
  expect(await call("/api/file-locations", "POST", USER_OP, { name: "fy", maxBytes: 16 })).toMatchObject({
    status: 201,
  });
  expect((await issuance("/api/files/uploads", USER_OP, [{ location: "fy", path: "again.txt" }])).status).toBe(200);
  // Issuance batch bound (L7): 101 entries fail closed before any slot.
  const many = Array.from({ length: 101 }, (_, i) => ({ location: "fy", path: `f${i}.txt` }));
  expect(await call("/api/files/uploads", "POST", USER_OP, { entries: many })).toMatchObject({
    status: 400,
    body: { error: { code: "INVALID_BATCH" } },
  });
});
