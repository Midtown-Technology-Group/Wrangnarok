// SPDX-License-Identifier: AGPL-3.0
// OPS-01 branch coverage (issue #172): pure parser guards plus
// workerd-backed createNotification validation/reconcile/dismiss branches
// the main ops suite does not exercise. Runs in real workerd with a real D1
// binding; only outbound vendor HTTP is untouched (none here).
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Bindings } from "../src/bindings";
import { Fault } from "../src/domain";
import {
  createNotification,
  dismissNotification,
  listAudit,
  listNotifications,
  parseAuditQuery,
  parseNotificationLimit,
  recordAudit,
  visibleNotification,
} from "../src/ops";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration6 from "../migrations/0006_apps.sql?raw";
import migration18 from "../migrations/0018_ops.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const ORG = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000002";
const OTHER_USER = "00000000-0000-4000-8000-000000000003";
const caller = { orgId: ORG, userId: USER };
const other = { orgId: ORG, userId: OTHER_USER };

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration6);
  await bindings.DB.exec(migration18);
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
