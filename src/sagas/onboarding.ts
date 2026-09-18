// SPDX-License-Identifier: AGPL-3.0
// Employee Onboarding proving Saga (issue #262, ADR TBD §7): one Saga
// source requests semantic capabilities and runs unmodified across the
// Entra, AD-via-Ninja, and Google Workspace bindings. The shared identity
// path carries zero provider-selection branches: each step resolves its
// capability to a frozen Connection binding, selects the Adapter from that
// binding's Integration, and executes. Provider-specific work stays
// provider-direct in the marked escape-hatch block below — never in the
// shared path, never as a lowest-common-denominator gate.
import { NonRetryableError } from "cloudflare:workflows";
import {
  GRAPH_INTEGRATION_ID,
  GROUPS_CAPABILITY,
  IDENTITY_CAPABILITY,
  IDENTITY_TIMEOUT_MS,
  MAIL_CAPABILITY,
  ONBOARDING_REQUIRED_CAPABILITIES,
  onboardingSaga,
  parseOnboardingInput,
} from "../domain";
import type { OnboardingResult, SafeError } from "../domain";
import { identityAdapterFor } from "../adapters/identity";
import { assignGraphLicense } from "../integrations/graph";
import { defineSaga } from "../saga";
import { capabilityOperation, optionalIntegrationOperation, prepareInput } from "../saga-helpers";
import { assertRunExecutionId, completeExecution, failSagaExecution } from "../executions";
import { makeSagaWorkflow } from "./shared";
/** Stable employee-onboarding Saga: capability-routed identity, groups, and
 * mailbox provisioning with an Entra-only licensing escape hatch. */
export const onboardingSagaDef = defineSaga<OnboardingResult>({
  id: onboardingSaga.id,
  name: onboardingSaga.name,
  revision: onboardingSaga.revision,
  description: onboardingSaga.description,
  tags: ["onboarding", "identity", "capability"],
  requiredIntegrations: [],
  requiredCapabilities: [...ONBOARDING_REQUIRED_CAPABILITIES],
  inputSchema: {
    type: "object",
    properties: Object.freeze({
      employee: Object.freeze({ type: "object" }),
      groups: Object.freeze({ type: "array" }),
    }),
    required: Object.freeze(["employee"]),
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: Object.freeze({
      userId: Object.freeze({ type: "string" }),
      userPrincipalName: Object.freeze({ type: "string" }),
      groupsAssigned: Object.freeze({ type: "array" }),
      mailboxProvisioned: Object.freeze({ type: "boolean" }),
      escapeHatch: Object.freeze({ type: "object" }),
    }),
    required: Object.freeze(["userId", "userPrincipalName", "groupsAssigned", "mailboxProvisioned", "escapeHatch"]),
    additionalProperties: false,
  },
  parse: parseOnboardingInput,
  run: async (ctx, step): Promise<OnboardingResult> => {
    const id = assertRunExecutionId(ctx.executionId);
    // The expected-failure branches below persist before throwing, so the
    // catch rethrows an already-persisted failure untouched: step names are
    // unique per Execution, so exactly one persist-failure-v1 runs.
    let terminalWritten = false;
    try {
      const prepared = await step.do("prepare-input-v1", () => prepareInput(ctx, onboardingSaga, parseOnboardingInput));
      const subject = {
        givenName: prepared.input.employee.givenName,
        familyName: prepared.input.employee.familyName,
        userPrincipalName: prepared.input.employee.userPrincipalName,
      };
      // Shared identity contract: the capability binding (environment
      // state) selects the Adapter. No org/provider branch — the same
      // three steps run for every bound identity stack.
      const created = await step.do("identity-provision-v1", () =>
        capabilityOperation(ctx, onboardingSagaDef, prepared, {
          op: "identity-provision-v1",
          position: 1,
          capability: IDENTITY_CAPABILITY,
          adapterFor: identityAdapterFor,
          vendorDefaultMs: IDENTITY_TIMEOUT_MS,
          failureCode: "ONBOARDING_IDENTITY_FAILED",
          failureMessage: "Employee onboarding could not create the identity.",
          call: (binding, _secrets, deadline, operationId) =>
            binding.adapter.createIdentity(
              {
                directory: binding.directory,
                loadTransport: binding.loadTransport,
                executionId: binding.executionId,
              },
              subject,
              operationId,
              deadline,
            ),
        }),
      );
      if (!created.ok) {
        await step.do("persist-failure-v1", () => failSagaExecution(ctx.db, id, created.error));
        terminalWritten = true;
        throw new NonRetryableError(created.error.code);
      }
      const grouped = await step.do("groups-assign-v1", () =>
        capabilityOperation(ctx, onboardingSagaDef, prepared, {
          op: "groups-assign-v1",
          position: 2,
          capability: GROUPS_CAPABILITY,
          adapterFor: identityAdapterFor,
          vendorDefaultMs: IDENTITY_TIMEOUT_MS,
          failureCode: "ONBOARDING_GROUPS_FAILED",
          failureMessage: "Employee onboarding could not assign groups.",
          call: (binding, _secrets, deadline, operationId) =>
            binding.adapter.assignToGroups(
              {
                directory: binding.directory,
                loadTransport: binding.loadTransport,
                executionId: binding.executionId,
              },
              created.result.userId,
              prepared.input.groups,
              operationId,
              deadline,
            ),
        }),
      );
      if (!grouped.ok) {
        await step.do("persist-failure-v1", () => failSagaExecution(ctx.db, id, grouped.error));
        terminalWritten = true;
        throw new NonRetryableError(grouped.error.code);
      }
      const mailed = await step.do("mailbox-provision-v1", () =>
        capabilityOperation(ctx, onboardingSagaDef, prepared, {
          op: "mailbox-provision-v1",
          position: 3,
          capability: MAIL_CAPABILITY,
          adapterFor: identityAdapterFor,
          vendorDefaultMs: IDENTITY_TIMEOUT_MS,
          failureCode: "ONBOARDING_MAILBOX_FAILED",
          failureMessage: "Employee onboarding could not provision the mailbox.",
          call: (binding, _secrets, deadline, operationId) =>
            binding.adapter.provisionMailbox(
              {
                directory: binding.directory,
                loadTransport: binding.loadTransport,
                executionId: binding.executionId,
              },
              created.result.userId,
              operationId,
              deadline,
            ),
        }),
      );
      if (!mailed.ok) {
        await step.do("persist-failure-v1", () => failSagaExecution(ctx.db, id, mailed.error));
        terminalWritten = true;
        throw new NonRetryableError(mailed.error.code);
      }
      // escape-hatch-begin: Entra-only licensing stays provider-direct
      // (ADR TBD §1). Optional access: orgs without a Graph Connection
      // resolve None and skip, so the shared path above never branches. The
      // frozen-binding gate keeps the hatch from firing against another
      // stack's identifiers in heterogeneous orgs: it runs only when this
      // Execution's identity binding froze to Graph.
      const licensed = await step.do("entra-license-v1", () =>
        optionalIntegrationOperation(ctx, onboardingSagaDef, prepared, {
          op: "entra-license-v1",
          position: 4,
          integrationId: GRAPH_INTEGRATION_ID,
          onlyWhen: { capability: IDENTITY_CAPABILITY, integrationId: GRAPH_INTEGRATION_ID },
          vendorDefaultMs: IDENTITY_TIMEOUT_MS,
          failureCode: "ONBOARDING_LICENSE_FAILED",
          failureMessage: "Employee onboarding could not assign the license.",
          call: (connection, _secrets, deadline, operationId) =>
            assignGraphLicense(
              { endpoint: connection.endpoint },
              created.result.userId,
              "entra-p1-fixture",
              operationId,
              deadline,
            ),
        }),
      );
      // escape-hatch-end
      if ("error" in licensed && licensed.error) {
        const failure: SafeError = licensed.error;
        await step.do("persist-failure-v1", () => failSagaExecution(ctx.db, id, failure));
        terminalWritten = true;
        throw new NonRetryableError(failure.code);
      }
      const output: OnboardingResult = {
        userId: created.result.userId,
        userPrincipalName: created.result.userPrincipalName,
        groupsAssigned: [...grouped.result],
        mailboxProvisioned: mailed.result.length > 0,
        escapeHatch: {
          attempted: !("skipped" in licensed),
          applied: "ok" in licensed && licensed.ok === true && licensed.result === true,
        },
      };
      // Native wait primitive, same posture as echo: infrastructure checkpoint,
      // not a product Operation.
      await step.sleep("settle-wait-v1", "1 second");
      await step.do("persist-success-v1", () => completeExecution(ctx.db, id, output));
      return output;
    } catch (error) {
      if (terminalWritten) throw error;
      const failure: SafeError = {
        code: "EXECUTION_FAILED",
        message: "The Execution could not complete. Inspect local runtime diagnostics.",
      };
      await step.do("persist-failure-v1", () => failSagaExecution(ctx.db, id, failure));
      throw new NonRetryableError(failure.code);
    }
  },
});
export class OnboardingWorkflow extends makeSagaWorkflow(onboardingSagaDef) {}
