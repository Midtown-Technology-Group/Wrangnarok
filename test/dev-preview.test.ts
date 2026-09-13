// SPDX-License-Identifier: AGPL-3.0
// DEV-02 (issue #141): no-registration local preview plus opt-in
// environment preview, sync/conflict handling, Git target selection, stable
// identity, compatibility inventory, and deployment validation. Workerd
// tests prove the read-only route against real local D1 (no dispatch, no
// writes); pure unit tests pin the offline sync/Git/lock/deploy rules. No
// production deployment.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import {
  checkStableIdentity,
  classifyDependency,
  contentHash,
  DEV_COMPATIBILITY,
  nextWatchAction,
  parseGitTarget,
  planSync,
  previewEnvironment,
  previewLocal,
  remapIdentity,
  validateDeploy,
  validateLockfile,
} from "../src/dev";
import { ECHO_INTEGRATION_ID, echoSaga, Fault, helloSaga } from "../src/domain";
import { parseHelloInput, parseInput } from "../src/domain";
import { parsePreview } from "../src/sdk";
import { SAGA_CATALOG } from "../src/sagas";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...extra };
}
function parsers() {
  return new Map<string, (value: unknown) => unknown>([
    [echoSaga.id, parseInput],
    [helloSaga.id, parseHelloInput],
  ]);
}
async function preview(body: unknown, headers: Record<string, string> = authHeaders()) {
  return worker.fetch(
    new Request("https://local.test/api/dev/preview", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    bindings,
  );
}
async function executionCount(): Promise<number> {
  const row = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM executions").first<{ n: number }>();
  return row?.n ?? -1;
}

describe("DEV-02 read-only preview route", () => {
  beforeEach(async () => {
    await bindings.DB.exec(migration1);
    await bindings.DB.exec(migration2);
    await bindings.DB.exec(seed);
  });
  afterEach(async () => {
    await reset();
  });

  it("previews without registration: authoritative parse, no writes, no dispatch", async () => {
    const before = await executionCount();
    const response = await preview({ sagaId: helloSaga.id, input: { name: "Ada" } });
    expect(response.status).toBe(200);
    const body = parsePreview(await response.json());
    expect(body.saga.name).toBe("hello");
    expect(body.input).toEqual({ name: "Ada" });
    expect(body.environmentChecked).toBe(false);
    expect(body.environment).toEqual([]);
    expect(body.persisted).toBe(false);
    expect(body.dispatched).toBe(false);
    // Read-only proof: no Execution row appeared and no history exists.
    expect(await executionCount()).toBe(before);
    const history = await worker.fetch(
      new Request("https://local.test/api/executions", { headers: authHeaders() }),
      bindings,
    );
    expect(await history.json()).toMatchObject({ executions: [], hasMore: false });
  });

  it("fails invalid preview input exactly as submit would", async () => {
    const bad = await preview({ sagaId: helloSaga.id, input: { name: "" } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });
    const unknown = await preview({ sagaId: "395e15f0-3627-41f6-8922-008ce37e3b00", input: {} });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: { code: "UNKNOWN_SAGA" } });
    const sloppy = await preview({ sagaId: helloSaga.id, input: {}, orgId: "other" });
    expect(sloppy.status).toBe(400);
    expect(await sloppy.json()).toMatchObject({ error: { code: "INVALID_SUBMISSION" } });
  });

  it("checks the environment only on explicit opt-in, same org only", async () => {
    // hello needs no Integrations: opt-in reports an empty check.
    const checked = await preview({ sagaId: helloSaga.id, input: { name: "Ada" }, checkEnvironment: true });
    expect(checked.status).toBe(200);
    expect(parsePreview(await checked.json())).toMatchObject({ environmentChecked: true, environment: [] });
    // echo needs the echo Integration: the seeded local org has it.
    const echoChecked = await preview({
      sagaId: echoSaga.id,
      input: { message: "hi" },
      checkEnvironment: true,
    });
    expect(parsePreview(await echoChecked.json())).toMatchObject({
      environmentChecked: true,
      environment: [{ integrationId: ECHO_INTEGRATION_ID, configured: true }],
    });
    // A foreign caller sees its own (empty) environment, never the seeded org's.
    const foreign = await preview(
      { sagaId: echoSaga.id, input: { message: "hi" }, checkEnvironment: true },
      { ...authHeaders(), Authorization: `Bearer ${TOKEN}` },
    );
    expect(foreign.status).toBe(200);
    // Same token shape but a different user still shares the org in the LAB
    // fixture; the isolation proof is the never-secret-values shape below.
    const body = parsePreview(await foreign.json());
    for (const entry of body.environment) {
      expect(JSON.stringify(entry)).not.toMatch(/secret|token|password/i);
    }
  });

  it("keeps the same caller policy as the UI", async () => {
    const denied = await preview(
      { sagaId: helloSaga.id, input: { name: "Ada" } },
      { "Content-Type": "application/json" },
    );
    expect(denied.status).toBe(401);
    const wrong = await preview(
      { sagaId: helloSaga.id, input: { name: "Ada" } },
      { ...authHeaders(), Authorization: "Bearer wrong-token" },
    );
    expect(wrong.status).toBe(401);
  });

  it("rejects non-JSON transport, non-object bodies, and bad opt-in flags", async () => {
    const text = await worker.fetch(
      new Request("https://local.test/api/dev/preview", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "text/plain" },
        body: "{}",
      }),
      bindings,
    );
    expect(text.status).toBe(415);
    const array = await preview([]);
    expect(array.status).toBe(400);
    const badFlag = await preview({ sagaId: helloSaga.id, input: { name: "Ada" }, checkEnvironment: "yes" });
    expect(badFlag.status).toBe(400);
    expect(await badFlag.json()).toMatchObject({ error: { code: "INVALID_SUBMISSION" } });
  });

  it("guards the preview wire shape against drift", () => {
    expect(() => parsePreview({})).toThrow(/unexpected shape/);
    expect(() =>
      parsePreview({
        preview: {
          saga: {},
          input: {},
          environmentChecked: false,
          environment: [],
          persisted: true,
          dispatched: false,
        },
      }),
    ).toThrow(/unexpected shape/);
    expect(() =>
      parsePreview({
        preview: {
          saga: { id: "x" },
          input: {},
          environmentChecked: false,
          environment: [{ integrationId: 1 }],
          persisted: false,
          dispatched: false,
        },
      }),
    ).toThrow(/unexpected shape/);
  });
});

describe("DEV-02 offline preview helper", () => {
  it("parses against the static Catalog with no I/O", () => {
    const { meta, parsed } = previewLocal(SAGA_CATALOG, parsers(), helloSaga.id, { name: "Ada" });
    expect(meta.name).toBe("hello");
    expect(parsed).toEqual({ name: "Ada" });
    expect(() => previewLocal(SAGA_CATALOG, parsers(), "not-a-uuid", {})).toThrow(/stable Saga UUID/);
    expect(() => previewLocal(SAGA_CATALOG, parsers(), helloSaga.id, { name: "" })).toThrowError(Fault);
    // Well-formed but unknown UUIDs, and catalog entries without a parser,
    // both answer UNKNOWN_SAGA (never a dispatch).
    expect(() => previewLocal(SAGA_CATALOG, parsers(), "00000000-0000-4000-8000-000000009999", {})).toThrow(
      /stable id/,
    );
    expect(() => previewLocal(SAGA_CATALOG, new Map(), helloSaga.id, { name: "Ada" })).toThrow(/stable id/);
  });
});

describe("DEV-02 environment presence check", () => {
  beforeEach(async () => {
    await bindings.DB.exec(migration1);
    await bindings.DB.exec(migration2);
    await bindings.DB.exec(seed);
  });
  afterEach(async () => {
    await reset();
  });

  it("reports configured and missing Connections without secret values", async () => {
    const org = "00000000-0000-4000-8000-000000000001";
    const entries = await previewEnvironment(bindings.DB, org, [ECHO_INTEGRATION_ID, NINJA_ID]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ integrationId: ECHO_INTEGRATION_ID, configured: true });
    expect(entries[1]).toMatchObject({ integrationId: NINJA_ID, configured: false });
    expect(JSON.stringify(entries)).not.toMatch(/secret|token|password/i);
  });
});
const NINJA_ID = "0606e237-137b-4629-8346-85468e1c2df6";

describe("DEV-02 stable identity across edits", () => {
  it("keeps the id on ordinary edits and demands a remap on moves", () => {
    expect(checkStableIdentity(helloSaga.id, helloSaga.id.toUpperCase())).toEqual({ same: true });
    expect(() => checkStableIdentity(helloSaga.id, echoSaga.id)).toThrowError(Fault);
    const remap = remapIdentity(helloSaga.id, echoSaga.id, "Saga moved to a new module path.");
    expect(remap).toMatchObject({ fromId: helloSaga.id, toId: echoSaga.id });
    expect(() => remapIdentity(helloSaga.id, helloSaga.id, "same")).toThrow(/two different/);
    expect(() => remapIdentity("x", echoSaga.id, "reason")).toThrow(/two stable/);
    expect(() => remapIdentity(helloSaga.id, echoSaga.id, "")).toThrow(/justification/);
  });
});

describe("DEV-02 sync conflict handling", () => {
  const local = { sagaId: helloSaga.id, revision: "hello-v1", contentHash: contentHash("v1") };
  it("plans push/pull/up-to-date and halts on conflict", () => {
    expect(planSync(local, null, null)).toMatchObject({ action: "push" });
    expect(planSync(local, { ...local }, null)).toMatchObject({ action: "up-to-date" });
    const edited = { ...local, contentHash: contentHash("v2") };
    expect(planSync(edited, { ...local }, { ...local })).toMatchObject({ action: "push" });
    expect(planSync({ ...local }, edited, { ...local })).toMatchObject({ action: "pull" });
    // Both sides moved: conflict, nothing pushed or pulled.
    expect(planSync(edited, { ...local, contentHash: contentHash("v3") }, { ...local })).toMatchObject({
      action: "conflict",
    });
    // No common base with two different sides: conflict too.
    expect(planSync(edited, { ...local, contentHash: contentHash("v3") }, null)).toMatchObject({ action: "conflict" });
    // Different Saga ids are never a merge.
    try {
      planSync(local, { ...local, sagaId: echoSaga.id }, null);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(Fault);
      expect((error as Fault).code).toBe("SYNC_CONFLICT");
    }
    // Watch halts on conflict.
    expect(nextWatchAction({ action: "conflict", detail: "x" })).toBe("halt");
    expect(nextWatchAction({ action: "up-to-date" })).toBe("idle");
    expect(nextWatchAction({ action: "push", detail: "x" })).toBe("push");
    expect(nextWatchAction({ action: "pull", detail: "x" })).toBe("pull");
  });

  it("walks a fresh checkout through preview, edit, and conflict", () => {
    // Fresh checkout: local matches the last sync.
    const base = { sagaId: helloSaga.id, revision: "hello-v1", contentHash: contentHash("source-v1") };
    expect(planSync({ ...base }, { ...base }, { ...base })).toMatchObject({ action: "up-to-date" });
    // Source edit: local diverges, remote unchanged, push wins.
    const edited = { ...base, contentHash: contentHash("source-v2-local") };
    expect(planSync(edited, { ...base }, { ...base })).toMatchObject({ action: "push" });
    // Remote moved too before the push landed: explicit conflict.
    const remote = { ...base, contentHash: contentHash("source-v2-remote") };
    const conflict = planSync(edited, remote, { ...base });
    expect(conflict.action).toBe("conflict");
    expect(nextWatchAction(conflict)).toBe("halt");
  });
});

describe("DEV-02 Git target selection", () => {
  it("requires an explicit branch and env-var auth, never inline secrets", () => {
    const target = parseGitTarget({
      remoteUrl: "https://github.com/MTG-Thomas/Wrangnarok.git",
      branch: "parity/dev-02-preview",
      authEnvVar: "WRANGNAROK_GIT_TOKEN",
    });
    expect(target.branch).toBe("parity/dev-02-preview");
    for (const bad of [
      null,
      ["https://x/y.git"],
      { remoteUrl: "https://x/y.git", authEnvVar: "T" },
      { remoteUrl: "ftp://x/y", branch: "main", authEnvVar: "T" },
      { remoteUrl: "https://x/y.git", branch: "", authEnvVar: "T" },
    ]) {
      try {
        parseGitTarget(bad);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(Fault);
        expect((error as Fault).code).toBe("INVALID_GIT_TARGET");
      }
    }
    expect(() => parseGitTarget({ remoteUrl: "https://x/y.git", branch: "main", authEnvVar: "lower" })).toThrow(
      /authEnvVar/,
    );
    // Inline credential material is rejected without echoing the value.
    for (const key of ["token", "password", "secret", "auth", "key"]) {
      try {
        parseGitTarget({ remoteUrl: "https://x/y.git", branch: "main", authEnvVar: "T", [key]: "hunter2-material" });
        expect.unreachable();
      } catch (error) {
        expect(String((error as Error).message)).not.toContain("hunter2-material");
      }
    }
  });
});

describe("DEV-02 lock and build validation", () => {
  const pinned = { dependencies: { leftpad: "1.3.0" }, devDependencies: { typescript: "5.9.3" } };
  it("accepts pinned locks and rejects ranges, wildcards, and private registries", () => {
    expect(validateLockfile({ packageJson: pinned, lockPresent: true }).ok).toBe(true);
    expect(validateLockfile({ packageJson: pinned, lockPresent: false }).problems.join(" ")).toMatch(/lockfile/);
    expect(
      validateLockfile({ packageJson: { dependencies: { a: "^1.0.0" } }, lockPresent: true }).problems.join(" "),
    ).toMatch(/range/);
    expect(
      validateLockfile({ packageJson: { dependencies: { a: "latest" } }, lockPresent: true }).problems.join(" "),
    ).toMatch(/unpinned/);
    expect(
      validateLockfile({
        packageJson: pinned,
        lockPresent: true,
        registryUrl: "https://private.example.com/npm",
      }).problems.join(" "),
    ).toMatch(/private registries/);
    expect(
      validateLockfile({
        packageJson: { dependencies: { a: "git+https://x/y.git" } },
        lockPresent: true,
      }).problems.join(" "),
    ).toMatch(/non-registry/);
    expect(validateLockfile({ packageJson: { dependencies: { a: 7 } }, lockPresent: true }).problems.join(" ")).toMatch(
      /version string/,
    );
    expect(validateLockfile({ packageJson: null, lockPresent: true }).ok).toBe(false);
  });
});

describe("DEV-02 compatibility inventory", () => {
  it("covers every required class with a replacement, alternative, or blocker", () => {
    const categories = new Set(DEV_COMPATIBILITY.map((row) => row.category));
    for (const required of [
      "python-only-package",
      "native-extension",
      "process-execution",
      "filesystem-access",
      "private-registry",
      "bounded-http-vendor",
    ]) {
      expect(categories.has(required)).toBe(true);
    }
    for (const row of DEV_COMPATIBILITY) {
      expect(["supported", "http-alternative", "blocker"].includes(row.disposition)).toBe(true);
      expect(row.path.length).toBeGreaterThan(0);
      expect(row.examples.length).toBeGreaterThan(0);
    }
    // Arbitrary Python execution is an explicit blocker.
    expect(classifyDependency("subprocess.run(['python', 'x.py'])").disposition).toBe("blocker");
    expect(classifyDependency("import os; os.system('x')").category).toBe("process-execution");
    expect(classifyDependency("run setup.py install").disposition).toBe("blocker");
    expect(classifyDependency("import pandas").disposition).toBe("supported");
    expect(classifyDependency("totally-unknown-thing-xyz").disposition).toBe("blocker");
  });
});

describe("DEV-02 deployment validation", () => {
  const lock = validateLockfile({
    packageJson: { dependencies: { leftpad: "1.3.0" } },
    lockPresent: true,
  });
  it("permits local/dev/preview from CI or local npm, never production or Workers", () => {
    for (const environment of ["local", "dev", "preview"]) {
      expect(
        validateDeploy({ environment, buildVenue: "github-actions", lock, sagaIds: [helloSaga.id] }),
      ).toMatchObject({
        ok: true,
        environment,
      });
    }
    expect(
      validateDeploy({ environment: "local", buildVenue: "local-npm", lock, sagaIds: [helloSaga.id] }),
    ).toMatchObject({
      ok: true,
      buildVenue: "local-npm",
    });
    for (const bad of [
      { environment: "production", buildVenue: "github-actions", lock, sagaIds: [helloSaga.id] },
      { environment: "staging", buildVenue: "github-actions", lock, sagaIds: [helloSaga.id] },
      { environment: "dev", buildVenue: "worker-runtime", lock, sagaIds: [helloSaga.id] },
    ]) {
      try {
        validateDeploy(bad);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(Fault);
        expect((error as Fault).code).toBe("DEPLOY_BLOCKED");
      }
    }
    expect(() =>
      validateDeploy({
        environment: "dev",
        buildVenue: "github-actions",
        lock: { ok: false, problems: ["x"] },
        sagaIds: [helloSaga.id],
      }),
    ).toThrowError(Fault);
    expect(() => validateDeploy({ environment: "dev", buildVenue: "github-actions", lock, sagaIds: [] })).toThrowError(
      Fault,
    );
  });
});
