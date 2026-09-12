// SPDX-License-Identifier: AGPL-3.0
// Scoped configuration and secret references (CON-02, issue #147; ADR 020):
// typed set/list/update/delete, upstream list-masking and partial-update
// parity, org scoping, managed-row ownership, and export exclusion — proven
// against real local D1 in workerd. Applies the migration chain (0001 +
// 0007 + 0010) so the configs schema composes with the org-membership gate
// (AUTH-01): route tests run as the LAB fixture identity (OWNER bootstraps
// to admin of ORG in authenticate), and OTHER_USER holds an ordinary
// membership so denials read as config policy, never as org strangers.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { Fault } from "../src/domain";
import {
  bindSagaConfig,
  exportConfigDeclarations,
  parseSecretRef,
  parseStoredValue,
  reconcileManagedConfigs,
  resolveConfig,
  resolveDeploymentSecret,
  SECRET_MASK,
  setConfig,
  validateConfigValue,
  validateManifestConfigValue,
} from "../src/config";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration4 from "../migrations/0004_solutions_install.sql?raw";
import migration5 from "../migrations/0010_solutions_activation.sql?raw";
import migration7 from "../migrations/0007_org_membership.sql?raw";
import migration10 from "../migrations/0023_config.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const ORG = "00000000-0000-4000-8000-000000000001";
const OWNER = "00000000-0000-4000-8000-000000000002";
const OTHER_USER = "00000000-0000-4000-8000-000000000003";
const OTHER_ORG = "00000000-0000-4000-8000-000000000009";
const DEPLOYMENT_SECRET = "test-client-secret-sentinel";

function headers(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
}

function call(path: string, method = "GET", body?: unknown, orgId = ORG, userId = OWNER) {
  return worker.fetch(
    new Request(`http://local.test${path}`, {
      method,
      headers: headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { ...bindings, LAB_ORG_ID: orgId, LAB_USER_ID: userId },
  );
}

function faultCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof Fault) return error.code;
    throw error;
  }
  throw new Error("expected a Fault");
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration4);
  await bindings.DB.exec(migration5);
  await bindings.DB.exec(migration7);
  await bindings.DB.exec(migration10);
  // AUTH-01 membership gate: the LAB fixture identity (OWNER) bootstraps to
  // admin of ORG inside authenticate on first use. OTHER_USER holds an
  // ordinary membership so config denials prove config policy, not org
  // strangerhood. OTHER_ORG stays unknown: cross-org names answer 404.
  const stamp = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?)").bind(ORG, "Local demo").run();
  await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
    .bind(OTHER_USER, stamp)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(ORG, OTHER_USER, "member", "active", "ordinary", stamp, stamp)
    .run();
});

afterEach(async () => {
  await reset();
});

describe("CON-02 typed validation", () => {
  it("validates each type and rejects malformed values", () => {
    expect(validateConfigValue("string", "hello")).toBe("hello");
    expect(validateConfigValue("int", "30")).toBe("30");
    expect(validateConfigValue("int", "-5")).toBe("-5");
    expect(validateConfigValue("bool", "true")).toBe("true");
    expect(validateConfigValue("bool", "false")).toBe("false");
    expect(validateConfigValue("json", '{"a":1}')).toBe('{"a":1}');
    expect(faultCode(() => validateConfigValue("int", "3.5"))).toBe("INVALID_CONFIG_VALUE");
    expect(faultCode(() => validateConfigValue("int", "abc"))).toBe("INVALID_CONFIG_VALUE");
    expect(faultCode(() => validateConfigValue("int", "9999999999"))).toBe("INVALID_CONFIG_VALUE");
    expect(faultCode(() => validateConfigValue("bool", "yes"))).toBe("INVALID_CONFIG_VALUE");
    expect(faultCode(() => validateConfigValue("json", "{nope"))).toBe("INVALID_CONFIG_VALUE");
    expect(faultCode(() => validateConfigValue("string", ""))).toBe("INVALID_CONFIG_VALUE");
    expect(parseStoredValue("int", "30")).toBe(30);
    expect(parseStoredValue("bool", "true")).toBe(true);
    expect(parseStoredValue("json", '{"a":1}')).toEqual({ a: 1 });
  });

  it("rejects credential-shaped material in non-secret rows", () => {
    expect(faultCode(() => validateConfigValue("string", "sk-api-key-12345"))).toBe("CREDENTIAL_IN_VALUE");
    expect(faultCode(() => validateConfigValue("string", "my client_secret value"))).toBe("CREDENTIAL_IN_VALUE");
    expect(faultCode(() => validateManifestConfigValue("api_key", "x"))).toBe("CREDENTIAL_IN_MANIFEST");
    expect(faultCode(() => validateManifestConfigValue("bad key!", "x"))).toBe("INVALID_CONFIG_KEY");
    validateManifestConfigValue("supportEmail", "ops@example.com");
  });

  it("rejects malformed keys, types, and secret references", async () => {
    const caller = { orgId: ORG, userId: OWNER };
    await expect(
      setConfig(bindings.DB, caller, { key: "bad-key!", type: "string", value: "x" }, {}),
    ).rejects.toMatchObject({
      code: "INVALID_CONFIG_KEY",
    });
    await expect(setConfig(bindings.DB, caller, { key: "ok_key", type: "nope", value: "x" }, {})).rejects.toMatchObject(
      {
        code: "INVALID_CONFIG_TYPE",
      },
    );
    expect(faultCode(() => parseSecretRef({ ref: "nope" }))).toBe("SECRET_SCHEMA_MISMATCH");
    expect(faultCode(() => parseSecretRef("raw-value"))).toBe("INVALID_CONFIG_VALUE");
    expect(parseSecretRef(null)).toBe(null);
    expect(parseSecretRef({})).toBe(null);
  });
});

describe("CON-02 operator routes", () => {
  it("sets, lists, updates, and deletes typed rows", async () => {
    const created = await call("/api/config", "POST", { key: "timeout", type: "int", value: "30" });
    expect(created.status).toBe(201);
    const entry = ((await created.json()) as { config: { id: string; value: unknown } }).config;
    expect(entry.value).toBe(30);

    const listed = await call("/api/config");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ configs: [{ key: "timeout", type: "int", value: 30 }] });

    const updated = await call(`/api/config/${entry.id}`, "PUT", { value: "60" });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ config: { key: "timeout", value: 60 } });

    const renamed = await call(`/api/config/${entry.id}`, "PUT", { key: "retries", type: "int", value: "3" });
    expect(await renamed.json()).toMatchObject({ config: { key: "retries", value: 3 } });

    const deleted = await call(`/api/config/${entry.id}`, "DELETE");
    expect(deleted.status).toBe(200);
    expect(await call("/api/config").then((res) => res.json())).toEqual({ configs: [] });
  });

  it("upserts by natural key and rejects unknown update fields", async () => {
    expect((await call("/api/config", "POST", { key: "flag", type: "bool", value: "true" })).status).toBe(201);
    const again = await call("/api/config", "POST", { key: "flag", type: "bool", value: "false" });
    expect(again.status).toBe(201);
    expect(await call("/api/config").then((res) => res.json())).toMatchObject({ configs: [{ value: false }] });
    const listed = (await (await call("/api/config")).json()) as { configs: { id: string }[] };
    const bad = await call(`/api/config/${listed.configs[0]!.id}`, "PUT", { bogus: 1 });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "INVALID_CONFIG_UPDATE" } });
  });

  it("masks secret rows on every read and never returns values", async () => {
    const created = await call("/api/config", "POST", {
      key: "apiKey",
      type: "secret",
      value: { ref: "clientSecret" },
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ config: { key: "apiKey", value: SECRET_MASK } });

    const listed = await call("/api/config");
    const body = (await listed.json()) as { configs: { value: unknown }[] };
    expect(body.configs[0]!.value).toBe(SECRET_MASK);
    const text = JSON.stringify(body);
    expect(text).not.toContain(DEPLOYMENT_SECRET);
    expect(text).not.toContain("clientSecret");
  });

  it("provisions secret references only against available deployment secrets", async () => {
    const unknown = await call("/api/config", "POST", { key: "k1", type: "secret", value: { ref: "nope" } });
    expect(unknown.status).toBe(400);
    const missing = await call(
      "/api/config",
      "POST",
      { key: "k2", type: "secret", value: { ref: "clientSecret" } },
      ORG,
      OTHER_USER,
    );
    expect(missing.status).toBe(201);
    // The vitest binding carries NINJA_CLIENT_SECRET, so wait: prove the
    // fail-closed arm by pointing at a declared-but-absent env name through
    // the pure gate instead.
    const { requireProvisionedSecret } = await import("../src/config");
    expect(() => requireProvisionedSecret({}, "clientSecret")).toThrow();
  });

  it("preserves secret references on empty updates and re-provisions new ones", async () => {
    const created = await call("/api/config", "POST", {
      key: "apiKey",
      type: "secret",
      value: { ref: "clientSecret" },
    });
    const id = ((await created.json()) as { config: { id: string } }).config.id;
    const kept = await call(`/api/config/${id}`, "PUT", { description: "rotated note" });
    expect(kept.status).toBe(200);
    expect(await kept.json()).toMatchObject({ config: { value: SECRET_MASK, description: "rotated note" } });
    const empty = await call(`/api/config/${id}`, "PUT", { value: "" });
    expect(await empty.json()).toMatchObject({ config: { value: SECRET_MASK } });
  });

  it("scopes rows to the Organization: foreign rows are invisible", async () => {
    const created = await call("/api/config", "POST", { key: "timeout", type: "int", value: "30" });
    const id = ((await created.json()) as { config: { id: string } }).config.id;
    // OTHER_USER is a member of ORG: same-org reads work.
    expect((await call("/api/config", "GET", undefined, ORG, OTHER_USER)).status).toBe(200);
    // OTHER_ORG boots as its own empty org: the ORG row never leaks across
    // (empty list), and the exact ID 404s there instead of resolving.
    const foreignList = await call("/api/config", "GET", undefined, OTHER_ORG);
    expect(foreignList.status).toBe(200);
    expect(await foreignList.json()).toEqual({ configs: [] });
    expect((await call(`/api/config/${id}`, "DELETE", undefined, OTHER_ORG)).status).toBe(404);
    // The home org still owns its row.
    expect(await call("/api/config").then((res) => res.json())).toMatchObject({
      configs: [{ key: "timeout", value: 30 }],
    });
  });

  it("rejects query strings and malformed bodies", async () => {
    expect((await call("/api/config?scope=global")).status).toBe(400);
    const bad = await call("/api/config", "POST", [1, 2]);
    expect(bad.status).toBe(400);
    const missing = await call("/api/config/aaaaaaaa-1111-4111-8111-111111111111", "DELETE");
    expect(missing.status).toBe(404);
  });
});

describe("CON-02 managed ownership and export exclusion", () => {
  it("rejects operator writes to managed rows", async () => {
    const now = new Date().toISOString();
    await bindings.DB.prepare(
      "INSERT INTO configs(id, org_id, key, type, value_json, description, managed_by, updated_at, updated_by) VALUES (?, ?, ?, 'string', ?, NULL, ?, ?, ?)",
    )
      .bind("aaaaaaaa-1111-4111-8111-111111111111", ORG, "supportEmail", "ops@example.com", "bundle@1.0.0", now, OWNER)
      .run();
    const caller = { orgId: ORG, userId: OWNER };
    await expect(
      setConfig(bindings.DB, caller, { key: "supportEmail", type: "string", value: "x@y.z" }, {}),
    ).rejects.toMatchObject({
      code: "MANAGED_RESOURCE",
    });
    const listed = await call("/api/config");
    expect(await listed.json()).toMatchObject({ configs: [{ key: "supportEmail", managedBy: "bundle@1.0.0" }] });
  });

  it("reconciles bundle_config pins with owned/loose enforcement", async () => {
    const bundle = "b10a7c2e-3f4d-4a5b-8c6d-7e8f9a0b1c2d";
    const org = await bindings.DB.prepare("SELECT id FROM organizations WHERE id = ?")
      .bind(ORG)
      .first<{ id: string }>();
    expect(org?.id).toBe(ORG);
    const first = await reconcileManagedConfigs(
      bindings.DB,
      bundle,
      ORG,
      `${bundle}@1.0.0`,
      new Map([["supportEmail", "ops@example.com"]]),
    );
    expect(first).toEqual({ created: 1, updated: 0, skipped: 0, deleted: 0 });
    const second = await reconcileManagedConfigs(
      bindings.DB,
      bundle,
      ORG,
      `${bundle}@1.0.0`,
      new Map([["supportEmail", "ops@example.com"]]),
    );
    expect(second.skipped).toBe(1);
    const third = await reconcileManagedConfigs(
      bindings.DB,
      bundle,
      ORG,
      `${bundle}@1.0.1`,
      new Map([["supportEmail", "new@example.com"]]),
    );
    expect(third.updated).toBe(1);
    const fourth = await reconcileManagedConfigs(bindings.DB, bundle, ORG, `${bundle}@1.0.1`, new Map());
    expect(fourth.deleted).toBe(1);
  });

  it("exports declarations only, never values", async () => {
    await call("/api/config", "POST", { key: "timeout", type: "int", value: "30" });
    await call("/api/config", "POST", { key: "apiKey", type: "secret", value: { ref: "clientSecret" } });
    const exported = await exportConfigDeclarations(bindings.DB, ORG);
    expect(exported).toEqual([
      { key: "apiKey", type: "secret", managedBy: null },
      { key: "timeout", type: "int", managedBy: null },
    ]);
    expect(JSON.stringify(exported)).not.toContain(DEPLOYMENT_SECRET);
  });
});

describe("CON-02 Saga resolution", () => {
  it("resolves typed values, defaults, and declared-missing outcomes", async () => {
    const caller = { orgId: ORG, userId: OWNER };
    await setConfig(bindings.DB, caller, { key: "timeout", type: "int", value: "30" }, {});
    const env = { db: bindings.DB, orgId: ORG, secrets: {} };
    const hit = await resolveConfig(env, "timeout", ["timeout"], {});
    expect(hit).toMatchObject({ found: true, value: 30, type: "int" });
    const fallback = await resolveConfig(env, "missing", [], { missing: "dflt" });
    expect(fallback).toMatchObject({ found: false, declared: false, value: "dflt" });
    const loud = await resolveConfig(env, "missing", ["missing"], {});
    expect(loud.found).toBe(false);
    if (!loud.found && loud.declared) expect(loud.error.code).toBe("CONFIG_REQUIREMENT_UNSATISFIED");
    const silent = await resolveConfig(env, "missing", [], {});
    expect(silent).toMatchObject({ found: false, declared: false, value: null });
  });

  it("resolves secret references transiently through deployment names", async () => {
    const caller = { orgId: ORG, userId: OWNER };
    await setConfig(
      bindings.DB,
      caller,
      { key: "apiKey", type: "secret", value: { ref: "clientSecret" } },
      { NINJA_CLIENT_SECRET: DEPLOYMENT_SECRET },
    );
    // Declared name resolves through the conventional env binding.
    expect(resolveDeploymentSecret({ NINJA_CLIENT_SECRET: DEPLOYMENT_SECRET }, "clientSecret")).toBe(DEPLOYMENT_SECRET);
    const env = {
      db: bindings.DB,
      orgId: ORG,
      executionId: "ab".repeat(32),
      secrets: { NINJA_CLIENT_SECRET: DEPLOYMENT_SECRET },
    };
    const hit = await resolveConfig(env, "apiKey", ["apiKey"], {});
    expect(hit).toMatchObject({ found: true, value: DEPLOYMENT_SECRET, type: "secret" });
    const handle = bindSagaConfig(env, ["apiKey"], {});
    await expect(handle.require("apiKey")).resolves.toBe(DEPLOYMENT_SECRET);
    await expect(handle.get("nope", "dflt")).resolves.toBe("dflt");
    await expect(handle.require("nope")).rejects.toMatchObject({ code: "CONFIG_REQUIREMENT_UNSATISFIED" });
  });

  it("fails closed on unprovisioned secret references", async () => {
    const caller = { orgId: ORG, userId: OWNER };
    await setConfig(bindings.DB, caller, { key: "ghost", type: "secret" }, {});
    const env = { db: bindings.DB, orgId: ORG, secrets: {} };
    const loud = await resolveConfig(env, "ghost", ["ghost"], {});
    if (!loud.found && loud.declared) expect(loud.error.code).toBe("SECRET_NOT_CONFIGURED");
    else throw new Error("expected a declared-missing secret outcome");
  });

  it("reads only its own org: no global tier, no cross-org fallback", async () => {
    const caller = { orgId: ORG, userId: OWNER };
    await setConfig(bindings.DB, caller, { key: "timeout", type: "int", value: "30" }, {});
    const foreign = await resolveConfig({ db: bindings.DB, orgId: OTHER_ORG, secrets: {} }, "timeout", ["timeout"], {});
    if (!foreign.found && foreign.declared) expect(foreign.error.code).toBe("CONFIG_REQUIREMENT_UNSATISFIED");
    else throw new Error("expected a foreign-org miss, never a fallback value");
  });
});
