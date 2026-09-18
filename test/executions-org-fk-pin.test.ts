// Executions organizations-FK pin (issue #493).
//
// History: migration 0008 dropped the executions.org_id foreign key so that
// Organization deletes retain ExecutionHistory (retention is structural, not
// just policy). Migration 0026 reintroduced
// `org_id TEXT NOT NULL REFERENCES organizations(id)` via its executions
// rebuild, so deleting an Organization with executions failed with
// `D1_ERROR: FOREIGN KEY constraint failed`. Migration 0037 repaired it with
// an 0008-pattern rebuild carrying every later column.
//
// This file applies the FULL migration chain in filename order on a fresh
// local D1 (the same order `wrangler d1 migrations apply` uses) and pins:
//  1. the rebuilt executions table carries no REFERENCES organizations(id);
//  2. the retention-pattern org delete succeeds with history retained;
//  3. no migration numbered >= 0037 reintroduces an executions ->
//     organizations FK in its own SQL (source pin; 0026 is grandfathered
//     history below 0037 and the final-DDL assertion above proves the repair
//     still converges over it).
//
// The chain is discovered with import.meta.glob so a future migration file is
// picked up automatically: if it reintroduces the FK, these assertions fail.
// Keep this file importing the full chain per docs/migration-ledger.md.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Bindings } from "../src/bindings";

const bindings = env as unknown as Bindings;

interface GlobImportMeta {
  glob(pattern: string, options: { query: string; import: string; eager: boolean }): Record<string, string>;
}

const migrationModules = (import.meta as unknown as GlobImportMeta).glob("../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

const CHAIN: ReadonlyArray<{ name: string; sql: string }> = Object.entries(migrationModules)
  .map(([path, sql]) => ({ name: path.split("/").pop() ?? path, sql }))
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

function migrationNumber(name: string): number {
  const match = /^(\d{4})_/.exec(name);
  if (match === null || match[1] === undefined) return -1;
  return Number(match[1]);
}

// CREATE TABLE bodies in one migration file that define the executions table
// itself (executions / executions_new / _executions_repair_new rebuild
// targets). Balanced-paren extraction, because migration files separate
// statements with newlines rather than semicolons and CHECK constraints nest
// parentheses. execution_logs and similar names never match: "execution_"
// lacks the trailing "s" of "executions".
function executionsTableBodies(sql: string): string[] {
  const bodies: string[] = [];
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(executions_new|_executions_repair_new|executions)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const head = m[0] ?? "";
    let depth = 1;
    let i = m.index + head.length;
    while (i < sql.length && depth > 0) {
      const ch = sql[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      i++;
    }
    bodies.push(sql.slice(m.index, i));
  }
  return bodies;
}

// ALTER TABLE ... ADD COLUMN can also carry a REFERENCES clause in SQLite.
function executionsAlterAddsOrgFk(sql: string): boolean {
  return /ALTER\s+TABLE\s+executions\s+ADD\s+[^\n;]*REFERENCES\s+organizations/i.test(sql);
}

beforeEach(async () => {
  expect(CHAIN.length).toBeGreaterThan(0);
  expect(CHAIN.some(({ name }) => name.startsWith("0037_"))).toBe(true);
  for (const { sql } of CHAIN) {
    await bindings.DB.exec(sql);
  }
});

afterEach(async () => {
  await reset();
});

it("fresh full chain carries no executions REFERENCES organizations(id)", async () => {
  const ddl = await bindings.DB.prepare("SELECT sql FROM sqlite_master WHERE name='executions'").first<{
    sql: string;
  }>();
  expect(ddl?.sql).toBeDefined();
  expect(ddl?.sql).not.toMatch(/REFERENCES\s+organizations/i);
  const columns = await bindings.DB.prepare("PRAGMA table_info(executions)").all<{ name: string }>();
  const names = new Set(columns.results.map((row) => row.name));
  expect(names.has("org_id")).toBe(true);
});

it("no migration numbered >= 0037 reintroduces the executions org FK in its own SQL", () => {
  const offenders: string[] = [];
  for (const { name, sql } of CHAIN) {
    if (migrationNumber(name) < 37) continue;
    const bad = executionsTableBodies(sql).filter((body) => /REFERENCES\s+organizations/i.test(body));
    if (bad.length > 0 || executionsAlterAddsOrgFk(sql)) offenders.push(name);
  }
  expect(offenders).toEqual([]);
});

it("retention-pattern org delete keeps execution history", async () => {
  const fk = await bindings.DB.prepare("PRAGMA foreign_keys").first<{ foreign_keys: number }>();
  expect(fk?.foreign_keys).toBe(1);
  const now = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?)").bind("org-1", "org").run();
  await bindings.DB.prepare(
    "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,created_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind("exec-1", "smoke", "smoke", "r1", "org-1", "user-1", "{}", now)
    .run();
  await bindings.DB.prepare("INSERT INTO operations(execution_id,name,position,status,started_at) VALUES (?,?,?,?,?)")
    .bind("exec-1", "prepare", 0, "Succeeded", now)
    .run();
  await bindings.DB.prepare("DELETE FROM organizations WHERE id=?").bind("org-1").run();
  const org = await bindings.DB.prepare("SELECT id FROM organizations WHERE id=?").bind("org-1").first();
  expect(org).toBeNull();
  const exec = await bindings.DB.prepare("SELECT id,org_id FROM executions WHERE id=?")
    .bind("exec-1")
    .first<{ id: string; org_id: string }>();
  expect(exec).toMatchObject({ id: "exec-1", org_id: "org-1" });
});
