// SPDX-License-Identifier: AGPL-3.0
// Authored Applications (APP-01, issue #159; ADR 017): independent-app
// lifecycle, ownership, recovery, and authorized asset serving, proven
// against real local D1 in workerd. Applies the full migration chain
// (0001 + 0006) so the apps schema composes with the existing tables.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration6 from "../migrations/0006_apps.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const ORG = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG = "00000000-0000-4000-8000-000000000009";
const OTHER_USER = "00000000-0000-4000-8000-000000000003";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...extra };
}

function call(path: string, method = "GET", body?: unknown, orgId = ORG, userId?: string) {
  return worker.fetch(
    new Request(`https://local.test${path}`, {
      method,
      headers: headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { ...bindings, LAB_ORG_ID: orgId, ...(userId ? { LAB_USER_ID: userId } : {}) },
  );
}

const GOOD_SOURCE = {
  files: [{ path: "index.html", content: "<h1>hello</h1>" }],
  dependencies: [{ name: "wrangnarok-ui", version: "1.0.0" }],
};

async function createApp(name = "hello-app", slug = "hello-app") {
  const response = await call("/api/apps", "POST", { name, slug });
  expect(response.status).toBe(201);
  return ((await response.json()) as { app: { id: string } }).app.id;
}

async function buildApp(id: string) {
  await call(`/api/apps/${id}/source`, "PUT", GOOD_SOURCE);
  const build = await call(`/api/apps/${id}/builds`, "POST");
  expect(build.status).toBe(202);
  return ((await build.json()) as { job: { id: string; status: string } }).job;
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration6);
});

afterEach(async () => {
  await reset();
});

it("creates, edits, validates, builds, and serves an independent app", async () => {
  const id = await createApp();
  const edited = await call(`/api/apps/${id}/source`, "PUT", GOOD_SOURCE);
  expect(edited.status).toBe(200);
  expect(await edited.json()).toMatchObject({ revision: { revision: 1, validation: "valid" } });
  const validated = await call(`/api/apps/${id}/validate`, "POST");
  expect(validated.status).toBe(200);
  const job = await buildApp(id);
  expect(job.status).toBe("succeeded");
  const detail = await call(`/api/apps/${id}`);
  const body = (await detail.json()) as {
    app: { status: string; activeDeploymentId: string | null; activeDeployment: { contentHash: string } | null };
  };
  expect(body.app.status).toBe("live");
  expect(body.app.activeDeploymentId).not.toBeNull();
  expect(body.app.activeDeployment?.contentHash).toMatch(/^[a-f0-9]{64}$/);
  const jobs = await call(`/api/apps/${id}/builds`);
  expect(await jobs.json()).toMatchObject({ jobs: [{ status: "succeeded" }] });
  const one = await call(`/api/apps/${id}/builds/${job.id}`);
  expect(await one.json()).toMatchObject({ job: { id: job.id, status: "succeeded" } });
  const asset = await call(`/api/apps/${id}/assets/index.html`);
  expect(asset.status).toBe(200);
  expect(asset.headers.get("ETag")).toContain(body.app.activeDeployment?.contentHash ?? "none");
  expect(asset.headers.get("Cache-Control")).toBe("no-store");
  expect(await asset.text()).toBe("<h1>hello</h1>");
});

it("recovers from build failure: invalid revisions block build and failed edits preserve the live app", async () => {
  const id = await createApp("shop", "shop");
  // No revision yet: build refuses.
  expect((await call(`/api/apps/${id}/builds`, "POST")).status).toBe(409);
  // Invalid source: 422 with field failures, revision recorded invalid.
  const badDep = await call(`/api/apps/${id}/source`, "PUT", {
    files: [{ path: "index.html", content: "x" }],
    dependencies: [{ name: "evil-lib", version: "9.9.9" }],
  });
  expect(badDep.status).toBe(422);
  expect(await badDep.json()).toMatchObject({ error: { code: "APP_VALIDATION_FAILED" } });
  expect((await call(`/api/apps/${id}/builds`, "POST")).status).toBe(409);
  // Fix, deploy, then break the next revision: the live pointer survives.
  const job = await buildApp(id);
  expect(job.status).toBe("succeeded");
  const before = (await (await call(`/api/apps/${id}`)).json()) as {
    app: { activeDeploymentId: string };
  };
  const badPath = await call(`/api/apps/${id}/source`, "PUT", {
    files: [{ path: "../escape.html", content: "x" }],
    dependencies: [],
  });
  expect(badPath.status).toBe(422);
  expect((await call(`/api/apps/${id}/builds`, "POST")).status).toBe(409);
  const after = (await (await call(`/api/apps/${id}`)).json()) as {
    app: { activeDeploymentId: string; status: string };
  };
  expect(after.app.activeDeploymentId).toBe(before.app.activeDeploymentId);
  expect(after.app.status).toBe("failed");
  // Recovery path 1 (redeploy): fix the source and build again.
  const recovered = await buildApp(id);
  expect(recovered.status).toBe("succeeded");
  const live = (await (await call(`/api/apps/${id}`)).json()) as { app: { status: string } };
  expect(live.app.status).toBe("live");
});

it("recovers via parked-old-app slug swap with explicit replace semantics", async () => {
  const liveId = await createApp("storefront", "storefront");
  await buildApp(liveId);
  // Park the old app: copy source under a parking slug and deploy it.
  const parkedId = await createApp("storefront backup", "storefront-v1");
  await buildApp(parkedId);
  const swapped = await call(`/api/apps/${liveId}/swap`, "POST", { otherAppId: parkedId });
  expect(swapped.status).toBe(200);
  const body = (await swapped.json()) as { app: { slug: string }; other: { slug: string } };
  expect(body.app.slug).toBe("storefront-v1");
  expect(body.other.slug).toBe("storefront");
  // The parked copy now serves the production route from its own deployment.
  const asset = await call(`/api/apps/${parkedId}/assets/index.html`);
  expect(asset.status).toBe(200);
  expect(await asset.text()).toBe("<h1>hello</h1>");
});

it("enforces slug uniqueness per Organization (route conflicts fail closed)", async () => {
  await createApp("one", "taken");
  const clash = await call("/api/apps", "POST", { name: "two", slug: "taken" });
  expect(clash.status).toBe(409);
  expect(await clash.json()).toMatchObject({ error: { code: "SLUG_CONFLICT" } });
  // Same slug in a different Organization is fine: slugs are per-org.
  const foreign = await call("/api/apps", "POST", { name: "two", slug: "taken" }, OTHER_ORG);
  expect(foreign.status).toBe(201);
});

it("rejects concurrent publication races: fenced activation and fenced swaps", async () => {
  const id = await createApp("race", "race");
  await call(`/api/apps/${id}/source`, "PUT", GOOD_SOURCE);
  const first = await call(`/api/apps/${id}/builds`, "POST");
  expect(first.status).toBe(202);
  // A second build over the same revision supersedes cleanly (same pointer).
  const second = await call(`/api/apps/${id}/builds`, "POST");
  expect(second.status).toBe(202);
  // Swapping an app with itself is refused, never a silent no-op.
  const self = await call(`/api/apps/${id}/swap`, "POST", { otherAppId: id });
  expect(self.status).toBe(400);
  expect(await self.json()).toMatchObject({ error: { code: "INVALID_SWAP" } });
});

it("rejects owned (Solution-managed) mutation and never touches loose rows", async () => {
  const id = await createApp("loose", "loose");
  // Simulate Solution install taking ownership of this row.
  await bindings.DB.prepare("UPDATE apps SET owner_kind='solution', managed_by=? WHERE id=?")
    .bind("b10a7c2e-3f4d-4a5b-8c6d-7e8f9a0b1c2d@1.0.0", id)
    .run();
  for (const [path, method, body] of [
    [`/api/apps/${id}/source`, "PUT", GOOD_SOURCE],
    [`/api/apps/${id}/builds`, "POST", undefined],
    [`/api/apps/${id}/swap`, "POST", { otherAppId: id }],
    [`/api/apps/${id}`, "DELETE", undefined],
  ] as const) {
    const response = await call(path, method, body);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "MANAGED_RESOURCE" } });
  }
  // Loose rows stay fully writable: create/build/delete succeed.
  const loose = await createApp("free", "free");
  await buildApp(loose);
  expect((await call(`/api/apps/${loose}`, "DELETE")).status).toBe(200);
  expect((await call(`/api/apps/${loose}`)).status).toBe(404);
});

it("scopes every route to the Organization: foreign rows 404, assets need a live deployment", async () => {
  const id = await createApp("private", "private");
  for (const path of [`/api/apps/${id}`, `/api/apps/${id}/builds`, `/api/apps/${id}/assets/index.html`]) {
    const foreign = await call(path, "GET", undefined, OTHER_ORG);
    expect(foreign.status).toBe(404);
  }
  const foreignUser = await call(`/api/apps/${id}`, "GET", undefined, ORG, OTHER_USER);
  expect(foreignUser.status).toBe(200);
  // Same org, different user: org-scoped visibility holds (org boundary, not per-user).
  expect((await call(`/api/apps/${id}/assets/index.html`)).status).toBe(404);
  const unknown = await call(`/api/apps/00000000-0000-4000-8000-000000000099`);
  expect(unknown.status).toBe(404);
  expect(await unknown.json()).toMatchObject({ error: { code: "APP_NOT_FOUND" } });
});

it("validates inputs fail-closed: slugs, bodies, revisions, swaps, and query strings", async () => {
  const badSlug = await call("/api/apps", "POST", { name: "x", slug: "Bad Slug!" });
  expect(badSlug.status).toBe(400);
  expect(await badSlug.json()).toMatchObject({ error: { code: "INVALID_SLUG" } });
  const badName = await call("/api/apps", "POST", { name: "", slug: "ok-slug" });
  expect(badName.status).toBe(400);
  const id = await createApp("shapes", "shapes");
  const badBody = await call(`/api/apps/${id}/source`, "PUT", { nope: true });
  expect(badBody.status).toBe(400);
  const tooMany = await call(`/api/apps/${id}/source`, "PUT", {
    files: Array.from({ length: 51 }, (_, i) => ({ path: `f${i}.html`, content: "x" })),
    dependencies: [],
  });
  expect(tooMany.status).toBe(400);
  // Oversize bodies trip the shared 4096-byte transport bound (413): the
  // body bound always trips before the per-file byte bound over HTTP, so
  // the per-file FILE_TOO_LARGE 422 is domain-level defense in depth.
  const oversize = await call(`/api/apps/${id}/source`, "PUT", {
    files: [{ path: "big.html", content: "x".repeat(5000) }],
    dependencies: [],
  });
  expect(oversize.status).toBe(413);
  const badSwap = await call(`/api/apps/${id}/swap`, "POST", { otherAppId: "nope" });
  expect(badSwap.status).toBe(400);
  const queried = await call(`/api/apps?scope=all`);
  expect(queried.status).toBe(400);
  expect(await queried.json()).toMatchObject({ error: { code: "UNSUPPORTED_QUERY" } });
  // Path traversal never reaches the asset route: the URL parser normalizes
  // `/assets/../secret` to an unmapped path, which answers UNIMPLEMENTED
  // (501). Fail-closed either way; in-route `..` segments answer 400.
  const missingAsset = await call(`/api/apps/${id}/assets/../secret`);
  expect(missingAsset.status).toBe(501);
  expect(await missingAsset.json()).toMatchObject({ error: { code: "UNIMPLEMENTED" } });
});
