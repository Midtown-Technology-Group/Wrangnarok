// SPDX-License-Identifier: AGPL-3.0
// OPS-01 (issue #172): administrative audit trails and user-visible
// operational notifications, proven against real local D1 in workerd.
// Applies the full migration chain (0001 + 0002 + 0006 + 0007) so the ops
// schema composes with the existing tables.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { echoSaga, Fault } from "../src/domain";
import {
  createNotification,
  parseAuditQuery,
  parseNotificationId,
  parseNotificationLimit,
  visibleNotification,
} from "../src/ops";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration6 from "../migrations/0006_apps.sql?raw";
import migrationOrg from "../migrations/0007_org_membership.sql?raw";
import migration9 from "../migrations/0011_connection_admin.sql?raw";
import migration18 from "../migrations/0018_ops.sql?raw";
import migrationFiles from "../migrations/0019_files.sql?raw";
import migrationEndpoints from "../migrations/0021_endpoints.sql?raw";
import migrationAppRuntime from "../migrations/0022_app_runtime.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

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
    new Request(`http://local.test${path}`, {
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

async function createApp(name = "ops-app", slug = "ops-app") {
  const response = await call("/api/apps", "POST", { name, slug });
  expect(response.status).toBe(201);
  return ((await response.json()) as { app: { id: string } }).app.id;
}

async function buildApp(id: string) {
  await call(`/api/apps/${id}/source`, "PUT", GOOD_SOURCE);
  const build = await call(`/api/apps/${id}/builds`, "POST");
  expect(build.status).toBe(202);
  const body = (await build.json()) as { job: { id: string; status: string } };
  return body.job;
}

async function auditEvents(query = "") {
  const response = await call(`/api/audit${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    events: {
      id: string;
      action: string;
      outcome: string;
      targetType: string | null;
      targetId: string | null;
      detail: unknown;
      actorUserId: string;
    }[];
    hasMore: boolean;
    nextCursor: string | null;
  };
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(migration6);
  await bindings.DB.exec(migrationOrg);
  await bindings.DB.exec(migration9);
  await bindings.DB.exec(migration18);
  await bindings.DB.exec(migrationFiles);
  await bindings.DB.exec(migrationEndpoints);
  await bindings.DB.exec(migrationAppRuntime);
  await bindings.DB.exec(seed);
});

afterEach(async () => {
  await reset();
});

it("records actor/org/action/target/outcome for app lifecycle and serves keyset pages", async () => {
  const id = await createApp("store", "store");
  await call(`/api/apps/${id}/source`, "PUT", GOOD_SOURCE);
  await buildApp(id);
  const swapped = await createApp("store backup", "store-v1");
  await call(`/api/apps/${swapped}/source`, "PUT", GOOD_SOURCE);
  await call(`/api/apps/${swapped}/builds`, "POST");
  expect((await call(`/api/apps/${id}/swap`, "POST", { otherAppId: swapped })).status).toBe(200);
  expect((await call(`/api/apps/${swapped}`, "DELETE")).status).toBe(200);

  const page = await auditEvents();
  const actions = page.events.map((event) => event.action);
  for (const action of [
    "app.create",
    "app.source.edit",
    "app.build.start",
    "app.build.complete",
    "app.swap",
    "app.delete",
  ]) {
    expect(actions).toContain(action);
  }
  // Newest-first with opaque cursors; summaries carry the scrubbed detail.
  const created = page.events.find((event) => event.action === "app.delete");
  expect(created).toMatchObject({ outcome: "success", targetType: "app", targetId: swapped });
  expect(page.hasMore).toBe(false);
  expect(page.nextCursor).toBeNull();
  // Action-prefix and outcome filters run server-side.
  const builds = await auditEvents("?action=app.build.");
  expect(builds.events.length).toBeGreaterThan(0);
  expect(builds.events.every((event) => event.action.startsWith("app.build."))).toBe(true);
  const failures = await auditEvents("?outcome=failure");
  expect(failures.events.every((event) => event.outcome === "failure")).toBe(true);
  // Cursor traversal preserves filters with no overlap.
  const first = await auditEvents("?limit=3");
  expect(first.hasMore).toBe(true);
  expect(typeof first.nextCursor).toBe("string");
  const second = await auditEvents(`?limit=3&cursor=${encodeURIComponent(first.nextCursor as string)}`);
  const firstIds = new Set(first.events.map((event) => event.id));
  expect(second.events.every((event) => !firstIds.has(event.id))).toBe(true);
});

it("records policy denies and cancel outcomes with failure attribution", async () => {
  const id = await createApp("loose", "loose");
  await bindings.DB.prepare("UPDATE apps SET owner_kind='solution', managed_by=? WHERE id=?")
    .bind("b10a7c2e-3f4d-4a5b-8c6d-7e8f9a0b1c2d@1.0.0", id)
    .run();
  const denied = await call(`/api/apps/${id}/source`, "PUT", GOOD_SOURCE);
  expect(denied.status).toBe(409);
  const denies = await auditEvents("?action=app.managed_deny");
  expect(denies.events).toHaveLength(1);
  expect(denies.events[0]).toMatchObject({ outcome: "failure", targetId: id });
  // A denied build records its failure audit and emits no notification.
  const deniedBuild = await call(`/api/apps/${id}/builds`, "POST");
  expect(deniedBuild.status).toBe(409);
  const inbox = (await (await call("/api/notifications")).json()) as { notifications: unknown[] };
  expect(inbox.notifications).toEqual([]);
});

it("scopes audit reads to the Organization and rejects bad filters", async () => {
  await createApp("private", "private");
  const foreign = await call("/api/audit", "GET", undefined, OTHER_ORG);
  expect(foreign.status).toBe(200);
  expect(((await foreign.json()) as { events: unknown[] }).events).toEqual([]);
  // Same org, different user: org-scoped visibility holds (org boundary, not per-user).
  const sameOrg = await call("/api/audit", "GET", undefined, ORG, OTHER_USER);
  expect(sameOrg.status).toBe(200);
  expect(((await sameOrg.json()) as { events: unknown[] }).events.length).toBeGreaterThan(0);
  expect(await (await call("/api/audit?action=")).json()).toMatchObject({ error: { code: "INVALID_ACTION_PREFIX" } });
  expect(await (await call("/api/audit?outcome=bogus")).json()).toMatchObject({ error: { code: "INVALID_OUTCOME" } });
  expect(await (await call("/api/audit?search=")).json()).toMatchObject({ error: { code: "INVALID_SEARCH" } });
  expect(await (await call("/api/audit?cursor=!!!")).json()).toMatchObject({ error: { code: "INVALID_CURSOR" } });
  expect(await (await call("/api/audit?foo=1")).json()).toMatchObject({ error: { code: "UNSUPPORTED_QUERY" } });
});

it("scrubs sensitive payloads from audit details and never invents success on storage failure", async () => {
  const secret = "test-client-secret-sentinel";
  const id = await createApp("scrub", "scrub");
  // The slug rides the detail; a secret substring embedded anywhere in the
  // detail must come back redacted.
  await bindings.DB.prepare("UPDATE audit_events SET detail_json=? WHERE action='app.create'")
    .bind(JSON.stringify({ slug: "scrub", leaked: `prefix-${secret}-suffix` }))
    .run();
  const page = await auditEvents("?action=app.create");
  expect(JSON.stringify(page)).not.toContain(secret);
  expect(JSON.stringify(page)).toContain("[REDACTED]");
  // Storage-failure policy is explicit: with no audit table the primary
  // mutation still succeeds (best-effort, logged, never fabricated).
  await bindings.DB.exec("DROP TABLE audit_events");
  const after = await call("/api/apps", "POST", { name: "after-drop", slug: "after-drop" });
  expect(after.status).toBe(201);
  expect((await call(`/api/apps/${id}`, "DELETE")).status).toBe(200);
});

it("emits a terminal personal notification per deploy job with dedup", async () => {
  const id = await createApp("notify", "notify");
  const job = await buildApp(id);
  expect(job.status).toBe("succeeded");
  const inbox = (await (await call("/api/notifications")).json()) as {
    notifications: {
      id: string;
      scope: string;
      status: string;
      title: string;
      detail: { appId: string; jobId: string };
    }[];
  };
  expect(inbox.notifications).toHaveLength(1);
  expect(inbox.notifications[0]).toMatchObject({
    scope: "personal",
    status: "completed",
    detail: { appId: id, jobId: job.id },
  });
  const one = await call(`/api/notifications/${inbox.notifications[0]!.id}`);
  expect(one.status).toBe(200);
  // Rebuilding creates a new job row and a new notification; re-creating for
  // the same job converges on the existing row (no duplicates).
  const again = await call(`/api/apps/${id}/builds`, "POST");
  expect(again.status).toBe(202);
  const inbox2 = (await (await call("/api/notifications")).json()) as { notifications: unknown[] };
  expect(inbox2.notifications).toHaveLength(2);
});

it("enforces dismissal ownership and never leaks cross-user notifications", async () => {
  const id = await createApp("dismiss", "dismiss");
  await buildApp(id);
  const inbox = (await (await call("/api/notifications")).json()) as { notifications: { id: string }[] };
  const noteId = inbox.notifications[0]!.id;
  // Another user in the same org cannot fetch or dismiss a personal row.
  expect((await call(`/api/notifications/${noteId}`, "GET", undefined, ORG, OTHER_USER)).status).toBe(404);
  expect((await call(`/api/notifications/${noteId}`, "DELETE", undefined, ORG, OTHER_USER)).status).toBe(404);
  // A foreign org never sees the row at all.
  const foreignInbox = (await (await call("/api/notifications", "GET", undefined, OTHER_ORG)).json()) as {
    notifications: unknown[];
  };
  expect(foreignInbox.notifications).toEqual([]);
  expect((await call(`/api/notifications/${noteId}`, "GET", undefined, OTHER_ORG)).status).toBe(404);
  // Owner dismissal removes it from the inbox; a second dismiss is gone (404).
  expect((await call(`/api/notifications/${noteId}`, "DELETE")).status).toBe(200);
  const after = (await (await call("/api/notifications")).json()) as { notifications: unknown[] };
  expect(after.notifications).toEqual([]);
  expect((await call(`/api/notifications/${noteId}`, "DELETE")).status).toBe(404);
  expect((await call(`/api/notifications/${noteId}`, "GET")).status).toBe(404);
  expect(await (await call("/api/notifications/not-an-id", "GET")).json()).toMatchObject({
    error: { code: "INVALID_NOTIFICATION_ID" },
  });
  expect(await (await call("/api/notifications?foo=1")).json()).toMatchObject({ error: { code: "UNSUPPORTED_QUERY" } });
});

it("reconciles interrupted jobs on read instead of reporting stale progress", async () => {
  const id = await createApp("stale", "stale");
  const job = await buildApp(id);
  // Simulate an interrupted client view: flip the notification back to
  // running. The job row is terminally succeeded, so the next read must
  // advance the notification to completed instead of showing stale progress.
  const inbox = (await (await call("/api/notifications")).json()) as { notifications: { id: string }[] };
  await bindings.DB.prepare("UPDATE notifications SET status='running',progress_percent=10 WHERE id=?")
    .bind(inbox.notifications[0]!.id)
    .run();
  const reread = await call(`/api/notifications/${inbox.notifications[0]!.id}`);
  expect(reread.status).toBe(200);
  expect(await reread.json()).toMatchObject({ notification: { status: "completed" } });
  expect(job.status).toBe("succeeded");
});

it("audits owner cancellation outcomes through the cancel route", async () => {
  // Undispatched Pending + vacuous native stop confirms: execution.cancel lands.
  const submitted = await worker.fetch(
    new Request("http://local.test/api/executions", {
      method: "POST",
      headers: { ...headers(), "Idempotency-Key": "ops-cancel-confirmed-001" },
      body: JSON.stringify({ sagaId: echoSaga.id, input: { message: "hello" } }),
    }),
    bindings,
  );
  expect(submitted.status).toBe(202);
  const { executionId } = (await submitted.json()) as { executionId: string };
  // Force the vacuous path: undispatched Pending plus a native binding whose
  // instance never existed.
  await bindings.DB.prepare("UPDATE executions SET dispatched=0,status='Pending' WHERE id=?").bind(executionId).run();
  const vacuous = {
    ...bindings,
    ECHO_WORKFLOW: {
      createBatch: async () => {},
      get: async () => {
        throw new Error("instance.not_found");
      },
    } as unknown as Bindings["ECHO_WORKFLOW"],
  };
  const cancelled = await worker.fetch(
    new Request(`http://local.test/api/executions/${executionId}/cancel`, {
      method: "POST",
      headers: headers(),
    }),
    vacuous,
  );
  expect(cancelled.status).toBe(200);
  const confirmed = await auditEvents("?action=execution.cancel");
  expect(confirmed.events.some((event) => event.targetId === executionId && event.outcome === "success")).toBe(true);
  // Ambiguous path: a dispatched Running row whose native instance vanished.
  // 503 + execution.cancel_unconfirmed (failure), retry-safe.
  const submitted2 = await worker.fetch(
    new Request("http://local.test/api/executions", {
      method: "POST",
      headers: { ...headers(), "Idempotency-Key": "ops-cancel-ambiguous-001" },
      body: JSON.stringify({ sagaId: echoSaga.id, input: { message: "hello" } }),
    }),
    bindings,
  );
  expect(submitted2.status).toBe(202);
  const { executionId: id2 } = (await submitted2.json()) as { executionId: string };
  await bindings.DB.prepare("UPDATE executions SET status='Running' WHERE id=?").bind(id2).run();
  const ambiguous = await worker.fetch(
    new Request(`http://local.test/api/executions/${id2}/cancel`, { method: "POST", headers: headers() }),
    vacuous,
  );
  expect(ambiguous.status).toBe(503);
  const unconfirmed = await auditEvents("?action=execution.cancel_unconfirmed");
  expect(unconfirmed.events.some((event) => event.targetId === id2 && event.outcome === "failure")).toBe(true);
});

it("searches audit details and tolerates corrupt stored rows", async () => {
  await createApp("searchable", "searchable");
  const found = await auditEvents("?search=searchable");
  expect(found.events.length).toBeGreaterThan(0);
  // Corrupt JSON in a stored row degrades to a null detail, never a 500.
  await bindings.DB.prepare("UPDATE audit_events SET detail_json='{{{not-json' WHERE action='app.create'").run();
  const degraded = await auditEvents("?action=app.create&limit=1");
  expect(degraded.events[0]).toMatchObject({ action: "app.create" });
  expect(degraded.events[0]!.detail).toBeNull();
  // Date bounds filter server-side; reversed bounds fail closed.
  const window = await auditEvents("?startDate=2026-09-01&endDate=2026-09-30");
  expect(window.events.length).toBeGreaterThan(0);
  expect(await (await call("/api/audit?startDate=2026-09-10&endDate=2026-09-01")).json()).toMatchObject({
    error: { code: "INVALID_DATE_RANGE" },
  });
});

it("rejects malformed ops inputs without touching the database", () => {
  expect(() => parseAuditQuery(new URLSearchParams("limit=0"))).toThrowError(Fault);
  expect(() => parseAuditQuery(new URLSearchParams("limit=51"))).toThrowError(Fault);
  expect(() => parseAuditQuery(new URLSearchParams("startDate=nope"))).toThrowError(Fault);
  expect(() => parseAuditQuery(new URLSearchParams("endDate=nope"))).toThrowError(Fault);
  expect(() => parseNotificationId("nope")).toThrowError(Fault);
  expect(() => parseNotificationLimit(new URLSearchParams("limit=101"))).toThrowError(Fault);
  expect(parseNotificationLimit(new URLSearchParams(""))).toBe(50);
});

it("keeps deny-by-default query posture on adjacent list routes", async () => {
  expect(await (await call("/api/apps?scope=all")).json()).toMatchObject({ error: { code: "UNSUPPORTED_QUERY" } });
  expect(await (await call("/api/notifications?limit=0")).json()).toMatchObject({ error: { code: "INVALID_LIMIT" } });
});

it("leaves running notifications alone when the jobs table is unavailable", async () => {
  // reconcileNotification catches a missing app_jobs table and returns the
  // row untouched (no invented terminal state, no throw).
  const me = { orgId: ORG, userId: "00000000-0000-4000-8000-000000000002" };
  const note = await createNotification(bindings.DB, me, {
    scope: "personal",
    category: "system",
    title: "running-no-jobs-table",
    status: "running",
    detail: { jobId: "11111111-1111-4111-8111-111111111111", appId: "22222222-2222-4222-8222-222222222222" },
  });
  await bindings.DB.exec("DROP TABLE app_jobs");
  const reread = await visibleNotification(bindings.DB, me, note.id);
  expect(reread?.status).toBe("running");
});

it("rethrows non-Fault failures without auditing them", async () => {
  // Fault injection at the storage layer: with the apps table gone, every
  // audited app route throws a raw D1 Error (never a Fault). The routes must
  // skip audit emission and rethrow, so the caller sees 500 INTERNAL_ERROR
  // rather than a fabricated audit row or a swallowed failure.
  const id = await createApp("fault", "fault");
  await bindings.DB.exec("DROP TABLE apps");
  const otherId = "11111111-1111-4111-8111-111111111111";
  // POST /api/apps converts any storage failure into SLUG_CONFLICT (409);
  // the remaining audited routes let raw D1 errors through untouched.
  const created = await call("/api/apps", "POST", { name: "x", slug: "x" });
  expect(created.status).toBe(409);
  const cases: [string, string, unknown][] = [
    [`/api/apps/${id}/source`, "PUT", GOOD_SOURCE],
    [`/api/apps/${id}/builds`, "POST", undefined],
    [`/api/apps/${id}/swap`, "POST", { otherAppId: otherId }],
    [`/api/apps/${id}`, "DELETE", undefined],
  ];
  for (const [path, method, body] of cases) {
    const response = await call(path, method, body);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
  }
});

// OPS-02 (issue #173): Cloudflare-native diagnostics and repair workflows,
// proven against real local D1 in workerd. Reads are Organization-scoped;
// repairs inspect by default and execute only behind the admin gate with an
// explicit dryRun:false commit.

it("serves version, health, metrics, scheduler, jobs, preflight, and connection health", async () => {
  const version = await call("/api/ops/version");
  expect(version.status).toBe(200);
  const versionBody = (await version.json()) as {
    version: { sdkVersion: string; sagaCatalog: { count: number; revision: string }; migrationsApplied: unknown };
  };
  expect(versionBody.version.sdkVersion).toBe("1");
  expect(versionBody.version.sagaCatalog.count).toBeGreaterThan(0);
  // No Cloudflare metering or secrets ride the version contract.
  expect(JSON.stringify(versionBody)).not.toContain("test-client-secret-sentinel");

  const health = await call("/api/ops/health");
  expect(health.status).toBe(200);
  expect(await health.json()).toMatchObject({ status: "ok", database: "ok", worker: "ok" });

  const metrics = await call("/api/ops/metrics");
  expect(metrics.status).toBe(200);
  const metricsBody = (await metrics.json()) as {
    metrics: { executions: { total: number; pendingUndispatched: number }; recentFailures: unknown[] };
  };
  expect(metricsBody.metrics.executions.total).toBe(0);
  expect(metricsBody.metrics.recentFailures).toEqual([]);

  const tasks = await call("/api/ops/scheduled-tasks");
  expect(tasks.status).toBe(200);
  // No scheduler process exists in this slice: an empty endpoint inventory
  // answers an empty task list, honestly stating the gap.
  expect(await tasks.json()).toEqual({ tasks: [] });

  const jobs = await call("/api/ops/jobs");
  expect(jobs.status).toBe(200);
  const jobsBody = (await jobs.json()) as {
    jobs: { executions: { total: number }; appBuilds: { queued: number; interrupted: unknown[] } };
  };
  expect(jobsBody.jobs.executions.total).toBe(0);
  expect(jobsBody.jobs.appBuilds.interrupted).toEqual([]);

  const preflight = await call("/api/ops/preflight");
  expect(preflight.status).toBe(200);
  const preflightBody = (await preflight.json()) as {
    integrations: { integrationName: string; connected: boolean; ready: boolean }[];
  };
  const echo = preflightBody.integrations.find((entry) => entry.integrationName === "echo");
  // The local seed owns the fixture echo mapping for the LAB org.
  expect(echo).toMatchObject({ connected: true, ready: true });
  expect(JSON.stringify(preflightBody)).not.toContain("test-client-secret-sentinel");

  const conns = await call("/api/ops/connections");
  expect(conns.status).toBe(200);
  const connsBody = (await conns.json()) as {
    connections: { integrationName: string; connected: boolean; testHint: string }[];
  };
  expect(connsBody.connections.find((entry) => entry.integrationName === "echo")).toMatchObject({
    connected: true,
  });
});

it("counts the admission backlog and surfaces recent failures without bodies", async () => {
  const submitted = await worker.fetch(
    new Request("http://local.test/api/executions", {
      method: "POST",
      headers: { ...headers(), "Idempotency-Key": "ops-metrics-backlog-001" },
      body: JSON.stringify({ sagaId: echoSaga.id, input: { message: "hello" } }),
    }),
    bindings,
  );
  expect(submitted.status).toBe(202);
  const { executionId } = (await submitted.json()) as { executionId: string };
  // Simulate an unconfirmed dispatch: the Pending receipt exists but the
  // Workflow dispatch never confirmed.
  await bindings.DB.prepare("UPDATE executions SET dispatched=0,status='Pending' WHERE id=?").bind(executionId).run();
  // A terminal failure row carries its safe error code, never input/result.
  await bindings.DB.prepare("UPDATE executions SET status='Failed',completed_at=?,error_json=? WHERE id=?")
    .bind(new Date().toISOString(), JSON.stringify({ code: "ECHO_INTEGRATION_FAILED", message: "nope" }), executionId)
    .run();
  const metrics = (await (await call("/api/ops/metrics?recent=5")).json()) as {
    metrics: {
      executions: { total: number; failed: number };
      recentFailures: { executionId: string; code: string; completedAt: string }[];
    };
  };
  expect(metrics.metrics.executions.total).toBe(1);
  expect(metrics.metrics.executions.failed).toBe(1);
  expect(metrics.metrics.recentFailures).toHaveLength(1);
  expect(metrics.metrics.recentFailures[0]).toMatchObject({
    executionId,
    code: "ECHO_INTEGRATION_FAILED",
  });
  expect(JSON.stringify(metrics)).not.toContain("hello");
  expect(await (await call("/api/ops/metrics?recent=0")).json()).toMatchObject({ error: { code: "INVALID_LIMIT" } });
  expect(await (await call("/api/ops/metrics?foo=1")).json()).toMatchObject({ error: { code: "UNSUPPORTED_QUERY" } });
});

it("flags interrupted builds and repairs the stuck app status", async () => {
  const id = await createApp("stuck", "stuck");
  await buildApp(id);
  // Simulate interruption: the build settled but the app row never left
  // `building` (a crash between the job write and the status flip).
  await bindings.DB.prepare("UPDATE apps SET status='building' WHERE id=?").bind(id).run();
  const jobs = (await (await call("/api/ops/jobs")).json()) as {
    jobs: { appBuilds: { succeeded: number; interrupted: { appId: string }[] } };
  };
  expect(jobs.jobs.appBuilds.succeeded).toBe(1);
  expect(jobs.jobs.appBuilds.interrupted.map((entry) => entry.appId)).toContain(id);
  // Dry-run inspects without mutating: still building afterwards.
  const inspect = await call("/api/ops/repairs", "POST", {
    kind: "repair-stuck-build",
    targetId: id,
  });
  expect(inspect.status).toBe(200);
  expect(await inspect.json()).toMatchObject({ repair: { kind: "repair-stuck-build", dryRun: true } });
  const still = (await bindings.DB.prepare("SELECT status FROM apps WHERE id=?").bind(id).first<{ status: string }>())
    ?.status;
  expect(still).toBe("building");
  // Execute restores the prior usable status (live: a deployment exists).
  const repaired = await call("/api/ops/repairs", "POST", {
    kind: "repair-stuck-build",
    targetId: id,
    dryRun: false,
  });
  expect(repaired.status).toBe(200);
  expect(await repaired.json()).toMatchObject({ repair: { kind: "repair-stuck-build", dryRun: false } });
  const restored = (
    await bindings.DB.prepare("SELECT status FROM apps WHERE id=?").bind(id).first<{ status: string }>()
  )?.status;
  expect(restored).toBe("live");
  // The repair emits its audit event; a second run finds nothing stuck.
  const events = await auditEvents("?action=ops.repair.repair-stuck-build");
  expect(events.events.some((event) => event.targetId === id && event.outcome === "success")).toBe(true);
  const again = await call("/api/ops/repairs", "POST", { kind: "repair-stuck-build", targetId: id, dryRun: false });
  expect(await again.json()).toMatchObject({ repair: { dryRun: false } });
});

it("cleans up pending uploads and expired tokens with bounded deletes", async () => {
  // One pending upload row plus its expired capability token.
  const now = new Date().toISOString();
  await bindings.DB.prepare(
    "INSERT INTO file_locations(org_id,name,max_bytes,content_types_json,shared_read,created_at) VALUES (?,?,?,?,?,?)",
  )
    .bind(ORG, "ops-cleanup", 1024, "[]", 0, now)
    .run();
  await bindings.DB.prepare("INSERT INTO file_policies(org_id,location,action,created_at) VALUES (?,?,?,?)")
    .bind(ORG, "ops-cleanup", "write", now)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO files(org_id,location,path,version,size,content_type,sha256,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(ORG, "ops-cleanup", "stale.bin", 0, 0, "", "", "pending", now, now)
    .run();
  const capId = "11111111-1111-4111-8111-111111111111";
  await bindings.DB.prepare(
    "INSERT INTO file_capabilities(id,org_id,source_org_id,location,path,action,staging_key,token_hash,expires_at,used_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,NULL,?)",
  )
    .bind(
      capId,
      ORG,
      ORG,
      "ops-cleanup",
      "stale.bin",
      "upload",
      "stale-key",
      "stale-hash",
      "2020-01-01T00:00:00.000Z",
      now,
    )
    .run();
  // Dry-runs count without deleting.
  const pendingInspect = await call("/api/ops/repairs", "POST", { kind: "cleanup-pending-uploads" });
  expect(await pendingInspect.json()).toMatchObject({ repair: { dryRun: true, result: { pending: 1 } } });
  const tokensInspect = await call("/api/ops/repairs", "POST", { kind: "cleanup-expired-tokens" });
  expect(tokensInspect.status).toBe(200);
  // Execute deletes both; live rows are untouched by construction (only
  // pending/expired rows match the fenced deletes).
  const pendingRun = await call("/api/ops/repairs", "POST", { kind: "cleanup-pending-uploads", dryRun: false });
  expect(await pendingRun.json()).toMatchObject({ repair: { dryRun: false, result: { deleted: 1 } } });
  const tokensRun = await call("/api/ops/repairs", "POST", { kind: "cleanup-expired-tokens", dryRun: false });
  expect(await tokensRun.json()).toMatchObject({
    repair: { dryRun: false, result: { capabilities: 1 } },
  });
});

it("gates repair execution behind admin membership with explicit commits", async () => {
  // OTHER_USER is a known user with no membership: a stranger's repair
  // inspect fails at the membership gate, never at repair policy.
  // LAB_FIXTURE_USER_ID pins the bootstrap identity so the swapped
  // LAB_USER_ID bootstraps nothing (the lifecycle-test posture).
  const stamp = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
    .bind(OTHER_USER, stamp)
    .run();
  const strangerBindings = {
    ...bindings,
    LAB_USER_ID: OTHER_USER,
    LAB_FIXTURE_USER_ID: "00000000-0000-4000-8000-000000000002",
  };
  const stranger = await worker.fetch(
    new Request("http://local.test/api/ops/repairs", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ kind: "cleanup-pending-uploads" }),
    }),
    strangerBindings,
  );
  expect(stranger.status).toBe(404);
  // An ordinary member may inspect (dry-run) but never execute: the commit
  // needs the admin gate, answered 403 with a machine-readable code.
  await bindings.DB.prepare(
    "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(ORG, OTHER_USER, "member", "active", "ordinary", stamp, stamp)
    .run();
  const memberInspect = await call("/api/ops/repairs", "POST", { kind: "cleanup-pending-uploads" }, ORG, OTHER_USER);
  expect(memberInspect.status).toBe(200);
  const memberExecute = await call(
    "/api/ops/repairs",
    "POST",
    { kind: "cleanup-pending-uploads", dryRun: false },
    ORG,
    OTHER_USER,
  );
  expect(memberExecute.status).toBe(403);
  expect(await memberExecute.json()).toMatchObject({ error: { code: "REPAIR_FORBIDDEN" } });
  // Malformed repairs fail closed before any mutation.
  expect(await (await call("/api/ops/repairs", "POST", { kind: "nope" })).json()).toMatchObject({
    error: { code: "INVALID_REPAIR_KIND" },
  });
  expect(await (await call("/api/ops/repairs", "POST", { kind: "repair-stuck-build" })).json()).toMatchObject({
    error: { code: "INVALID_REPAIR_TARGET" },
  });
  expect(
    await (
      await call("/api/ops/repairs", "POST", { kind: "cleanup-pending-uploads", targetId: "x", dryRun: false })
    ).json(),
  ).toMatchObject({ error: { code: "INVALID_REPAIR_TARGET" } });
  expect(await (await call("/api/ops/version?foo=1")).json()).toMatchObject({ error: { code: "UNSUPPORTED_QUERY" } });
  // Every other diagnostics read guards its query string the same way.
  for (const path of [
    "/api/ops/health?foo=1",
    "/api/ops/scheduled-tasks?foo=1",
    "/api/ops/jobs?foo=1",
    "/api/ops/preflight?foo=1",
    "/api/ops/connections?foo=1",
  ]) {
    expect(await (await call(path)).json()).toMatchObject({ error: { code: "UNSUPPORTED_QUERY" } });
  }
});

it("keeps ops diagnostics scoped to the Organization", async () => {
  await createApp("scoped", "scoped");
  const foreign = (await (await call("/api/ops/metrics", "GET", undefined, OTHER_ORG)).json()) as {
    metrics: { executions: { total: number } };
  };
  expect(foreign.metrics.executions.total).toBe(0);
  const foreignJobs = (await (await call("/api/ops/jobs", "GET", undefined, OTHER_ORG)).json()) as {
    jobs: { executions: { total: number } };
  };
  expect(foreignJobs.jobs.executions.total).toBe(0);
});

it("lists durable endpoints as scheduled tasks with delivery counts", async () => {
  // Seed one endpoint of each kind directly: the tasks surface reports
  // name, kind, enabled state, and recorded delivery depth with an honest
  // null cadence (no scheduler rows exist in this slice).
  const now = new Date().toISOString();
  for (const [id, name, kind, enabled] of [
    ["11111111-1111-4111-8111-111111111111", "ops-hook", "webhook", 1],
    ["22222222-2222-4222-8222-222222222222", "ops-key", "api-key", 0],
  ] as const) {
    await bindings.DB.prepare(
      "INSERT INTO endpoints(id,org_id,name,saga_id,kind,enabled,challenge,created_at) VALUES (?,?,?,?,?,?,?,?)",
    )
      .bind(id, ORG, name, echoSaga.id, kind, enabled, "none", now)
      .run();
  }
  await bindings.DB.prepare(
    "INSERT INTO endpoint_events(endpoint_id,event_id,input_json,execution_id,created_at) VALUES (?,?,?,?,?)",
  )
    .bind("11111111-1111-4111-8111-111111111111", "evt-1", "{}", "a".repeat(64), now)
    .run();
  const tasks = (await (await call("/api/ops/scheduled-tasks")).json()) as {
    tasks: { name: string; kind: string; enabled: boolean; cadence: string | null; detail: string }[];
  };
  expect(tasks.tasks).toHaveLength(2);
  expect(tasks.tasks[0]).toMatchObject({ name: "ops-hook", kind: "endpoint", enabled: true, cadence: null });
  expect(tasks.tasks[0]?.detail).toContain("1 recorded deliveries");
  expect(tasks.tasks[1]).toMatchObject({ name: "ops-key", enabled: false });
  expect(tasks.tasks[1]?.detail).toContain("0 recorded deliveries");
});

it("aggregates every deploy-job status in platform progress", async () => {
  // Seed one job per status directly: queued/running/failed join the
  // succeeded build from the helper path in the aggregate counts.
  const now = new Date().toISOString();
  const appIds = [
    "aaaaaaaa-1111-4111-8111-111111111111",
    "bbbbbbbb-2222-4222-8222-222222222222",
    "cccccccc-3333-4333-8333-333333333333",
  ];
  for (const [index, appId] of appIds.entries()) {
    await bindings.DB.prepare(
      "INSERT INTO apps(id,org_id,name,slug,owner_kind,managed_by,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?, ?,?)",
    )
      .bind(appId, ORG, `agg-${index}`, `agg-${index}`, "independent", null, "ready", now, now)
      .run();
  }
  const statuses = ["queued", "running", "failed"] as const;
  for (const [index, status] of statuses.entries()) {
    await bindings.DB.prepare(
      "INSERT INTO app_jobs(id,app_id,revision,status,created_at,started_at) VALUES (?,?,?,?,?,?)",
    )
      .bind(`dddddddd-1111-4111-8111-11111111111${index}`, appIds[index] as string, 1, status, now, now)
      .run();
  }
  const jobs = (await (await call("/api/ops/jobs")).json()) as {
    jobs: { appBuilds: { queued: number; running: number; succeeded: number; failed: number } };
  };
  expect(jobs.jobs.appBuilds).toMatchObject({ queued: 1, running: 1, failed: 1 });
});

it("retries terminal executions and cancels live ones through repairs", async () => {
  // Submit a terminal Failed execution, then retry it through the repair
  // route: the retry replays the original input under the fresh key.
  const submitted = await worker.fetch(
    new Request("http://local.test/api/executions", {
      method: "POST",
      headers: { ...headers(), "Idempotency-Key": "ops-repair-retry-001" },
      body: JSON.stringify({ sagaId: echoSaga.id, input: { message: "retry me" } }),
    }),
    bindings,
  );
  expect(submitted.status).toBe(202);
  const { executionId } = (await submitted.json()) as { executionId: string };
  await bindings.DB.prepare("UPDATE executions SET status='Failed',completed_at=?,error_json=? WHERE id=?")
    .bind(new Date().toISOString(), JSON.stringify({ code: "ECHO_INTEGRATION_FAILED", message: "nope" }), executionId)
    .run();
  const retryInspect = await call("/api/ops/repairs", "POST", {
    kind: "retry-execution",
    targetId: executionId,
    idempotencyKey: "ops-repair-retry-002",
  });
  expect(retryInspect.status).toBe(200);
  expect(await retryInspect.json()).toMatchObject({ repair: { dryRun: true } });
  // Live executions refuse retry: cancel the live one first.
  await bindings.DB.prepare("UPDATE executions SET status='Running' WHERE id=?").bind(executionId).run();
  const refused = await call("/api/ops/repairs", "POST", {
    kind: "retry-execution",
    targetId: executionId,
    idempotencyKey: "ops-repair-retry-003",
  });
  expect(await refused.json()).toMatchObject({ error: { code: "EXECUTION_NOT_REPAIRABLE" } });
  // Cancel the live execution through the repair route (dryRun:false).
  // The native binding is real workerd: terminate is best-effort, the D1
  // marker is the durable repair record.
  const cancelled = await call("/api/ops/repairs", "POST", {
    kind: "cancel-execution",
    targetId: executionId,
    dryRun: false,
  });
  expect(cancelled.status).toBe(200);
  const cancelledBody = (await cancelled.json()) as { repair: { dryRun: boolean; result: { cancelled: boolean } } };
  expect(cancelledBody.repair.dryRun).toBe(false);
  const row = await bindings.DB.prepare("SELECT status FROM executions WHERE id=?")
    .bind(executionId)
    .first<{ status: string }>();
  expect(["Cancelling", "Cancelled"]).toContain(row?.status);
  // Unknown saga IDs and unknown executions fail closed.
  const ghost = await call("/api/ops/repairs", "POST", {
    kind: "retry-execution",
    targetId: "d".repeat(64),
    idempotencyKey: "ops-repair-retry-004",
  });
  expect(await ghost.json()).toMatchObject({ error: { code: "EXECUTION_NOT_FOUND" } });
  // A retry whose Saga is no longer deployed fails closed (UNKNOWN_SAGA).
  const orphanId = "e".repeat(64);
  await bindings.DB.prepare(
    "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      orphanId,
      "00000000-0000-4000-8000-000000009999",
      "retired",
      "retired-v1",
      ORG,
      "00000000-0000-4000-8000-000000000002",
      "{}",
      1,
      "Failed",
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();
  const orphan = await call("/api/ops/repairs", "POST", {
    kind: "retry-execution",
    targetId: orphanId,
    idempotencyKey: "ops-repair-retry-005",
    dryRun: false,
  });
  expect(await orphan.json()).toMatchObject({ error: { code: "UNKNOWN_SAGA" } });
  // Cancelling an already-terminal execution through the repair route
  // answers the current status with cancelled:false (lost-race path).
  const settled = await call("/api/ops/repairs", "POST", {
    kind: "cancel-execution",
    targetId: executionId,
    dryRun: false,
  });
  expect(await settled.json()).toMatchObject({ repair: { dryRun: false } });
});
