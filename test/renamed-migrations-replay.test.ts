// SPDX-License-Identifier: AGPL-3.0
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Bindings } from "../src/bindings";
import migration01 from "../migrations/0001_initial.sql?raw";
import migration18 from "../migrations/0018_ops.sql?raw";
import migration19 from "../migrations/0019_files.sql?raw";
import migration20 from "../migrations/0020_artifacts.sql?raw";
import migration21 from "../migrations/0021_endpoints.sql?raw";

const bindings = env as unknown as Bindings;
const legacyDefinition = (migration: string) => migration.replaceAll("IF NOT EXISTS ", "");
const activationJournalAlias = `
INSERT INTO d1_migrations(name)
SELECT '0010_solutions_activation.sql'
WHERE EXISTS (
  SELECT 1 FROM d1_migrations
  WHERE name = '0005_solutions_activation.sql'
)
AND NOT EXISTS (
  SELECT 1 FROM d1_migrations
  WHERE name = '0010_solutions_activation.sql'
);
`;

beforeEach(async () => {
  await bindings.DB.exec(migration01);
});

afterEach(async () => {
  await reset();
});

it("aliases the activation rename only after the legacy migration was applied", async () => {
  await bindings.DB.exec(
    "CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
  );
  await bindings.DB.prepare("INSERT INTO d1_migrations(name) VALUES (?)").bind("0005_solutions_activation.sql").run();

  await bindings.DB.prepare(activationJournalAlias).run();
  await bindings.DB.prepare(activationJournalAlias).run();

  expect((await bindings.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all()).results).toEqual([
    { name: "0005_solutions_activation.sql" },
    { name: "0010_solutions_activation.sql" },
  ]);
});

it("leaves the activation migration pending when its legacy name is absent", async () => {
  await bindings.DB.exec(
    "CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
  );

  await bindings.DB.prepare(activationJournalAlias).run();

  expect((await bindings.DB.prepare("SELECT name FROM d1_migrations").all()).results).toEqual([]);
});

it("replays the renamed ops migration without replacing existing rows", async () => {
  await bindings.DB.exec(legacyDefinition(migration18));
  const now = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?)").bind("org-1", "Example").run();
  await bindings.DB.prepare(
    "INSERT INTO audit_events(id,org_id,actor_user_id,action,outcome,created_at) VALUES (?,?,?,?,?,?)",
  )
    .bind("audit-1", "org-1", "user-1", "migration.test", "success", now)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO notifications(id,org_id,user_id,scope,category,title,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind("note-1", "org-1", "user-1", "personal", "test", "Preserve me", now, now)
    .run();

  await bindings.DB.exec(migration18);

  expect(await bindings.DB.prepare("SELECT action FROM audit_events WHERE id=?").bind("audit-1").first()).toMatchObject(
    {
      action: "migration.test",
    },
  );
  expect(await bindings.DB.prepare("SELECT title FROM notifications WHERE id=?").bind("note-1").first()).toMatchObject({
    title: "Preserve me",
  });
});

it("replays the renamed artifact migration without replacing existing rows", async () => {
  await bindings.DB.exec(legacyDefinition(migration20));
  const now = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?)").bind("org-1", "Example").run();
  await bindings.DB.prepare(
    "INSERT INTO artifacts(id,org_id,creator_user_id,name,mime,size_bytes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind("artifact-1", "org-1", "user-1", "evidence.txt", "text/plain", 8, now, now)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO artifact_versions(id,artifact_id,version,mime,size_bytes,created_at) VALUES (?,?,?,?,?,?)",
  )
    .bind("version-1", "artifact-1", 1, "text/plain", 8, now)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO artifact_bindings(id,artifact_id,org_id,scope,ref_id,created_at) VALUES (?,?,?,?,?,?)",
  )
    .bind("binding-1", "artifact-1", "org-1", "workspace", "row-1", now)
    .run();

  await bindings.DB.exec(migration20);

  expect(await bindings.DB.prepare("SELECT name FROM artifacts WHERE id=?").bind("artifact-1").first()).toMatchObject({
    name: "evidence.txt",
  });
  expect(
    await bindings.DB.prepare("SELECT version FROM artifact_versions WHERE id=?").bind("version-1").first(),
  ).toMatchObject({
    version: 1,
  });
  expect(
    await bindings.DB.prepare("SELECT ref_id FROM artifact_bindings WHERE id=?").bind("binding-1").first(),
  ).toMatchObject({
    ref_id: "row-1",
  });
});

it("replays the renamed file migration without replacing existing rows", async () => {
  await bindings.DB.exec(legacyDefinition(migration19));
  const now = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?)").bind("org-1", "Example").run();
  await bindings.DB.prepare("INSERT INTO file_locations(org_id,name,max_bytes,created_at) VALUES (?,?,?,?)")
    .bind("org-1", "uploads", 1024, now)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO files(org_id,location,path,version,size,content_type,sha256,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  )
    .bind("org-1", "uploads", "evidence.txt", 1, 8, "text/plain", "", "ready", now, now)
    .run();
  await bindings.DB.prepare("INSERT INTO file_policies(org_id,location,action,created_at) VALUES (?,?,?,?)")
    .bind("org-1", "uploads", "read", now)
    .run();

  await bindings.DB.exec(migration19);

  expect(
    await bindings.DB.prepare("SELECT max_bytes FROM file_locations WHERE org_id=? AND name=?")
      .bind("org-1", "uploads")
      .first(),
  ).toMatchObject({ max_bytes: 1024 });
  expect(
    await bindings.DB.prepare("SELECT status FROM files WHERE org_id=? AND location=? AND path=?")
      .bind("org-1", "uploads", "evidence.txt")
      .first(),
  ).toMatchObject({ status: "ready" });
  expect(
    await bindings.DB.prepare("SELECT action FROM file_policies WHERE org_id=? AND location=?")
      .bind("org-1", "uploads")
      .first(),
  ).toMatchObject({ action: "read" });
});

it("replays the renamed endpoint migration without replacing existing rows", async () => {
  await bindings.DB.exec(legacyDefinition(migration21));
  const now = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?)").bind("org-1", "Example").run();
  await bindings.DB.prepare("INSERT INTO endpoints(id,org_id,name,saga_id,kind,created_at) VALUES (?,?,?,?,?,?)")
    .bind("endpoint-1", "org-1", "hook", "saga-1", "webhook", now)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO endpoint_events(endpoint_id,event_id,input_json,execution_id,created_at) VALUES (?,?,?,?,?)",
  )
    .bind("endpoint-1", "event-1", "{}", "execution-1", now)
    .run();

  await bindings.DB.exec(migration21);

  expect(await bindings.DB.prepare("SELECT name FROM endpoints WHERE id=?").bind("endpoint-1").first()).toMatchObject({
    name: "hook",
  });
  expect(
    await bindings.DB.prepare("SELECT execution_id FROM endpoint_events WHERE event_id=?").bind("event-1").first(),
  ).toMatchObject({ execution_id: "execution-1" });
});
