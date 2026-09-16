// SPDX-License-Identifier: AGPL-3.0
// Artifact branch coverage (FILE-02, issue #158): pure-TypeScript parser
// gates plus domain fault paths that the route-level suite covers only on
// the happy side. No bindings, no network.
import { expect, it } from "vitest";
import {
  artifactObjectKey,
  ARTIFACT_FORMAT_STATUS,
  ARTIFACT_FORMATS,
  ARTIFACT_LIST_LIMIT_MAX,
  ARTIFACT_MAX_BYTES,
  ARTIFACT_RETENTION_MAX_DAYS,
  ARTIFACT_RETENTION_MIN_DAYS,
  isAdminCaller,
  listArtifacts,
  parseArtifactId,
  parseArtifactMime,
  parseArtifactName,
  parseArtifactVersion,
  parseBindingRef,
  parseBindingScope,
  parseRetentionDays,
} from "../src/artifacts";
import { Fault } from "../src/domain";

function faultOf(fn: () => unknown): Fault {
  try {
    fn();
  } catch (error) {
    if (error instanceof Fault) return error;
    throw error;
  }
  throw new Error("expected a Fault");
}

it("keys one R2 object per artifact version", () => {
  expect(artifactObjectKey("id", 2)).toBe("artifacts/id/v2");
});

it("pins the format subcapabilities and retention bounds", () => {
  expect([...ARTIFACT_FORMATS]).toEqual(["pdf", "docx", "xlsx", "csv", "html", "markdown", "json", "text"]);
  expect(new Set(Object.values(ARTIFACT_FORMAT_STATUS))).toEqual(new Set(["deferred"]));
  expect(ARTIFACT_LIST_LIMIT_MAX).toBe(50);
  expect(ARTIFACT_MAX_BYTES).toBe(5 * 1024 * 1024);
  expect(ARTIFACT_RETENTION_MIN_DAYS).toBe(1);
  expect(ARTIFACT_RETENTION_MAX_DAYS).toBe(3650);
});

it("gates the artifact id on exact UUIDs", () => {
  expect(parseArtifactId("11111111-1111-4111-8111-111111111111")).toBe("11111111-1111-4111-8111-111111111111");
  expect(faultOf(() => parseArtifactId("nope")).code).toBe("INVALID_ARTIFACT_ID");
});

it("rejects non-string, empty, overlong, control-char, and path names", () => {
  expect(parseArtifactName("notes.md")).toBe("notes.md");
  expect(faultOf(() => parseArtifactName(7)).code).toBe("INVALID_ARTIFACT");
  expect(faultOf(() => parseArtifactName("")).code).toBe("INVALID_ARTIFACT");
  expect(faultOf(() => parseArtifactName("x".repeat(257))).code).toBe("INVALID_ARTIFACT");
  expect(faultOf(() => parseArtifactName("bad\x00name")).code).toBe("INVALID_ARTIFACT");
  expect(faultOf(() => parseArtifactName("bad\x7fname")).code).toBe("INVALID_ARTIFACT");
  expect(faultOf(() => parseArtifactName("../evil")).code).toBe("INVALID_ARTIFACT");
  expect(faultOf(() => parseArtifactName("a/b")).code).toBe("INVALID_ARTIFACT");
  expect(faultOf(() => parseArtifactName("a\\b")).code).toBe("INVALID_ARTIFACT");
});

it("rejects malformed MIME claims", () => {
  expect(parseArtifactMime("Text/Plain")).toBe("text/plain");
  expect(faultOf(() => parseArtifactMime("not-a-mime")).code).toBe("INVALID_ARTIFACT");
  expect(faultOf(() => parseArtifactMime("")).code).toBe("INVALID_ARTIFACT");
  expect(faultOf(() => parseArtifactMime(7)).code).toBe("INVALID_ARTIFACT");
  expect(faultOf(() => parseArtifactMime(`x/${"y".repeat(200)}`)).code).toBe("INVALID_ARTIFACT");
});

it("bounds versions to integers in range", () => {
  expect(parseArtifactVersion(3)).toBe(3);
  for (const bad of [0, 101, 1.5, "2", NaN]) {
    expect(faultOf(() => parseArtifactVersion(bad)).code).toBe("INVALID_VERSION");
  }
});

it("bounds binding scopes and refs", () => {
  expect(parseBindingScope("execution")).toBe("execution");
  expect(parseBindingScope("workspace")).toBe("workspace");
  expect(parseBindingScope("conversation")).toBe("conversation");
  expect(faultOf(() => parseBindingScope("chat")).code).toBe("INVALID_BINDING");
  expect(faultOf(() => parseBindingScope(7)).code).toBe("INVALID_BINDING");
  expect(parseBindingRef("conv-1")).toBe("conv-1");
  expect(faultOf(() => parseBindingRef("")).code).toBe("INVALID_BINDING");
  expect(faultOf(() => parseBindingRef("x".repeat(129))).code).toBe("INVALID_BINDING");
  expect(faultOf(() => parseBindingRef(7)).code).toBe("INVALID_BINDING");
});

it("bounds retention days to 1-3650 integers", () => {
  expect(parseRetentionDays(90)).toBe(90);
  for (const bad of [0, 3651, 1.5, "7", null]) {
    expect(faultOf(() => parseRetentionDays(bad)).code).toBe("INVALID_RETENTION");
  }
});

it("grants the admin bypass to instance and org admins only", () => {
  expect(isAdminCaller({ isInstanceAdmin: true, isOrgAdmin: false })).toBe(true);
  expect(isAdminCaller({ isInstanceAdmin: false, isOrgAdmin: true })).toBe(true);
  expect(isAdminCaller({ isInstanceAdmin: false, isOrgAdmin: false })).toBe(false);
});

it("fences listArtifacts to the creator for non-admins (issue #354)", async () => {
  const rows = [
    {
      id: "a",
      org_id: "org-1",
      creator_user_id: "owner-1",
      name: "mine.md",
      mime: "text/markdown",
      size_bytes: 3,
      version: 1,
      status: "active",
      created_at: "2026-09-16T00:00:00.000Z",
      updated_at: "2026-09-16T00:00:00.000Z",
      deleted_at: null,
    },
    {
      id: "b",
      org_id: "org-1",
      creator_user_id: "owner-2",
      name: "theirs.md",
      mime: "text/markdown",
      size_bytes: 4,
      version: 1,
      status: "active",
      created_at: "2026-09-16T00:00:01.000Z",
      updated_at: "2026-09-16T00:00:01.000Z",
      deleted_at: null,
    },
  ];
  // Minimal D1 double: records the SQL and applies the creator fence the
  // real query applies, so the branch assertions below prove the parameters.
  let lastSql = "";
  let lastBinds: unknown[] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...binds: unknown[]) => ({
        all: async () => {
          lastSql = sql;
          lastBinds = binds;
          const creatorFenced = sql.includes("creator_user_id=?");
          const filtered = creatorFenced ? rows.filter((row) => row.creator_user_id === binds[1]) : rows;
          return { results: filtered };
        },
      }),
    }),
  } as unknown as D1Database;
  const owner = { orgId: "org-1", userId: "owner-1" };
  // Admin: no creator fence in SQL, both rows visible.
  const adminPage = await listArtifacts(db, owner, {}, true);
  expect(lastSql).not.toContain("creator_user_id=?");
  expect(adminPage.artifacts.map((entry) => entry.name).sort()).toEqual(["mine.md", "theirs.md"]);
  expect(adminPage.hasMore).toBe(false);
  // Non-admin default: creator fence in SQL, only the own row visible.
  const memberPage = await listArtifacts(db, owner, {});
  expect(lastSql).toContain("creator_user_id=?");
  expect(lastBinds[1]).toBe("owner-1");
  expect(memberPage.artifacts.map((entry) => entry.name)).toEqual(["mine.md"]);
  // Explicit false behaves like the default (deny-by-absence).
  await listArtifacts(db, owner, {}, false);
  expect(lastSql).toContain("creator_user_id=?");
  // Limits still validate before the fence runs.
  await expect(listArtifacts(db, owner, { limit: 99 })).rejects.toMatchObject({ code: "INVALID_LIMIT" });
  // includeDeleted:true drops the status filter (admin path keeps no fence).
  await listArtifacts(db, owner, { includeDeleted: true }, true);
  expect(lastSql).not.toContain("status='active'");
  // includeDeleted:true for a non-admin keeps the creator fence without the
  // status filter.
  await listArtifacts(db, owner, { includeDeleted: true }, false);
  expect(lastSql).toContain("creator_user_id=?");
  expect(lastSql).not.toContain("status='active'");
});
