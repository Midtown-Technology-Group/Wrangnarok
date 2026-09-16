// SPDX-License-Identifier: AGPL-3.0
// Stable Cloudflare Zone Inventory Saga definitions (ADR 002): read-only
// token verification and bounded zone inventory, re-authored from the
// `cloudflare-zone-inventory` bundle's `functions/cloudflare_inventory.py`.
// No behavior lives in the adapters: each definition owns parse + run, and
// every durable effect flows through step.do(...).
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Bindings } from "../bindings";
import {
  CLOUDFLARE_INTEGRATION_ID,
  CLOUDFLARE_TIMEOUT_MS,
  EXECUTION_ID,
  Fault,
  cloudflareInventorySaga,
  cloudflareVerifySaga,
  parseCloudflareInventoryInput,
  parseCloudflareVerifyInput,
  vendorDeadlineMs,
} from "../domain";
import { parseStoredPolicy } from "../executions";
import type {
  CloudflareInventoryInput,
  CloudflareInventoryResult,
  CloudflareVerifyResult,
  ExecutionParams,
  SafeError,
} from "../domain";
import { defineSaga, withOperation } from "../saga";
import { scrubExecutionError, scrubExecutionValue } from "../secrets";
import { beginOperation, failExecution, finishOperation, prepareExecution, resolveConnection } from "../executions";
import { executeSaga } from "./shared";

const accountSchema = Object.freeze({
  type: "object" as const,
  properties: Object.freeze({
    id: Object.freeze({}),
    name: Object.freeze({}),
  }),
  required: Object.freeze([]),
  additionalProperties: false,
});

const verifyInputSchema = Object.freeze({
  type: "object" as const,
  properties: Object.freeze({ account: accountSchema }),
  required: Object.freeze([]),
  additionalProperties: false,
});

const verifyOutputSchema = Object.freeze({
  type: "object" as const,
  properties: Object.freeze({
    status: Object.freeze({ type: "string" }),
    readOnly: Object.freeze({ type: "boolean" }),
    integration: Object.freeze({ type: "string" }),
    account: Object.freeze({ type: "object" }),
    token: Object.freeze({ type: "object" }),
    apiCalls: Object.freeze({ type: "number" }),
  }),
  required: Object.freeze(["status", "readOnly", "integration", "account", "token", "apiCalls"]),
  additionalProperties: false,
});

const inventoryInputSchema = Object.freeze({
  type: "object" as const,
  properties: Object.freeze({ max_zones: Object.freeze({ type: "number" }), account: accountSchema }),
  required: Object.freeze([]),
  additionalProperties: false,
});

const inventoryOutputSchema = Object.freeze({
  type: "object" as const,
  properties: Object.freeze({
    status: Object.freeze({ type: "string" }),
    readOnly: Object.freeze({ type: "boolean" }),
    integration: Object.freeze({ type: "string" }),
    account: Object.freeze({ type: "object" }),
    zoneCount: Object.freeze({ type: "number" }),
    totalAvailable: Object.freeze({ type: "number" }),
    truncated: Object.freeze({ type: "boolean" }),
    apiCalls: Object.freeze({ type: "number" }),
    summary: Object.freeze({ type: "object" }),
    zones: Object.freeze({ type: "array" }),
  }),
  required: Object.freeze([
    "status",
    "readOnly",
    "integration",
    "account",
    "zoneCount",
    "truncated",
    "apiCalls",
    "summary",
    "zones",
  ]),
  additionalProperties: false,
});

/** Resolve the vendor step inputs inside step.do(): Connection from the
 * step's own OrgCtx (declared required, so a miss fails loud with 424), the
 * account mapping from the Execution input binding, and the bearer token
 * straight through the Integration boundary (presence enforced inside the
 * Action). Returns a structured failure instead of throwing for expected
 * downstream errors; NonRetryableError stays reserved for contract bugs. */
async function resolveCloudflareVendor(
  db: D1Database,
  orgCtx: { orgId: string },
  required: readonly string[],
  account: { readonly id: unknown; readonly name: unknown },
): Promise<
  | { ok: true; connection: { endpoint: string }; account: { readonly id: unknown; readonly name: unknown } }
  | { ok: false; error: SafeError }
> {
  const resolved = await resolveConnection(db, orgCtx as Parameters<typeof resolveConnection>[1], CLOUDFLARE_INTEGRATION_ID, required);
  if (!resolved.found && !resolved.declared) {
    throw new NonRetryableError("Unexpected optional Integration access.");
  }
  if (!resolved.found) return { ok: false as const, error: resolved.error };
  return { ok: true as const, connection: resolved.connection, account };
}

/** Stable verify Saga: read-only Cloudflare token check, one vendor GET. */
export const cloudflareVerifySagaDef = defineSaga<CloudflareVerifyResult>({
  id: cloudflareVerifySaga.id,
  name: cloudflareVerifySaga.name,
  revision: cloudflareVerifySaga.revision,
  description: cloudflareVerifySaga.description,
  tags: ["cloudflare", "inventory", "read-only", "solution"],
  requiredIntegrations: [CLOUDFLARE_INTEGRATION_ID],
  inputSchema: verifyInputSchema,
  outputSchema: verifyOutputSchema,
  parse: parseCloudflareVerifyInput,
  run: async (ctx, step): Promise<CloudflareVerifyResult> => {
    const id = ctx.executionId;
    if (typeof id !== "string" || !EXECUTION_ID.test(id)) {
      throw new NonRetryableError("Invalid local Execution invocation.");
    }
    let expectedFailure: SafeError | undefined;
    let timedOut = false;
    try {
      const prepared = await step.do("prepare-input-v1", () =>
        prepareExecution(ctx.db, id, cloudflareVerifySaga.id, cloudflareVerifySaga.revision, parseCloudflareVerifyInput),
      );
      const outcome = await step.do("cloudflare-verify-v1", async () => {
        await beginOperation(ctx.db, id, "cloudflare-verify-v1", 1);
        const applied = await ctx.db
          .prepare("SELECT policy_json FROM executions WHERE id=?")
          .bind(id)
          .first<{ policy_json: string | null }>()
          .catch(() => null);
        const deadline = vendorDeadlineMs(
          applied?.policy_json == null ? parseStoredPolicy(null) : parseStoredPolicy(applied.policy_json),
          CLOUDFLARE_TIMEOUT_MS,
        );
        const stepOrg = withOperation(prepared.orgCtx, "cloudflare-verify-v1");
        // The account mapping rides the parsed Execution input (scenario
        // `binding.entity_id/entity_name`, validated by the input parser and
        // persisted through submit): read it from the prepared input, never
        // from Workflow params. The Integration boundary owns the strict
        // account-ID check.
        const binding = prepared.input.account ?? { id: null, name: null };
        const vendor = await resolveCloudflareVendor(
          ctx.db,
          stepOrg,
          cloudflareVerifySagaDef.requiredIntegrations,
          binding,
        );
        if (!vendor.ok) return { ok: false as const, error: vendor.error };
        let result: CloudflareVerifyResult;
        try {
          result = await ctx.integrations.cloudflare.verifyConnection(
            vendor.connection,
            ctx.secrets,
            vendor.account,
            id,
            deadline,
          );
        } catch (error) {
          const safe =
            error instanceof Fault
              ? scrubExecutionError({ code: error.code, message: error.message }, id)
              : { code: "CLOUDFLARE_INTEGRATION_FAILED", message: "The Cloudflare Integration could not complete." };
          return { ok: false as const, error: safe };
        }
        await finishOperation(ctx.db, id, "cloudflare-verify-v1", result);
        return { ok: true as const, result };
      });
      if (!outcome.ok) {
        expectedFailure = outcome.error;
        timedOut = outcome.error.code === "CLOUDFLARE_VENDOR_TIMEOUT";
        if (timedOut) {
          const failure: SafeError = scrubExecutionError(outcome.error, id);
          await step.do("timeout-mark-v1", () => failExecution(ctx.db, id, failure, "TimedOut"));
        }
        throw new NonRetryableError(expectedFailure.code);
      }
      const output = outcome.result;
      await step.do("persist-success-v1", async () => {
        await ctx.db
          .prepare(
            "UPDATE executions SET status='Succeeded',completed_at=?,result_json=? WHERE id=? AND status='Running'",
          )
          .bind(new Date().toISOString(), JSON.stringify(scrubExecutionValue(output, id)), id)
          .run();
      });
      return output;
    } catch {
      const raw: SafeError = expectedFailure ?? {
        code: "EXECUTION_FAILED",
        message: "The Execution could not complete. Inspect local runtime diagnostics.",
      };
      const safe: SafeError = scrubExecutionError(raw, id);
      if (!timedOut) {
        await step.do("persist-failure-v1", () => failExecution(ctx.db, id, safe));
      }
      throw new NonRetryableError(safe.code);
    }
  },
});

/** Stable inventory Saga: bounded read-only zone census, paginated vendor GETs. */
export const cloudflareInventorySagaDef = defineSaga<CloudflareInventoryResult>({
  id: cloudflareInventorySaga.id,
  name: cloudflareInventorySaga.name,
  revision: cloudflareInventorySaga.revision,
  description: cloudflareInventorySaga.description,
  tags: ["cloudflare", "dns", "zones", "inventory", "read-only", "solution"],
  requiredIntegrations: [CLOUDFLARE_INTEGRATION_ID],
  inputSchema: inventoryInputSchema,
  outputSchema: inventoryOutputSchema,
  parse: parseCloudflareInventoryInput,
  run: async (ctx, step): Promise<CloudflareInventoryResult> => {
    const id = ctx.executionId;
    if (typeof id !== "string" || !EXECUTION_ID.test(id)) {
      throw new NonRetryableError("Invalid local Execution invocation.");
    }
    let expectedFailure: SafeError | undefined;
    let timedOut = false;
    try {
      const prepared = await step.do("prepare-input-v1", () =>
        prepareExecution(
          ctx.db,
          id,
          cloudflareInventorySaga.id,
          cloudflareInventorySaga.revision,
          parseCloudflareInventoryInput,
        ),
      );
      const outcome = await step.do("cloudflare-inventory-v1", async () => {
        await beginOperation(ctx.db, id, "cloudflare-inventory-v1", 1);
        const applied = await ctx.db
          .prepare("SELECT policy_json FROM executions WHERE id=?")
          .bind(id)
          .first<{ policy_json: string | null }>()
          .catch(() => null);
        const deadline = vendorDeadlineMs(
          applied?.policy_json == null ? parseStoredPolicy(null) : parseStoredPolicy(applied.policy_json),
          CLOUDFLARE_TIMEOUT_MS,
        );
        const stepOrg = withOperation(prepared.orgCtx, "cloudflare-inventory-v1");
        const binding = prepared.input.account ?? { id: null, name: null };
        const vendor = await resolveCloudflareVendor(
          ctx.db,
          stepOrg,
          cloudflareInventorySagaDef.requiredIntegrations,
          binding,
        );
        if (!vendor.ok) return { ok: false as const, error: vendor.error };
        const input: CloudflareInventoryInput = { maxZones: prepared.input.maxZones };
        let result: CloudflareInventoryResult;
        try {
          result = await ctx.integrations.cloudflare.inventoryZones(
            vendor.connection,
            ctx.secrets,
            vendor.account,
            input,
            id,
            deadline,
          );
        } catch (error) {
          const safe =
            error instanceof Fault
              ? scrubExecutionError({ code: error.code, message: error.message }, id)
              : { code: "CLOUDFLARE_INTEGRATION_FAILED", message: "The Cloudflare Integration could not complete." };
          return { ok: false as const, error: safe };
        }
        await finishOperation(ctx.db, id, "cloudflare-inventory-v1", result);
        return { ok: true as const, result };
      });
      if (!outcome.ok) {
        expectedFailure = outcome.error;
        timedOut = outcome.error.code === "CLOUDFLARE_VENDOR_TIMEOUT";
        if (timedOut) {
          const failure: SafeError = scrubExecutionError(outcome.error, id);
          await step.do("timeout-mark-v1", () => failExecution(ctx.db, id, failure, "TimedOut"));
        }
        throw new NonRetryableError(expectedFailure.code);
      }
      const output = outcome.result;
      await step.do("persist-success-v1", async () => {
        await ctx.db
          .prepare(
            "UPDATE executions SET status='Succeeded',completed_at=?,result_json=? WHERE id=? AND status='Running'",
          )
          .bind(new Date().toISOString(), JSON.stringify(scrubExecutionValue(output, id)), id)
          .run();
      });
      return output;
    } catch {
      const raw: SafeError = expectedFailure ?? {
        code: "EXECUTION_FAILED",
        message: "The Execution could not complete. Inspect local runtime diagnostics.",
      };
      const safe: SafeError = scrubExecutionError(raw, id);
      if (!timedOut) {
        await step.do("persist-failure-v1", () => failExecution(ctx.db, id, safe));
      }
      throw new NonRetryableError(safe.code);
    }
  },
});

export class CloudflareVerifyWorkflow extends WorkflowEntrypoint<Bindings, ExecutionParams> {
  async run(event: WorkflowEvent<ExecutionParams>, step: WorkflowStep): Promise<CloudflareVerifyResult> {
    return executeSaga(this.env, event, step, cloudflareVerifySagaDef);
  }
}

export class CloudflareInventoryWorkflow extends WorkflowEntrypoint<Bindings, ExecutionParams> {
  async run(event: WorkflowEvent<ExecutionParams>, step: WorkflowStep): Promise<CloudflareInventoryResult> {
    return executeSaga(this.env, event, step, cloudflareInventorySagaDef);
  }
}
