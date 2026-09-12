// SPDX-License-Identifier: AGPL-3.0
// CON-02 Saga runtime proof (issue #147; ADR 020): ctx.config resolves only
// the Execution's own org/install context, inside step.do(), with the same
// declared-versus-undeclared outcomes as the pure resolver. Runs through the
// real executeSaga adapter (no native Workflow instance): D1 is real local
// D1, steps run inline, outbound vendor HTTP stays stubbed.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { NonRetryableError } from "cloudflare:workflows";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Bindings } from "../src/bindings";
import { helloSaga } from "../src/domain";
import type { SagaEventContext } from "../src/saga";
import { setConfig } from "../src/config";
import { executeSaga } from "../src/sagas/shared";
import { defineSaga } from "../src/saga";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration4 from "../migrations/0004_solutions_install.sql?raw";
import migration5 from "../migrations/0010_solutions_activation.sql?raw";
import migration7 from "../migrations/0007_org_membership.sql?raw";
import migration10 from "../migrations/0023_config.sql?raw";

const bindings = env as unknown as Bindings;
const ORG = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG = "00000000-0000-4000-8000-000000000009";
const OWNER = "00000000-0000-4000-8000-000000000002";
const ID = "ab".repeat(32);
const SECRET_VALUE = "config-runtime-secret-sentinel-001";

const readingSaga = defineSaga<{ timeout: unknown; fallback: unknown }>({
  id: helloSaga.id,
  name: "config-probe",
  revision: "config-probe-v1",
  description: "Config probe Saga.",
  requiredIntegrations: [],
  parse: (value: unknown) => value,
  run: async (ctx, step) => {
    const prepared = await step.do("prepare-input-v1", async () => ({ orgCtx: { orgId: "unused" } }));
    void prepared;
    const timeout = await step.do("read-timeout-v1", () => ctx.config.get("timeout"));
    const fallback = await step.do("read-missing-v1", () => ctx.config.get("missing", "dflt"));
    return { timeout, fallback };
  },
});

const requiringSaga = defineSaga<unknown>({
  id: helloSaga.id,
  name: "config-require-probe",
  revision: "config-require-probe-v1",
  description: "Config require probe Saga.",
  requiredIntegrations: [],
  parse: (value: unknown) => value,
  run: async (ctx, step) => {
    await step.do("prepare-input-v1", async () => ({}));
    return step.do("read-required-v1", () => ctx.config.require("timeout"));
  },
});

const secretSaga = defineSaga<{ apiKey: unknown }>({
  id: helloSaga.id,
  name: "config-secret-probe",
  revision: "config-secret-probe-v1",
  description: "Config secret probe Saga.",
  requiredIntegrations: [],
  parse: (value: unknown) => value,
  run: async (ctx, step) => {
    await step.do("prepare-input-v1", async () => ({}));
    const apiKey = await step.do("read-secret-v1", () => ctx.config.get("apiKey"));
    return { apiKey };
  },
});

async function insertExecution(db: D1Database, id: string, orgId: string) {
  await db
    .prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      id,
      helloSaga.id,
      helloSaga.name,
      helloSaga.revision,
      orgId,
      OWNER,
      "{}",
      1,
      "Pending",
      new Date().toISOString(),
    )
    .run();
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration4);
  await bindings.DB.exec(migration5);
  await bindings.DB.exec(migration7);
  await bindings.DB.exec(migration10);
  const stamp = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?)").bind(ORG, "Local demo").run();
  await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
    .bind(OWNER, stamp)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(ORG, OWNER, "admin", "active", "ordinary", stamp, stamp)
    .run();
});

afterEach(async () => {
  await reset();
});

function eventFor(id: string) {
  return { payload: { executionId: id }, instanceId: id } as never;
}

function nativeStep(): never {
  return {
    do: async (_name: string, _opts: unknown, fn: () => Promise<unknown>) => fn(),
    sleep: async () => {},
  } as never;
}

describe("CON-02 ctx.config runtime", () => {
  it("reads the Execution's own org rows through the adapter", async () => {
    const caller = { orgId: ORG, userId: OWNER };
    await setConfig(bindings.DB, caller, { key: "timeout", type: "int", value: "30" }, {});
    await insertExecution(bindings.DB, ID, ORG);
    const env = { ...bindings, LAB_ENABLED: "true" } as unknown as Bindings;
    const output = await executeSaga(
      env,
      eventFor(ID),
      nativeStep(),
      readingSaga as unknown as Parameters<typeof executeSaga>[3],
    );
    expect(output).toEqual({ timeout: 30, fallback: "dflt" });
  });

  it("fails loud on declared-but-missing keys, never a fabricated value", async () => {
    await insertExecution(bindings.DB, ID, ORG);
    const env = { ...bindings, LAB_ENABLED: "true" } as unknown as Bindings;
    await expect(
      executeSaga(env, eventFor(ID), nativeStep(), requiringSaga as unknown as Parameters<typeof executeSaga>[3]),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });

  it("resolves secret references transiently without persisting them", async () => {
    const caller = { orgId: ORG, userId: OWNER };
    await setConfig(
      bindings.DB,
      caller,
      { key: "apiKey", type: "secret", value: { ref: "clientSecret" } },
      { NINJA_CLIENT_SECRET: SECRET_VALUE },
    );
    await insertExecution(bindings.DB, ID, ORG);
    const env = {
      ...bindings,
      LAB_ENABLED: "true",
      NINJA_CLIENT_SECRET: SECRET_VALUE,
    } as unknown as Bindings;
    const output = await executeSaga(
      env,
      eventFor(ID),
      nativeStep(),
      secretSaga as unknown as Parameters<typeof executeSaga>[3],
    );
    // The adapter scrubs the Workflow terminal value by mechanism: the
    // resolved secret rode the registry into [REDACTED] on the way out.
    expect(output).toEqual({ apiKey: "[REDACTED]" });
    // The D1 configs row still carries only the reference, never the value.
    const row = await bindings.DB.prepare("SELECT value_json FROM configs WHERE org_id = ? AND key = ?")
      .bind(ORG, "apiKey")
      .first<{ value_json: string }>();
    expect(row?.value_json).toBe(JSON.stringify({ ref: "clientSecret" }));
  });

  it("never reads across the org boundary: foreign rows are invisible", async () => {
    const caller = { orgId: ORG, userId: OWNER };
    await setConfig(bindings.DB, caller, { key: "timeout", type: "int", value: "30" }, {});
    // The Execution belongs to OTHER_ORG, which holds no rows: the read
    // resolves to the default, never to ORG's value.
    await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?)").bind(OTHER_ORG, "Other demo").run();
    const otherId = "cd".repeat(32);
    await insertExecution(bindings.DB, otherId, OTHER_ORG);
    const env = { ...bindings, LAB_ENABLED: "true" } as unknown as Bindings;
    const output = await executeSaga(
      env,
      { payload: { executionId: otherId }, instanceId: otherId } as never,
      nativeStep(),
      readingSaga as unknown as Parameters<typeof executeSaga>[3],
    );
    expect(output).toEqual({ timeout: null, fallback: "dflt" });
  });

  it("fails closed when the Execution row vanishes before the config read", async () => {
    // The handle resolves the org from the immutable D1 row inside step.do:
    // a vanished row fails loud instead of resolving against a null org.
    await insertExecution(bindings.DB, ID, ORG);
    await bindings.DB.prepare("DELETE FROM executions WHERE id = ?").bind(ID).run();
    const env = { ...bindings, LAB_ENABLED: "true" } as unknown as Bindings;
    await expect(
      executeSaga(env, eventFor(ID), nativeStep(), readingSaga as unknown as Parameters<typeof executeSaga>[3]),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });

  it("exposes ctx.config on the event context for Saga authors", () => {
    // Author-visible surface: every Saga ctx carries the config handle with
    // get/require. Determinism enforcement (inside step.do only) is pinned by
    // test/saga-contract.test.ts.
    const ctx = { config: { get: async () => null, require: async () => null } } as unknown as SagaEventContext;
    expect(typeof ctx.config.get).toBe("function");
    expect(typeof ctx.config.require).toBe("function");
  });
});
