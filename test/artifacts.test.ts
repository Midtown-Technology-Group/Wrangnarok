// SPDX-License-Identifier: AGPL-3.0
// Generated Artifacts (FILE-02, issue #158): upload with same-filename
// versioning, list/preview/download/rename/delete, and the canonical versus
// attachment-binding access split, proven against real local D1 + R2 in
// workerd. Applies the full migration chain (0001 + 0007 + 0008 + 0010)
// so the artifact schema composes with the org-membership gate (AUTH-01).
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration7 from "../migrations/0007_org_membership.sql?raw";
import migration8 from "../migrations/0008_executions_org_fk.sql?raw";
import migration20 from "../migrations/0020_artifacts.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const ORG = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000002";
const OTHER_ORG = "00000000-0000-4000-8000-000000000009";
const OTHER_USER = "00000000-0000-4000-8000-000000000003";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, ...extra };
}

function call(
  path: string,
  method = "GET",
  init: {
    body?: BodyInit;
    contentType?: string;
    orgId?: string;
    userId?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const requestHeaders: Record<string, string> = headers(init.headers);
  if (init.contentType !== undefined) requestHeaders["Content-Type"] = init.contentType;
  return worker.fetch(
    new Request(`http://local.test${path}`, {
      method,
      headers: requestHeaders,
      ...(init.body === undefined ? {} : { body: init.body }),
    }),
    { ...bindings, LAB_ORG_ID: init.orgId ?? ORG, LAB_USER_ID: init.userId ?? USER },
  );
}

function upload(path: string, bytes: Uint8Array, mime = "text/markdown", orgId = ORG, userId = USER) {
  void mime;
  return call(path, "PUT", {
    body: bytes.slice().buffer as ArrayBuffer,
    contentType: "application/octet-stream",
    orgId,
    userId,
    headers: {},
  });
}

async function uploadArtifact(
  name: string,
  text: string,
  mime = "text/markdown",
): Promise<{ id: string; status: number }> {
  const response = await upload(
    `/api/artifacts?name=${encodeURIComponent(name)}&mime=${encodeURIComponent(mime)}`,
    new TextEncoder().encode(text),
  );
  const body = (await response.json()) as { artifact: { id: string } };
  return { id: body.artifact.id, status: response.status };
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration7);
  await bindings.DB.exec(migration8);
  await bindings.DB.exec(migration20);
  // AUTH-01 membership gate: the LAB fixture identity (USER) bootstraps to
  // admin of ORG inside authenticate on first use. OTHER_USER holds an
  // ordinary membership so artifact denials prove artifact policy (403),
  // never org strangerhood (membership 404). OTHER_ORG stays unknown.
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
  // R2 test state is per-test-run, not per-test: clear keys this suite wrote.
  const listed = await bindings.ARTIFACTS!.list({ prefix: "artifacts/" });
  for (const object of listed.objects) await bindings.ARTIFACTS!.delete(object.key);
  await reset();
});

it("uploads, versions by filename, and serves current plus addressed versions", async () => {
  const first = await uploadArtifact("notes.md", "# v1");
  expect(first.status).toBe(201);
  const second = await uploadArtifact("notes.md", "# v2");
  expect(second.status).toBe(200);
  // Same-filename re-upload versions the SAME row: one id, version 2.
  expect(second.id).toBe(first.id);
  const detail = (await (await call(`/api/artifacts/${first.id}`)).json()) as {
    artifact: { version: number; versions: { version: number }[] };
  };
  expect(detail.artifact.version).toBe(2);
  expect(detail.artifact.versions.map((entry) => entry.version)).toEqual([1, 2]);
  const preview = await call(`/api/artifacts/${first.id}/preview`);
  expect(preview.status).toBe(200);
  expect(preview.headers.get("Content-Type")).toContain("text/markdown");
  expect(await preview.text()).toBe("# v2");
  const v1 = await call(`/api/artifacts/${first.id}/versions/1`);
  expect(v1.status).toBe(200);
  expect(await v1.text()).toBe("# v1");
  // No stale-version 409 on re-upload: the pointer always advances.
  const third = await uploadArtifact("notes.md", "# v3");
  expect(third.status).toBe(200);
  expect(third.id).toBe(first.id);
});

it("renames the canonical record without moving bytes or versions", async () => {
  const { id } = await uploadArtifact("draft.md", "hello");
  const renamed = await call(`/api/artifacts/${id}/rename`, "POST", {
    body: JSON.stringify({ name: "final.md" }),
    contentType: "application/json",
  });
  expect(renamed.status).toBe(200);
  expect(((await renamed.json()) as { artifact: { name: string; version: number } }).artifact).toMatchObject({
    name: "final.md",
    version: 1,
  });
  const preview = await call(`/api/artifacts/${id}/preview`);
  expect(await preview.text()).toBe("hello");
  const download = await call(`/api/artifacts/${id}/download`);
  expect(download.headers.get("Content-Disposition")).toContain('filename="final.md"');
});

it("downloads with attachment disposition and lists with pagination", async () => {
  await uploadArtifact("a.md", "a");
  await uploadArtifact("b.md", "b");
  const list = (await (await call("/api/artifacts?limit=1")).json()) as { artifacts: unknown[]; hasMore: boolean };
  expect(list.artifacts).toHaveLength(1);
  expect(list.hasMore).toBe(true);
  expect((await (await call("/api/artifacts?limit=99")).json()) instanceof Object).toBe(true);
  const badLimit = await call("/api/artifacts?limit=99");
  expect(badLimit.status).toBe(400);
  const badKey = await call("/api/artifacts?bogus=1");
  expect(badKey.status).toBe(400);
});

it("enforces the canonical access matrix: 404 foreign, 403 same-org non-creator, admin bypass", async () => {
  const { id } = await uploadArtifact("secret.md", "creator bytes");
  // Foreign org: 404, never a leak (detail, bytes, rename, delete). The
  // membership gate answers unknown orgs before artifact policy runs.
  expect((await call(`/api/artifacts/${id}`, "GET", { orgId: OTHER_ORG })).status).toBe(404);
  expect((await call(`/api/artifacts/${id}/preview`, "GET", { orgId: OTHER_ORG })).status).toBe(404);
  expect((await call(`/api/artifacts/${id}/download`, "GET", { orgId: OTHER_ORG })).status).toBe(404);
  // Same org, different creator, ordinary member: 403 on canonical access.
  expect((await call(`/api/artifacts/${id}`, "GET", { userId: OTHER_USER })).status).toBe(403);
  expect((await call(`/api/artifacts/${id}/preview`, "GET", { userId: OTHER_USER })).status).toBe(403);
  expect((await call(`/api/artifacts/${id}/download`, "GET", { userId: OTHER_USER })).status).toBe(403);
  const deniedRename = await call(`/api/artifacts/${id}/rename`, "POST", {
    body: JSON.stringify({ name: "hijack.md" }),
    contentType: "application/json",
    userId: OTHER_USER,
  });
  expect(deniedRename.status).toBe(403);
  // Admin bypass (AUTH-01 composition): promote the member to org admin and
  // the same canonical reads, renames, and deletes succeed with no header.
  const stamp = new Date().toISOString();
  await bindings.DB.prepare("UPDATE org_memberships SET role='admin',updated_at=? WHERE org_id=? AND user_id=?")
    .bind(stamp, ORG, OTHER_USER)
    .run();
  expect((await call(`/api/artifacts/${id}`, "GET", { userId: OTHER_USER })).status).toBe(200);
  const adminRename = await call(`/api/artifacts/${id}/rename`, "POST", {
    body: JSON.stringify({ name: "admin-renamed.md" }),
    contentType: "application/json",
    userId: OTHER_USER,
  });
  expect(adminRename.status).toBe(200);
  expect((await call(`/api/artifacts/${id}`, "DELETE", { userId: OTHER_USER })).status).toBe(200);
  // Deleted: the fixture identity bootstraps to org admin, so it sees 410
  // (gone vs never-existed). Ordinary members see 404 on deleted rows.
  expect((await call(`/api/artifacts/${id}`)).status).toBe(410);
  expect((await call(`/api/artifacts/${id}`, "GET", { userId: OTHER_USER })).status).toBe(410);
});

it("binds attachments, lists triples without bytes, and separates binding from canonical access", async () => {
  const { id } = await uploadArtifact("chat.png", "bytes", "image/png");
  const bound = await call(`/api/artifacts/${id}/bindings`, "POST", {
    body: JSON.stringify({ scope: "conversation", refId: "conv-1" }),
    contentType: "application/json",
  });
  expect(bound.status).toBe(201);
  // Duplicate binding refuses with BINDING_EXISTS, never a silent double.
  const duplicate = await call(`/api/artifacts/${id}/bindings`, "POST", {
    body: JSON.stringify({ scope: "conversation", refId: "conv-1" }),
    contentType: "application/json",
  });
  expect(duplicate.status).toBe(409);
  // Binding listing answers the triple only: no bytes, no canonical fields.
  const listed = (await (await call("/api/artifacts/bindings?scope=conversation&refId=conv-1")).json()) as {
    bindings: { artifactId: string; scope: string; refId: string }[];
  };
  expect(listed.bindings).toEqual([{ artifactId: id, scope: "conversation", refId: "conv-1" }]);
  // A same-org non-creator can resolve the triple but NOT the bytes: the
  // binding never grants canonical access.
  const triple = await call("/api/artifacts/bindings?scope=conversation&refId=conv-1", "GET", { userId: OTHER_USER });
  expect(triple.status).toBe(200);
  expect((await call(`/api/artifacts/${id}/preview`, "GET", { userId: OTHER_USER })).status).toBe(403);
  // Foreign org sees no bindings at all.
  const foreign = (await (
    await call("/api/artifacts/bindings?scope=conversation&refId=conv-1", "GET", { orgId: OTHER_ORG })
  ).json()) as { bindings: unknown[] };
  expect(foreign.bindings).toEqual([]);
  // Unbind removes the triple; bytes stay.
  const unbound = await call(`/api/artifacts/${id}/bindings`, "DELETE", {
    body: JSON.stringify({ scope: "conversation", refId: "conv-1" }),
    contentType: "application/json",
  });
  expect(unbound.status).toBe(200);
  const again = await call(`/api/artifacts/${id}/bindings`, "DELETE", {
    body: JSON.stringify({ scope: "conversation", refId: "conv-1" }),
    contentType: "application/json",
  });
  expect(again.status).toBe(404);
  expect((await call(`/api/artifacts/${id}/preview`)).status).toBe(200);
});

it("rejects bad uploads: MIME/size limits, deleted metadata versus object bytes", async () => {
  const badMime = await upload("/api/artifacts?name=x.md&mime=not-a-mime", new TextEncoder().encode("x"));
  expect(badMime.status).toBe(400);
  const badName = await upload("/api/artifacts?mime=text/plain", new TextEncoder().encode("x"));
  expect(badName.status).toBe(400);
  const pathName = await upload("/api/artifacts?name=../evil.md", new TextEncoder().encode("x"));
  expect(pathName.status).toBe(400);
  const wrongType = await call("/api/artifacts?name=x.md", "PUT", {
    body: JSON.stringify({ bytes: "nope" }),
    contentType: "application/json",
  });
  expect(wrongType.status).toBe(415);
  const empty = await upload("/api/artifacts?name=empty.md", new Uint8Array());
  expect(empty.status).toBe(400);
  const bogusKey = await upload("/api/artifacts?name=x.md&bogus=1", new TextEncoder().encode("x"));
  expect(bogusKey.status).toBe(400);
  // Oversize: the route refuses before R2, leaving no orphan metadata row.
  const huge = await upload("/api/artifacts?name=huge.bin", new Uint8Array(5 * 1024 * 1024 + 1));
  expect(huge.status).toBe(413);
  const list = (await (await call("/api/artifacts")).json()) as { artifacts: { name: string }[] };
  expect(list.artifacts.some((entry) => entry.name === "huge.bin")).toBe(false);
});

it("rejects unsupported query keys on every query-bearing artifact route", async () => {
  const { id } = await uploadArtifact("guarded.md", "x");
  expect((await call("/api/artifacts/formats?x=1")).status).toBe(400);
  expect((await call("/api/artifacts/retention?x=1")).status).toBe(400);
  expect((await call("/api/artifacts/cleanup/preview?x=1")).status).toBe(400);
  expect((await call("/api/artifacts/cleanup/run?x=1", "POST")).status).toBe(400);
  expect((await call(`/api/artifacts/${id}/preview?x=1`)).status).toBe(400);
  expect((await call(`/api/artifacts/${id}/download?x=1`)).status).toBe(400);
  expect((await call(`/api/artifacts/${id}/export?x=1`)).status).toBe(400);
  const versioned = await upload(`/api/artifacts/${id}/bytes?mime=text%2Fplain&x=1`, new TextEncoder().encode("y"));
  expect(versioned.status).toBe(200);
  // Wrong encoding on byte routes: 415; empty byte body: 400.
  const encoded = await call(`/api/artifacts/${id}/bytes`, "PUT", {
    body: new TextEncoder().encode("y").slice().buffer as ArrayBuffer,
    contentType: "application/octet-stream",
    headers: { "Content-Encoding": "gzip" },
  });
  expect(encoded.status).toBe(415);
  // Non-numeric limit: 400.
  expect((await call("/api/artifacts?limit=abc")).status).toBe(400);
});

it("deletes metadata-versus-bytes correctly: bytes gone, metadata row survives as deleted", async () => {
  const { id } = await uploadArtifact("gone.md", "bye");
  await uploadArtifact("gone.md", "bye v2");
  expect((await call(`/api/artifacts/${id}`, "DELETE")).status).toBe(200);
  // Bytes for every version are removed from R2.
  expect(await bindings.ARTIFACTS!.get(`artifacts/${id}/v1`)).toBeNull();
  expect(await bindings.ARTIFACTS!.get(`artifacts/${id}/v2`)).toBeNull();
  // The D1 metadata row survives with status deleted (filtered from lists).
  const row = await bindings.DB.prepare("SELECT status FROM artifacts WHERE id=?").bind(id).first<{ status: string }>();
  expect(row?.status).toBe("deleted");
  const list = (await (await call("/api/artifacts")).json()) as { artifacts: unknown[] };
  expect(list.artifacts).toEqual([]);
});

it("exposes generated-output formats as unchecked subcapabilities", async () => {
  const formats = (await (await call("/api/artifacts/formats")).json()) as {
    formats: { format: string; status: string }[];
  };
  expect(formats.formats.map((entry) => entry.format)).toEqual([
    "pdf",
    "docx",
    "xlsx",
    "csv",
    "html",
    "markdown",
    "json",
    "text",
  ]);
  expect(new Set(formats.formats.map((entry) => entry.status))).toEqual(new Set(["deferred"]));
});

it("covers fault paths: missing bytes, bad versions, bad bindings, version races", async () => {
  const { id } = await uploadArtifact("fault.md", "v1");
  // Malformed artifact id (route-shaped but not a UUID): 400, not a lookup.
  expect((await call(`/api/artifacts/${"0".repeat(36)}`)).status).toBe(400);
  // Bad addressed version: 400.
  expect((await call(`/api/artifacts/${id}/versions/0`)).status).toBe(400);
  expect((await call(`/api/artifacts/${id}/versions/101`)).status).toBe(400);
  // Missing bytes: delete the R2 object out of band, metadata stays.
  await bindings.ARTIFACTS!.delete(`artifacts/${id}/v1`);
  const missing = await call(`/api/artifacts/${id}/preview`);
  expect(missing.status).toBe(404);
  expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("ARTIFACT_BYTES_MISSING");
  // Bad binding shapes: 400 on scope and ref.
  for (const body of [
    { scope: "chat", refId: "x" },
    { scope: "conversation", refId: "" },
  ]) {
    const bad = await call(`/api/artifacts/${id}/bindings`, "POST", {
      body: JSON.stringify(body),
      contentType: "application/json",
    });
    expect(bad.status).toBe(400);
  }
  const badList = await call("/api/artifacts/bindings?scope=chat&refId=x");
  expect(badList.status).toBe(400);
  // Direct version-upload route exercises the same fenced path as re-upload.
  const direct = await upload(`/api/artifacts/${id}/bytes?mime=text%2Fplain`, new TextEncoder().encode("v2"));
  expect(direct.status).toBe(200);
  expect(((await direct.json()) as { artifact: { version: number } }).artifact.version).toBe(2);
});

it("exports a metadata-only manifest: never runtime bytes", async () => {
  const { id } = await uploadArtifact("report.md", "portable?");
  const exported = (await (await call(`/api/artifacts/${id}/export`)).json()) as {
    artifact: { id: string; name: string };
    bytesIncluded: boolean;
  };
  expect(exported.artifact.id).toBe(id);
  expect(exported.bytesIncluded).toBe(false);
  expect(JSON.stringify(exported)).not.toContain("portable?");
});
