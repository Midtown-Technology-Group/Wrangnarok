// SPDX-License-Identifier: AGPL-3.0
// Issue #57 (Phase 1a): Saga authoring-contract gates. All run in real workerd
// via @cloudflare/vitest-plugin; only the determinism scanner and catalog
// validation are exercised here — vendor HTTP stays mocked at the Integration
// boundary in the execution tests, and D1/Workflow bindings are never replaced.
import { describe, expect, it } from "vitest";
import {
  assertDeterministicRun,
  assertJsonSerializable,
  buildCatalog,
  defineSaga,
  stripStepDoBodies,
} from "../src/saga";
import type { SagaEventContext, SagaStep } from "../src/saga";
import { SAGA_CATALOG, SAGA_DEFINITIONS } from "../src/sagas";
import {
  BODY_LIMIT,
  ECHO_INTEGRATION_ID,
  digestSaga,
  helloSaga,
  echoSaga,
  NINJA_INTEGRATION_ID,
  ninjaSaga,
  parseDigestInput,
  parseHelloInput,
  parseInput,
  parseNinjaOrgsInput,
  parseSmokeInput,
  smokeSaga,
} from "../src/domain";
import manifest from "../sagas.manifest.json";

const CHURN_MESSAGE =
  "Stable Saga identity churn detected. Changing a stable id creates a DIFFERENT Saga " +
  "(Triggers, history, and API callers break silently). If this change is deliberate, update " +
  "sagas.manifest.json in the same PR with justification per ADR 002; if it is accidental, " +
  "restore the previous stable id.";

describe("Saga authoring contract (issue #57)", () => {
  it("keeps all I/O and nondeterminism inside step.do() for every registered Saga", () => {
    expect(SAGA_DEFINITIONS).toHaveLength(5);
    for (const def of SAGA_DEFINITIONS) {
      expect(() => assertDeterministicRun(def.name, def.run)).not.toThrow();
    }
  });

  it("fails run bodies that leak effects past step.do()", () => {
    async function topLevelFetch(_ctx: SagaEventContext, step: SagaStep): Promise<unknown> {
      await fetch("http://127.0.0.1:9/unused");
      return step.do("probe-v1", async () => ({ ok: true }));
    }
    async function topLevelClock(_ctx: SagaEventContext, step: SagaStep): Promise<unknown> {
      const started = Date.now();
      return step.do("probe-v1", async () => ({ started }));
    }
    async function topLevelRandom(_ctx: SagaEventContext, step: SagaStep): Promise<unknown> {
      const salt = Math.random();
      return step.do("probe-v1", async () => ({ salt }));
    }
    async function topLevelIntegrations(ctx: SagaEventContext, step: SagaStep): Promise<unknown> {
      const integrations = ctx.integrations;
      return step.do("probe-v1", async () => ({ ready: Boolean(integrations) }));
    }
    async function topLevelDb(ctx: SagaEventContext, step: SagaStep): Promise<unknown> {
      const tables = await ctx.db.prepare("SELECT name FROM sqlite_master").all();
      return step.do("probe-v1", async () => ({ tables: tables.results.length }));
    }
    async function topLevelConfig(ctx: SagaEventContext, step: SagaStep): Promise<unknown> {
      const timeout = await ctx.config.get("timeout");
      return step.do("probe-v1", async () => ({ timeout }));
    }
    async function noDurableSteps(): Promise<unknown> {
      return { ok: true };
    }
    expect(() => assertDeterministicRun("bad-fetch", topLevelFetch)).toThrow(/fetch.*outside step\.do/);
    expect(() => assertDeterministicRun("bad-clock", topLevelClock)).toThrow(/Date\.now.*outside step\.do/);
    expect(() => assertDeterministicRun("bad-random", topLevelRandom)).toThrow(/Math\.random.*outside step\.do/);
    expect(() => assertDeterministicRun("bad-integrations", topLevelIntegrations)).toThrow(
      /ctx\.integrations.*outside step\.do/,
    );
    expect(() => assertDeterministicRun("bad-db", topLevelDb)).toThrow(/ctx\.db.*outside step\.do/);
    expect(() => assertDeterministicRun("bad-config", topLevelConfig)).toThrow(/ctx\.config.*outside step\.do/);
    expect(() => assertDeterministicRun("bad-nosteps", noDurableSteps)).toThrow(/never calls step\.do/);
  });

  it("strips nested step.do() bodies without confusing strings, comments, or templates", () => {
    const source = [
      'const probe = await step.do("probe-v1", async () => {',
      '  // step.do("not-a-call", async () => {}) in a comment',
      '  const label = ".do(also-not-a-call)";',
      "  const text = `template ${JSON.stringify({ nested: [1, (2)] })} tail`;",
      '  returnfn(format("a(b)", /re(/));',
      "});",
      "const after = 1;",
    ].join("\n");
    const stripped = stripStepDoBodies(source);
    expect(stripped).toContain(".do()");
    expect(stripped).toContain("const after = 1;");
    expect(stripped).not.toContain("JSON.stringify");
    // A caller outside any step still shows up after stripping.
    expect(stripStepDoBodies('await fetch(url);\nawait step.do("x-v1", async () => 1);')).toMatch(/fetch/);
    // Division is not a regex literal: the expression must survive stripping.
    expect(stripStepDoBodies('const ratio = total / count;\nawait step.do("x-v1", async () => ratio);')).toMatch(
      /total \/ count/,
    );
  });

  it("round-trips every Saga input/output through JSON within the persisted bound", () => {
    const samples: Record<string, { input: unknown; output: unknown }> = {
      echo: { input: { message: "hello" }, output: { message: "hello" } },
      hello: {
        input: { name: "Ada" },
        output: { greeting: "Hello, Ada!", name: "Ada" },
      },
      "ninjaone-orgs": {
        input: {},
        output: { organizationCount: 1, organizations: [{ id: 7, name: "Acme" }] },
      },
      "ninjaone-echo-digest": {
        input: {},
        output: { organizationCount: 1, echoed: { message: "NinjaOne organizations (1 total): Acme" } },
      },
      "system.smoke": {
        input: {},
        output: {
          d1WriteOk: true,
          d1ReadOk: true,
          operationCount: 3,
          operations: ["prepare-input-v1", "smoke-write-v1", "smoke-verify-v1"],
        },
      },
    };
    for (const def of SAGA_DEFINITIONS) {
      const sample = samples[def.name];
      if (!sample) throw new Error(`missing JSON sample for Saga "${def.name}"`);
      const roundTripped = JSON.parse(JSON.stringify(sample.input));
      expect(roundTripped).toEqual(sample.input);
      expect(def.parse(roundTripped)).toEqual(def.parse(sample.input));
      assertJsonSerializable(sample.output, `${def.name} output`);
      expect(JSON.parse(JSON.stringify(sample.output))).toEqual(sample.output);
      expect(new TextEncoder().encode(JSON.stringify(sample.output)).length).toBeLessThanOrEqual(BODY_LIMIT);
    }
  });

  it("rejects non-JSON values before they can reach Workflow replay or D1", () => {
    expect(() => assertJsonSerializable({ run: () => 1 })).toThrow(/function/);
    expect(() => assertJsonSerializable({ missing: undefined })).toThrow(/undefined/);
    expect(() => assertJsonSerializable({ values: new Map([["a", 1]]) })).toThrow(/plain objects/);
    expect(() => assertJsonSerializable(Number.NaN)).toThrow(/non-finite/);
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(() => assertJsonSerializable(circular)).toThrow(/circular/);
    expect(() => assertJsonSerializable({ ok: true, nested: [1, "two", null] })).not.toThrow();
  });

  it("treats duplicate stable IDs or names as fatal catalog errors", () => {
    const probe = defineSaga({
      id: "aaaaaaaa-1111-4111-8111-111111111111",
      name: "probe",
      revision: "probe-v1",
      description: "Contract probe Saga.",
      requiredIntegrations: [],
      parse: (value: unknown) => value,
      run: async (_ctx: SagaEventContext, step: SagaStep): Promise<number> => step.do("probe-v1", async () => 1),
    });
    expect(() => buildCatalog([])).toThrow(/no Sagas/);
    expect(() => buildCatalog([probe, { ...probe, name: "probe-two" }])).toThrow(/duplicate stable Saga ID/);
    expect(() => buildCatalog([probe, { ...probe, id: "bbbbbbbb-2222-4222-8222-222222222222" }])).toThrow(
      /duplicate Saga name/,
    );
    expect(() => buildCatalog([probe, probe])).toThrow(/duplicate stable Saga ID/);
  });

  it("rejects operational policy and malformed identity in Saga source", () => {
    const base = {
      id: "aaaaaaaa-1111-4111-8111-111111111111",
      name: "probe",
      revision: "probe-v1",
      description: "Contract probe Saga.",
      requiredIntegrations: [],
      parse: (value: unknown) => value,
      run: async (_ctx: SagaEventContext, step: SagaStep): Promise<number> => step.do("probe-v1", async () => 1),
    };
    expect(() => defineSaga({ ...base, id: "not-a-uuid" })).toThrow(/stable UUID/);
    expect(() => defineSaga({ ...base, description: "" })).toThrow(/description/);
    expect(() => defineSaga({ ...base, requiredIntegrations: undefined as never })).toThrow(/requiredIntegrations/);
    expect(() => defineSaga({ ...base, requiredIntegrations: ["not-a-uuid"] })).toThrow(/requiredIntegrations/);
    for (const policy of [{ retries: 2 }, { timeout: "10 seconds" }, { schedule: "* * * * *" }]) {
      expect(() => buildCatalog([defineSaga({ ...base, ...policy })])).toThrow(/operational policy/);
    }
  });

  it("declares required Integrations explicitly on every registered Saga", () => {
    // ADR 010 section 3: declared-but-missing fails loud (424), undeclared
    // access resolves to None. The declaration is mandatory source metadata.
    const byName = new Map(SAGA_DEFINITIONS.map((def) => [def.name, def]));
    expect(byName.get("echo")?.requiredIntegrations).toEqual([ECHO_INTEGRATION_ID]);
    expect(byName.get("ninjaone-orgs")?.requiredIntegrations).toEqual([NINJA_INTEGRATION_ID]);
    expect(byName.get("ninjaone-echo-digest")?.requiredIntegrations).toEqual([
      NINJA_INTEGRATION_ID,
      ECHO_INTEGRATION_ID,
    ]);
    expect(byName.get("system.smoke")?.requiredIntegrations).toEqual([]);
    expect(byName.get("hello")?.requiredIntegrations).toEqual([]);
    for (const def of SAGA_DEFINITIONS) {
      expect(Array.isArray(def.requiredIntegrations)).toBe(true);
    }
    // Knob boundary (ADR 010 section 4): timeouts, retries, schedules, and
    // other runtime policy must never live in Saga source — only the
    // stepRetryLimit code table and platform adapter may carry them.
    for (const def of SAGA_DEFINITIONS) {
      for (const key of [
        "timeout",
        "timeouts",
        "retry",
        "retries",
        "schedule",
        "schedules",
        "cron",
        "endpoint",
        "endpoints",
        "access",
        "rateLimit",
        "cache",
        "ttl",
        "concurrency",
        "backoff",
      ]) {
        expect(def, `Saga "${def.name}" carries persisted-policy key "${key}"`).not.toHaveProperty(key);
      }
    }
  });

  it("keeps definitions, domain constants, catalog, and manifest in agreement", () => {
    const byName = new Map(SAGA_DEFINITIONS.map((def) => [def.name, def]));
    expect([...byName.keys()].sort()).toEqual([
      "echo",
      "hello",
      "ninjaone-echo-digest",
      "ninjaone-orgs",
      "system.smoke",
    ]);
    const expected = [
      { stable: echoSaga, parse: parseInput },
      { stable: ninjaSaga, parse: parseNinjaOrgsInput },
      { stable: digestSaga, parse: parseDigestInput },
      { stable: smokeSaga, parse: parseSmokeInput },
      { stable: helloSaga, parse: parseHelloInput },
    ];
    for (const { stable, parse } of expected) {
      const def = byName.get(stable.name);
      expect(def, `missing Saga definition for "${stable.name}"`).toBeDefined();
      expect(def?.id).toBe(stable.id);
      expect(def?.revision).toBe(stable.revision);
      expect(def?.description).toBe(stable.description);
      expect(def?.parse).toBe(parse);
    }
    // Catalog metadata minimum: stable UUID id, name, description, declared
    // requirements, plus the optional discovery metadata. No operational
    // policy ever appears here.
    for (const entry of SAGA_CATALOG) {
      expect(entry.id).toMatch(/^[a-f0-9-]{36}$/i);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.tags?.length).toBeGreaterThan(0);
      expect(entry.requiredIntegrations).toEqual(byName.get(entry.name)?.requiredIntegrations);
      expect(entry.inputSchema?.type).toBe("object");
      expect(entry.outputSchema?.type).toBe("object");
      expect(entry).not.toHaveProperty("retries");
      expect(entry).not.toHaveProperty("timeout");
      expect(entry).not.toHaveProperty("parse");
      expect(entry).not.toHaveProperty("run");
    }
    // Churn/rename detection: the checked-in manifest must match the catalog
    // exactly. Any unexpected diff fails loudly (see CHURN_MESSAGE).
    expect(manifest.sagas, CHURN_MESSAGE).toHaveLength(SAGA_CATALOG.length);
    for (const snap of manifest.sagas) {
      const entry = SAGA_CATALOG.find((candidate) => candidate.id === snap.id);
      expect(entry, `${CHURN_MESSAGE} Missing stable ID ${snap.id} ("${snap.name}").`).toBeDefined();
      expect(entry?.name, CHURN_MESSAGE).toBe(snap.name);
      expect(entry?.revision, CHURN_MESSAGE).toBe(snap.revision);
    }
    for (const entry of SAGA_CATALOG) {
      expect(
        manifest.sagas.some((snap) => snap.id === entry.id),
        `${CHURN_MESSAGE} Unregistered stable ID ${entry.id} ("${entry.name}").`,
      ).toBe(true);
    }
  });
});
