// SPDX-License-Identifier: AGPL-3.0
// Issue #57: module-evaluation-order regression. A leaf Saga module is a
// valid consumer shape (tests, tooling, future SDK/build-time consumers), so
// importing e.g. src/sagas/onboarding.ts before the Worker entry must still
// yield the startup-validated static catalog ADR 002 promises — never a
// partially initialized list. This file keeps that order on purpose: the
// leaf import below evaluates before the definitions list, the barrel, and
// the Worker entry. Each test file runs in its own isolate, so no earlier
// import order can mask a cycle here.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { onboardingSagaDef } from "../src/sagas/onboarding";
import { SAGA_DEFINITIONS } from "../src/sagas/definitions";
import { SAGA_CATALOG } from "../src/sagas";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { resolveChildSaga } from "../src/children";
import {
  cloudflareInventorySaga,
  cloudflareVerifySaga,
  digestSaga,
  echoSaga,
  helloParentSaga,
  helloSaga,
  ninjaSaga,
  onboardingSaga,
  smokeSaga,
} from "../src/domain";
import manifest from "../sagas.manifest.json";

const bindings = env as unknown as Bindings;
const auth = { Authorization: `Bearer ${"a".repeat(64)}` };

// Canonical registration order: the assembled list must read the same no
// matter which module evaluates first.
const CANONICAL_NAMES = [
  "echo",
  "ninjaone-orgs",
  "ninjaone-echo-digest",
  "system.smoke",
  "hello",
  "hello-parent",
  "cloudflare-verify-connection",
  "cloudflare-inventory-zones",
  "employee-onboarding",
];
const STABLE = [
  echoSaga,
  ninjaSaga,
  digestSaga,
  smokeSaga,
  helloSaga,
  helloParentSaga,
  cloudflareVerifySaga,
  cloudflareInventorySaga,
  onboardingSaga,
];

describe("saga module init order (issue #57)", () => {
  it("serves every registered Saga when a leaf module is imported first", () => {
    expect(SAGA_DEFINITIONS.map((def) => def.name)).toEqual(CANONICAL_NAMES);
    for (const stable of STABLE) {
      const def = SAGA_DEFINITIONS.find((candidate) => candidate.name === stable.name);
      expect(def, `missing Saga definition for "${stable.name}"`).toBeDefined();
      expect(def?.id).toBe(stable.id);
      expect(def?.revision).toBe(stable.revision);
      expect(typeof def?.parse).toBe("function");
      expect(typeof def?.run).toBe("function");
      expect(Array.isArray(def?.requiredIntegrations)).toBe(true);
    }
    // The leaf imported first is the identical registered object, not a copy.
    expect(SAGA_DEFINITIONS.find((def) => def.name === onboardingSaga.name)).toBe(onboardingSagaDef);
  });

  it("resolves every child reference through the runtime child-catalog shape", () => {
    // Same shape executeSaga installs on ctx.children: { sagas: <list> }.
    const catalog = { sagas: SAGA_DEFINITIONS };
    for (const def of SAGA_DEFINITIONS) {
      expect(resolveChildSaga(catalog, def.name)).toBe(def);
      expect(resolveChildSaga(catalog, def.id)).toBe(def);
      expect(resolveChildSaga(catalog, def.id.toUpperCase())).toBe(def);
    }
    try {
      resolveChildSaga(catalog, "no-such-saga");
      throw new Error("expected CHILD_SAGA_NOT_FOUND");
    } catch (error) {
      expect(error).toMatchObject({ code: "CHILD_SAGA_NOT_FOUND" });
    }
  });

  it("serves identical contents via the barrel catalog and the Worker route", async () => {
    const byId = new Map(SAGA_DEFINITIONS.map((def) => [def.id, def]));
    expect(SAGA_CATALOG).toHaveLength(SAGA_DEFINITIONS.length);
    for (const entry of SAGA_CATALOG) {
      const def = byId.get(entry.id);
      expect(def, `catalog entry ${entry.id} has no definition`).toBeDefined();
      expect(entry.name).toBe(def?.name);
      expect(entry.revision).toBe(def?.revision);
    }
    expect(manifest.sagas.map((snap) => snap.id).sort()).toEqual(
      [...byId.keys()].sort(),
    );
    const response = await worker.fetch(new Request("https://local.test/api/sagas", { headers: auth }), bindings);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { sagas: { id: string; name: string; revision: string }[] };
    expect(body.sagas.map((saga) => saga.id).sort()).toEqual([...byId.keys()].sort());
    expect(body.sagas.map((saga) => saga.name).sort()).toEqual(
      SAGA_DEFINITIONS.map((def) => def.name).sort(),
    );
  });
});
