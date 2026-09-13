// SPDX-License-Identifier: AGPL-3.0
// OPS-01 branch coverage (issue #172): pure parser guards plus
// workerd-backed createNotification validation/reconcile/dismiss branches
// the main ops suite does not exercise. Runs in real workerd with a real D1
// binding; only outbound vendor HTTP is untouched (none here).
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Bindings } from "../src/bindings";
import { ECHO_INTEGRATION_ID, Fault, NINJA_INTEGRATION_ID } from "../src/domain";
import {
  createNotification,
  dismissNotification,
  inspectRepair,
  listAudit,
  listNotifications,
  opsConnectionHealth,
  opsJobs,
  opsMetrics,
  opsPreflight,
  opsScheduledTasks,
  opsVersion,
  parseAuditQuery,
  parseNotificationLimit,
  parseRepairBody,
  recordAudit,
  runRepair,
  visibleNotification,
} from "../src/ops";
import type { OpsRepairInput } from "../src/ops";
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
const ORG = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000002";
const OTHER_USER = "00000000-0000-4000-8000-000000000003";
const caller = { orgId: ORG, userId: USER };
const other = { orgId: ORG, userId: OTHER_USER };

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

it("pins the audit query parser on every branch", () => {
  // Valid shapes.
  expect(parseAuditQuery(new URLSearchParams("")).limit).toBe(20);
  expect(parseAuditQuery(new URLSearchParams("action=app.&outcome=failure&search=x&limit=1")).actionPrefix).toBe(
    "app.",
  );
  expect(parseAuditQuery(new URLSearchParams("startDate=2026-09-01&endDate=2026-09-02")).startAt).toBe(
    "2026-09-01T00:00:00.000Z",
  );
  // Plain-day endDates cover the whole day (exclusive next midnight).
  expect(parseAuditQuery(new URLSearchParams("endDate=2026-09-02")).endBefore).toBe("2026-09-03T00:00:00.000Z");
  // Full-datetime endDates stay exact.
  expect(parseAuditQuery(new URLSearchParams("endDate=2026-09-02T12:00:00.000Z")).endBefore).toBe(
    "2026-09-02T12:00:00.000Z",
  );
  expect(parseAuditQuery(new URLSearchParams("cursor=" + encodeCursor()))).toBeDefined();
  // Every reject branch.
  const bad: [string, string][] = [
    ["action=", "INVALID_ACTION_PREFIX"],
    [`action=${"a".repeat(129)}`, "INVALID_ACTION_PREFIX"],
    ["outcome=bogus", "INVALID_OUTCOME"],
    ["search=", "INVALID_SEARCH"],
    [`search=${"a".repeat(257)}`, "INVALID_SEARCH"],
    ["limit=abc", "INVALID_LIMIT"],
    ["cursor=!!!", "INVALID_CURSOR"],
    [`cursor=${btoa(JSON.stringify({ createdAt: "x", id: "nope" }))}`, "INVALID_CURSOR"],
  ];
  for (const [query, code] of bad) {
    try {
      parseAuditQuery(new URLSearchParams(query));
      throw new Error(`accepted ${query}`);
    } catch (error) {
      expect((error as Fault).code).toBe(code);
    }
  }
});

function encodeCursor(): string {
  return btoa(JSON.stringify({ createdAt: "2026-09-11T00:00:00.000Z", id: "11111111-1111-4111-8111-111111111111" }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

it("pins the notification limit parser on every branch", () => {
  expect(parseNotificationLimit(new URLSearchParams(""))).toBe(50);
  expect(parseNotificationLimit(new URLSearchParams("limit=7"))).toBe(7);
  for (const query of ["limit=0", "limit=101", "limit=abc", "foo=1"]) {
    try {
      parseNotificationLimit(new URLSearchParams(query));
      throw new Error(`accepted ${query}`);
    } catch (error) {
      expect(error).toBeInstanceOf(Fault);
    }
  }
});

it("validates notification creates and dedups idempotent replays", async () => {
  await expect(
    createNotification(bindings.DB, caller, { scope: "personal", category: "system", title: "", status: "pending" }),
  ).rejects.toMatchObject({ code: "INVALID_NOTIFICATION" });
  await expect(
    createNotification(bindings.DB, caller, {
      scope: "personal",
      category: "system",
      title: "ok",
      body: "x".repeat(501),
      status: "pending",
    }),
  ).rejects.toMatchObject({ code: "INVALID_NOTIFICATION" });
  // Non-dedup path returns the stored row.
  const plain = await createNotification(bindings.DB, caller, {
    scope: "personal",
    category: "system",
    title: "plain",
    body: "hello",
    status: "running",
    progressPercent: 25,
  });
  expect(plain).toMatchObject({ title: "plain", status: "running", progressPercent: 25 });
  // Dedup path converges: same key returns the first row, never a fork.
  const first = await createNotification(bindings.DB, caller, {
    scope: "personal",
    category: "app_build",
    title: "first",
    body: "dedup body",
    status: "completed",
    dedupKey: "ops-branches-dedup-001",
  });
  const replay = await createNotification(bindings.DB, caller, {
    scope: "personal",
    category: "app_build",
    title: "second",
    status: "completed",
    dedupKey: "ops-branches-dedup-001",
  });
  expect(replay.id).toBe(first.id);
  expect(replay.title).toBe("first");
});

it("records audit rows with and without targets and details", async () => {
  await recordAudit(bindings.DB, caller, "system.probe", undefined, "success", undefined);
  await recordAudit(bindings.DB, caller, "system.probe", { type: "probe", id: "p1" }, "failure", { note: "x" });
  // A NULL detail_json lists as a null detail (the toEvent null arm).
  const listed = await listAudit(bindings.DB, caller, { actionPrefix: "system.probe", limit: 10 });
  expect(listed.events.some((event) => event.detail === null)).toBe(true);
  const rows = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='system.probe'")
    .bind()
    .first<{ n: number }>();
  expect(rows?.n).toBe(2);
});

it("reconciles non-terminal job states and tolerates corrupt details", async () => {
  // A running notification whose detail names no job stays running (no
  // invented terminal state); corrupt JSON degrades to null detail.
  const orphan = await createNotification(bindings.DB, caller, {
    scope: "personal",
    category: "system",
    title: "orphan",
    status: "running",
    detail: { jobId: "11111111-1111-4111-8111-111111111111", appId: "22222222-2222-4222-8222-222222222222" },
  });
  expect((await visibleNotification(bindings.DB, caller, orphan.id))?.status).toBe("running");
  await bindings.DB.prepare("UPDATE notifications SET detail_json='{{{corrupt' WHERE id=?").bind(orphan.id).run();
  expect((await visibleNotification(bindings.DB, caller, orphan.id))?.detail).toBeNull();
  // Org-scoped rows are visible to other same-org users and dismissible by them.
  const shared = await createNotification(bindings.DB, caller, {
    scope: "org",
    category: "system",
    title: "shared",
    status: "pending",
  });
  expect((await visibleNotification(bindings.DB, other, shared.id))?.id).toBe(shared.id);
  expect(await dismissNotification(bindings.DB, other, shared.id)).toBe(true);
  // Terminal rows never reconcile (no-op read, still terminal).
  const done = await createNotification(bindings.DB, caller, {
    scope: "personal",
    category: "system",
    title: "done",
    status: "completed",
  });
  expect((await visibleNotification(bindings.DB, caller, done.id))?.status).toBe("completed");
  // Failed and still-running job rows: failed advances to failed, running
  // stays running (no invented terminal state).
  const appId = "aaaaaaaa-1111-4111-8111-111111111111";
  const failedJob = "bbbbbbbb-2222-4222-8222-222222222222";
  const runningJob = "cccccccc-3333-4333-8333-333333333333";
  await bindings.DB.prepare(
    "INSERT INTO apps(id,org_id,name,slug,owner_kind,managed_by,status,created_at,updated_at) VALUES (?,?,'branch-app','branch-app','independent',NULL,'ready',?,?)",
  )
    .bind(appId, ORG, new Date().toISOString(), new Date().toISOString())
    .run();
  for (const [jobId, status] of [
    [failedJob, "failed"],
    [runningJob, "running"],
  ] as const) {
    await bindings.DB.prepare(
      "INSERT INTO app_jobs(id,app_id,revision,status,created_at,started_at) VALUES (?,?,1,?,?,?)",
    )
      .bind(jobId, appId, status, new Date().toISOString(), new Date().toISOString())
      .run();
  }
  const failedNote = await createNotification(bindings.DB, caller, {
    scope: "personal",
    category: "app_build",
    title: "failed job",
    status: "running",
    detail: { jobId: failedJob, appId },
  });
  expect((await visibleNotification(bindings.DB, caller, failedNote.id))?.status).toBe("failed");
  const runningNote = await createNotification(bindings.DB, caller, {
    scope: "personal",
    category: "app_build",
    title: "running job",
    status: "running",
    detail: { jobId: runningJob, appId },
  });
  expect((await visibleNotification(bindings.DB, caller, runningNote.id))?.status).toBe("running");
  // Unknown IDs resolve to null/false, never a throw or a leak.
  expect(await visibleNotification(bindings.DB, caller, "11111111-1111-4111-8111-111111111112")).toBeNull();
  expect(await dismissNotification(bindings.DB, caller, "11111111-1111-4111-8111-111111111112")).toBe(false);
  // The inbox carries org rows for other users too.
  await createNotification(bindings.DB, caller, { scope: "org", category: "system", title: "all", status: "pending" });
  expect((await listNotifications(bindings.DB, other, 50)).some((row) => row.title === "all")).toBe(true);
});

// OPS-02 (issue #173): pure repair-body parser guards plus workerd-backed
// diagnostics/repair branches the route suite does not exercise.

it("pins the repair body parser on every branch", () => {
  const execId = "a".repeat(64);
  const appId = "aaaaaaaa-1111-4111-8111-111111111111";
  // Valid shapes: dryRun defaults to true (inspect-first).
  expect(parseRepairBody({ kind: "cleanup-pending-uploads" }).dryRun).toBe(true);
  expect(
    parseRepairBody({ kind: "retry-execution", targetId: execId, idempotencyKey: "ops-branch-retry-001" }),
  ).toMatchObject({ kind: "retry-execution" });
  expect(parseRepairBody({ kind: "repair-stuck-build", targetId: appId, dryRun: false }).dryRun).toBe(false);
  // Non-string idempotencyKey fails closed (typeof arm).
  try {
    parseRepairBody({ kind: "cleanup-pending-uploads", idempotencyKey: 7 });
    throw new Error("accepted numeric key");
  } catch (error) {
    expect((error as Fault).code).toBe("INVALID_REPAIR");
  }
  // Every reject branch.
  const bad: [unknown, string][] = [
    ["nope", "INVALID_REPAIR"],
    [{}, "INVALID_REPAIR_KIND"],
    [{ kind: "nope" }, "INVALID_REPAIR_KIND"],
    [{ kind: "cleanup-pending-uploads", bogus: 1 }, "INVALID_REPAIR"],
    [{ kind: "cleanup-pending-uploads", dryRun: "yes" }, "INVALID_REPAIR"],
    [{ kind: "cleanup-pending-uploads", targetId: 7 }, "INVALID_REPAIR_TARGET"],
    [{ kind: "cleanup-pending-uploads", idempotencyKey: "ops-branch-retry-001" }, "INVALID_REPAIR"],
    [{ kind: "cleanup-pending-uploads", targetId: "x" }, "INVALID_REPAIR_TARGET"],
    [{ kind: "retry-execution" }, "INVALID_REPAIR_TARGET"],
    [{ kind: "retry-execution", targetId: "short" }, "INVALID_REPAIR_TARGET"],
    [{ kind: "cancel-execution", targetId: "short" }, "INVALID_REPAIR_TARGET"],
    [{ kind: "repair-stuck-build", targetId: "short" }, "INVALID_REPAIR_TARGET"],
    [{ kind: "repair-stuck-build", targetId: "" }, "INVALID_REPAIR_TARGET"],
    [{ kind: "retry-execution", targetId: execId }, "INVALID_REPAIR_KEY"],
    [{ kind: "retry-execution", targetId: execId, idempotencyKey: "short" }, "INVALID_REPAIR_KEY"],
    [{ kind: "cancel-execution", targetId: execId, idempotencyKey: "ops-branch-retry-001" }, "INVALID_REPAIR"],
  ];
  for (const [body, code] of bad) {
    try {
      parseRepairBody(body);
      throw new Error(`accepted ${JSON.stringify(body)}`);
    } catch (error) {
      expect((error as Fault).code).toBe(code);
    }
  }
});

it("degrades diagnostics when tables are missing and never fabricates metrics", async () => {
  // A database without the ops-adjacent tables still answers: zeros, empty
  // lists, empty journals. Missing provider metrics stay unavailable.
  await bindings.DB.exec("DROP TABLE executions");
  await bindings.DB.exec("DROP TABLE endpoints");
  await bindings.DB.exec("DROP TABLE apps");
  await bindings.DB.exec("DROP TABLE app_jobs");
  const metrics = await opsMetrics(bindings.DB, caller);
  expect(metrics.executions.total).toBe(0);
  expect(metrics.recentFailures).toEqual([]);
  const tasks = await opsScheduledTasks(bindings.DB, caller);
  expect(tasks.tasks).toEqual([]);
  const jobs = await opsJobs(bindings.DB, caller);
  expect(jobs.executions.total).toBe(0);
  expect(jobs.appBuilds.interrupted).toEqual([]);
  const version = await opsVersion(bindings.DB, { sdkVersion: "1", catalog: [] });
  expect(version.sagaCatalog.count).toBe(0);
  expect(version.migrationsApplied).toEqual([]);
});

it("inspects every repair kind without mutating", async () => {
  const execId = "b".repeat(64);
  await bindings.DB.prepare(
    "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at,completed_at,error_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      execId,
      "echo",
      "echo",
      "echo-v1",
      ORG,
      USER,
      JSON.stringify({ message: "hi" }),
      1,
      "Failed",
      new Date().toISOString(),
      new Date().toISOString(),
      JSON.stringify({ code: "ECHO_INTEGRATION_FAILED", message: "nope" }),
    )
    .run();
  const retry = await inspectRepair(bindings.DB, caller, {
    kind: "retry-execution",
    targetId: execId,
    idempotencyKey: "ops-branch-retry-002",
  });
  expect(retry).toMatchObject({ kind: "retry-execution", dryRun: true, targetId: execId });
  expect((retry.result as { input: unknown }).input).toEqual({ message: "hi" });
  // Corrupt error_json degrades to a null code, never a throw.
  await bindings.DB.prepare("UPDATE executions SET error_json='{{{corrupt' WHERE id=?").bind(execId).run();
  const degraded = await opsMetrics(bindings.DB, caller);
  expect(degraded.recentFailures[0]?.code).toBeNull();
  await bindings.DB.prepare("UPDATE executions SET error_json=? WHERE id=?")
    .bind(JSON.stringify({ code: "ECHO_INTEGRATION_FAILED", message: "nope" }), execId)
    .run();
  // A failure row with no error_json and a non-string code both degrade to
  // null codes; a TimedOut row surfaces alongside Failed.
  await bindings.DB.prepare("UPDATE executions SET error_json=NULL WHERE id=?").bind(execId).run();
  const nullCode = await opsMetrics(bindings.DB, caller);
  expect(nullCode.recentFailures[0]?.code).toBeNull();
  await bindings.DB.prepare("UPDATE executions SET error_json=? WHERE id=?")
    .bind(JSON.stringify({ code: 7 }), execId)
    .run();
  const numericCode = await opsMetrics(bindings.DB, caller);
  expect(numericCode.recentFailures[0]?.code).toBeNull();
  await bindings.DB.prepare("UPDATE executions SET status='TimedOut',error_json=? WHERE id=?")
    .bind(JSON.stringify({ code: "ECHO_VENDOR_TIMEOUT", message: "slow" }), execId)
    .run();
  const timedOut = await opsMetrics(bindings.DB, caller);
  expect(timedOut.executions.timedOut).toBe(1);
  expect(timedOut.recentFailures[0]).toMatchObject({ status: "TimedOut", code: "ECHO_VENDOR_TIMEOUT" });
  await bindings.DB.prepare("UPDATE executions SET status='Failed',error_json=? WHERE id=?")
    .bind(JSON.stringify({ code: "ECHO_INTEGRATION_FAILED", message: "nope" }), execId)
    .run();
  const cancel = await inspectRepair(bindings.DB, caller, { kind: "cancel-execution", targetId: execId });
  expect(cancel).toMatchObject({ kind: "cancel-execution", dryRun: true });
  expect((cancel.result as { cancellable: boolean }).cancellable).toBe(false);
  // A live Pending row inspects as cancellable for cancel-execution.
  await bindings.DB.prepare("UPDATE executions SET status='Pending' WHERE id=?").bind(execId).run();
  const liveCancel = await inspectRepair(bindings.DB, caller, { kind: "cancel-execution", targetId: execId });
  expect((liveCancel.result as { cancellable: boolean }).cancellable).toBe(true);
  expect(liveCancel.action).toContain("Cancelling");
  await bindings.DB.prepare("UPDATE executions SET status='Failed' WHERE id=?").bind(execId).run();
  // Live executions refuse retry (409) and report cancellable on cancel.
  await bindings.DB.prepare("UPDATE executions SET status='Running' WHERE id=?").bind(execId).run();
  await expect(
    inspectRepair(bindings.DB, caller, {
      kind: "retry-execution",
      targetId: execId,
      idempotencyKey: "ops-branch-retry-003",
    }),
  ).rejects.toMatchObject({ code: "EXECUTION_NOT_REPAIRABLE" });
  // Unknown executions answer 404, never a leak.
  await expect(
    inspectRepair(bindings.DB, caller, {
      kind: "retry-execution",
      targetId: "c".repeat(64),
      idempotencyKey: "ops-branch-retry-004",
    }),
  ).rejects.toMatchObject({ code: "EXECUTION_NOT_FOUND" });
  // Defense-in-depth: inspectRepair validates its own target even when the
  // route parser is bypassed (direct domain callers pass unvalidated input).
  await expect(
    inspectRepair(bindings.DB, caller, {
      kind: "retry-execution",
      idempotencyKey: "ops-branch-retry-004",
    } as OpsRepairInput),
  ).rejects.toMatchObject({ code: "INVALID_REPAIR_TARGET" });
  await expect(
    inspectRepair(bindings.DB, caller, { kind: "cancel-execution" } as OpsRepairInput),
  ).rejects.toMatchObject({
    code: "INVALID_REPAIR_TARGET",
  });
  await expect(
    inspectRepair(bindings.DB, caller, { kind: "repair-stuck-build", dryRun: true } as OpsRepairInput),
  ).rejects.toMatchObject({ code: "INVALID_REPAIR_TARGET" });
  await expect(
    inspectRepair(bindings.DB, caller, { kind: "cancel-execution", targetId: "c".repeat(64) }),
  ).rejects.toMatchObject({ code: "EXECUTION_NOT_FOUND" });
  await expect(
    inspectRepair(bindings.DB, caller, {
      kind: "repair-stuck-build",
      targetId: "dddddddd-1111-4111-8111-111111111111",
    }),
  ).rejects.toMatchObject({ code: "APP_NOT_FOUND" });
  // Not-stuck apps inspect as no-ops.
  const appId = "eeeeeeee-1111-4111-8111-111111111111";
  await bindings.DB.prepare(
    "INSERT INTO apps(id,org_id,name,slug,owner_kind,managed_by,status,created_at,updated_at) VALUES (?,?,'steady','steady','independent',NULL,'live',?,?)",
  )
    .bind(appId, ORG, new Date().toISOString(), new Date().toISOString())
    .run();
  const steady = await inspectRepair(bindings.DB, caller, { kind: "repair-stuck-build", targetId: appId });
  expect((steady.result as { stuck: boolean }).stuck).toBe(false);
  // A stuck app with no deployment restores to ready (not live).
  const bareId = "ffffffff-2222-4222-8222-222222222222";
  await bindings.DB.prepare(
    "INSERT INTO apps(id,org_id,name,slug,owner_kind,managed_by,status,created_at,updated_at) VALUES (?,?,'bare','bare','independent',NULL,'building',?,?)",
  )
    .bind(bareId, ORG, new Date().toISOString(), new Date().toISOString())
    .run();
  const bare = await runRepair(
    bindings.DB,
    caller,
    { kind: "repair-stuck-build", targetId: bareId },
    { admin: true, secrets: [] },
  );
  expect((bare.result as { restored: string }).restored).toBe("ready");
  const pending = await inspectRepair(bindings.DB, caller, { kind: "cleanup-pending-uploads" });
  expect(pending.targetId).toBeNull();
  const tokens = await inspectRepair(bindings.DB, caller, { kind: "cleanup-expired-tokens" });
  expect(tokens.targetId).toBeNull();
});

it("gates repair execution on admin and executes bounded cleanups", async () => {
  await expect(
    runRepair(bindings.DB, caller, { kind: "cleanup-pending-uploads" }, { admin: false, secrets: [] }),
  ).rejects.toMatchObject({ code: "REPAIR_FORBIDDEN" });
  await expect(
    runRepair(
      bindings.DB,
      caller,
      { kind: "retry-execution", targetId: "a".repeat(64), idempotencyKey: "ops-branch-retry-005" },
      { admin: true, secrets: [] },
    ),
  ).rejects.toMatchObject({ code: "EXECUTION_NOT_FOUND" });
  // Retry/cancel without dispatchers fail closed (503, never silent).
  const execId = "f".repeat(64);
  await bindings.DB.prepare(
    "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      execId,
      "echo",
      "echo",
      "echo-v1",
      ORG,
      USER,
      JSON.stringify({ message: "hi" }),
      1,
      "Failed",
      new Date().toISOString(),
    )
    .run();
  await expect(
    runRepair(
      bindings.DB,
      caller,
      { kind: "retry-execution", targetId: execId, idempotencyKey: "ops-branch-retry-006" },
      { admin: true, secrets: [] },
    ),
  ).rejects.toMatchObject({ code: "REPAIR_UNAVAILABLE" });
  await expect(
    runRepair(bindings.DB, caller, { kind: "cancel-execution", targetId: execId }, { admin: true, secrets: [] }),
  ).rejects.toMatchObject({ code: "REPAIR_UNAVAILABLE" });
  // Retry with a dispatcher replays the original input under the fresh key.
  const retried = await runRepair(
    bindings.DB,
    caller,
    { kind: "retry-execution", targetId: execId, idempotencyKey: "ops-branch-retry-007" },
    {
      admin: true,
      secrets: [],
      retry: async (key, sagaId, input) => {
        expect(key).toBe("ops-branch-retry-007");
        expect(sagaId).toBe("echo");
        expect(input).toEqual({ message: "hi" });
        return { executionId: "new-id", replayed: false };
      },
    },
  );
  expect(retried).toMatchObject({ kind: "retry-execution", dryRun: false });
  // Cancel with a dispatcher confirms through the injected path.
  const cancelled = await runRepair(
    bindings.DB,
    caller,
    { kind: "cancel-execution", targetId: execId },
    {
      admin: true,
      secrets: [],
      cancel: async (id) => {
        expect(id).toBe(execId);
        return { status: "Cancelled", cancelled: true };
      },
    },
  );
  expect(cancelled).toMatchObject({ kind: "cancel-execution", dryRun: false });
  // Cleanup executors tolerate missing tables (degraded zeros).
  await bindings.DB.exec("DROP TABLE files");
  await bindings.DB.exec("DROP TABLE file_capabilities");
  const pendingGone = await runRepair(
    bindings.DB,
    caller,
    { kind: "cleanup-pending-uploads" },
    { admin: true, secrets: [] },
  );
  expect((pendingGone.result as { deleted: number }).deleted).toBe(0);
  const tokensGone = await runRepair(
    bindings.DB,
    caller,
    { kind: "cleanup-expired-tokens" },
    { admin: true, secrets: [] },
  );
  expect((tokensGone.result as { deleted: number }).deleted).toBe(0);
});

it("reports preflight and connection health without vendor calls", async () => {
  const preflight = await opsPreflight(bindings.DB, caller, {});
  expect(preflight.integrations.length).toBeGreaterThan(0);
  for (const entry of preflight.integrations) {
    expect(typeof entry.ready).toBe("boolean");
  }
  // NinjaOne without its deployment credential reports the missing secret
  // name (never the value) once connected.
  const health = await opsConnectionHealth(bindings.DB, caller);
  expect(health.connections.length).toBe(preflight.integrations.length);
  const echo = health.connections.find((entry) => entry.integrationName === "echo");
  expect(echo).toMatchObject({ connected: true });
  expect(typeof echo?.testHint).toBe("string");
  // Connect NinjaOne with no deployment credential: the required secret
  // name surfaces as missing while the mapping counts as connected.
  await bindings.DB.prepare(
    "INSERT INTO connections(id,org_id,integration_id,endpoint,display_name,enabled,updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(
      "ffffffff-1111-4111-8111-111111111111",
      ORG,
      NINJA_INTEGRATION_ID,
      "https://example.invalid/api",
      null,
      1,
      new Date().toISOString(),
    )
    .run();
  const missing = await opsPreflight(bindings.DB, caller, {});
  const ninja = missing.integrations.find((entry) => entry.integrationName === "ninjaone");
  expect(ninja).toMatchObject({ connected: true, ready: false });
  expect(ninja?.missingSecrets).toContain("clientSecret");
  // With the credential present the mapping reports ready.
  const ready = await opsPreflight(bindings.DB, caller, { NINJA_CLIENT_SECRET: "sentinel" });
  expect(ready.integrations.find((entry) => entry.integrationName === "ninjaone")).toMatchObject({ ready: true });
  // A disabled mapping reports connected-but-disabled and never ready.
  await bindings.DB.prepare("UPDATE connections SET enabled=0 WHERE org_id=? AND integration_id=?")
    .bind(ORG, ECHO_INTEGRATION_ID)
    .run();
  const disabled = await opsPreflight(bindings.DB, caller, { NINJA_CLIENT_SECRET: "sentinel" });
  expect(disabled.integrations.find((entry) => entry.integrationName === "echo")).toMatchObject({
    connected: true,
    enabled: false,
    ready: false,
  });
});
