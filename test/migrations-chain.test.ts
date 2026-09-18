// Migration-chain fidelity (issue #302, Slice C): applies every migration
// 0001->0036 in order against a scratch database and proves table rebuilds
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
import migration34 from "../migrations/0034_branding_profile.sql?raw";
import migration35 from "../migrations/0035_embeds.sql?raw";
import migration36 from "../migrations/0036_anon_app_embeds.sql?raw";
import migration37 from "../migrations/0037_executions_org_fk_drop.sql?raw";
import migration38 from "../migrations/0038_capability_resolution.sql?raw";

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
  migration34,
  migration35,
  migration36,
  migration38,
];

// Issue #493: the 0037 repair is applied explicitly per test (after optional
// seeding on the 0001->0036 shape) to model the real upgrade path: a populated
// database where DROP TABLE executions must preserve child-table rows.
async function applyRepairMigration() {
  await bindings.DB.exec(migration37);
}

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

it("executions carries no organizations foreign key after the 0037 repair", async () => {
  await applyRepairMigration();
  const ddl = await bindings.DB.prepare("SELECT sql FROM sqlite_master WHERE name='executions'").first<{
    sql: string;
  }>();
  expect(ddl?.sql).not.toMatch(/REFERENCES organizations/);
});

it("0037 preserves populated child tables across the executions rebuild", async () => {
  const now = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?)").bind("org-1", "org").run();
  await bindings.DB.prepare(
    "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,status,created_at,policy_json,parent_execution_id,parent_step) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind("exec-1", "smoke", "smoke", "r1", "org-1", "user-1", "{}", "Succeeded", now, '{"v":1}', "parent-1", "step")
    .run();
  await bindings.DB.prepare(
    "INSERT INTO operations(execution_id,name,position,status,started_at,completed_at,result_json) VALUES (?,?,?,?,?,?,?)",
  )
    .bind("exec-1", "prepare", 0, "Succeeded", now, now, '{"ok":true}')
    .run();
  await bindings.DB.prepare("INSERT INTO usage_blocks(execution_id,usage_json,created_at) VALUES (?,?,?)")
    .bind("exec-1", '{"tokens":7}', now)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO execution_logs(execution_id,org_id,user_id,saga_id,saga_name,level,message,created_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind("exec-1", "org-1", "user-1", "smoke", "smoke", "INFO", "hello", now)
    .run();

  await applyRepairMigration();

  const exec = await bindings.DB.prepare(
    "SELECT id,status,policy_json,parent_execution_id,parent_step FROM executions WHERE id=?",
  )
    .bind("exec-1")
    .first<{ id: string; status: string; policy_json: string; parent_execution_id: string; parent_step: string }>();
  expect(exec).toMatchObject({ id: "exec-1", status: "Succeeded", policy_json: '{"v":1}' });
  expect(exec?.parent_execution_id).toBe("parent-1");
  expect(exec?.parent_step).toBe("step");
  const op = await bindings.DB.prepare(
    "SELECT execution_id,name,position,status,result_json FROM operations WHERE execution_id=? AND name=?",
  )
    .bind("exec-1", "prepare")
    .first<{ execution_id: string; position: number; status: string; result_json: string }>();
  expect(op).toMatchObject({ execution_id: "exec-1", position: 0, status: "Succeeded", result_json: '{"ok":true}' });
  const usage = await bindings.DB.prepare("SELECT usage_json FROM usage_blocks WHERE execution_id=?")
    .bind("exec-1")
    .first<{ usage_json: string }>();
  expect(usage?.usage_json).toBe('{"tokens":7}');
  const log = await bindings.DB.prepare(
    "SELECT execution_id,org_id,level,message FROM execution_logs WHERE execution_id=?",
  )
    .bind("exec-1")
    .first<{ execution_id: string; org_id: string; level: string; message: string }>();
  expect(log).toMatchObject({ execution_id: "exec-1", org_id: "org-1", level: "INFO", message: "hello" });
  const ddl = await bindings.DB.prepare("SELECT sql FROM sqlite_master WHERE name='executions'").first<{
    sql: string;
  }>();
  expect(ddl?.sql).not.toMatch(/REFERENCES organizations/);
  for (const name of ["executions_history", "executions_parent", "execution_logs_tail", "execution_logs_search"]) {
    const index = await bindings.DB.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
      .bind(name)
      .first<{ name: string }>();
    expect(index?.name).toBe(name);
  }
});

it("org delete retains execution history on the fully migrated schema", async () => {
  await applyRepairMigration();
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?)").bind("org-1", "org").run();
  await bindings.DB.prepare(
    "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,created_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind("exec-1", "smoke", "smoke", "r1", "org-1", "user-1", "{}", new Date().toISOString())
    .run();
  await bindings.DB.prepare("DELETE FROM organizations WHERE id=?").bind("org-1").run();
  const org = await bindings.DB.prepare("SELECT id FROM organizations WHERE id=?").bind("org-1").first();
  expect(org).toBeNull();
  const exec = await bindings.DB.prepare("SELECT id,org_id FROM executions WHERE id=?")
    .bind("exec-1")
    .first<{ id: string; org_id: string }>();
  expect(exec?.id).toBe("exec-1");
  expect(exec?.org_id).toBe("org-1");
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

it("0038 lands capability assignments, entity mappings, and frozen resolutions", async () => {
  // Deleting a Connection cascades its assignments and mappings (ADR TBD
  // §2); frozen Execution bindings survive as audit.
  const now = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?)").bind("org-1", "org").run();
  await bindings.DB.prepare("INSERT INTO connections(id,org_id,integration_id,endpoint) VALUES (?,?,?,?)")
    .bind("conn-1", "org-1", "0606e237-137b-4629-8346-85468e1c2df6", "https://ninja-in-test.invalid/api")
    .run();
  await bindings.DB.prepare(
    "INSERT INTO capability_assignments(org_id,capability,connection_id,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?)",
  )
    .bind("org-1", "identity.primary", "conn-1", 1, now, now)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO external_entity_mappings(id,org_id,connection_id,entity_id,is_primary,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind("map-1", "org-1", "conn-1", "vendor-7", 1, "manual", now, now)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,created_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind("exec-1", "saga", "saga", "r1", "org-1", "user-1", "{}", now)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO capability_resolutions(execution_id,capability,connection_id,integration_id,integration_revision,adapter_id,adapter_revision,transport,operation,resolved_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      "exec-1",
      "identity.primary",
      "conn-1",
      "0606e237-137b-4629-8346-85468e1c2df6",
      "ninjaone",
      "ad-identity-v1",
      "ad-identity-v1",
      "ninjaone",
      "identity-provision-v1",
      now,
    )
    .run();
  // The child tables cascade off connections in DDL; the module also
  // deletes explicitly (belt beside the FK cascade, which D1 may not
  // enforce — same posture as connection_secrets/oauth_tokens). Frozen
  // Execution bindings survive either way, as audit.
  for (const table of ["capability_assignments", "external_entity_mappings"]) {
    const ddl = await bindings.DB.prepare("SELECT sql FROM sqlite_master WHERE name=?")
      .bind(table)
      .first<{ sql: string }>();
    expect(ddl?.sql).toMatch(/REFERENCES connections\(id\) ON DELETE CASCADE/);
  }
  await bindings.DB.prepare("DELETE FROM capability_assignments WHERE connection_id=?").bind("conn-1").run();
  await bindings.DB.prepare("DELETE FROM external_entity_mappings WHERE connection_id=?").bind("conn-1").run();
  await bindings.DB.prepare("DELETE FROM connections WHERE id=?").bind("conn-1").run();
  const assignment = await bindings.DB.prepare("SELECT capability FROM capability_assignments WHERE org_id=?")
    .bind("org-1")
    .first();
  expect(assignment).toBeNull();
  const mapping = await bindings.DB.prepare("SELECT id FROM external_entity_mappings WHERE org_id=?")
    .bind("org-1")
    .first();
  expect(mapping).toBeNull();
  const frozen = await bindings.DB.prepare(
    "SELECT adapter_id,transport FROM capability_resolutions WHERE execution_id=?",
  )
    .bind("exec-1")
    .first<{ adapter_id: string; transport: string }>();
  expect(frozen).toMatchObject({ adapter_id: "ad-identity-v1", transport: "ninjaone" });
});
