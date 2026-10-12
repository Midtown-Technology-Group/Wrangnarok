// SPDX-License-Identifier: AGPL-3.0
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Bindings } from "../src/bindings";
import migration01 from "../migrations/0001_initial.sql?raw";
import migration04 from "../migrations/0004_solutions_install.sql?raw";
import migration10 from "../migrations/0010_solutions_activation.sql?raw";
import migration18 from "../migrations/0018_ops.sql?raw";
import migration19 from "../migrations/0019_files.sql?raw";
import migration20 from "../migrations/0020_artifacts.sql?raw";
import migration21 from "../migrations/0021_endpoints.sql?raw";

const bindings = env as unknown as Bindings;
const legacyDefinition = (migration: string) => migration.replaceAll("IF NOT EXISTS ", "");
const legacyActivation = `
CREATE TABLE IF NOT EXISTS bundle_active(bundle_id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES organizations(id), version TEXT NOT NULL, manifest_hash TEXT NOT NULL, install_id INTEGER NOT NULL REFERENCES bundle_installs(id), activated_at TEXT NOT NULL, PRIMARY KEY(bundle_id, org_id));
CREATE TABLE IF NOT EXISTS bundle_config(bundle_id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES organizations(id), config_key TEXT NOT NULL, config_value TEXT NOT NULL, managed_by TEXT NOT NULL, PRIMARY KEY(bundle_id, org_id, config_key));
CREATE TABLE IF NOT EXISTS bundle_sagas(bundle_id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES organizations(id), saga_id TEXT NOT NULL, revision TEXT NOT NULL, managed_by TEXT NOT NULL, PRIMARY KEY(bundle_id, org_id, saga_id));
ALTER TABLE connections ADD COLUMN config_json TEXT;
CREATE TRIGGER IF NOT EXISTS bundle_installs_no_update BEFORE UPDATE ON bundle_installs BEGIN SELECT RAISE(ABORT, 'bundle_installs is immutable install evidence'); END;
CREATE TRIGGER IF NOT EXISTS bundle_installs_no_delete BEFORE DELETE ON bundle_installs BEGIN SELECT RAISE(ABORT, 'bundle_installs is immutable install evidence'); END;
`;

beforeEach(async () => {
  await bindings.DB.exec(migration01);
});

afterEach(async () => {
  await reset();
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

it("converges the renamed activation migration with an existing config column", async () => {
  await bindings.DB.exec(migration04);
  await bindings.DB.exec(legacyActivation);
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?)").bind("org-1", "Example").run();
  await bindings.DB.prepare(
    "INSERT INTO connections(id,org_id,integration_id,endpoint,managed_by,config_json) VALUES (?,?,?,?,?,?)",
  )
    .bind("connection-1", "org-1", "integration-1", "https://example.invalid", "bundle-1", '{"region":"us"}')
    .run();

  await bindings.DB.exec(migration10);

  expect(
    await bindings.DB.prepare("SELECT managed_by,config_json FROM connections WHERE id=?").bind("connection-1").first(),
  ).toMatchObject({ managed_by: "bundle-1", config_json: '{"region":"us"}' });
});
