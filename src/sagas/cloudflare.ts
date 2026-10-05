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
  cloudflareInventorySaga,
  cloudflareVerifySaga,
  parseCloudflareInventoryInput,
  parseCloudflareVerifyInput,
} from "../domain";
import type {
  CloudflareInventoryInput,
  CloudflareInventoryResult,
  CloudflareVerifyResult,
  ExecutionParams,
  SafeError,
} from "../domain";
import { defineSaga } from "../saga";
import { integrationOperation } from "../saga-helpers";
import { scrubExecutionError } from "../secrets";
import {
  assertRunExecutionId,
  failExecution,
  persistRunFailure,
  persistRunSuccess,
  prepareExecution,
} from "../executions";
import { executeSaga } from "./shared";
import { registerSagaDef } from "./registry";

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
    credential: Object.freeze({ type: "object" }),
    apiCalls: Object.freeze({ type: "number" }),
  }),
  required: Object.freeze(["status", "readOnly", "integration", "account", "credential", "apiCalls"]),
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
    const id = assertRunExecutionId(ctx.executionId);
    let expectedFailure: SafeError | undefined;
    let timedOut = false;
    try {
      const prepared = await step.do("prepare-input-v1", () =>
        prepareExecution(
          ctx.db,
          id,
          cloudflareVerifySaga.id,
          cloudflareVerifySaga.revision,
          parseCloudflareVerifyInput,
        ),
      );
      // ADR-033-4: one Action convention — the helper supplies
      // (connection, secrets, deadline, operationId) and each leg takes what
      // its Action needs. The account mapping rides the parsed Execution input
      // (scenario `binding.entity_id/entity_name`, validated by the input
      // parser and persisted through submit): read it from the prepared
      // input, never from Workflow params. The Integration boundary owns
      // the strict account-ID check.
      const outcome = await step.do("cloudflare-verify-v1", () => {
        const binding = prepared.input.account ?? { id: null, name: null };
        return integrationOperation(ctx, cloudflareVerifySagaDef, prepared, {
          op: "cloudflare-verify-v1",
          position: 1,
          integrationId: CLOUDFLARE_INTEGRATION_ID,
          vendorDefaultMs: CLOUDFLARE_TIMEOUT_MS,
          failureCode: "CLOUDFLARE_INTEGRATION_FAILED",
          failureMessage: "The Cloudflare Integration could not complete.",
          call: (connection, secrets, deadline) =>
            ctx.integrations.cloudflare.verifyConnection(connection, secrets, binding, id, deadline),
        });
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
      await step.do("persist-success-v1", () => persistRunSuccess(ctx.db, id, output));
      return output;
    } catch {
      return persistRunFailure(ctx, step, id, expectedFailure, timedOut);
    }
  },
});

registerSagaDef(cloudflareVerifySagaDef);
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
    const id = assertRunExecutionId(ctx.executionId);
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
      // ADR-033-4: same Action convention as the verify leg above and
      // every other Saga. The bounded inventory input shapes from the
      // prepared input beside the account mapping.
      const outcome = await step.do("cloudflare-inventory-v1", () => {
        const binding = prepared.input.account ?? { id: null, name: null };
        const input: CloudflareInventoryInput = { maxZones: prepared.input.maxZones };
        return integrationOperation(ctx, cloudflareInventorySagaDef, prepared, {
          op: "cloudflare-inventory-v1",
          position: 1,
          integrationId: CLOUDFLARE_INTEGRATION_ID,
          vendorDefaultMs: CLOUDFLARE_TIMEOUT_MS,
          failureCode: "CLOUDFLARE_INTEGRATION_FAILED",
          failureMessage: "The Cloudflare Integration could not complete.",
          call: (connection, secrets, deadline) =>
            ctx.integrations.cloudflare.inventoryZones(connection, secrets, binding, input, id, deadline),
        });
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
      await step.do("persist-success-v1", () => persistRunSuccess(ctx.db, id, output));
      return output;
    } catch {
      return persistRunFailure(ctx, step, id, expectedFailure, timedOut);
    }
  },
});

registerSagaDef(cloudflareInventorySagaDef);
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
