// SPDX-License-Identifier: AGPL-3.0
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Bindings } from "../src/bindings";
import migration01 from "../migrations/0001_initial.sql?raw";
import migration18 from "../migrations/0018_ops.sql?raw";
import migration20 from "../migrations/0020_artifacts.sql?raw";

const bindings = env as unknown as Bindings;
const legacyDefinition = (migration: string) => migration.replaceAll("IF NOT EXISTS ", "");

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
