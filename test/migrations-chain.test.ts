// Migration-chain fidelity (issue #302, Slice C): applies every migration
// 0001->0033 in order against a scratch database and proves table rebuilds
// carry all previously added columns. Guards the 0026 regression, which
// rebuilt executions without policy_json (0012) and parent_execution_id /
// parent_step (0015), breaking child lineage statements on fully migrated
// databases while every à-la-carte test stayed green.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Bindings } from "../src/bindings";
import migration01 from "../migrations/0001_initial.sql?raw";
import migration02 from "../migrations/0002_cancelling.sql?raw";
import migration03 from "../migrations/0003_usage_blocks.sql?raw";
import migration04 from "../migrations/0004_solutions_install.sql?raw";
import migration05 from "../migrations/0005_forms.sql?raw";
import migration06 from "../migrations/0006_apps.sql?raw";
import migration07 from "../migrations/0007_org_membership.sql?raw";
import migration08 from "../migrations/0008_executions_org_fk.sql?raw";
import migration09 from "../migrations/0009_tables.sql?raw";
import migration10 from "../migrations/0010_solutions_activation.sql?raw";
import migration11 from "../migrations/0011_connection_admin.sql?raw";
import migration12 from "../migrations/0012_saga_policies.sql?raw";
import migration13 from "../migrations/0013_resource_roles.sql?raw";
import migration14 from "../migrations/0014_execution_logs.sql?raw";
import migration15 from "../migrations/0015_child_lineage.sql?raw";
import migration16 from "../migrations/0016_schedules.sql?raw";
import migration18 from "../migrations/0018_ops.sql?raw";
import migration19 from "../migrations/0019_files.sql?raw";
import migration20 from "../migrations/0020_artifacts.sql?raw";
import migration21 from "../migrations/0021_endpoints.sql?raw";
import migration22 from "../migrations/0022_app_runtime.sql?raw";
import migration23 from "../migrations/0023_config.sql?raw";
import migration24 from "../migrations/0024_tool_enrollments.sql?raw";
import migration25 from "../migrations/0025_audit_retention.sql?raw";
import migration26 from "../migrations/0026_cancelling_repair.sql?raw";
import migration27 from "../migrations/0027_rename_replay_repair.sql?raw";
import migration28 from "../migrations/0028_ai_profiles.sql?raw";
import migration29 from "../migrations/0029_connection_secrets.sql?raw";
import migration30 from "../migrations/0030_events.sql?raw";
import migration31 from "../migrations/0031_oauth_tokens.sql?raw";
import migration32 from "../migrations/0032_executions_column_restore.sql?raw";
import migration33 from "../migrations/0033_event_subscriptions.sql?raw";

const bindings = env as unknown as Bindings;

const CHAIN = [
  migration01,
  migration02,
  migration03,
  migration04,
  migration05,
  migration06,
  migration07,
  migration08,
  migration09,
  migration10,
  migration11,
  migration12,
  migration13,
  migration14,
  migration15,
  migration16,
  migration18,
  migration19,
  migration20,
  migration21,
  migration22,
  migration23,
  migration24,
  migration25,
  migration26,
  migration27,
  migration28,
  migration29,
  migration30,
  migration31,
  migration32,
  migration33,
];

beforeEach(async () => {
  for (const migration of CHAIN) {
    await bindings.DB.exec(migration);
  }
});

afterEach(async () => {
  await reset();
});

it("rebuilds carry every previously added executions column", async () => {
  const info = await bindings.DB.prepare("PRAGMA table_info(executions)").all<{ name: string }>();
  const names = new Set(info.results.map((row) => row.name));
  for (const column of ["policy_json", "parent_execution_id", "parent_step"]) {
    expect(names.has(column)).toBe(true);
  }
  const index = await bindings.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='executions_parent'",
  ).first<{ name: string }>();
  expect(index?.name).toBe("executions_parent");
});

it("child lineage statements run on the fully migrated schema", async () => {
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?)").bind("org-1", "org").run();
  await bindings.DB.prepare(
    "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,parent_execution_id,parent_step,created_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
  )
    .bind("exec-1", "smoke", "smoke", "r1", "org-1", "user-1", "{}", "parent-1", "step", new Date().toISOString())
    .run();
  const row = await bindings.DB.prepare(
    "SELECT id,saga_id,status,dispatched FROM executions WHERE parent_execution_id=? AND org_id=? AND user_id=?",
  )
    .bind("parent-1", "org-1", "user-1")
    .first<{ id: string }>();
  expect(row?.id).toBe("exec-1");
});
