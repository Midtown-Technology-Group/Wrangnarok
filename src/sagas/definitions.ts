// SPDX-License-Identifier: AGPL-3.0
// Static Git-owned Saga definitions list (ADR 002). Each leaf Saga module
// registers its definition into ./registry on evaluation; this module pulls
// every leaf in canonical order for its side effects only and assembles the
// list from the registry by stable name. shared.ts reads the same registry
// (never this module), so no module here value-imports a module that
// transitively imports its importers — leaf-first evaluation yields the full
// list instead of partial bindings (issue #57). index.ts builds the Catalog
// from this list and re-exports everything for the Worker entrypoint.
import type { SagaDefinition } from "../saga";
import { registeredSagaDefs } from "./registry";
import "./echo";
import "./ninjaorgs";
import "./digest";
import "./smoke";
import "./hello";
import "./hello-parent";
import "./cloudflare";
import "./onboarding";

/** Canonical registration order. Add new Sagas here (and side-effect-import
 * their module above); the catalog below validates them at Worker startup. */
const CANONICAL_ORDER: readonly string[] = [
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

/** All Saga definitions, in canonical order, regardless of which module
 * evaluated first. A name with no registered definition fails loud at
 * module load, which fails Worker boot — same fatal stance as buildCatalog. */
const REGISTERED = registeredSagaDefs();
export const SAGA_DEFINITIONS: readonly SagaDefinition<unknown>[] = CANONICAL_ORDER.map((name) => {
  const def = REGISTERED.find((candidate) => candidate.name === name);
  if (def === undefined) throw new Error(`Saga "${name}" did not register a definition.`);
  return def;
});
