// SPDX-License-Identifier: AGPL-3.0
// TRG-01 follow-up (issue #436): the LAB fixture converges on canonical
// migration 0016 instead of a forked schedules shape. Canonical schedule
// CRUD plus one-off promotion works on an ordinary migrated D1 and on the
// LAB-fixture path. Real workerd with real D1; hello Saga needs no vendor.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { helloSaga } from "../src/domain";
import { ensureLabFixture } from "../src/orgs";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration7 from "../migrations/0007_org_membership.sql?raw";
import migration8 from "../migrations/0008_executions_org_fk.sql?raw";
import migration12 from "../migrations/0012_saga_policies.sql?raw";
import migration16 from "../migrations/0016_schedules.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const ORG = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000002";
const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

function authed(path: string, method: string, body?: unknown): Request {
  return new Request(`https://local.test${path}`, {
    method,
    headers: { ...auth },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function tick(): Promise<void> {
  const cron = worker as unknown as { scheduled: (event: unknown, env: Bindings) => Promise<void> };
  await cron.scheduled({ cron: "* * * * *" }, bindings);
}

/** Canonical migration 0016 column set: every name the runtime reads or
 * writes, and none of the forked LAB columns (user_id, status, cron_expr). */
const CANONICAL_COLUMNS = [
  "id",
  "org_id",
  "name",
  "saga_id",
  "kind",
  "cron",
  "timezone",
  "enabled",
  "input_json",
  "run_as_user_id",
  "run_at",
  "next_due_at",
  "last_window",
  "created_at",
  "updated_at",
];

async function expectCanonicalScheduleSchema(): Promise<void> {
  const info = await bindings.DB.prepare("PRAGMA table_info(schedules)").all<{ name: string }>();
  expect([...info.results.map((row) => row.name)].sort()).toEqual([...CANONICAL_COLUMNS].sort());
  const deliveries = await bindings.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schedule_deliveries'",
  ).first<{ name: string }>();
  expect(deliveries?.name).toBe("schedule_deliveries");
  const dueIndex = await bindings.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='schedules_org_due'",
  ).first<{ name: string }>();
  expect(dueIndex?.name).toBe("schedules_org_due");
  const unique = await bindings.DB.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='schedules'",
  ).first<{ sql: string }>();
  expect(unique?.sql).toContain("UNIQUE(org_id, name)");
}

async function createDueOneOff(name: string): Promise<void> {
  const runAt = new Date(Date.now() - 30_000).toISOString();
  const created = await worker.fetch(
    authed("/api/schedules", "POST", {
      name,
      sagaId: helloSaga.id,
      kind: "one-off",
      runAt,
      input: { name: "sched" },
    }),
    bindings,
  );
  expect(created.status).toBe(201);
}

async function expectPromotedOnce(name: string): Promise<void> {
  await tick();
  const detail = (await (await worker.fetch(authed(`/api/schedules/${name}`, "GET"), bindings)).json()) as {
    schedule: { enabled: boolean; lastWindow: string | null };
  };
  expect(detail.schedule.enabled).toBe(false);
  expect(detail.schedule.lastWindow).toMatch(/^once-/);
  const deliveries = await bindings.DB.prepare(
    "SELECT COUNT(*) AS n FROM schedule_deliveries WHERE schedule_id=(SELECT id FROM schedules WHERE org_id=? AND name=?)",
  )
    .bind(ORG, name)
    .first<{ n: number }>();
  expect(deliveries?.n).toBe(1);
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(migration7);
  await bindings.DB.exec(migration8);
  await bindings.DB.exec(migration12);
  await bindings.DB.exec(migration16);
  await bindings.DB.exec(seed);
});
afterEach(async () => {
  await reset();
});

describe("TRG-01 schedule schema convergence (issue #436)", () => {
  it("runs canonical CRUD plus one-off promotion on an ordinary migrated D1", async () => {
    await expectCanonicalScheduleSchema();
    await createDueOneOff("converge-migrated");
    const listed = (await (await worker.fetch(authed("/api/schedules", "GET"), bindings)).json()) as {
      schedules: { name: string }[];
    };
    expect(listed.schedules.map((entry) => entry.name)).toContain("converge-migrated");
    // UNIQUE(org_id, name) is enforced, never a second row.
    expect(
      (
        await worker.fetch(
          authed("/api/schedules", "POST", {
            name: "converge-migrated",
            sagaId: helloSaga.id,
            kind: "one-off",
            runAt: new Date(Date.now() - 30_000).toISOString(),
            input: { name: "sched" },
          }),
          bindings,
        )
      ).status,
    ).toBe(409);
    await expectPromotedOnce("converge-migrated");
    expect((await worker.fetch(authed("/api/schedules/converge-migrated", "DELETE"), bindings)).status).toBe(200);
    expect((await worker.fetch(authed("/api/schedules/converge-migrated", "GET"), bindings)).status).toBe(404);
  }, 25000);

  it("rebuilds a persistent legacy forked schedules table to canonical and promotes", async () => {
    // A local database that ran the pre-#436 fixture keeps the forked shape,
    // which CREATE IF NOT EXISTS would leave shadowing the canonical schema.
    // The legacy row below is unmappable (no `name` for UNIQUE(org_id,name),
    // `once` violates the canonical kind CHECK) and no runtime writer ever
    // targeted these columns, so convergence rebuilds rather than migrates.
    await bindings.DB.exec("DROP TABLE IF EXISTS schedule_deliveries");
    await bindings.DB.exec("DROP TABLE IF EXISTS schedules");
    await bindings.DB.exec(
      "CREATE TABLE schedules(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),user_id TEXT NOT NULL,saga_id TEXT NOT NULL,input_json TEXT NOT NULL CHECK(length(input_json) <= 4096),kind TEXT NOT NULL CHECK(kind IN ('once','recurring')),status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled','deleted')),cron_expr TEXT,timezone TEXT NOT NULL DEFAULT 'UTC',run_at TEXT,next_due_at TEXT,overlap TEXT NOT NULL DEFAULT 'allow' CHECK(overlap IN ('allow','skip')),last_execution_id TEXT,last_skipped_window TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,CHECK((kind = 'once' AND cron_expr IS NULL AND run_at IS NOT NULL) OR (kind = 'recurring' AND cron_expr IS NOT NULL AND run_at IS NULL)))",
    );
    await bindings.DB.prepare(
      "INSERT INTO schedules(id,org_id,user_id,saga_id,input_json,kind,status,cron_expr,timezone,run_at,next_due_at,overlap,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        "legacy-schedule-1",
        ORG,
        USER,
        helloSaga.id,
        "{}",
        "recurring",
        "active",
        "* * * * *",
        "UTC",
        null,
        new Date().toISOString(),
        "allow",
        new Date().toISOString(),
        new Date().toISOString(),
      )
      .run();
    await ensureLabFixture(bindings.DB, ORG, USER);
    await expectCanonicalScheduleSchema();
    await createDueOneOff("converge-legacy");
    await expectPromotedOnce("converge-legacy");
    expect((await worker.fetch(authed("/api/schedules/converge-legacy", "DELETE"), bindings)).status).toBe(200);
  }, 25000);

  it("converges a hand-built LAB database to the same canonical schema and promotes", async () => {
    // Simulate a hand-built LAB database that never ran migration 0016: drop
    // the canonical tables, then let the fixture rebuild them.
    await bindings.DB.exec("DROP TABLE IF EXISTS schedule_deliveries");
    await bindings.DB.exec("DROP TABLE IF EXISTS schedules");
    await ensureLabFixture(bindings.DB, ORG, USER);
    await expectCanonicalScheduleSchema();
    await createDueOneOff("converge-lab");
    await expectPromotedOnce("converge-lab");
    expect((await worker.fetch(authed("/api/schedules/converge-lab", "DELETE"), bindings)).status).toBe(200);
  }, 25000);
});
