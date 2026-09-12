// SPDX-License-Identifier: AGPL-3.0
// Shared thin-platform glue for the per-saga modules: translate one Saga
// definition onto the native Workflow contract. No Saga behavior lives here;
// each module under src/sagas owns its definition plus its Workflow adapter.
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Bindings } from "../bindings";
import { EXECUTION_ID } from "../domain";
import type { ExecutionParams, SagaRuntimePolicy } from "../domain";
import { assertJsonSerializable, bindSagaStep } from "../saga";
import type { SagaDefinition, SagaEventContext } from "../saga";
import { bindSagaConfig } from "../config";
import { clearExecutionSecrets, registerExecutionSecrets, scrubExecutionText, scrubExecutionValue } from "../secrets";
import { echo } from "../integrations/echo";
import { listOrganizations } from "../integrations/ninjaone";
import { parseStoredPolicy } from "../executions";

/** Read the Execution's own Organization from the immutable D1 row. Never
 * Workflow params, never caller input: the row is the authority. */
async function executionOrgId(db: D1Database, id: string): Promise<string> {
  const row = await db.prepare("SELECT org_id FROM executions WHERE id = ?").bind(id).first<{ org_id: string }>();
  if (!row) throw new NonRetryableError("Unknown Execution.");
  return row.org_id;
}

export async function executeSaga<TOutput>(
  env: Bindings,
  event: WorkflowEvent<ExecutionParams>,
  step: WorkflowStep,
  def: SagaDefinition<TOutput>,
): Promise<TOutput> {
  const id = event.payload.executionId;
  if (env.LAB_ENABLED !== "true" || typeof id !== "string" || !EXECUTION_ID.test(id) || id !== event.instanceId) {
    throw new NonRetryableError("Invalid local Execution invocation.");
  }
  // The Workflow isolate registers deployment credentials up front so every
  // checkpoint below scrubs them by substring, including tokens the Action
  // registers mid-run. Cleared on every exit path — a reused isolate never
  // carries one Execution's secrets into the next.
  registerExecutionSecrets(id, [env.NINJA_CLIENT_ID, env.NINJA_CLIENT_SECRET]);
  try {
    // ctx.config resolves against the Execution's own Organization only: the
    // org comes from the immutable D1 Execution row (never Workflow params,
    // never caller input), read lazily inside step.do() so the handle itself
    // performs no I/O at construction. Deployment secrets resolve secret
    // references transiently; resolved values register with the
    // execution-scoped registry for write-time scrubbing.
    const deploymentSecrets: Record<string, string | undefined> = {
      clientSecret: env.NINJA_CLIENT_SECRET,
      NINJA_CLIENT_SECRET: env.NINJA_CLIENT_SECRET,
    };
    // One handle per Execution: the org is looked up lazily (inside step.do)
    // so construction performs no I/O, then delegates to the pure binder.
    // Faults (424 CONFIG_REQUIREMENT_UNSATISFIED) propagate to Saga code,
    // which maps them like any other structured downstream error.
    const lazyConfig = {
      async get(key: string, defaultValue?: unknown): Promise<unknown> {
        const orgId = await executionOrgId(env.DB, id);
        return bindSagaConfig({ db: env.DB, orgId, executionId: id, secrets: deploymentSecrets }).get(
          key,
          defaultValue,
        );
      },
      async require(key: string): Promise<unknown> {
        const orgId = await executionOrgId(env.DB, id);
        return bindSagaConfig({ db: env.DB, orgId, executionId: id, secrets: deploymentSecrets }).require(key);
      },
    };
    // RUN-01 (ADR 018): the Workflow resolves step retry limits through the
    // Execution's snapshotted policy, never the live operator row. In-flight
    // runs keep the behavior they started with when an operator edits policy
    // mid-flight; missing snapshots (old rows) collapse to the code table.
    const snapshot = await env.DB.prepare("SELECT policy_json FROM executions WHERE id=?")
      .bind(id)
      .first<{ policy_json: string | null }>()
      .catch(() => null);
    const policy: SagaRuntimePolicy | undefined =
      snapshot?.policy_json == null ? undefined : parseStoredPolicy(snapshot.policy_json);
    const ctx: SagaEventContext = {
      executionId: id,
      integrations: { echo: { echo }, ninjaone: { listOrganizations } },
      db: env.DB,
      secrets: { clientId: env.NINJA_CLIENT_ID, clientSecret: env.NINJA_CLIENT_SECRET },
      config: lazyConfig,
    };
    const output = await def.run(ctx, bindSagaStep(step, policy));
    assertJsonSerializable(output, `${def.name} output`);
    // Workflow terminal value is an outward path: a secret-bearing transform
    // result would otherwise ride the native status API out unscrubbed.
    return scrubExecutionValue(output, id);
  } catch (error) {
    // A secret substring in a thrown exception string must not escape via the
    // native errored status. NonRetryableError carries only the safe code.
    if (error instanceof NonRetryableError) throw error;
    if (error instanceof Error) throw new NonRetryableError(scrubExecutionText(id, error.message));
    throw error;
  } finally {
    clearExecutionSecrets(id);
  }
}
