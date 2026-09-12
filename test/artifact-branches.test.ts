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
