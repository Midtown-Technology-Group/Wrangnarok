// SPDX-License-Identifier: AGPL-3.0
// Static Git-owned Saga definitions list (ADR 002). Split from index.ts so
// the Workflow adapter (shared.ts) can resolve child Sagas without a module
// cycle: saga modules import shared.ts, shared.ts imports this list, and
// index.ts re-exports everything for the Worker entrypoint.
import type { SagaDefinition } from "../saga";
import { digestSagaDef } from "./digest";
import { helloParentSagaDef } from "./hello-parent";
import { helloSagaDef } from "./hello";
import { echoSagaDef } from "./echo";
import { ninjaOrgsSagaDef } from "./ninjaorgs";
import { smokeSagaDef } from "./smoke";

/** All Saga definitions, in canonical order. Add new Sagas here; the catalog
 * below validates them at Worker startup. */
export const SAGA_DEFINITIONS: readonly SagaDefinition<unknown>[] = [
  echoSagaDef,
  ninjaOrgsSagaDef,
  digestSagaDef,
  smokeSagaDef,
  helloSagaDef,
  helloParentSagaDef,
];
