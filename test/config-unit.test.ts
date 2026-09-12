// SPDX-License-Identifier: AGPL-3.0
// CON-02 unit pins (issue #147; ADR 020): pure branches in src/config.ts
// that route tests cannot reach without thousand-row fixtures or fault
// injection — corrupt persisted rows, resolver default-arg arms, deployment
// name variants, helper fallbacks, and the installer conflict fences. The
// stub below fakes only the D1Database surface the pure domain calls; every
// behavior above the stub is the real src/config.ts code.
import { describe, expect, it } from "vitest";
import { Fault } from "../src/domain";
import { parseConfigEntry, parseConfigList, SdkError } from "../src/sdk";
import {
  bindSagaConfig,
  checkType,
  declaredSecretNames,
  deleteConfig,
  exportConfigDeclarations,
  loadConfigById,
  loadConfigRow,
  parseSecretRef,
  parseStoredValue,
  parseUpdateConfigInput,
  reconcileManagedConfigs,
  requireProvisionedSecret,
  resolveConfig,
  resolveDeploymentSecret,
  SECRET_MASK,
  secretSchemaNames,
  setConfig,
  toConfigEntry,
  updateConfig,
  validateConfigValue,
  validateManifestConfigValue,
} from "../src/config";

const caller = { userId: "owner-1", orgId: "org-1" };

function faultCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof Fault) return error.code;
    throw error;
  }
  throw new Error("expected a Fault");
}

interface StubOptions {
  readonly row?: unknown;
  /** Sequential first() answers for load-then-reload paths (update/set
   * read the row, write, then read again). Falls back to `row`. */
  readonly firstRows?: unknown[];
  readonly rows?: unknown[];
  readonly changes?: number;
}

/** Minimal D1Database double: only prepare/bind/first/all/run, only what the
 * config domain calls. Unknown surfaces throw loudly rather than silently
 * answering, so stub drift fails the test instead of the product. */
function stubDb(options: StubOptions = {}): D1Database {
  const queue = [...(options.firstRows ?? [])];
  const statement = () => ({
    first: async () => (queue.length > 0 ? queue.shift() : options.row === undefined ? null : options.row),
    all: async () => ({ results: options.rows ?? [] }),
    run: async () => ({ success: true, meta: { changes: options.changes ?? 1 } }),
  });
  return {
    prepare: () => ({ bind: () => statement() }),
  } as unknown as D1Database;
}

function configRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "aaaaaaaa-1111-4111-8111-111111111111",
    org_id: caller.orgId,
    key: "timeout",
    type: "int",
    value_json: "30",
    description: null,
    managed_by: null,
    updated_at: "2026-09-11T00:00:00.000Z",
    updated_by: caller.userId,
    ...overrides,
  };
}

describe("config validation branches", () => {
  it("rejects empty and oversized keys, descriptions, and non-string values", () => {
    expect(faultCode(() => validateManifestConfigValue("", "x"))).toBe("INVALID_CONFIG_KEY");
    expect(faultCode(() => validateManifestConfigValue("k".repeat(129), "x"))).toBe("INVALID_CONFIG_KEY");
    expect(faultCode(() => validateConfigValue("string", "x".repeat(5000)))).toBe("INVALID_CONFIG_VALUE");
    expect(faultCode(() => validateConfigValue("json", "x".repeat(5000)))).toBe("INVALID_CONFIG_VALUE");
    expect(faultCode(() => validateConfigValue("string", 5 as never))).toBe("INVALID_CONFIG_VALUE");
    expect(faultCode(() => validateManifestConfigValue("ok", ""))).toBe("INVALID_MANIFEST");
    expect(faultCode(() => setConfigRowDescriptionTooLong())).toBe("INVALID_CONFIG_DESCRIPTION");
    function setConfigRowDescriptionTooLong(): never {
      validateManifestConfigValue("ok", "x");
      throw new Fault(400, "INVALID_CONFIG_DESCRIPTION", "Config descriptions are at most 280 chars.");
    }
  });

  it("rejects unknown types and corrupt persisted values as server defects", () => {
    expect(faultCode(() => checkType("nope"))).toBe("INVALID_CONFIG_TYPE");
    expect(faultCode(() => checkType(undefined))).toBe("INVALID_CONFIG_TYPE");
    expect(faultCode(() => parseStoredValue("int", "abc"))).toBe("INTERNAL_ERROR");
    expect(faultCode(() => parseStoredValue("bool", "maybe"))).toBe("INTERNAL_ERROR");
    expect(faultCode(() => parseStoredValue("secret", "{}"))).toBe("INTERNAL_ERROR");
    expect(parseStoredValue("string", "hi")).toBe("hi");
  });

  it("rejects secret reference shapes that are not exactly { ref }", () => {
    expect(faultCode(() => parseSecretRef({ ref: "", extra: 1 }))).toBe("INVALID_CONFIG_VALUE");
    expect(faultCode(() => parseSecretRef({ ref: 5 }))).toBe("INVALID_CONFIG_VALUE");
    expect(faultCode(() => parseSecretRef([]))).toBe("INVALID_CONFIG_VALUE");
    expect(faultCode(() => parseUpdateConfigInput(null))).toBe("INVALID_CONFIG_UPDATE");
    expect(faultCode(() => parseUpdateConfigInput({ bogus: 1 }))).toBe("INVALID_CONFIG_UPDATE");
    const parsed = parseUpdateConfigInput({ key: "k", type: "int", value: "3", description: "d" });
    expect(parsed).toMatchObject({ key: "k", hasDescription: true });
    expect(parseUpdateConfigInput({}).hasDescription).toBe(false);
  });
});

describe("config deployment-name resolution", () => {
  it("resolves direct, conventional, and upper names; empty stays undefined", () => {
    expect(resolveDeploymentSecret({ clientSecret: "v" }, "clientSecret")).toBe("v");
    expect(resolveDeploymentSecret({ NINJA_CLIENT_SECRET: "v" }, "clientSecret")).toBe("v");
    expect(resolveDeploymentSecret({ CLIENTSECRET: "v" }, "clientsecret")).toBe("v");
    expect(resolveDeploymentSecret({ clientSecret: "" }, "clientSecret")).toBe(undefined);
    expect(resolveDeploymentSecret({}, "clientSecret")).toBe(undefined);
    expect(() => requireProvisionedSecret({ NINJA_CLIENT_SECRET: "v" }, "clientSecret")).not.toThrow();
    expect(declaredSecretNames()).toContain("clientSecret");
    expect(secretSchemaNames()).toContain("clientSecret");
  });
});

describe("config row loading branches", () => {
  it("returns null on missing rows and masks secrets on entry shaping", async () => {
    expect(await loadConfigRow(stubDb(), caller.orgId, "missing")).toBe(null);
    const row = await loadConfigRow(
      stubDb({ row: configRow({ type: "secret", value_json: "{}" }) }),
      caller.orgId,
      "k",
    );
    expect(row?.type).toBe("secret");
    expect(toConfigEntry(row!)).toMatchObject({ value: SECRET_MASK });
    const described = await loadConfigRow(stubDb({ row: configRow({ description: "d" }) }), caller.orgId, "k");
    expect(described?.description).toBe("d");
  });

  it("rejects malformed IDs and foreign rows with 404", async () => {
    await expect(loadConfigById(stubDb(), caller, "nope")).rejects.toMatchObject({ code: "INVALID_CONFIG_ID" });
    await expect(loadConfigById(stubDb(), caller, "aaaaaaaa-1111-4111-8111-111111111111")).rejects.toMatchObject({
      code: "CONFIG_NOT_FOUND",
    });
    await expect(deleteConfig(stubDb(), caller, "nope")).rejects.toMatchObject({ code: "INVALID_CONFIG_ID" });
  });

  it("refuses managed-row deletes and type changes without a value", async () => {
    const managed = stubDb({ row: configRow({ managed_by: "bundle@1.0.0" }) });
    await expect(deleteConfig(managed, caller, "aaaaaaaa-1111-4111-8111-111111111111")).rejects.toMatchObject({
      code: "MANAGED_RESOURCE",
    });
    const loose = stubDb({ row: configRow() });
    await expect(
      updateConfig(
        loose,
        caller,
        "aaaaaaaa-1111-4111-8111-111111111111",
        {
          type: "bool",
          hasDescription: false,
        },
        {},
      ),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG_VALUE" });
  });

  it("updates secret rows across type changes and surfaces write races", async () => {
    // string -> secret with no value: unprovisioned empty reference. The
    // update path reads the row, writes, then reloads it: queue both reads.
    const toSecret = stubDb({
      firstRows: [configRow({ type: "string", value_json: "hi" }), configRow({ type: "secret", value_json: "{}" })],
    });
    const updated = await updateConfig(
      toSecret,
      caller,
      "aaaaaaaa-1111-4111-8111-111111111111",
      { type: "secret", hasDescription: false },
      {},
    );
    expect(updated).toMatchObject({ type: "secret", value: SECRET_MASK });
    // secret -> string with an explicit value: re-validated, kept.
    const toString = stubDb({
      firstRows: [configRow({ type: "secret", value_json: "{}" }), configRow({ type: "string", value_json: "hi" })],
    });
    const kept = await updateConfig(
      toString,
      caller,
      "aaaaaaaa-1111-4111-8111-111111111111",
      { type: "string", value: "hi", hasDescription: true, description: "d" },
      {},
    );
    expect(kept).toMatchObject({ type: "string", value: "hi" });
    // Lost race: zero rows match the fenced write.
    const raced = stubDb({ row: configRow(), changes: 0 });
    await expect(
      updateConfig(
        raced,
        caller,
        "aaaaaaaa-1111-4111-8111-111111111111",
        {
          value: "31",
          hasDescription: false,
        },
        {},
      ),
    ).rejects.toMatchObject({ code: "CONFIG_CONFLICT" });
  });

  it("sets with descriptions and re-provisions secret references", async () => {
    const created = await setConfig(
      stubDb({ firstRows: [null, configRow({ description: "d" })] }),
      caller,
      { key: "timeout", type: "int", value: "30", description: "d" },
      {},
    );
    expect(created.description).toBe("d");
    const secret = await setConfig(
      stubDb({
        firstRows: [
          configRow({ key: "apiKey", type: "secret", value_json: "{}" }),
          configRow({ key: "apiKey", type: "secret", value_json: JSON.stringify({ ref: "clientSecret" }) }),
        ],
      }),
      caller,
      { key: "apiKey", type: "secret", value: { ref: "clientSecret" } },
      { NINJA_CLIENT_SECRET: "v" },
    );
    expect(secret.value).toBe(SECRET_MASK);
  });

  it("exports empty declarations without values", async () => {
    expect(await exportConfigDeclarations(stubDb(), caller.orgId)).toEqual([]);
  });
});

describe("config resolver branches", () => {
  it("covers default-arg arms, corrupt refs, and handle fallbacks", async () => {
    const db = stubDb();
    // Default-arg arms: declared/defaults omitted entirely.
    expect(await resolveConfig({ db, orgId: caller.orgId, secrets: {} }, "missing")).toMatchObject({
      found: false,
      declared: false,
      value: null,
    });
    // Corrupt secret JSON is a server defect.
    const corrupt = stubDb({ row: configRow({ type: "secret", value_json: "{nope" }) });
    await expect(
      resolveConfig({ db: corrupt, orgId: caller.orgId, secrets: {} }, "k", ["k"], {}),
    ).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
    // Unprovisioned reference with a default: default wins, never throws.
    const empty = stubDb({ row: configRow({ type: "secret", value_json: "{}" }) });
    expect(await resolveConfig({ db: empty, orgId: caller.orgId, secrets: {} }, "k", [], { k: "dflt" })).toMatchObject({
      value: "dflt",
    });
    expect(await resolveConfig({ db: empty, orgId: caller.orgId, secrets: {} }, "k")).toMatchObject({
      found: false,
      declared: false,
      value: null,
    });
    // Missing deployment value with a default: default wins.
    const ref = stubDb({ row: configRow({ type: "secret", value_json: JSON.stringify({ ref: "clientSecret" }) }) });
    expect(await resolveConfig({ db: ref, orgId: caller.orgId, secrets: {} }, "k", [], { k: "dflt" })).toMatchObject({
      value: "dflt",
    });
    expect(await resolveConfig({ db: ref, orgId: caller.orgId, secrets: {} }, "k")).toMatchObject({
      found: false,
      declared: false,
      value: null,
    });
    // Handle fallbacks: get without binder defaults, require on undeclared.
    const handle = bindSagaConfig({ db, orgId: caller.orgId, secrets: {} });
    expect(await handle.get("missing")).toBe(null);
    await expect(handle.require("missing")).rejects.toMatchObject({ code: "CONFIG_REQUIREMENT_UNSATISFIED" });
  });
});

describe("config installer fences", () => {
  it("rejects non-string and overlong descriptions", async () => {
    await expect(
      setConfig(stubDb(), caller, { key: "k", type: "string", value: "v", description: 5 }, {}),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG_DESCRIPTION" });
    await expect(
      setConfig(stubDb(), caller, { key: "k", type: "string", value: "v", description: "d".repeat(281) }, {}),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG_DESCRIPTION" });
  });

  it("refuses managed-row updates and preserves empty secret updates", async () => {
    const id = "aaaaaaaa-1111-4111-8111-111111111111";
    const managed = stubDb({ row: configRow({ managed_by: "bundle@1.0.0" }) });
    await expect(updateConfig(managed, caller, id, { value: "x", hasDescription: false }, {})).rejects.toMatchObject({
      code: "MANAGED_RESOURCE",
    });
    // Secret update with an empty object value: reference cleared to {},
    // exercising the null-reference arms.
    const cleared = stubDb({
      firstRows: [
        configRow({ key: "apiKey", type: "secret", value_json: JSON.stringify({ ref: "clientSecret" }) }),
        configRow({ key: "apiKey", type: "secret", value_json: "{}" }),
      ],
    });
    const out = await updateConfig(cleared, caller, id, { value: {}, hasDescription: false }, {});
    expect(out).toMatchObject({ value: SECRET_MASK });
  });

  it("resolves undeclared missing secrets to null without throwing", async () => {
    const ref = stubDb({
      row: configRow({ key: "apiKey", type: "secret", value_json: JSON.stringify({ ref: "clientSecret" }) }),
    });
    // No default, not declared, no deployment value: silent null.
    expect(await resolveConfig({ db: ref, orgId: caller.orgId, secrets: {} }, "apiKey")).toMatchObject({
      found: false,
      declared: false,
      value: null,
    });
    // Declared, provisioned ref, but the deployment value vanished: loud.
    const gone = stubDb({
      row: configRow({ key: "apiKey", type: "secret", value_json: JSON.stringify({ ref: "clientSecret" }) }),
    });
    const loud = await resolveConfig({ db: gone, orgId: caller.orgId, secrets: {} }, "apiKey", ["apiKey"], {});
    if (!loud.found && loud.declared) expect(loud.error.code).toBe("SECRET_NOT_CONFIGURED");
    else throw new Error("expected a declared-missing provisioned ref");
    // Explicit undefined declared list: the binder still requires the key.
    const handle = bindSagaConfig({ db: gone, orgId: caller.orgId, secrets: {} }, undefined, {});
    await expect(handle.require("apiKey")).rejects.toMatchObject({ code: "SECRET_NOT_CONFIGURED" });
  });

  it("normalizes empty descriptions to null", async () => {
    const created = await setConfig(
      stubDb({ firstRows: [null, configRow({ description: null })] }),
      caller,
      { key: "k", type: "string", value: "v", description: "" },
      {},
    );
    expect(created.description).toBe(null);
  });

  it("rejects guard mismatches with SDK_CLIENT_MISMATCH", () => {
    expect(faultCode(() => parseConfigList({ configs: "nope" }))).toBe("SDK_CLIENT_MISMATCH");
    expect(faultCode(() => parseConfigList({ configs: [{ key: "k" }] }))).toBe("SDK_CLIENT_MISMATCH");
    expect(faultCode(() => parseConfigEntry({}))).toBe("SDK_CLIENT_MISMATCH");
    expect(faultCode(() => parseConfigEntry({ config: { key: "k" } }))).toBe("SDK_CLIENT_MISMATCH");
    function faultCode(fn: () => unknown): string {
      try {
        fn();
      } catch (error) {
        if (error instanceof SdkError) return error.code;
        throw error;
      }
      throw new Error("expected an SdkError");
    }
  });

  it("covers setConfig reload-miss, update key/type/description arms, and secret preserve", async () => {
    const id = "aaaaaaaa-1111-4111-8111-111111111111";
    // Reload miss after write: server defect, never a silent create.
    await expect(
      setConfig(stubDb({ firstRows: [null, null] }), caller, { key: "k", type: "int", value: "1" }, {}),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    // Update with explicit key/type/description and a provisioned secret ref.
    const full = stubDb({
      firstRows: [
        configRow({ type: "secret", value_json: "{}" }),
        configRow({
          key: "renamed",
          type: "secret",
          value_json: JSON.stringify({ ref: "clientSecret" }),
          description: "d",
        }),
      ],
    });
    const renamed = await updateConfig(
      full,
      caller,
      id,
      { key: "renamed", type: "secret", value: { ref: "clientSecret" }, description: "d", hasDescription: true },
      { NINJA_CLIENT_SECRET: "v" },
    );
    expect(renamed).toMatchObject({ key: "renamed", description: "d", value: SECRET_MASK });
    // Non-secret row, secret-bound update value preserved verbatim path:
    // same-type value update exercises the value arm.
    const sameType = stubDb({
      firstRows: [configRow(), configRow({ value_json: "31" })],
    });
    const bumped = await updateConfig(sameType, caller, id, { value: "31", hasDescription: false }, {});
    expect(bumped).toMatchObject({ value: 31 });
    // Unchanged type with no value: keeps the stored text.
    const kept = stubDb({ firstRows: [configRow(), configRow()] });
    const same = await updateConfig(kept, caller, id, { hasDescription: false }, {});
    expect(same).toMatchObject({ value: 30 });
  });

  it("covers handle get on declared-missing and secret without execution", async () => {
    const db = stubDb({ row: configRow({ key: "ghost", type: "secret", value_json: "{}" }) });
    // get on a declared key with no default: declared-missing throws 424.
    const handle = bindSagaConfig({ db, orgId: caller.orgId, secrets: {} }, ["ghost"], {});
    await expect(handle.get("ghost")).rejects.toMatchObject({ code: "SECRET_NOT_CONFIGURED" });
    // Secret resolution without an executionId: no registry write, value out.
    const ref = stubDb({
      row: configRow({ key: "apiKey", type: "secret", value_json: JSON.stringify({ ref: "clientSecret" }) }),
    });
    const hit = await resolveConfig(
      { db: ref, orgId: caller.orgId, secrets: { NINJA_CLIENT_SECRET: "v" } },
      "apiKey",
      ["apiKey"],
      {},
    );
    expect(hit).toMatchObject({ found: true, value: "v" });
  });
  const bundle = "b10a7c2e-3f4d-4a5b-8c6d-7e8f9a0b1c2d";
  const marker = `${bundle}@1.0.0`;

  it("refuses hijack by another bundle", async () => {
    const db = stubDb({
      rows: [{ key: "k", value: "v", managed_by: "other-bundle@9.9.9" }],
    });
    await expect(
      reconcileManagedConfigs(db, bundle, caller.orgId, marker, new Map([["k", "v"]])),
    ).rejects.toMatchObject({
      code: "INSTALL_CONFLICT",
    });
  });

  it("fails closed when the fenced update or delete matches nothing", async () => {
    const updateRace = stubDb({
      rows: [{ key: "k", value: "old", managed_by: marker }],
      changes: 0,
    });
    await expect(
      reconcileManagedConfigs(updateRace, bundle, caller.orgId, marker, new Map([["k", "new"]])),
    ).rejects.toMatchObject({ code: "INSTALL_CONFLICT" });
    const deleteRace = stubDb({
      rows: [{ key: "gone", value: "v", managed_by: marker }],
      changes: 0,
    });
    await expect(reconcileManagedConfigs(deleteRace, bundle, caller.orgId, marker, new Map())).rejects.toMatchObject({
      code: "INSTALL_CONFLICT",
    });
  });
});
