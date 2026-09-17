// SPDX-License-Identifier: AGPL-3.0
// Native-entrypoint proof fixture (issue #416): a test-only Saga authored
// exactly the way the agents guide prescribes (defineSaga + interior
// helpers, visible step.do boundaries). Test-only stable identity, never
// registered in SAGA_DEFINITIONS, so the manifest gate never sees it.
import { NonRetryableError } from "cloudflare:workflows";
import { defineSaga, schemaOf } from "../../src/saga";
import type { SafeError } from "../../src/domain";
import { assertRunExecutionId, completeExecution, failSagaExecution } from "../../src/executions";
import { prepareInput } from "../../src/saga-helpers";

export const PROOF_SAGA_ID = "88888888-8888-4888-8888-888888888888";
export const PROOF_SAGA_REVISION = "proof-v1";

export interface ProofInput {
  readonly marker: string;
}

export interface ProofOutput {
  readonly ready: boolean;
  readonly marker: string;
}

export function parseProofInput(value: unknown): ProofInput {
  if (typeof value !== "object" || value === null || typeof (value as { marker?: unknown }).marker !== "string") {
    throw new Error("Expected { marker: string }.");
  }
  return { marker: (value as { marker: string }).marker };
}

export const PROOF_SAGA = { id: PROOF_SAGA_ID, revision: PROOF_SAGA_REVISION } as const;

/** Minimal helper-authored Saga: prepare, one pure step, persist. The
 * dispatch test drives this through a makeSagaWorkflow-generated native
 * Workflow entrypoint to terminal success. */
export const proofSagaDef = defineSaga<ProofOutput>({
  id: PROOF_SAGA_ID,
  name: "entrypoint-proof",
  revision: PROOF_SAGA_REVISION,
  description: "Native-entrypoint proof fixture (test-only, never registered).",
  tags: ["test", "proof"],
  requiredIntegrations: [],
  inputSchema: schemaOf({ marker: "string" }, ["marker"]),
  outputSchema: schemaOf({ ready: "boolean", marker: "string" }, ["ready", "marker"]),
  parse: parseProofInput,
  run: async (ctx, step): Promise<ProofOutput> => {
    // No expected-failure branch here (pure transform, no Integration
    // legs), so the catch below is the only persist-failure-v1 writer and
    // no already-persisted guard is needed. Sagas with a pre-persisting
    // failure branch add the terminalWritten guard from golden example 2.
    const id = assertRunExecutionId(ctx.executionId);
    try {
      const prepared = await step.do("prepare-input-v1", () => prepareInput(ctx, proofSagaDef, parseProofInput));
      const output: ProofOutput = { ready: true, marker: prepared.input.marker };
      await step.do("persist-success-v1", () => completeExecution(ctx.db, id, output));
      return output;
    } catch {
      const failure: SafeError = {
        code: "EXECUTION_FAILED",
        message: "The Execution could not complete. Inspect local runtime diagnostics.",
      };
      await step.do("persist-failure-v1", () => failSagaExecution(ctx.db, id, failure));
      throw new NonRetryableError(failure.code);
    }
  },
});
