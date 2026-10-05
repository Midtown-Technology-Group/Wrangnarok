// SPDX-License-Identifier: AGPL-3.0
// Account posture slice (issue #252): three read-only Sagas on the existing
// Cloudflare Integration — Audit Logs summary, Security Insights tracking,
// and the benchmark-as-checks evaluation. New Wrangnarok-native surface, no
// upstream counterpart. No behavior lives in the adapters: each definition
// owns parse + run, and every durable effect flows through step.do(...).
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Bindings } from "../bindings";
import {
  CLOUDFLARE_BENCHMARK_DEFAULT_CHECKED_ZONES,
  CLOUDFLARE_INTEGRATION_ID,
  CLOUDFLARE_MAX_ZONES,
  CLOUDFLARE_TIMEOUT_MS,
  CLOUDFLARE_ZONE_SETTING_ALLOWLIST,
  cloudflareAuditSaga,
  cloudflareInsightsSaga,
  cloudflarePostureSaga,
  evaluateInsightsVerdict,
  evaluatePostureChecks,
  parseCloudflareAuditInput,
  parseCloudflareInsightsInput,
  parseCloudflarePostureInput,
  postureManualControls,
} from "../domain";
import type {
  CloudflareAuditInput,
  CloudflareAuditResult,
  CloudflareInsightsInput,
  CloudflareInsightsResult,
  CloudflareInventoryInput,
  CloudflarePostureResult,
  ExecutionParams,
  PostureSettingEvidence,
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

const auditInputSchema = Object.freeze({
  type: "object" as const,
  properties: Object.freeze({
    account: accountSchema,
    since: Object.freeze({ type: "string" }),
    limit: Object.freeze({ type: "number" }),
    classes: Object.freeze({ type: "array" }),
  }),
  required: Object.freeze([]),
  additionalProperties: false,
});

const auditOutputSchema = Object.freeze({
  type: "object" as const,
  properties: Object.freeze({
    status: Object.freeze({ type: "string" }),
    readOnly: Object.freeze({ type: "boolean" }),
    integration: Object.freeze({ type: "string" }),
    account: Object.freeze({ type: "object" }),
    entryCount: Object.freeze({ type: "number" }),
    truncated: Object.freeze({ type: "boolean" }),
    apiCalls: Object.freeze({ type: "number" }),
    classCounts: Object.freeze({ type: "object" }),
    actorKindCounts: Object.freeze({ type: "object" }),
    entries: Object.freeze({ type: "array" }),
  }),
  required: Object.freeze([
    "status",
    "readOnly",
    "integration",
    "account",
    "entryCount",
    "truncated",
    "apiCalls",
    "classCounts",
    "actorKindCounts",
    "entries",
  ]),
  additionalProperties: false,
});

const insightsInputSchema = Object.freeze({
  type: "object" as const,
  properties: Object.freeze({
    account: accountSchema,
    limit: Object.freeze({ type: "number" }),
    includeDismissed: Object.freeze({ type: "boolean" }),
    baseline: Object.freeze({ type: "object" }),
  }),
  required: Object.freeze([]),
  additionalProperties: false,
});

const insightsOutputSchema = Object.freeze({
  type: "object" as const,
  properties: Object.freeze({
    status: Object.freeze({ type: "string" }),
    readOnly: Object.freeze({ type: "boolean" }),
    integration: Object.freeze({ type: "string" }),
    account: Object.freeze({ type: "object" }),
    issueCount: Object.freeze({ type: "number" }),
    truncated: Object.freeze({ type: "boolean" }),
    apiCalls: Object.freeze({ type: "number" }),
    severityCounts: Object.freeze({ type: "object" }),
    unresolvedCriticalIds: Object.freeze({ type: "array" }),
    verdict: Object.freeze({ type: "string" }),
    issues: Object.freeze({ type: "array" }),
  }),
  required: Object.freeze([
    "status",
    "readOnly",
    "integration",
    "account",
    "issueCount",
    "truncated",
    "apiCalls",
    "severityCounts",
    "unresolvedCriticalIds",
    "verdict",
    "issues",
  ]),
  additionalProperties: false,
});

const postureInputSchema = Object.freeze({
  type: "object" as const,
  properties: Object.freeze({
    account: accountSchema,
    maxZones: Object.freeze({ type: "number" }),
    maxCheckedZones: Object.freeze({ type: "number" }),
    settings: Object.freeze({ type: "array" }),
    baseline: Object.freeze({ type: "object" }),
  }),
  required: Object.freeze([]),
  additionalProperties: false,
});

const postureOutputSchema = Object.freeze({
  type: "object" as const,
  properties: Object.freeze({
    status: Object.freeze({ type: "string" }),
    readOnly: Object.freeze({ type: "boolean" }),
    integration: Object.freeze({ type: "string" }),
    account: Object.freeze({ type: "object" }),
    verdict: Object.freeze({ type: "string" }),
    apiCalls: Object.freeze({ type: "number" }),
    checks: Object.freeze({ type: "array" }),
    manual: Object.freeze({ type: "array" }),
    deferred: Object.freeze({ type: "array" }),
  }),
  required: Object.freeze([
    "status",
    "readOnly",
    "integration",
    "account",
    "verdict",
    "apiCalls",
    "checks",
    "manual",
    "deferred",
  ]),
  additionalProperties: false,
});

/** S1 — Audit Logs Saga: bounded read-only Audit Logs v2 summary with the
 * issue's filter classes and actor-vs-service attribution. Scheduled rows
 * carry the (reviewed) input as input_json; on-demand submits pass it
 * directly. Findings persist as the Execution result via the standard path. */
export const cloudflareAuditSagaDef = defineSaga<CloudflareAuditResult>({
  id: cloudflareAuditSaga.id,
  name: cloudflareAuditSaga.name,
  revision: cloudflareAuditSaga.revision,
  description: cloudflareAuditSaga.description,
  tags: ["cloudflare", "posture", "audit-logs", "read-only", "solution"],
  requiredIntegrations: [CLOUDFLARE_INTEGRATION_ID],
  inputSchema: auditInputSchema,
  outputSchema: auditOutputSchema,
  parse: parseCloudflareAuditInput,
  run: async (ctx, step): Promise<CloudflareAuditResult> => {
    const id = assertRunExecutionId(ctx.executionId);
    let expectedFailure: SafeError | undefined;
    let timedOut = false;
    try {
      const prepared = await step.do("prepare-input-v1", () =>
        prepareExecution(ctx.db, id, cloudflareAuditSaga.id, cloudflareAuditSaga.revision, parseCloudflareAuditInput),
      );
      const outcome = await step.do("cloudflare-audit-logs-v1", () => {
        const binding = prepared.input.account ?? { id: null, name: null };
        const input: CloudflareAuditInput = {
          ...(prepared.input.since !== undefined ? { since: prepared.input.since } : {}),
          ...(prepared.input.limit !== undefined ? { limit: prepared.input.limit } : {}),
          ...(prepared.input.classes !== undefined ? { classes: prepared.input.classes } : {}),
        };
        return integrationOperation(ctx, cloudflareAuditSagaDef, prepared, {
          op: "cloudflare-audit-logs-v1",
          position: 1,
          integrationId: CLOUDFLARE_INTEGRATION_ID,
          vendorDefaultMs: CLOUDFLARE_TIMEOUT_MS,
          failureCode: "CLOUDFLARE_INTEGRATION_FAILED",
          failureMessage: "The Cloudflare Integration could not complete.",
          call: (connection, secrets, deadline) =>
            ctx.integrations.cloudflare.listAuditLogs(connection, secrets, binding, input, id, deadline),
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

registerSagaDef(cloudflareAuditSagaDef);

/** S2 — Security Insights Saga: bounded insights list with severity counts
 * and unresolved-Critical tracking. Advisory-first: the failing verdict
 * applies only after a recorded baseline exists (see
 * evaluateInsightsVerdict); without one every run stays advisory. */
export const cloudflareInsightsSagaDef = defineSaga<CloudflareInsightsResult>({
  id: cloudflareInsightsSaga.id,
  name: cloudflareInsightsSaga.name,
  revision: cloudflareInsightsSaga.revision,
  description: cloudflareInsightsSaga.description,
  tags: ["cloudflare", "posture", "security-insights", "read-only", "solution"],
  requiredIntegrations: [CLOUDFLARE_INTEGRATION_ID],
  inputSchema: insightsInputSchema,
  outputSchema: insightsOutputSchema,
  parse: parseCloudflareInsightsInput,
  run: async (ctx, step): Promise<CloudflareInsightsResult> => {
    const id = assertRunExecutionId(ctx.executionId);
    let expectedFailure: SafeError | undefined;
    let timedOut = false;
    try {
      const prepared = await step.do("prepare-input-v1", () =>
        prepareExecution(
          ctx.db,
          id,
          cloudflareInsightsSaga.id,
          cloudflareInsightsSaga.revision,
          parseCloudflareInsightsInput,
        ),
      );
      const outcome = await step.do("cloudflare-security-insights-v1", () => {
        const binding = prepared.input.account ?? { id: null, name: null };
        const input: CloudflareInsightsInput = {
          ...(prepared.input.limit !== undefined ? { limit: prepared.input.limit } : {}),
          ...(prepared.input.includeDismissed !== undefined
            ? { includeDismissed: prepared.input.includeDismissed }
            : {}),
        };
        return integrationOperation(ctx, cloudflareInsightsSagaDef, prepared, {
          op: "cloudflare-security-insights-v1",
          position: 1,
          integrationId: CLOUDFLARE_INTEGRATION_ID,
          vendorDefaultMs: CLOUDFLARE_TIMEOUT_MS,
          failureCode: "CLOUDFLARE_INTEGRATION_FAILED",
          failureMessage: "The Cloudflare Integration could not complete.",
          call: (connection, secrets, deadline) =>
            ctx.integrations.cloudflare.listSecurityInsights(connection, secrets, binding, input, id, deadline),
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
      // Pure verdict over the shaped list plus the reviewed baseline carried
      // on the prepared input: deterministic, so it runs outside step.do.
      const { verdict } = evaluateInsightsVerdict(outcome.result.unresolvedCriticalIds, prepared.input.baseline);
      const output: CloudflareInsightsResult = {
        ...outcome.result,
        verdict,
        baselineRecordedAt: prepared.input.baseline?.recordedAt ?? null,
      };
      await step.do("persist-success-v1", () => persistRunSuccess(ctx.db, id, output));
      return output;
    } catch {
      return persistRunFailure(ctx, step, id, expectedFailure, timedOut);
    }
  },
});

registerSagaDef(cloudflareInsightsSagaDef);

/** S3 — Benchmark Saga: typed checks over already-called APIs (token
 * verification, zone inventory, zone settings vs the reviewed baseline)
 * plus honestly-manual controls and deferred sibling-Saga items. Manual and
 * deferred entries never fail; automated checks fail closed on concrete
 * misconfiguration. Steampipe/Powerpipe is deliberately not used (new
 * external binary outside the local-Cloudflare-tooling direction). */
export const cloudflarePostureSagaDef = defineSaga<CloudflarePostureResult>({
  id: cloudflarePostureSaga.id,
  name: cloudflarePostureSaga.name,
  revision: cloudflarePostureSaga.revision,
  description: cloudflarePostureSaga.description,
  tags: ["cloudflare", "posture", "benchmark", "read-only", "solution"],
  requiredIntegrations: [CLOUDFLARE_INTEGRATION_ID],
  inputSchema: postureInputSchema,
  outputSchema: postureOutputSchema,
  parse: parseCloudflarePostureInput,
  run: async (ctx, step): Promise<CloudflarePostureResult> => {
    const id = assertRunExecutionId(ctx.executionId);
    let expectedFailure: SafeError | undefined;
    let timedOut = false;
    try {
      const prepared = await step.do("prepare-input-v1", () =>
        prepareExecution(
          ctx.db,
          id,
          cloudflarePostureSaga.id,
          cloudflarePostureSaga.revision,
          parseCloudflarePostureInput,
        ),
      );
      const binding = prepared.input.account ?? { id: null, name: null };
      const verifyOutcome = await step.do("cloudflare-posture-verify-v1", () =>
        integrationOperation(ctx, cloudflarePostureSagaDef, prepared, {
          op: "cloudflare-posture-verify-v1",
          position: 1,
          integrationId: CLOUDFLARE_INTEGRATION_ID,
          vendorDefaultMs: CLOUDFLARE_TIMEOUT_MS,
          failureCode: "CLOUDFLARE_INTEGRATION_FAILED",
          failureMessage: "The Cloudflare Integration could not complete.",
          call: (connection, secrets, deadline) =>
            ctx.integrations.cloudflare.verifyConnection(connection, secrets, binding, id, deadline),
        }),
      );
      if (!verifyOutcome.ok) {
        expectedFailure = verifyOutcome.error;
        timedOut = verifyOutcome.error.code === "CLOUDFLARE_VENDOR_TIMEOUT";
        if (timedOut) {
          const failure: SafeError = scrubExecutionError(verifyOutcome.error, id);
          await step.do("timeout-mark-verify-v1", () => failExecution(ctx.db, id, failure, "TimedOut"));
        }
        throw new NonRetryableError(verifyOutcome.error.code);
      }
      const maxZones = prepared.input.maxZones ?? CLOUDFLARE_MAX_ZONES;
      const inventoryInput: CloudflareInventoryInput = { maxZones };
      const inventoryOutcome = await step.do("cloudflare-posture-inventory-v1", () =>
        integrationOperation(ctx, cloudflarePostureSagaDef, prepared, {
          op: "cloudflare-posture-inventory-v1",
          position: 2,
          integrationId: CLOUDFLARE_INTEGRATION_ID,
          vendorDefaultMs: CLOUDFLARE_TIMEOUT_MS,
          failureCode: "CLOUDFLARE_INTEGRATION_FAILED",
          failureMessage: "The Cloudflare Integration could not complete.",
          call: (connection, secrets, deadline) =>
            ctx.integrations.cloudflare.inventoryZones(connection, secrets, binding, inventoryInput, id, deadline),
        }),
      );
      if (!inventoryOutcome.ok) {
        expectedFailure = inventoryOutcome.error;
        timedOut = inventoryOutcome.error.code === "CLOUDFLARE_VENDOR_TIMEOUT";
        if (timedOut) {
          const failure: SafeError = scrubExecutionError(inventoryOutcome.error, id);
          await step.do("timeout-mark-inventory-v1", () => failExecution(ctx.db, id, failure, "TimedOut"));
        }
        throw new NonRetryableError(inventoryOutcome.error.code);
      }
      const maxCheckedZones = prepared.input.maxCheckedZones ?? CLOUDFLARE_BENCHMARK_DEFAULT_CHECKED_ZONES;
      const checkedZoneIds = inventoryOutcome.result.zones.slice(0, maxCheckedZones).map((zone) => zone.id);
      const checkedSettings: readonly string[] = prepared.input.settings ?? CLOUDFLARE_ZONE_SETTING_ALLOWLIST;
      let settingEvidence: readonly PostureSettingEvidence[] = Object.freeze([]);
      let settingsCalls = 0;
      if (checkedZoneIds.length > 0) {
        const settingsOutcome = await step.do("cloudflare-posture-settings-v1", () =>
          integrationOperation(ctx, cloudflarePostureSagaDef, prepared, {
            op: "cloudflare-posture-settings-v1",
            position: 3,
            integrationId: CLOUDFLARE_INTEGRATION_ID,
            vendorDefaultMs: CLOUDFLARE_TIMEOUT_MS,
            failureCode: "CLOUDFLARE_INTEGRATION_FAILED",
            failureMessage: "The Cloudflare Integration could not complete.",
            call: (connection, secrets, deadline) =>
              ctx.integrations.cloudflare.readZoneSettings(
                connection,
                secrets,
                binding,
                { zoneIds: checkedZoneIds, settings: checkedSettings },
                id,
                deadline,
              ),
          }),
        );
        if (!settingsOutcome.ok) {
          expectedFailure = settingsOutcome.error;
          timedOut = settingsOutcome.error.code === "CLOUDFLARE_VENDOR_TIMEOUT";
          if (timedOut) {
            const failure: SafeError = scrubExecutionError(settingsOutcome.error, id);
            await step.do("timeout-mark-settings-v1", () => failExecution(ctx.db, id, failure, "TimedOut"));
          }
          throw new NonRetryableError(settingsOutcome.error.code);
        }
        settingEvidence = settingsOutcome.result.settings;
        settingsCalls = settingsOutcome.result.apiCalls;
      }
      const verifyStatus = verifyOutcome.result.status;
      const inventory = inventoryOutcome.result;
      const baseline = prepared.input.baseline;
      // Clock read stays inside step.do with the pure evaluation so replay
      // stays deterministic (same precedent as prepare-input-v1).
      const evaluated = await step.do("evaluate-benchmark-v1", async () =>
        evaluatePostureChecks({
          verifyStatus,
          zoneCount: inventory.zoneCount,
          pausedZones: inventory.summary.paused,
          developmentModeActive: inventory.summary.developmentModeActive,
          checkedZoneIds,
          settingEvidence,
          checkedSettings,
          baseline,
          nowIso: new Date().toISOString(),
        }),
      );
      const manualNow = await step.do("manual-controls-v1", async () =>
        postureManualControls(baseline, new Date().toISOString()),
      );
      const output: CloudflarePostureResult = {
        status: "completed",
        readOnly: true,
        integration: "Cloudflare",
        account: inventory.account,
        verdict: evaluated.verdict,
        apiCalls: verifyOutcome.result.apiCalls + inventory.apiCalls + settingsCalls,
        checks: evaluated.checks,
        manual: manualNow,
        // Fresh copies, not shared references: the serializability gate
        // rejects shared structure as circular.
        deferred: Object.freeze(
          evaluated.checks
            .filter((check) => check.status === "deferred")
            .map((check) => ({
              id: check.id,
              title: check.title,
              status: check.status,
              detail: check.detail,
              suppressed: check.suppressed,
            })),
        ),
      };
      await step.do("persist-success-v1", () => persistRunSuccess(ctx.db, id, output));
      return output;
    } catch {
      return persistRunFailure(ctx, step, id, expectedFailure, timedOut);
    }
  },
});

registerSagaDef(cloudflarePostureSagaDef);

export class CloudflareAuditWorkflow extends WorkflowEntrypoint<Bindings, ExecutionParams> {
  async run(event: WorkflowEvent<ExecutionParams>, step: WorkflowStep): Promise<CloudflareAuditResult> {
    return executeSaga(this.env, event, step, cloudflareAuditSagaDef);
  }
}

export class CloudflareInsightsWorkflow extends WorkflowEntrypoint<Bindings, ExecutionParams> {
  async run(event: WorkflowEvent<ExecutionParams>, step: WorkflowStep): Promise<CloudflareInsightsResult> {
    return executeSaga(this.env, event, step, cloudflareInsightsSagaDef);
  }
}

export class CloudflarePostureWorkflow extends WorkflowEntrypoint<Bindings, ExecutionParams> {
  async run(event: WorkflowEvent<ExecutionParams>, step: WorkflowStep): Promise<CloudflarePostureResult> {
    return executeSaga(this.env, event, step, cloudflarePostureSagaDef);
  }
}
