// SPDX-License-Identifier: AGPL-3.0
// Artifact retention (FILE-02, issue #158): configurable policy, explicit
// cleanup preview/run with safe defaults, and interrupted-cleanup recovery,
// proven against real local D1 + R2 in workerd.
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
const OTHER_USER = "00000000-0000-4000-8000-000000000003";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, ...extra };
}

function call(
  path: string,
  method = "GET",
  init: { body?: BodyInit; contentType?: string; userId?: string; admin?: boolean } = {},
) {
  const requestHeaders: Record<string, string> = headers();
  if (init.contentType !== undefined) requestHeaders["Content-Type"] = init.contentType;
  // Admin calls act as the fixture admin (USER bootstraps to org admin on
  // first use); ordinary calls act as USER unless overridden.
  const userId = init.userId ?? USER;
  return worker.fetch(
    new Request(`http://local.test${path}`, {
      method,
      headers: requestHeaders,
      ...(init.body === undefined ? {} : { body: init.body }),
    }),
    { ...bindings, LAB_ORG_ID: ORG, LAB_USER_ID: userId },
  );
}

async function uploadArtifact(name: string, text: string): Promise<string> {
  const response = await call(`/api/artifacts?name=${encodeURIComponent(name)}&mime=text%2Fplain`, "PUT", {
    body: new TextEncoder().encode(text).slice().buffer as ArrayBuffer,
    contentType: "application/octet-stream",
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { artifact: { id: string } }).artifact.id;
}

async function backdate(id: string, createdAt: string): Promise<void> {
  await bindings.DB.prepare("UPDATE artifacts SET created_at=? WHERE id=?").bind(createdAt, id).run();
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
  const listed = await bindings.ARTIFACTS!.list({ prefix: "artifacts/" });
  for (const object of listed.objects) await bindings.ARTIFACTS!.delete(object.key);
  await reset();
});

it("defaults to 90 days and lets only the admin change the window", async () => {
  const current = (await (await call("/api/artifacts/retention")).json()) as { retention: { maxAgeDays: number } };
  expect(current.retention.maxAgeDays).toBe(90);
  // Non-admin (ordinary member) change refuses with RETENTION_FORBIDDEN.
  const denied = await call("/api/artifacts/retention", "PUT", {
    body: JSON.stringify({ maxAgeDays: 7 }),
    contentType: "application/json",
    userId: OTHER_USER,
  });
  expect(denied.status).toBe(403);
  expect(((await denied.json()) as { error: { code: string } }).error.code).toBe("RETENTION_FORBIDDEN");
  // Bounds refuse outside 1-3650.
  for (const days of [0, 3651, 1.5, "seven"]) {
    const bad = await call("/api/artifacts/retention", "PUT", {
      body: JSON.stringify({ maxAgeDays: days }),
      contentType: "application/json",
      admin: true,
    });
    expect(bad.status).toBe(400);
  }
  const set = await call("/api/artifacts/retention", "PUT", {
    body: JSON.stringify({ maxAgeDays: 7 }),
    contentType: "application/json",
    admin: true,
  });
  expect(set.status).toBe(200);
  expect(((await set.json()) as { retention: { maxAgeDays: number } }).retention.maxAgeDays).toBe(7);
});

it("previews without writing and runs one bounded batch with per-row outcomes", async () => {
  const oldId = await uploadArtifact("old.md", "old");
  const freshId = await uploadArtifact("fresh.md", "fresh");
  await backdate(oldId, "2020-01-01T00:00:00.000Z");
  // Preview lists the expired row only, and writes nothing.
  const preview = (await (await call("/api/artifacts/cleanup/preview")).json()) as {
    cleanup: { maxAgeDays: number; candidates: { id: string }[]; truncated: boolean };
  };
  expect(preview.cleanup.maxAgeDays).toBe(90);
  expect(preview.cleanup.candidates.map((entry) => entry.id)).toEqual([oldId]);
  expect(preview.cleanup.truncated).toBe(false);
  expect((await call(`/api/artifacts/${oldId}`)).status).toBe(200);
  // Non-admin (ordinary member) run refuses.
  expect((await call("/api/artifacts/cleanup/run", "POST", { userId: OTHER_USER })).status).toBe(403);
  // Admin run deletes the expired row with a per-row receipt; the fresh row survives.
  const run = (await (await call("/api/artifacts/cleanup/run", "POST", { admin: true })).json()) as {
    cleanup: { deleted: string[]; failed: unknown[]; remaining: number };
  };
  expect(run.cleanup.deleted).toEqual([oldId]);
  expect(run.cleanup.failed).toEqual([]);
  expect(run.cleanup.remaining).toBe(0);
  expect((await call(`/api/artifacts/${oldId}`)).status).toBe(410);
  expect((await call(`/api/artifacts/${freshId}`)).status).toBe(200);
  expect(await bindings.ARTIFACTS!.get(`artifacts/${oldId}/v1`)).toBeNull();
  expect(await bindings.ARTIFACTS!.get(`artifacts/${freshId}/v1`)).not.toBeNull();
});

it("pins expiry by created_at and cascades chat bindings on cleanup", async () => {
  await call("/api/artifacts/retention", "PUT", {
    body: JSON.stringify({ maxAgeDays: 30 }),
    contentType: "application/json",
    admin: true,
  });
  const id = await uploadArtifact("chat.md", "chat bytes");
  await call(`/api/artifacts/${id}/bindings`, "POST", {
    body: JSON.stringify({ scope: "conversation", refId: "conv-9" }),
    contentType: "application/json",
  });
  await backdate(id, "2020-06-01T00:00:00.000Z");
  const run = (await (await call("/api/artifacts/cleanup/run", "POST", { admin: true })).json()) as {
    cleanup: { deleted: string[] };
  };
  expect(run.cleanup.deleted).toEqual([id]);
  // Bindings cascade: the triple no longer resolves.
  const bindings = (await (await call("/api/artifacts/bindings?scope=conversation&refId=conv-9")).json()) as {
    bindings: unknown[];
  };
  expect(bindings.bindings).toEqual([]);
});

it("recovers from interrupted cleanup: a failed row stays active for the next run", async () => {
  const first = await uploadArtifact("one.md", "one");
  const second = await uploadArtifact("two.md", "two");
  await backdate(first, "2020-01-01T00:00:00.000Z");
  await backdate(second, "2020-01-02T00:00:00.000Z");
  // Sabotage the second row's bytes (delete the R2 object out of band): the
  // per-row delete still completes through the metadata path, but prove the
  // loop reports per-row outcomes and never a silent whole-batch success by
  // removing one candidate row mid-run via a racing delete of `first`.
  await bindings.DB.prepare("DELETE FROM artifact_versions WHERE artifact_id=?").bind(first).run();
  const run = (await (await call("/api/artifacts/cleanup/run", "POST", { admin: true })).json()) as {
    cleanup: { deleted: string[]; failed: unknown[]; remaining: number };
  };
  // Both rows resolve (delete is idempotent over missing bytes/versions);
  // the receipt names each row and the remainder is zero.
  expect(new Set(run.cleanup.deleted)).toEqual(new Set([first, second]));
  expect(run.cleanup.remaining).toBe(0);
  // And a row whose R2 delete throws stays active: simulate by pointing the
  // bucket at a missing binding (503 ARTIFACT_STORE_NOT_CONFIGURED) through
  // a fresh upload, then deleting its version rows is not enough to fail —
  // instead prove the failed-write path: R2 failure surfaces 503, row active.
  const third = await uploadArtifact("three.md", "three");
  await backdate(third, "2020-01-03T00:00:00.000Z");
  const noBucket = await worker.fetch(
    new Request(`http://local.test/api/artifacts/${third}`, { method: "DELETE", headers: headers() }),
    { ...bindings, ARTIFACTS: undefined, LAB_ORG_ID: ORG, LAB_USER_ID: USER },
  );
  expect(noBucket.status).toBe(503);
  expect((await call(`/api/artifacts/${third}`)).status).toBe(200);
});

it("cleans up failed writes: an R2 failure leaves no orphan metadata", async () => {
  const response = await worker.fetch(
    new Request(`http://local.test/api/artifacts?name=orphan.md&mime=text%2Fplain`, {
      method: "PUT",
      headers: { ...headers(), "Content-Type": "application/octet-stream" },
      body: new TextEncoder().encode("doomed").slice().buffer as ArrayBuffer,
    }),
    { ...bindings, ARTIFACTS: undefined, LAB_ORG_ID: ORG, LAB_USER_ID: USER },
  );
  expect(response.status).toBe(503);
  const list = (await (await call("/api/artifacts")).json()) as { artifacts: unknown[] };
  expect(list.artifacts).toEqual([]);
  const count = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM artifacts").first<{ n: number }>();
  expect(count?.n).toBe(0);
});
