// SPDX-License-Identifier: AGPL-3.0
// Integration vs Connection split (ADR 003): the registry holds portable
// provider definitions (schema, defaults, required-secret names, health);
// per-Organization state never appears here.
// Pure unit tests — no D1, no Workflow bindings.
import { describe, expect, it } from "vitest";
import {
  defineIntegration,
  echoIntegrationDef,
  INTEGRATION_DEFINITIONS,
  integrationById,
  integrationByName,
  isInternalLiteralHost,
  isLoopbackHost,
  ninjaIntegrationDef,
  validateConnectionConfig,
} from "../src/integrations";
import { ECHO_INTEGRATION_ID, NINJA_INTEGRATION_ID } from "../src/domain";

const BASE = {
  id: "aaaaaaaa-1111-4111-8111-111111111111",
  name: "probe",
  description: "Contract probe Integration.",
  secretFields: [] as string[],
  configSchema: [{ name: "endpoint", type: "string" as const, required: true, description: "Probe endpoint." }],
  requiredSecrets: [] as string[],
  secretEnvVars: {},
  health: { testHint: "Probe the endpoint.", remediation: "Check the endpoint and retry." },
};

describe("Integration registry (ADR 003)", () => {
  it("registers the built-in Integrations with stable identity", () => {
    expect(INTEGRATION_DEFINITIONS).toHaveLength(3);
    expect(echoIntegrationDef).toMatchObject({ id: ECHO_INTEGRATION_ID, name: "echo", secretFields: [] });
    expect(ninjaIntegrationDef).toMatchObject({
      id: NINJA_INTEGRATION_ID,
      name: "ninjaone",
      secretFields: ["clientSecret"],
    });
    expect(integrationById(ECHO_INTEGRATION_ID)).toBe(echoIntegrationDef);
    expect(integrationById(NINJA_INTEGRATION_ID)).toBe(ninjaIntegrationDef);
    expect(integrationById("00000000-0000-4000-8000-000000000000")).toBeUndefined();
    expect(integrationByName("echo")).toBe(echoIntegrationDef);
    expect(integrationByName("NINJAONE")).toBe(ninjaIntegrationDef);
    expect(integrationByName("ghost")).toBeUndefined();
  });
  it("declares schema, defaults, required secrets, and health per Integration", () => {
    expect(echoIntegrationDef.configSchema).toMatchObject([{ name: "endpoint", required: true }]);
    expect(echoIntegrationDef.requiredSecrets).toEqual([]);
    expect(ninjaIntegrationDef.requiredSecrets).toEqual(["clientSecret"]);
    expect(ninjaIntegrationDef.secretEnvVars).toMatchObject({ clientSecret: "NINJA_CLIENT_SECRET" });
    for (const entry of INTEGRATION_DEFINITIONS) {
      expect(entry.health.testHint.length).toBeGreaterThan(0);
      expect(entry.health.remediation.length).toBeGreaterThan(0);
      expect(entry.configSchema.some((field) => field.name === "endpoint")).toBe(true);
    }
  });
  it("keeps stable IDs and names unique and frozen", () => {
    const ids = INTEGRATION_DEFINITIONS.map((entry) => entry.id);
    const names = INTEGRATION_DEFINITIONS.map((entry) => entry.name);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
    expect(Object.isFrozen(INTEGRATION_DEFINITIONS)).toBe(true);
    for (const entry of INTEGRATION_DEFINITIONS) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.secretFields)).toBe(true);
      expect(Object.isFrozen(entry.configSchema)).toBe(true);
      expect(Object.isFrozen(entry.requiredSecrets)).toBe(true);
    }
  });
  it("rejects malformed Integration definitions", () => {
    expect(() => defineIntegration({ ...BASE, id: "not-a-uuid" })).toThrow(/stable UUID/);
    expect(() => defineIntegration({ ...BASE, name: "Not A Slug!" })).toThrow(/slug/);
    expect(() => defineIntegration({ ...BASE, description: "" })).toThrow(/description/);
    expect(() => defineIntegration({ ...BASE, secretFields: "clientSecret" as never })).toThrow(/secretFields/);
    expect(() => defineIntegration({ ...BASE, secretFields: ["a", "a"] })).toThrow(/unique/);
    expect(() => defineIntegration({ ...BASE, secretFields: [""] })).toThrow(/secretFields/);
    expect(() => defineIntegration({ ...BASE, configSchema: [] })).toThrow(/configSchema/);
    expect(() => defineIntegration({ ...BASE, configSchema: "endpoint" as never })).toThrow(/configSchema/);
    expect(() =>
      defineIntegration({
        ...BASE,
        configSchema: [{ name: "clientSecret", type: "string" as const, required: false, description: "Leak." }],
      }),
    ).toThrow(/secret/);
    // Every configSchema field arm: non-object entry, bad name, duplicate,
    // non-string type, non-boolean required, bad default, bad maxLength, bad
    // description, and a schema with no endpoint.
    const field = { name: "endpoint", type: "string" as const, required: true, description: "Probe endpoint." };
    expect(() => defineIntegration({ ...BASE, configSchema: [null as never] })).toThrow(/object/);
    expect(() => defineIntegration({ ...BASE, configSchema: [{ ...field, name: "9bad" }] })).toThrow(/1-64/);
    expect(() => defineIntegration({ ...BASE, configSchema: [field, { ...field, description: "Again." }] })).toThrow(
      /duplicate/,
    );
    expect(() => defineIntegration({ ...BASE, configSchema: [{ ...field, type: "number" as never }] })).toThrow(/type/);
    expect(() => defineIntegration({ ...BASE, configSchema: [{ ...field, required: "yes" as never }] })).toThrow(
      /required/,
    );
    expect(() => defineIntegration({ ...BASE, configSchema: [{ ...field, default: "" }] })).toThrow(/default/);
    expect(() =>
      defineIntegration({
        ...BASE,
        secretFields: ["clientSecret"],
        configSchema: [{ ...field, default: "hunter2-client-secret" }],
      }),
    ).toThrow(/credential/);
    expect(() => defineIntegration({ ...BASE, configSchema: [{ ...field, maxLength: 0 }] })).toThrow(/maxLength/);
    expect(() => defineIntegration({ ...BASE, configSchema: [{ ...field, description: "" }] })).toThrow(/description/);
    expect(() =>
      defineIntegration({
        ...BASE,
        configSchema: [{ name: "label", type: "string" as const, required: false, description: "Label." }],
      }),
    ).toThrow(/endpoint/);
    // Required-secret and env-var arms: non-list, unknown secret name,
    // non-object map, and a bad env var name.
    expect(() => defineIntegration({ ...BASE, requiredSecrets: "clientSecret" as never })).toThrow(/requiredSecrets/);
    expect(() => defineIntegration({ ...BASE, requiredSecrets: [""] })).toThrow(/requiredSecrets/);
    expect(() => defineIntegration({ ...BASE, secretFields: ["clientSecret"], requiredSecrets: ["ghost"] })).toThrow(
      /secretFields/,
    );
    expect(() => defineIntegration({ ...BASE, secretEnvVars: [] as never })).toThrow(/secretEnvVars/);
    expect(() => defineIntegration({ ...BASE, secretEnvVars: null as never })).toThrow(/secretEnvVars/);
    expect(() =>
      defineIntegration({
        ...BASE,
        secretFields: ["clientSecret"],
        requiredSecrets: ["clientSecret"],
        secretEnvVars: {},
      }),
    ).toThrow(/env var/);
    expect(() =>
      defineIntegration({
        ...BASE,
        secretFields: ["clientSecret"],
        requiredSecrets: ["clientSecret"],
        secretEnvVars: { clientSecret: "lowercase" },
      }),
    ).toThrow(/env var/);
    // Health arms: null, non-string and overlong testHint/remediation.
    expect(() => defineIntegration({ ...BASE, health: { testHint: "", remediation: "" } })).toThrow(/health/);
    expect(() => defineIntegration({ ...BASE, health: null as never })).toThrow(/health/);
    expect(() => defineIntegration({ ...BASE, health: { testHint: "x".repeat(281), remediation: "ok" } })).toThrow(
      /health/,
    );
    expect(() => defineIntegration({ ...BASE, health: { testHint: "ok", remediation: "x".repeat(281) } })).toThrow(
      /health/,
    );
    // A valid probe definition passes and freezes every list.
    const probe = defineIntegration({
      ...BASE,
      secretFields: ["clientSecret"],
      configSchema: [
        field,
        { name: "label", type: "string" as const, required: false, default: "main", description: "Label." },
      ],
      requiredSecrets: ["clientSecret"],
      secretEnvVars: { clientSecret: "PROBE_SECRET" },
    });
    expect(probe.requiredSecrets).toEqual(["clientSecret"]);
    expect(Object.isFrozen(probe.configSchema)).toBe(true);
    expect(Object.isFrozen(probe.requiredSecrets)).toBe(true);
    expect(Object.isFrozen(probe.secretEnvVars)).toBe(true);
    expect(Object.isFrozen(probe.health)).toBe(true);
  });
});

describe("Connection config validation (CON-01)", () => {
  it("applies the echo default endpoint when omitted", () => {
    expect(validateConnectionConfig(echoIntegrationDef, {})).toMatchObject({
      endpoint: "http://127.0.0.1:8788/echo",
    });
  });
  it("rejects unknown fields, missing required, and credential-shaped keys", () => {
    expect(() => validateConnectionConfig(echoIntegrationDef, { endpoint: "https://x.test", token: "abc" })).toThrow(
      expect.objectContaining({ code: "CONNECTION_SCHEMA_INVALID" }),
    );
    try {
      validateConnectionConfig(ninjaIntegrationDef, {});
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "CONNECTION_SCHEMA_INVALID" });
    }
    try {
      validateConnectionConfig(echoIntegrationDef, { endpoint: "https://x.test", apiKey: "hunter2" });
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "CONNECTION_SCHEMA_INVALID" });
    }
  });
  it("covers every config validation arm", () => {
    // Non-object bodies fail through the NOT_OBJECT arm.
    for (const body of [null, [], "endpoint", 42]) {
      try {
        validateConnectionConfig(echoIntegrationDef, body);
        expect.unreachable();
      } catch (error) {
        expect(error).toMatchObject({ code: "CONNECTION_SCHEMA_INVALID" });
      }
    }
    // Non-string and empty values fail through INVALID_TYPE.
    for (const endpoint of [42, "", null]) {
      try {
        validateConnectionConfig(echoIntegrationDef, { endpoint });
        expect.unreachable();
      } catch (error) {
        expect(error).toMatchObject({ code: "CONNECTION_SCHEMA_INVALID" });
      }
    }
    // Overlong values fail through TOO_LONG.
    try {
      validateConnectionConfig(echoIntegrationDef, { endpoint: `https://x.test/${"y".repeat(512)}` });
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "CONNECTION_SCHEMA_INVALID" });
    }
    // Credential-shaped non-endpoint values fail through CREDENTIAL_LIKE_VALUE.
    try {
      validateConnectionConfig(ninjaIntegrationDef, {
        endpoint: "https://us2.ninjarmm.com/api",
        clientIdLabel: "hunter2-client-secret",
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "CONNECTION_SCHEMA_INVALID" });
    }
    // Optional fields without defaults resolve absent; with values they pass.
    expect(validateConnectionConfig(ninjaIntegrationDef, { endpoint: "https://us2.ninjarmm.com/api" })).toEqual({
      endpoint: "https://us2.ninjarmm.com/api",
    });
    expect(
      validateConnectionConfig(ninjaIntegrationDef, {
        endpoint: "https://us2.ninjarmm.com/api",
        clientIdLabel: "primary",
      }),
    ).toEqual({ endpoint: "https://us2.ninjarmm.com/api", clientIdLabel: "primary" });
  });

  it("gates the echo default endpoint by deployment environment (issue #239)", () => {
    // Local keeps the loopback fixture default, explicit or omitted. Main's
    // #236 policy owns URL safety; this gate owns which environments may
    // inherit the default.
    expect(validateConnectionConfig(echoIntegrationDef, {})).toMatchObject({
      endpoint: "http://127.0.0.1:8788/echo",
    });
    expect(
      validateConnectionConfig(
        echoIntegrationDef,
        { endpoint: "http://127.0.0.1:8788/echo" },
        { environment: "local" },
      ),
    ).toMatchObject({ endpoint: "http://127.0.0.1:8788/echo" });
    // Non-local deployments fail closed without an explicit endpoint: the
    // loopback default must never silently follow code to dev/preview.
    for (const environment of ["dev", "preview", "production"]) {
      try {
        validateConnectionConfig(echoIntegrationDef, {}, { environment });
        expect.unreachable();
      } catch (error) {
        expect(error).toMatchObject({ code: "CONNECTION_SCHEMA_INVALID" });
        expect(JSON.stringify((error as { details?: unknown }).details)).toContain("explicit endpoint");
      }
      // An explicit loopback URL is rejected outside local too.
      try {
        validateConnectionConfig(echoIntegrationDef, { endpoint: "http://127.0.0.1:8788/echo" }, { environment });
        expect.unreachable();
      } catch (error) {
        expect(error).toMatchObject({ code: "CONNECTION_SCHEMA_INVALID" });
        expect(JSON.stringify((error as { details?: unknown }).details)).toContain("LOCAL_ENDPOINT_NOT_ALLOWED");
      }
    }
  });
  it("rejects endpoint values that are not safe URLs for the Integration (issue #236)", () => {
    const detailsOf = (run: () => unknown): { field: string; code: string }[] => {
      try {
        run();
        expect.unreachable();
      } catch (error) {
        expect(error).toMatchObject({ code: "CONNECTION_SCHEMA_INVALID" });
        return (error as { details: { field: string; code: string }[] }).details;
      }
    };
    // Malformed and non-web schemes fail closed on both Integrations.
    for (const endpoint of ["not-a-url", "ftp://files.example.com/x", "file:///etc/passwd"]) {
      expect(detailsOf(() => validateConnectionConfig(echoIntegrationDef, { endpoint }))?.[0]).toMatchObject({
        field: "endpoint",
      });
      expect(detailsOf(() => validateConnectionConfig(ninjaIntegrationDef, { endpoint }))?.[0]).toMatchObject({
        field: "endpoint",
      });
    }
    expect(detailsOf(() => validateConnectionConfig(echoIntegrationDef, { endpoint: "not-a-url" }))?.[0]).toMatchObject(
      { field: "endpoint", code: "INVALID_URL" },
    );
    expect(
      detailsOf(() => validateConnectionConfig(ninjaIntegrationDef, { endpoint: "ftp://files.example.com/x" }))?.[0],
    ).toMatchObject({ field: "endpoint", code: "INVALID_SCHEME" });
    // Credential-bearing URLs are never persistable.
    expect(
      detailsOf(() =>
        validateConnectionConfig(ninjaIntegrationDef, { endpoint: "https://user:pass@us2.ninjarmm.com/api" }),
      )?.[0],
    ).toMatchObject({ field: "endpoint", code: "ENDPOINT_NOT_ALLOWED" });
    // Internal/literal targets are never persistable on either Integration.
    for (const endpoint of ["http://10.1.2.3/echo", "http://192.168.1.10/api", "http://[fe80::1]/echo"]) {
      expect(detailsOf(() => validateConnectionConfig(echoIntegrationDef, { endpoint }))?.[0]).toMatchObject({
        field: "endpoint",
        code: "ENDPOINT_NOT_ALLOWED",
      });
    }
    expect(
      detailsOf(() => validateConnectionConfig(ninjaIntegrationDef, { endpoint: "http://10.1.2.3/api" }))?.[0],
    ).toMatchObject({ field: "endpoint", code: "ENDPOINT_NOT_ALLOWED" });
    // Echo stays loopback-only over http: public hosts fail, as does https loopback.
    expect(
      detailsOf(() => validateConnectionConfig(echoIntegrationDef, { endpoint: "https://example.com/echo" }))?.[0],
    ).toMatchObject({ field: "endpoint", code: "ENDPOINT_NOT_ALLOWED" });
    expect(
      detailsOf(() => validateConnectionConfig(echoIntegrationDef, { endpoint: "http://example.com/echo" }))?.[0],
    ).toMatchObject({ field: "endpoint", code: "ENDPOINT_NOT_ALLOWED" });
    for (const endpoint of ["https://127.0.0.1:8788/echo"]) {
      expect(detailsOf(() => validateConnectionConfig(echoIntegrationDef, { endpoint }))?.[0]).toMatchObject({
        field: "endpoint",
        code: "INVALID_SCHEME",
      });
    }
    // NinjaOne needs https under the vendor or test suffixes: loopback, plain
    // http, and foreign public hosts all fail.
    expect(
      detailsOf(() => validateConnectionConfig(ninjaIntegrationDef, { endpoint: "http://127.0.0.1:8788/echo" }))?.[0],
    ).toMatchObject({ field: "endpoint", code: "ENDPOINT_NOT_ALLOWED" });
    expect(
      detailsOf(() => validateConnectionConfig(ninjaIntegrationDef, { endpoint: "http://us2.ninjarmm.com/api" }))?.[0],
    ).toMatchObject({ field: "endpoint", code: "INVALID_SCHEME" });
    expect(
      detailsOf(() => validateConnectionConfig(ninjaIntegrationDef, { endpoint: "https://evil.example.com/api" }))?.[0],
    ).toMatchObject({ field: "endpoint", code: "ENDPOINT_NOT_ALLOWED" });
    // Safe values still pass: the echo fixture default plus loopback variants,
    // https vendor regions, and the never-routable .invalid test seam.
    expect(validateConnectionConfig(echoIntegrationDef, { endpoint: "http://localhost:8788/echo" })).toEqual({
      endpoint: "http://localhost:8788/echo",
    });
    expect(validateConnectionConfig(echoIntegrationDef, { endpoint: "http://[::1]:8788/echo" })).toEqual({
      endpoint: "http://[::1]:8788/echo",
    });
    expect(validateConnectionConfig(ninjaIntegrationDef, { endpoint: "https://eu.ninjarmm.com/api" })).toEqual({
      endpoint: "https://eu.ninjarmm.com/api",
    });
    expect(validateConnectionConfig(ninjaIntegrationDef, { endpoint: "https://probe.ninja.invalid/api" })).toEqual({
      endpoint: "https://probe.ninja.invalid/api",
    });
    // The echo default is a safe fixture URL; a probe Integration whose default
    // is unsafe fails closed through the same per-field channel.
    expect(validateConnectionConfig(echoIntegrationDef, {})).toMatchObject({
      endpoint: "http://127.0.0.1:8788/echo",
    });
    const unsafeDefault = defineIntegration({
      id: "bbbbbbbb-2222-4222-8222-222222222222",
      name: "unsafedefault",
      description: "Probe with an unsafe endpoint default.",
      secretFields: [],
      configSchema: [
        {
          name: "endpoint",
          type: "string" as const,
          required: true,
          default: "http://10.9.9.9/api",
          description: "Unsafe default.",
        },
      ],
      requiredSecrets: [],
      secretEnvVars: {},
      health: { testHint: "Probe.", remediation: "Fix the default." },
    });
    expect(detailsOf(() => validateConnectionConfig(unsafeDefault, {}))?.[0]).toMatchObject({
      field: "endpoint",
      code: "ENDPOINT_NOT_ALLOWED",
    });
  });

  it("classifies loopback and internal literal hosts (issue #236)", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("example.com")).toBe(false);
    expect(isInternalLiteralHost("127.0.0.1")).toBe(true);
    expect(isInternalLiteralHost("10.0.0.9")).toBe(true);
    expect(isInternalLiteralHost("172.16.4.2")).toBe(true);
    expect(isInternalLiteralHost("172.15.0.1")).toBe(false);
    expect(isInternalLiteralHost("192.168.0.1")).toBe(true);
    expect(isInternalLiteralHost("169.254.9.9")).toBe(true);
    expect(isInternalLiteralHost("0.0.0.0")).toBe(true);
    expect(isInternalLiteralHost("8.8.8.8")).toBe(false);
    expect(isInternalLiteralHost("999.1.1.1")).toBe(false);
    expect(isInternalLiteralHost("::1")).toBe(true);
    expect(isInternalLiteralHost("[::1]")).toBe(true);
    expect(isInternalLiteralHost("::")).toBe(true);
    expect(isInternalLiteralHost("fe80::1")).toBe(true);
    expect(isInternalLiteralHost("fc00::1")).toBe(true);
    expect(isInternalLiteralHost("fd00::1")).toBe(true);
    expect(isInternalLiteralHost("2001:db8::1")).toBe(false);
    expect(isInternalLiteralHost("example.com")).toBe(false);
  });
});
