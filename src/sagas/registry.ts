// SPDX-License-Identifier: AGPL-3.0
// Leaf-side Saga registration (issue #57). Each module under src/sagas owns
// its definition and registers it here on evaluation. The registry imports
// no Saga module — only the definition type — so the Workflow adapter
// (shared.ts) can read the registered list without value-importing a module
// that transitively imports its importers (the definitions -> leaf ->
// shared -> definitions cycle). The assembled canonical list lives in
// ./definitions, which side-effect-imports every leaf and orders the
// snapshot; this module never orders, it only records.
import type { SagaDefinition } from "../saga";

const registered: SagaDefinition<unknown>[] = [];

/** Record one leaf Saga definition at module evaluation. Registering the
 * same object twice is a no-op (shared module graphs evaluate once, but
 * test isolates may re-run evaluation); a different object under an already
 * registered stable ID or name fails loud, mirroring the fatal catalog
 * stance in buildCatalog. */
export function registerSagaDef(def: SagaDefinition<unknown>): void {
  const existing = registered.find((candidate) => candidate.id === def.id || candidate.name === def.name);
  if (existing === undefined) {
    registered.push(def);
    return;
  }
  if (existing !== def) {
    throw new Error(`Duplicate Saga registration for "${def.name}" (${def.id}).`);
  }
}

/** Registration-order snapshot of every Saga registered so far. Callers that
 * need the canonical order (Worker boot, the static catalog) read
 * SAGA_DEFINITIONS from ./definitions instead; callers that need
 * post-initialization truth (the per-Execution child catalog in shared.ts)
 * read this at call time, never at module evaluation. */
export function registeredSagaDefs(): readonly SagaDefinition<unknown>[] {
  return Object.freeze([...registered]);
}
