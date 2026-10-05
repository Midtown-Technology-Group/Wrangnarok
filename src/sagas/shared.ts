// SPDX-License-Identifier: AGPL-3.0
// Shared thin-platform glue for the per-saga modules: translate one Saga
// definition onto the native Workflow contract. No Saga behavior lives here;
// each module under src/sagas owns its definition plus its Workflow adapter.
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Bindings } from "../bindings";
import { CLOUDFLARE_INTEGRATION_ID, EXECUTION_ID, NINJA_INTEGRATION_ID } from "../domain";
import type { ExecutionParams, SagaRuntimePolicy } from "../domain";
import { assertJsonSerializable, bindSagaStep } from "../saga";
import type { SagaDefinition, SagaEventContext } from "../saga";
import { bindSagaChildren } from "../children";
import type { ChildCatalog } from "../children";
import { registeredSagaDefs } from "./registry";
import { bindSagaConfig } from "../config";
import { clearExecutionSecrets, registerExecutionSecrets, scrubExecutionText, scrubExecutionValue } from "../secrets";
import { echo } from "../integrations/echo";
import { listOrganizations } from "../integrations/ninjaone";
import {
  inventoryZones,
  listAuditLogs,
  listSecurityInsights,
  readZoneSettings,
  verifyConnection,
} from "../integrations/cloudflare";
import { loadExecutionPolicy, resolveConnection } from "../executions";
import { resolveConnectionSecrets } from "../connections";
import { ENVELOPE_KEY_VERSION } from "../envelope";

/** Read the parent caller identity from its immutable D1 Execution row.
 * Lazy (first child invoke/await only): context construction itself never
 * touches D1, so unknown rows still fail in prepareExecution as before. */
async function readParentOrg(env: Bindings, id: string): Promise<{ orgId: string; userId: string }> {
  const row = await env.DB.prepare("SELECT org_id,user_id FROM executions WHERE id=?")
    .bind(id)
    .first<{ org_id: string; user_id: string }>();
  if (!row) throw new NonRetryableError("Unknown Saga revision.");
  return { orgId: row.org_id, userId: row.user_id };
}

/** Read the Execution's own Organization from the immutable D1 row. Never
 * Workflow params, never caller input: the row is the authority. */
async function executionOrgId(db: D1Database, id: string): Promise<string> {
  const row = await db.prepare("SELECT org_id FROM executions WHERE id = ?").bind(id).first<{ org_id: string }>();
  if (!row) throw new NonRetryableError("Unknown Execution.");
  return row.org_id;
}

/** Resolve per-Organization secret values for one Execution (SEC-02, issue
 * #411). Without a KEK this returns empty without touching D1: the v0 path
 * runs untouched, and removing the KEK parks the per-org path (rows stay
 * inert ciphertext) rather than migrating anything. With a KEK, stored
 * envelopes for the Execution's org resolve here and win over the
 * deployment credential; corrupt rows fail loud via
 * resolveConnectionSecrets (never a silent deployment fallback). Unknown
 * executions resolve to no org row and return empty — the prepare step
 * still owns that failure exactly as before. Resolved values register with
 * the execution-scoped registry for write-time scrubbing. */
export async function resolveExecutionOrgSecrets(
  db: D1Database,
  id: string,
  saga: { readonly id: string; readonly revision: string },
  kekMaterial: string | undefined,
): Promise<{ clientSecret?: string; apiToken?: string }> {
  if (typeof kekMaterial !== "string" || kekMaterial.length === 0) return {};
  const keks: Readonly<Record<number, string>> = { [ENVELOPE_KEY_VERSION]: kekMaterial };
  const orgRow = await db
    .prepare("SELECT org_id,user_id FROM executions WHERE id=?")
    .bind(id)
    .first<{ org_id: string; user_id: string }>();
  if (!orgRow) return {};
  const orgSecrets: { clientSecret?: string; apiToken?: string } = {};
  const orgCtx = {
    orgId: orgRow.org_id,
    userId: orgRow.user_id,
    executionId: id,
    sagaId: saga.id,
    sagaRevision: saga.revision,
    attemptToken: `${id}:0`,
  };
  const bindings = [
    { integrationId: NINJA_INTEGRATION_ID, field: "clientSecret", ctxKey: "clientSecret" },
    { integrationId: CLOUDFLARE_INTEGRATION_ID, field: "apiToken", ctxKey: "apiToken" },
  ] as const;
  for (const binding of bindings) {
    const resolved = await resolveConnection(db, orgCtx, binding.integrationId, []);
    if (!resolved.found) continue;
    const decrypted = await resolveConnectionSecrets(db, orgRow.org_id, resolved.connection.id, keks);
    const value = decrypted[binding.field];
    if (typeof value === "string" && value.length > 0) {
      orgSecrets[binding.ctxKey] = value;
      registerExecutionSecrets(id, [value]);
    }
  }
  return orgSecrets;
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
  registerExecutionSecrets(id, [
    env.NINJA_CLIENT_ID,
    env.NINJA_CLIENT_SECRET,
    env.HALO_CLIENT_ID,
    env.HALO_CLIENT_SECRET,
    env.CLOUDFLARE_API_TOKEN,
  ]);
  // Per-Organization secrets (SEC-02, issue #411); see
  // resolveExecutionOrgSecrets below for the contract.
  const orgSecrets = await resolveExecutionOrgSecrets(env.DB, id, def, env.SECRETS_KEK);
  try {
    const sagaStep = bindSagaStep(step);
    // Post-initialization snapshot from the leaf registry (./registry), not
    // the assembled list: this module must never value-import a module that
    // transitively imports its importers (issue #57). By Execution time
    // every leaf has evaluated, so the snapshot carries the full catalog.
    const catalog: ChildCatalog = { sagas: registeredSagaDefs() };
    // The child handle resolves the parent OrgCtx lazily from the immutable
    // parent D1 row (never from caller input) on first invoke/await, so
    // constructing the context never touches D1: prepareExecution inside
    // run() stays the first read (unknown rows fail there as before).
    let parentOrg: { orgId: string; userId: string } | null = null;
    const childEnv = (caller: { orgId: string; userId: string }) => ({
      env,
      catalog,
      parentOrg: {
        orgId: caller.orgId,
        userId: caller.userId,
        executionId: id,
        sagaId: def.id,
        sagaRevision: def.revision,
        attemptToken: `${id}:0`,
      },
      parentExecutionId: id,
      parentSagaId: def.id,
    });
    const lazyChildren = {
      invoke: async (...args: Parameters<ReturnType<typeof bindSagaChildren>["invoke"]>) => {
        parentOrg ??= await readParentOrg(env, id);
        return bindSagaChildren(childEnv(parentOrg), sagaStep).invoke(...args);
      },
      awaitResult: async <T>(...args: Parameters<ReturnType<typeof bindSagaChildren>["awaitResult"]>) => {
        parentOrg ??= await readParentOrg(env, id);
        return bindSagaChildren(childEnv(parentOrg), sagaStep).awaitResult<T>(args[0], args[1]);
      },
    };
    // ctx.config resolves against the Execution's own Organization only: the
    // org comes from the immutable D1 Execution row (never Workflow params,
    // never caller input), read lazily inside step.do() so the handle itself
    // performs no I/O at construction. Deployment secrets resolve secret
    // references transiently; resolved values register with the
    // execution-scoped registry for write-time scrubbing.
    const deploymentSecrets: Record<string, string | undefined> = {
      clientSecret: env.NINJA_CLIENT_SECRET,
      NINJA_CLIENT_SECRET: env.NINJA_CLIENT_SECRET,
      apiToken: env.CLOUDFLARE_API_TOKEN,
      CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
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
    // RUN-01 (ADR 018, Slice A issue #135): the Workflow resolves step retry
    // limits through the Execution's snapshotted policy, never the live
    // operator row. In-flight runs keep the behavior they started with when
    // an operator edits policy mid-flight; legacy snapshots (old rows)
    // resolve to the code default through the shared loader. A snapshot read
    // failure throws before any step runs, never falling back to defaults.
    const policy: SagaRuntimePolicy = await loadExecutionPolicy(env.DB, id);
    const ctx: SagaEventContext = {
      executionId: id,
      integrations: {
        echo: { echo },
        ninjaone: { listOrganizations },
        cloudflare: { verifyConnection, inventoryZones, listAuditLogs, listSecurityInsights, readZoneSettings },
      },
      db: env.DB,
      secrets: {
        clientId: env.NINJA_CLIENT_ID,
        clientSecret: orgSecrets.clientSecret ?? env.NINJA_CLIENT_SECRET,
        apiToken: orgSecrets.apiToken ?? env.CLOUDFLARE_API_TOKEN,
      },
      children: lazyChildren,
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

/** Workflow adapter factory (ADR-033-1): returns the WorkflowEntrypoint
 * subclass for one Saga definition, replacing the per-file adapter class
 * body. Each Saga file keeps a one-line named subclass
 * (`export class EchoWorkflow extends makeSagaWorkflow(echoSagaDef) {}`)
 * because wrangler.jsonc class_name targets and the src/index.ts re-export
 * require statically exported classes. The return type preserves the native
 * (ctx, env) construct signature: a `new () => ...` type fails with TS2322
 * because the native constructor takes 2 arguments. */
export function makeSagaWorkflow<TOutput>(
  def: SagaDefinition<TOutput>,
): new (ctx: ExecutionContext, env: Bindings) => WorkflowEntrypoint<Bindings, ExecutionParams> {
  return class extends WorkflowEntrypoint<Bindings, ExecutionParams> {
    async run(event: WorkflowEvent<ExecutionParams>, step: WorkflowStep): Promise<TOutput> {
      return executeSaga(this.env, event, step, def);
    }
  };
}
