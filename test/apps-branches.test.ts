// SPDX-License-Identifier: AGPL-3.0
// Authored Applications (APP-01, issue #159; ADR 017): fail-closed branch
// coverage for the app validation, lookup, recovery, and serving paths.
// Every invalid shape below answers 4xx with a stable code; nothing here
// invents behavior, it pins the existing fail-closed contract against real
// local D1 in workerd.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import { validateAppSource } from "../src/apps";
import type { Bindings } from "../src/bindings";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration6 from "../migrations/0006_apps.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const ORG = "00000000-0000-4000-8000-000000000001";
const UNKNOWN = "00000000-0000-4000-8000-000000000099";
const UNKNOWN_OTHER = "00000000-0000-4000-8000-000000000098";
const DASHES = "-".repeat(36);

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...extra };
}

function call(path: string, method = "GET", body?: unknown, orgId = ORG) {
  return worker.fetch(
    new Request(`https://local.test${path}`, {
      method,
      headers: headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { ...bindings, LAB_ORG_ID: orgId },
  );
}

const GOOD_SOURCE = {
  files: [{ path: "index.html", content: "<h1>hello</h1>" }],
  dependencies: [{ name: "wrangnarok-ui", version: "1.0.0" }],
};

async function createApp(name = "branch-app", slug = "branch-app") {
  const response = await call("/api/apps", "POST", { name, slug });
  expect(response.status).toBe(201);
  return ((await response.json()) as { app: { id: string } }).app.id;
}

async function buildLive(id: string) {
  expect((await call(`/api/apps/${id}/source`, "PUT", GOOD_SOURCE)).status).toBe(200);
  const build = await call(`/api/apps/${id}/builds`, "POST");
  expect(build.status).toBe(202);
  expect(((await build.json()) as { job: { status: string } }).job.status).toBe("succeeded");
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration6);
});

afterEach(async () => {
  await reset();
});

it("rejects malformed UUID segments with INVALID_APP_ID, never a route leak", async () => {
  const detail = await call(`/api/apps/${DASHES}`);
  expect(detail.status).toBe(400);
  expect(await detail.json()).toMatchObject({ error: { code: "INVALID_APP_ID" } });
  const id = await createApp("dash-job", "dash-job");
  const job = await call(`/api/apps/${id}/builds/${DASHES}`);
  expect(job.status).toBe(400);
  expect(await job.json()).toMatchObject({ error: { code: "INVALID_JOB_ID" } });
});

it("collects source shape failures field by field instead of throwing blind", async () => {
  const id = await createApp("shapes", "shapes");
  const badFile = await call(`/api/apps/${id}/source`, "PUT", {
    files: [{ path: "ok.html" }],
    dependencies: [],
  });
  expect(badFile.status).toBe(422);
  expect(await badFile.json()).toMatchObject({ error: { code: "APP_VALIDATION_FAILED" } });
  const escape = await call(`/api/apps/${id}/source`, "PUT", {
    files: [{ path: "a/../b.html", content: "x" }],
    dependencies: [],
  });
  expect(escape.status).toBe(422);
  const duplicate = await call(`/api/apps/${id}/source`, "PUT", {
    files: [
      { path: "dup.html", content: "x" },
      { path: "dup.html", content: "y" },
    ],
    dependencies: [],
  });
  expect(duplicate.status).toBe(422);
  const badDepShape = await call(`/api/apps/${id}/source`, "PUT", {
    files: [{ path: "index.html", content: "x" }],
    dependencies: [{ name: "wrangnarok-ui" }],
  });
  expect(badDepShape.status).toBe(422);
  const badDepSlug = await call(`/api/apps/${id}/source`, "PUT", {
    files: [{ path: "index.html", content: "x" }],
    dependencies: [{ name: "Bad Name!", version: "1.0.0" }],
  });
  expect(badDepSlug.status).toBe(422);
  const depsNotList = await call(`/api/apps/${id}/source`, "PUT", {
    files: [{ path: "index.html", content: "x" }],
    dependencies: "nope",
  });
  expect(depsNotList.status).toBe(400);
  expect(await depsNotList.json()).toMatchObject({ error: { code: "INVALID_SOURCE" } });
});

it("bounds single files by bytes even when the transport fits", () => {
  let code = "";
  try {
    validateAppSource([{ path: "big.html", content: "x".repeat(5000) }], []);
  } catch (error) {
    code = (error as { code?: string }).code ?? "";
    const details = (error as { details?: { code?: string }[] }).details ?? [];
    expect(details.some((failure) => failure.code === "FILE_TOO_LARGE")).toBe(true);
  }
  expect(code).toBe("APP_VALIDATION_FAILED");
});

it("answers unknown apps 404 on every lookup and mutation route", async () => {
  expect((await call(`/api/apps/${UNKNOWN}`)).status).toBe(404);
  expect((await call(`/api/apps/${UNKNOWN}`, "DELETE")).status).toBe(404);
  expect((await call(`/api/apps/${UNKNOWN}/source`, "PUT", GOOD_SOURCE)).status).toBe(404);
  expect((await call(`/api/apps/${UNKNOWN}/validate`, "POST")).status).toBe(404);
  expect((await call(`/api/apps/${UNKNOWN}/builds`, "POST")).status).toBe(404);
  expect((await call(`/api/apps/${UNKNOWN}/builds`)).status).toBe(404);
  expect((await call(`/api/apps/${UNKNOWN}/builds/${UNKNOWN}`, "GET")).status).toBe(404);
  expect((await call(`/api/apps/${UNKNOWN}/swap`, "POST", { otherAppId: UNKNOWN_OTHER })).status).toBe(404);
});

it("rejects cross-origin form posts on app builds (codex #355)", async () => {
  // Codex #355: starting a build mutates deploy state behind the JSON-write
  // gate, so a cross-origin form post (simple content type, no preflight)
  // answers 415 JSON_REQUIRED and no deploy job is created.
  const id = await createApp("csrf-build", "csrf-build");
  expect((await call(`/api/apps/${id}/source`, "PUT", GOOD_SOURCE)).status).toBe(200);
  const formBuild = await worker.fetch(
    new Request(`https://local.test/api/apps/${id}/builds`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "confirm=yes",
    }),
    { ...bindings, LAB_ORG_ID: ORG },
  );
  expect(formBuild.status).toBe(415);
  expect(await formBuild.json()).toMatchObject({ error: { code: "JSON_REQUIRED" } });
  const jobs = (await (await call(`/api/apps/${id}/builds`)).json()) as { jobs: unknown[] };
  expect(jobs.jobs).toEqual([]);
});

it("rejects non-object bodies and unknown swap/job targets fail-closed", async () => {
  const nullCreate = await call("/api/apps", "POST", null);
  expect(nullCreate.status).toBe(400);
  expect(await nullCreate.json()).toMatchObject({ error: { code: "INVALID_APP" } });
  const id = await createApp("targets", "targets");
  const nullSource = await call(`/api/apps/${id}/source`, "PUT", null);
  expect(nullSource.status).toBe(400);
  const unknownOther = await call(`/api/apps/${id}/swap`, "POST", { otherAppId: UNKNOWN_OTHER });
  expect(unknownOther.status).toBe(404);
  await buildLive(id);
  const unknownJob = await call(`/api/apps/${id}/builds/${UNKNOWN}`, "GET");
  expect(unknownJob.status).toBe(404);
  expect(await unknownJob.json()).toMatchObject({ error: { code: "JOB_NOT_FOUND" } });
});

it("validates the current revision explicitly: empty, invalid, then missing file assets", async () => {
  const id = await createApp("validate-me", "validate-me");
  const empty = await call(`/api/apps/${id}/validate`, "POST");
  expect(empty.status).toBe(409);
  expect(await empty.json()).toMatchObject({ error: { code: "NO_REVISION" } });
  expect(
    (
      await call(`/api/apps/${id}/source`, "PUT", {
        files: [{ path: "index.html", content: "x" }],
        dependencies: [{ name: "evil-lib", version: "9.9.9" }],
      })
    ).status,
  ).toBe(422);
  const invalid = await call(`/api/apps/${id}/validate`, "POST");
  expect(invalid.status).toBe(422);
  expect(await invalid.json()).toMatchObject({ error: { code: "APP_VALIDATION_FAILED" } });
  await buildLive(id);
  const missingAsset = await call(`/api/apps/${id}/assets/no-such-file.html`);
  expect(missingAsset.status).toBe(404);
  expect(await missingAsset.json()).toMatchObject({ error: { code: "ASSET_NOT_FOUND" } });
  const longAsset = await call(`/api/apps/${id}/assets/${"x".repeat(200)}`);
  expect(longAsset.status).toBe(400);
  expect(await longAsset.json()).toMatchObject({ error: { code: "INVALID_ASSET" } });
});

it("keeps a live app live across valid edits", async () => {
  const id = await createApp("stay-live", "stay-live");
  await buildLive(id);
  expect((await call(`/api/apps/${id}/source`, "PUT", GOOD_SOURCE)).status).toBe(200);
  const detail = (await (await call(`/api/apps/${id}`)).json()) as { app: { status: string } };
  expect(detail.app.status).toBe("live");
});

it("fails a poisoned build closed and keeps the failed job inspectable", async () => {
  const id = await createApp("poison", "poison");
  expect((await call(`/api/apps/${id}/source`, "PUT", GOOD_SOURCE)).status).toBe(200);
  await bindings.DB.prepare("UPDATE app_revisions SET files_json=? WHERE app_id=?")
    .bind(JSON.stringify([{ path: "../evil.html", content: "x" }]), id)
    .run();
  const build = await call(`/api/apps/${id}/builds`, "POST");
  expect(build.status).toBe(202);
  const job = ((await build.json()) as { job: { status: string; error: { code: string } } }).job;
  expect(job.status).toBe("failed");
  expect(job.error.code).toBe("APP_VALIDATION_FAILED");
  const jobs = (await (await call(`/api/apps/${id}/builds`)).json()) as {
    jobs: { status: string; error: { code: string } | null }[];
  };
  expect(jobs.jobs[0]?.error?.code).toBe("APP_VALIDATION_FAILED");
  const detail = (await (await call(`/api/apps/${id}`)).json()) as { app: { status: string } };
  expect(detail.app.status).toBe("ready");
});

it("preserves the live pointer when a later build fails after deploy", async () => {
  const id = await createApp("live-poison", "live-poison");
  await buildLive(id);
  const before = (await (await call(`/api/apps/${id}`)).json()) as {
    app: { activeDeploymentId: string };
  };
  await bindings.DB.prepare("UPDATE app_revisions SET files_json=? WHERE app_id=?")
    .bind(JSON.stringify([{ path: "../evil.html", content: "x" }]), id)
    .run();
  const build = await call(`/api/apps/${id}/builds`, "POST");
  expect(build.status).toBe(202);
  expect(((await build.json()) as { job: { status: string } }).job.status).toBe("failed");
  const after = (await (await call(`/api/apps/${id}`)).json()) as {
    app: { activeDeploymentId: string; status: string };
  };
  expect(after.app.activeDeploymentId).toBe(before.app.activeDeploymentId);
  expect(after.app.status).toBe("live");
});

it("serves nothing once the active deployment row is gone", async () => {
  const id = await createApp("gone-live", "gone-live");
  await buildLive(id);
  await bindings.DB.prepare("DELETE FROM app_deployments WHERE app_id=?").bind(id).run();
  const detail = (await (await call(`/api/apps/${id}`)).json()) as {
    app: { activeDeployment: unknown };
  };
  expect(detail.app.activeDeployment).toBeNull();
  const asset = await call(`/api/apps/${id}/assets/index.html`);
  expect(asset.status).toBe(404);
  expect(await asset.json()).toMatchObject({ error: { code: "APP_NOT_LIVE" } });
});
