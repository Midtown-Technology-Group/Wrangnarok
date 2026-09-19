// SPDX-License-Identifier: AGPL-3.0
export const echoSaga = Object.freeze({
  id: "720b9ebf-9b6a-4eac-bae9-6ed22c970401",
  name: "echo",
  revision: "echo-v1",
  description: "MVP slice: prepare input and call the local HTTP echo Integration",
});
export const ECHO_INTEGRATION_ID = "720b9ebf-9b6a-4eac-bae9-6ed22c970402";
export const ninjaSaga = Object.freeze({
  id: "2c79a880-f1ac-4183-b324-d05daffc321a",
  name: "ninjaone-orgs",
  revision: "ninjaone-orgs-v1",
  description: "Rung 1: list NinjaOne organizations read-only over client-credentials OAuth",
});
export const NINJA_INTEGRATION_ID = "0606e237-137b-4629-8346-85468e1c2df6";
// Second migration pilot (issue #115): read-only NinjaOne organization
// lookup by name, re-authored from workspace
// `features/ninjaone/workflows/sync_organizations.py` (private
// bifrost-workspace; unreachable from this lane, mapping operator-declared).
// Only the vendor-read half is ported: list the census, match locally, and
// persist the bounded match. Mapping writes stay a follow-up, not this Saga.
// Stable identity per ADR 002 (UUID + revision).
export const ninjaLookupSaga = Object.freeze({
  id: "aeab823e-c162-437d-835f-b19a05f078b6",
  name: "ninjaone-org-lookup",
  revision: "ninjaone-org-lookup-v1",
  description: "Pilot: find NinjaOne organizations by name over a read-only census",
});
// TOOL-01 HaloPSA Code Mode provider (issue #170, ADR 022): stable identity
// for the OpenAPI proof Integration. Never changes across source edits.
export const HALO_INTEGRATION_ID = "a1b2c3d4-0000-4111-8111-000000000001";
// AI-01 provider Integration identities (issue #164, ADR 032): stable UUIDs
// for the five upstream provider kinds. Never change across source edits.
export const OPENAI_INTEGRATION_ID = "b2c3d4e5-0000-4111-8111-000000000001";
export const ANTHROPIC_INTEGRATION_ID = "c3d4e5f6-0000-4111-8111-000000000001";
export const GOOGLE_INTEGRATION_ID = "d4e5f6a7-0000-4111-8111-000000000001";
export const OPENROUTER_INTEGRATION_ID = "e5f6a7b8-0000-4111-8111-000000000001";
export const OPENAI_COMPATIBLE_INTEGRATION_ID = "f6a7b8c9-0000-4111-8111-000000000001";
// AI-01 provider kinds (issue #164, ADR 032): the five upstream provider
// kinds as Integration-definition names. Stable slugs; the definitions land
// in src/integrations/index.ts in the build slice.
export const AI_PROVIDER_KINDS = ["openai", "anthropic", "google", "openrouter", "openai-compatible"] as const;
export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number];
/** Upstream default-assignment keys (issue #164): the six fixed routing keys
 * profiles resolve through. Org-scoped rows in the build slice; no
 * platform-global tier in v1 (ADR 032). */
export const AI_ASSIGNMENT_KEYS = [
  "primary",
  "summarization",
  "tuning",
  "image_generation",
  "video_generation",
  "chat_default",
] as const;
export type AiAssignmentKey = (typeof AI_ASSIGNMENT_KEYS)[number];
// Phase 2 multi-Integration Saga: NinjaOne census digested through the echo
// Integration. Stable identity per ADR 002 (UUID + revision).
export const digestSaga = Object.freeze({
  id: "5f3bf136-ba9e-4529-8842-6786270ee80d",
  name: "ninjaone-echo-digest",
  revision: "ninjaone-echo-digest-v1",
  description: "Phase 2: NinjaOne organization census digested through the echo Integration",
});
// system.smoke is loopback-free: D1-only Operations + transform steps, zero
// external vendor dependency. Stable identity per ADR 002 (UUID + revision).
export const smokeSaga = Object.freeze({
  id: "7a1f3c5e-9b2d-4f6a-8c1e-5d3b7a9f1c2e",
  name: "system.smoke",
  revision: "system.smoke-v1",
  description:
    "Platform smoke: Worker request handling, D1 write/read verification, multi-Operation Workflow, terminal persistence, usage block — no vendor dependency",
});
// Migration pilot (issue #119): workspace `workflows/sample/hello_world.py`
// re-authored as a TypeScript Saga. Stable identity per ADR 002 (UUID + revision).
export const helloSaga = Object.freeze({
  id: "395e15f0-3627-41f6-8922-008ce37e3b35",
  name: "hello",
  revision: "hello-v1",
  description:
    "Migration pilot: prepare input plus a pure greeting transform shaped from the workspace hello_world workflow — no vendor dependency",
});
// Nested-invocation demo (RUN-02, issue #136, ADR 018): a parent Saga that
// invokes the hello Saga as an authorized child and awaits its typed JSON
// output. Stable identity per ADR 002 (UUID + revision).
export const helloParentSaga = Object.freeze({
  id: "c0ff4b1e-7a2d-4a1e-9c3d-5e6f7a8b9c0d",
  name: "hello-parent",
  revision: "hello-parent-v1",
  description: "Nested-invocation demo: invoke the hello Saga as a child and await its greeting",
});
// Zone Inventory migration (issues #116 MIG-01, #119 MIG-02): the
// `cloudflare-zone-inventory` bundle re-authored as TypeScript Sagas. The
// Bifrost manifest UUIDs are source identity only (docs/migration-bridge.md);
// the registered IDs below are minted Wrangnarok identity, mapped explicitly
// in docs/migration-pilot.md. Stable identity per ADR 002 (UUID + revision).
export const cloudflareVerifySaga = Object.freeze({
  id: "9d2f4a6c-3b1e-4f5a-9c2d-6e8f0a1b2c3d",
  name: "cloudflare-verify-connection",
  revision: "cloudflare-verify-connection-v1",
  description: "Zone Inventory migration: verify the Cloudflare API credential and account mapping read-only",
});
export const cloudflareInventorySaga = Object.freeze({
  id: "7c1e3b5a-2d4f-4e6b-8a1c-5d7f9e0a1b2c",
  name: "cloudflare-inventory-zones",
  revision: "cloudflare-inventory-zones-v1",
  description: "Zone Inventory migration: bounded read-only inventory of Cloudflare zones",
});
// Account posture slice (issue #252): three read-only Sagas on the existing
// Cloudflare Integration. New Wrangnarok-native surface, no upstream
// counterpart (Bifrost has no Cloudflare-account concept). Stable identity
// per ADR 002 (UUID + revision); never change across source edits.
export const cloudflareAuditSaga = Object.freeze({
  id: "5b0448bb-ab43-4ed1-8315-81b96ad7b57f",
  name: "cloudflare-audit-logs",
  revision: "cloudflare-audit-logs-v1",
  description: "Account posture: bounded read-only summary of Cloudflare Audit Logs v2 with filter classes",
});
export const cloudflareInsightsSaga = Object.freeze({
  id: "ade72191-699d-4f95-aec5-f786fef6fc67",
  name: "cloudflare-security-insights",
  revision: "cloudflare-security-insights-v1",
  description: "Account posture: advisory-first Security Insights list with unresolved-Critical tracking",
});
export const cloudflarePostureSaga = Object.freeze({
  id: "92baddec-e920-4f42-bf8c-772fac55e427",
  name: "cloudflare-posture-benchmark",
  revision: "cloudflare-posture-benchmark-v1",
  description: "Account posture: typed benchmark checks over already-called Cloudflare APIs plus manual controls",
});
export const CLOUDFLARE_INTEGRATION_ID = "6b0d2a48-1c3e-4d5a-7b9a-4c6e8d0f2a1b";
// Capability-based Connection resolution (issue #262, ADR TBD): stable
// Integration identities for the three proving-scenario identity stacks.
// Never change across source edits. The `ad` Integration holds directory
// configuration only; execution reaches it through the NinjaOne Transport.
export const GRAPH_INTEGRATION_ID = "a7c3e5d1-2b4f-4a6c-8e0d-1f3a5b7c9d2e";
export const GOOGLEWORKSPACE_INTEGRATION_ID = "b8d4f6e2-3c5a-4b7d-9f1e-2a4b6c8d0f3a";
export const AD_INTEGRATION_ID = "c9e5a7f3-4d6b-4c8e-0a2f-3b5c7d9e1f4b";
// Employee Onboarding proving Saga (issue #262, ADR TBD §7): one Saga source
// requests semantic capabilities and runs unmodified across the Entra,
// AD-via-Ninja, and Google Workspace bindings. Stable identity per ADR 002.
export const onboardingSaga = Object.freeze({
  id: "e4b1d2f3-8a5c-4d6e-9f0a-1b2c3d4e5f6a",
  name: "employee-onboarding",
  revision: "employee-onboarding-v1",
  description: "Capability-routed employee onboarding: create identity, assign groups, provision mailbox",
});
// Semantic capability names requested by the Onboarding Saga (ADR TBD §1:
// opaque dotted strings; the name is the whole contract in v1).
export const IDENTITY_CAPABILITY = "identity.primary";
export const GROUPS_CAPABILITY = "groups.primary";
export const MAIL_CAPABILITY = "mail.primary";
export const ONBOARDING_REQUIRED_CAPABILITIES: readonly string[] = Object.freeze([
  IDENTITY_CAPABILITY,
  GROUPS_CAPABILITY,
  MAIL_CAPABILITY,
]);
// Identity-vendor deadline for the capability-routed Actions (same posture
// as echo/ninjaone: the Integration enforces its own deadline and surfaces
// a vendor-timeout Fault; failSagaExecution classifies it).
export const IDENTITY_TIMEOUT_MS = 5000;
// Disposable smoke Organization (ADR 004): smoke runs here, never against
// production tenant/Connection data. Seeded in tests; provisioned in dev via
// the runbook (docs/architecture/004-ci-cd.md).
export const SMOKE_ORG_NAME = "org_system_smoke";
export const SMOKE_ORG_ID = "11111111-1111-4111-8111-111111111111";
export const SMOKE_USER_ID = "22222222-2222-4222-8222-222222222222";
// Token lives on the regional host, not the central app host: derive it from
// the Connection endpoint origin (verified live 2026-09-09: us2 answers
// /oauth/token, app.ninjarmm.com does not know us2 clients). Read-only scope:
// the M2M app carries monitoring only, and management is rejected for it.
export const NINJA_TOKEN_PATH = "/oauth/token";
export const NINJA_SCOPE = "monitoring";
export const NINJA_ORGS_PATH = "/v2/organizations";
export const BODY_LIMIT = 4096;
export const RECOVERY_WINDOW_MS = 15 * 60 * 1000;
// Canonical per ADR 001 (reconciled #15): deterministic 64-hex Execution ID
// scoped to (org, user, key); required Idempotency-Key 16-128; Pending never
// auto-swept; operator step-retry ceiling 2. Schedule promotion submits
// directly to Pending (TRG-01, issue #436): no Scheduled execution state.
export const STEP_RETRY_CEILING = 2;
// Explicit vendor deadline (issue #16): the echo vendor step enforces its own
// deadline and surfaces ECHO_VENDOR_TIMEOUT. TimedOut is only ever written by
// failSagaExecution's classification (ADR-033-3, issue #414), never inferred
// from introspection.
export const VENDOR_TIMEOUT_MS = 1000;
// NinjaOne vendor deadline (Phase 2, issue #76): same posture as echo — the
// Integration enforces its own deadline and surfaces NINJA_VENDOR_TIMEOUT
// for both aborted and merely-late vendors. Every terminal routes through
// failSagaExecution; any surviving legacy timeout-mark-v1 Saga step (see the
// #416 migration order in ADR 033) fails closed to the vendor retry budget
// (0 by default) until its migration lands.
export const NINJA_TIMEOUT_MS = 5000;
// --- Persisted per-Saga runtime policy (RUN-01, ADR 018) --------------------
// NEVER Saga source: buildCatalog rejects these keys, and ordinary callers
// cannot change them. One row per (org, Saga) in D1 `saga_policies`; every
// Execution snapshots the applied policy into `executions.policy_json` so the
// applied behavior stays inspectable after later policy edits. Missing rows
// resolve to DEFAULT_SAGA_POLICY, never to an invented per-Saga guess.
export interface SagaRetryPolicy {
  /** Engine-loss-only checkpoint retry ceiling (0-2, default 2). */
  readonly checkpointRetries: number;
  /** Integration/vendor step retry ceiling (0-2, default 0). */
  readonly vendorRetries: number;
}
export interface SagaTimeoutPolicy {
  /** Per-Operation vendor deadline in ms (0 disables, default by Integration). */
  readonly vendorTimeoutMs: number;
  /** Native Workflow step timeout label (fixed platform text, default below). */
  readonly stepTimeout: string;
}
export interface SagaAdmissionPolicy {
  /** Whether new Executions dispatch (default true). False fences submit. */
  readonly enabled: boolean;
  /** Max concurrent active (Pending/Running/Cancelling) Executions; 0 = unbounded. */
  readonly maxConcurrent: number;
}
export interface SagaRuntimePolicy {
  readonly timeout: SagaTimeoutPolicy;
  readonly retry: SagaRetryPolicy;
  /** Pause is admission-only (enabled=false): in-flight Executions keep their
   * snapshot and run to their own terminal; no new dispatches under the key. */
  readonly admission: SagaAdmissionPolicy;
}
export const POLICY_VERSION = 1;
export const POLICY_JSON_BOUND = 2048;
const POLICY_STEP_TIMEOUTS = ["10 seconds"] as const;
export const DEFAULT_VENDOR_TIMEOUT_MS: Readonly<Record<string, number>> = Object.freeze({
  echo: VENDOR_TIMEOUT_MS,
  ninjaone: NINJA_TIMEOUT_MS,
});
export const DEFAULT_SAGA_POLICY: SagaRuntimePolicy = {
  timeout: { vendorTimeoutMs: 0, stepTimeout: "10 seconds" },
  retry: { checkpointRetries: STEP_RETRY_CEILING, vendorRetries: 0 },
  admission: { enabled: true, maxConcurrent: 0 },
};
function policyFault(message: string): Fault {
  return new Fault(400, "INVALID_POLICY", message);
}
/** Pure parser for operator-supplied policy bodies. Unknown keys reject;
 * partial bodies merge over the current policy (defaults for a fresh row). */
export function parseSagaPolicy(value: unknown, base: SagaRuntimePolicy = DEFAULT_SAGA_POLICY): SagaRuntimePolicy {
  if (!object(value)) throw policyFault("Policy must be a JSON object with timeout, retry, and admission sections.");
  for (const key of Object.keys(value)) {
    if (!["timeout", "retry", "admission", "version"].includes(key)) {
      throw policyFault(`Unknown policy field "${key}".`);
    }
  }
  const timeoutRaw = value.timeout ?? {};
  const retryRaw = value.retry ?? {};
  const admissionRaw = value.admission ?? {};
  if (!object(timeoutRaw) || !object(retryRaw) || !object(admissionRaw)) {
    throw policyFault("Policy sections timeout, retry, and admission must be objects.");
  }
  for (const key of Object.keys(timeoutRaw)) {
    if (!["vendorTimeoutMs", "stepTimeout"].includes(key)) throw policyFault(`Unknown timeout field "${key}".`);
  }
  for (const key of Object.keys(retryRaw)) {
    if (!["checkpointRetries", "vendorRetries"].includes(key)) throw policyFault(`Unknown retry field "${key}".`);
  }
  for (const key of Object.keys(admissionRaw)) {
    if (!["enabled", "maxConcurrent"].includes(key)) throw policyFault(`Unknown admission field "${key}".`);
  }
  const vendorTimeoutMs = timeoutRaw.vendorTimeoutMs ?? base.timeout.vendorTimeoutMs;
  if (
    typeof vendorTimeoutMs !== "number" ||
    !Number.isInteger(vendorTimeoutMs) ||
    vendorTimeoutMs < 0 ||
    vendorTimeoutMs > 30000
  ) {
    throw policyFault("timeout.vendorTimeoutMs must be an integer 0 to 30000 (0 disables the override).");
  }
  const stepTimeout = timeoutRaw.stepTimeout ?? base.timeout.stepTimeout;
  if (typeof stepTimeout !== "string" || !(POLICY_STEP_TIMEOUTS as readonly string[]).includes(stepTimeout)) {
    throw policyFault('timeout.stepTimeout must be "10 seconds".');
  }
  const checkpointRetries = retryRaw.checkpointRetries ?? base.retry.checkpointRetries;
  if (
    typeof checkpointRetries !== "number" ||
    !Number.isInteger(checkpointRetries) ||
    checkpointRetries < 0 ||
    checkpointRetries > STEP_RETRY_CEILING
  ) {
    throw policyFault(`retry.checkpointRetries must be an integer 0 to ${STEP_RETRY_CEILING}.`);
  }
  const vendorRetries = retryRaw.vendorRetries ?? base.retry.vendorRetries;
  if (
    typeof vendorRetries !== "number" ||
    !Number.isInteger(vendorRetries) ||
    vendorRetries < 0 ||
    vendorRetries > STEP_RETRY_CEILING
  ) {
    throw policyFault(`retry.vendorRetries must be an integer 0 to ${STEP_RETRY_CEILING}.`);
  }
  const enabled = admissionRaw.enabled ?? base.admission.enabled;
  if (typeof enabled !== "boolean") throw policyFault("admission.enabled must be a boolean.");
  const maxConcurrent = admissionRaw.maxConcurrent ?? base.admission.maxConcurrent;
  if (
    typeof maxConcurrent !== "number" ||
    !Number.isInteger(maxConcurrent) ||
    maxConcurrent < 0 ||
    maxConcurrent > 100
  ) {
    throw policyFault("admission.maxConcurrent must be an integer 0 to 100 (0 is unbounded).");
  }
  return {
    timeout: { vendorTimeoutMs, stepTimeout },
    retry: { checkpointRetries, vendorRetries },
    admission: { enabled, maxConcurrent },
  };
}
/** Resolve the effective vendor deadline: a per-Saga override wins when set;
 * 0 means the Integration default (echo 1000ms, ninjaone 5000ms). */
export function vendorDeadlineMs(policy: SagaRuntimePolicy, integrationDefaultMs: number): number {
  return policy.timeout.vendorTimeoutMs > 0 ? policy.timeout.vendorTimeoutMs : integrationDefaultMs;
}
/** Resolve the effective vendor step retry limit: engine-loss-only with the
 * operator ceiling. Business/expected failures still throw NonRetryableError
 * so the engine never retries a non-idempotent mutation. */
export function vendorRetryLimit(policy: SagaRuntimePolicy): number {
  return Math.min(policy.retry.vendorRetries, STEP_RETRY_CEILING);
}
/** Resolve the effective checkpoint retry limit through the same operator ceiling. */
export function checkpointRetryLimit(policy: SagaRuntimePolicy): number {
  return Math.min(policy.retry.checkpointRetries, STEP_RETRY_CEILING);
}
export const EXECUTION_ID = /^[a-f0-9]{64}$/;
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export type ExecutionStatus = "Pending" | "Running" | "Succeeded" | "Failed" | "TimedOut" | "Cancelling" | "Cancelled";
// Retry policy table (upstream finding 14, issue #16): vendor/Integration
// steps never auto-retry (0) unless destination-side idempotency is proven and
// an explicit policy exists; only idempotent D1 checkpoint steps may retry, up
// to the operator ceiling. Unknown step names fail closed to 0. Unit-tested as
// pure TypeScript; Sagas must resolve every step.do retry limit through here.
// ADR-033-3 (issue #414) retired timeout-mark-v1 from this set:
// failSagaExecution classifies Failed vs TimedOut inside persist-failure-v1,
// so no distinct timeout checkpoint exists. Any surviving legacy Saga step
// still emitting the name (see the #416 migration order in ADR 033) resolves
// 0 until its migration lands; unknown names fail closed to 0, which the
// domain suite pins so the drift is loud, not silent.
const CHECKPOINT_STEPS: ReadonlySet<string> = new Set(["prepare-input-v1", "persist-success-v1", "persist-failure-v1"]);
/** Child-dispatch Operations (`child-dispatch-<step>`) converge on one
 * deterministic child row, so they retry like other idempotent D1
 * checkpoints. Matched by prefix: each parent step dispatches under its own
 * Operation name. */
const CHILD_DISPATCH_PREFIX = "child-dispatch-";
export function stepRetryLimit(stepName: string): number {
  if (stepName.startsWith(CHILD_DISPATCH_PREFIX)) return STEP_RETRY_CEILING;
  return CHECKPOINT_STEPS.has(stepName) ? STEP_RETRY_CEILING : 0;
}
// Canonical transition table (ADR 001). Cancelling is transient:
// Pending/Running -> Cancelling -> Cancelled. Once the owner-requested
// Cancelling marker is written, cancel wins: a terminal checkpoint that
// lands after it is the stale one and no-ops, so an acknowledged
// cancellation is never flipped to Failed afterward. Terminal states have
// no outgoing transitions. Unit-tested as pure TypeScript.
const EXECUTION_TRANSITIONS: Record<ExecutionStatus, readonly ExecutionStatus[]> = {
  // TRG-01 (issue #436): no Scheduled execution state exists. Schedule
  // promotion submits directly to Pending through submit(); schedule
  // disable/delete plus Pending/Running cancellation cover the lifecycle.
  Pending: ["Running", "Failed", "Cancelling"],
  Running: ["Succeeded", "Failed", "TimedOut", "Cancelling"],
  Cancelling: ["Cancelled"],
  Succeeded: [],
  Failed: [],
  TimedOut: [],
  Cancelled: [],
};
export function canTransition(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return EXECUTION_TRANSITIONS[from].includes(to);
}
// Native terminate() outcome (RUN-04, issue #151): the local REST surface
// throws exact-code Errors after the Workflow engine handles the control —
// "WorkflowError: (instance.cannot_terminate) ..." when the instance already
// sits in a finite state (complete/errored/terminated), and "instance.not_found"
// when no such native instance exists. Everything else (transient or
// control-plane failures, timeouts, non-Error throws, messages without a
// known code) fails closed to ambiguous: the route must NOT report a confirmed
// stop it never observed. Pure and unit-tested; never surfaces native text.
export type TerminateOutcome = "stopped" | "already-settled" | "not-found" | "ambiguous";
export function classifyTerminateError(error: unknown): TerminateOutcome {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (message.includes("instance.cannot_terminate")) return "already-settled";
  if (message.includes("instance.not_found")) return "not-found";
  return "ambiguous";
}
// Operation state model (ADR 010 section 2, Phase 1b follow-up). Operations
// stay within ('Running','Succeeded','Failed'); the timeout code lives in
// error_json, never as an Operation status. A step (re)begin moves a fresh
// row to Running or resets a retried Running row; terminal rows are never
// resurrected — begin/finish writes are fenced on status='Running' in SQL,
// and this table is the pure-TypeScript gate for the same rule.
export type OperationStatus = "Running" | "Succeeded" | "Failed";
const OPERATION_TRANSITIONS: Record<OperationStatus, readonly OperationStatus[]> = {
  Running: ["Succeeded", "Failed"],
  Succeeded: [],
  Failed: [],
};
export function canTransitionOperation(from: OperationStatus, to: OperationStatus): boolean {
  return OPERATION_TRANSITIONS[from].includes(to);
}
export interface Principal {
  readonly userId: string;
  readonly orgId: string;
}
export interface EchoInput {
  message: string;
}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- input-less Saga: no parameters by design
export interface NinjaOrgsInput {
  /* empty: read-only census, no parameters */
}
export interface NinjaOrgSummary {
  id: number;
  name: string;
}
export interface NinjaOrgsResult {
  organizationCount: number;
  organizations: NinjaOrgSummary[];
}
export interface NinjaLookupInput {
  query: string;
}
export interface NinjaLookupResult {
  query: string;
  organizationCount: number;
  matchCount: number;
  matches: NinjaOrgSummary[];
}
/** Pure transform: case-insensitive substring match over a read-only census.
 * matchCount totals the matches within the given census; matches are bounded
 * for persistence like the census itself. The lookup inherits the census
 * bound (first NINJA_ORGS_MAX): organizations beyond it are out of lookup
 * scope until paginated reads exist. */
export function matchNinjaOrgs(
  organizations: readonly NinjaOrgSummary[],
  query: string,
): { matchCount: number; matches: NinjaOrgSummary[] } {
  const needle = query.toLowerCase();
  const all = organizations
    .filter((org) => org.name.toLowerCase().includes(needle))
    .map((org) => ({ id: org.id, name: org.name }));
  return { matchCount: all.length, matches: all.slice(0, NINJA_ORGS_MAX) };
}
export const NINJA_ORGS_MAX = 25;
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- input-less Saga: no parameters by design
export interface DigestInput {
  /* empty: census is read live, digest shaped in-Saga */
}
export interface DigestResult {
  organizationCount: number;
  echoed: EchoInput;
}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- input-less Saga: no parameters by design
export interface SmokeInput {
  /* empty: loopback-free census, no parameters */
}
export interface SmokeResult {
  d1WriteOk: boolean;
  d1ReadOk: boolean;
  operationCount: number;
  operations: string[];
}
export interface HelloInput {
  name: string;
}
// codex/hello-domain (issues #377, #372): the accepted hello name must fit
// every downstream bound it flows into. The HelloResult stores the name twice
// (greeting plus name) after JSON escaping, both log lines prefix it, and the
// INFO data row re-serializes it, so the input bound is sized from the
// tightest downstream fit, not from the raw transport cap.
export const HELLO_NAME_MAX_BYTES = 512;
export const HELLO_NAME_MAX_CHARS = 512;
// D1 CHECK bounds the persisted rows ride under: `length()` counts UTF-16
// code units on TEXT, so the budget is in characters, not bytes. The result
// rows carry the HelloResult JSON; the log rows carry the prefixed messages
// and the serialized data payload.
export const RESULT_JSON_MAX_CHARS = 4096;
export const LOG_MESSAGE_MAX_CHARS = 1024;
export const LOG_DATA_MAX_BYTES = 2048;
/** Persisted size of the HelloResult for one name: the name appears twice
 * (greeting plus name) after JSON escaping. Pure and unit-tested. */
export function helloNameResultChars(name: string): number {
  return JSON.stringify({ greeting: `Hello, ${name}!`, name }).length;
}
export interface HelloResult {
  greeting: string;
  name: string;
}
export interface HelloParentInput {
  name: string;
  childKey?: string;
}
export interface HelloParentResult {
  greeting: string;
  name: string;
  childExecutionId: string;
}
export interface ExecutionParams {
  executionId: string;
}
export interface SafeError {
  code: string;
  message: string;
}

/** One structured validation failure: names the offending field plus a
 * machine-readable code. Whole-body errors use an empty field name. */
export interface FieldFailure {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export class Fault extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "Fault";
  }
}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function parseInput(value: unknown): EchoInput {
  if (
    !object(value) ||
    Object.keys(value).some((key) => key !== "message") ||
    typeof value.message !== "string" ||
    value.message.length === 0 ||
    new TextEncoder().encode(value.message).length > 1024
  ) {
    throw new Fault(400, "INVALID_INPUT", "Expected one message of 1 to 1024 UTF-8 bytes.");
  }
  return { message: value.message };
}
export function parseNinjaOrgsInput(value: unknown): NinjaOrgsInput {
  if (!object(value) || Object.keys(value).length !== 0) {
    throw new Fault(400, "INVALID_INPUT", "The ninjaone-orgs Saga takes an empty input object.");
  }
  return {};
}
/** Lookup query bound (issue #115): one name fragment, non-empty and short
 * enough to persist verbatim in the result row. Rejects with INVALID_INPUT;
 * never truncates caller input. */
export const NINJA_LOOKUP_QUERY_MAX_CHARS = 128;
export const NINJA_LOOKUP_QUERY_MAX_BYTES = 256;
export function parseNinjaLookupInput(value: unknown): NinjaLookupInput {
  const message = "The ninjaone-org-lookup Saga takes one query of 1 to 128 characters.";
  if (!object(value) || Object.keys(value).some((key) => key !== "query")) {
    throw new Fault(400, "INVALID_INPUT", message);
  }
  const query = (value as Record<string, unknown>).query;
  if (
    typeof query !== "string" ||
    query.length === 0 ||
    query.length > NINJA_LOOKUP_QUERY_MAX_CHARS ||
    new TextEncoder().encode(query).length > NINJA_LOOKUP_QUERY_MAX_BYTES
  ) {
    throw new Fault(400, "INVALID_INPUT", message);
  }
  return { query };
}
export function parseSmokeInput(value: unknown): SmokeInput {
  if (!object(value) || Object.keys(value).length !== 0) {
    throw new Fault(400, "INVALID_INPUT", "The system.smoke Saga takes an empty input object.");
  }
  return {};
}
/** Pure bound check shared by the hello and hello-parent parsers: an accepted
 * name must fit the D1 result CHECK after JSON escaping/duplication, both
 * prefixed author-log lines after scrubbing, and the INFO data row. Rejects
 * with INVALID_INPUT; never truncates caller input. */
export function checkHelloName(name: unknown): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new Fault(400, "INVALID_INPUT", `Expected one name of 1 to ${HELLO_NAME_MAX_BYTES} UTF-8 bytes.`);
  }
  if (name.length > HELLO_NAME_MAX_CHARS || new TextEncoder().encode(name).length > HELLO_NAME_MAX_BYTES) {
    throw new Fault(400, "INVALID_INPUT", `Expected one name of 1 to ${HELLO_NAME_MAX_BYTES} UTF-8 bytes.`);
  }
  if (helloNameResultChars(name) > RESULT_JSON_MAX_CHARS) {
    throw new Fault(400, "INVALID_INPUT", `Expected one name of 1 to ${HELLO_NAME_MAX_BYTES} UTF-8 bytes.`);
  }
  if (
    `Greeting ${name}`.length > LOG_MESSAGE_MAX_CHARS ||
    `Hello Saga greeted ${name}`.length > LOG_MESSAGE_MAX_CHARS
  ) {
    throw new Fault(400, "INVALID_INPUT", `Expected one name of 1 to ${HELLO_NAME_MAX_BYTES} UTF-8 bytes.`);
  }
  if (new TextEncoder().encode(JSON.stringify({ name })).length > LOG_DATA_MAX_BYTES) {
    throw new Fault(400, "INVALID_INPUT", `Expected one name of 1 to ${HELLO_NAME_MAX_BYTES} UTF-8 bytes.`);
  }
  return name;
}
export function parseHelloInput(value: unknown): HelloInput {
  if (!object(value) || Object.keys(value).some((key) => key !== "name")) {
    throw new Fault(400, "INVALID_INPUT", `Expected one name of 1 to ${HELLO_NAME_MAX_BYTES} UTF-8 bytes.`);
  }
  return { name: checkHelloName(value.name) };
}
export function parseHelloParentInput(value: unknown): HelloParentInput {
  if (!object(value) || Object.keys(value).some((key) => !["name", "childKey"].includes(key))) {
    throw new Fault(400, "INVALID_INPUT", "Expected a name plus an optional childKey.");
  }
  if (typeof value.name !== "string" || value.name.length === 0) {
    throw new Fault(400, "INVALID_INPUT", `Expected one name of 1 to ${HELLO_NAME_MAX_BYTES} UTF-8 bytes.`);
  }
  const name = checkHelloName(value.name);
  if (value.childKey !== undefined) {
    if (typeof value.childKey !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.childKey)) {
      throw new Fault(400, "INVALID_INPUT", "The childKey must be 1 to 128 safe characters.");
    }
    return { name, childKey: value.childKey };
  }
  return { name };
}
export function parseDigestInput(value: unknown): DigestInput {
  if (!object(value) || Object.keys(value).length !== 0) {
    throw new Fault(400, "INVALID_INPUT", "The ninjaone-echo-digest Saga takes an empty input object.");
  }
  return {};
}
export interface OnboardingEmployee {
  readonly givenName: string;
  readonly familyName: string;
  readonly userPrincipalName: string;
}
export interface OnboardingInput {
  readonly employee: OnboardingEmployee;
  readonly groups: readonly string[];
}
export interface OnboardingResult {
  readonly userId: string;
  readonly userPrincipalName: string;
  readonly groupsAssigned: readonly string[];
  readonly mailboxProvisioned: boolean;
  readonly escapeHatch: { readonly attempted: boolean; readonly applied: boolean };
}
const ONBOARDING_NAME_MAX = 128;
const ONBOARDING_UPN_MAX = 256;
const ONBOARDING_GROUPS_MAX = 32;
// Group names echo back into groupsAssigned inside executions.result_json
// (CHECK capped at 4096 chars): 32 names of 64 chars serialize to ~2145
// chars, leaving room for the remaining result fields plus any
// vendor-shaped userId. Bounds reject rather than truncate, per the
// hello-name precedent.
const ONBOARDING_GROUP_MAX = 64;
function checkOnboardingName(field: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > ONBOARDING_NAME_MAX) {
    throw new Fault(400, "INVALID_INPUT", `The onboarding employee ${field} must be 1 to 128 characters.`);
  }
  return value;
}
/** Parse the Onboarding Saga input: one new-hire identity plus optional
 * group names. Bounds mirror the hello-name precedent: every accepted value
 * must fit the D1 result CHECK after JSON escaping, so the parser rejects
 * rather than truncates. Idempotent over its own output. */
export function parseOnboardingInput(value: unknown): OnboardingInput {
  if (!object(value)) {
    throw new Fault(400, "INVALID_INPUT", "The employee-onboarding Saga takes an employee and optional groups.");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "employee" && key !== "groups") {
      throw new Fault(400, "INVALID_INPUT", "The employee-onboarding Saga takes an employee and optional groups.");
    }
  }
  if (!object(record.employee)) {
    throw new Fault(
      400,
      "INVALID_INPUT",
      "The onboarding employee needs givenName, familyName, and userPrincipalName.",
    );
  }
  const employeeRecord = record.employee as Record<string, unknown>;
  for (const key of Object.keys(employeeRecord)) {
    if (key !== "givenName" && key !== "familyName" && key !== "userPrincipalName") {
      throw new Fault(
        400,
        "INVALID_INPUT",
        "The onboarding employee needs givenName, familyName, and userPrincipalName.",
      );
    }
  }
  const givenName = checkOnboardingName("givenName", employeeRecord.givenName);
  const familyName = checkOnboardingName("familyName", employeeRecord.familyName);
  const upn = employeeRecord.userPrincipalName;
  if (typeof upn !== "string" || upn.length === 0 || upn.length > ONBOARDING_UPN_MAX || !upn.includes("@")) {
    throw new Fault(400, "INVALID_INPUT", "The onboarding userPrincipalName must be a 1 to 256 character address.");
  }
  const rawGroups = record.groups === undefined ? [] : record.groups;
  if (!Array.isArray(rawGroups) || rawGroups.length > ONBOARDING_GROUPS_MAX) {
    throw new Fault(400, "INVALID_INPUT", "The onboarding groups must be at most 32 names.");
  }
  const groups: string[] = [];
  for (const entry of rawGroups) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > ONBOARDING_GROUP_MAX) {
      throw new Fault(400, "INVALID_INPUT", "Each onboarding group must be 1 to 128 characters.");
    }
    groups.push(entry);
  }
  return { employee: { givenName, familyName, userPrincipalName: upn }, groups };
}
// Zone Inventory migration (issues #116 MIG-01, #119 MIG-02): Cloudflare
// bearer vendor contract. The bundle's Python bounds are preserved verbatim:
// at most 250 zones, 50 per page, 20s vendor deadline, read-only (no
// mutations exist in this bundle).
export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
export const CLOUDFLARE_VERIFY_PATH = "/user/tokens/verify";
export const CLOUDFLARE_ZONES_PATH = "/zones";
export const CLOUDFLARE_MAX_ZONES = 250;
export const CLOUDFLARE_PAGE_SIZE = 50;
export const CLOUDFLARE_TIMEOUT_MS = 20000;
export const CLOUDFLARE_ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/;
export interface CloudflareAccountBinding {
  readonly id: unknown;
  readonly name: unknown;
}
export interface CloudflareVerifyInput {
  readonly account?: CloudflareAccountBinding;
}
export interface CloudflareInventoryInput {
  readonly maxZones: number;
  readonly account?: CloudflareAccountBinding;
}
/** Optional account envelope (migration binding `entity_id/entity_name`):
 * accepted and carried through the parsed input so the Saga can resolve
 * the account mapping without scraping the raw persisted body. Validated
 * as an object when present; the Integration boundary owns the strict
 * account-ID check. */
function parseCloudflareAccountBinding(value: unknown): CloudflareAccountBinding | undefined {
  if (value === undefined) return undefined;
  if (!object(value)) {
    throw new Fault(400, "INVALID_INPUT", "The account binding must be an object with id and name.");
  }
  const record = value as Record<string, unknown>;
  return { id: record.id ?? null, name: record.name ?? null };
}
export function parseCloudflareVerifyInput(value: unknown): CloudflareVerifyInput {
  if (!object(value)) {
    throw new Fault(400, "INVALID_INPUT", "The cloudflare-verify-connection Saga takes an empty input object.");
  }
  for (const key of Object.keys(value)) {
    if (key !== "account") {
      throw new Fault(400, "INVALID_INPUT", "The cloudflare-verify-connection Saga takes an empty input object.");
    }
  }
  const account = parseCloudflareAccountBinding((value as Record<string, unknown>).account);
  return account === undefined ? {} : { account };
}
export function parseCloudflareInventoryInput(value: unknown): CloudflareInventoryInput {
  if (!object(value)) {
    throw new Fault(400, "INVALID_INPUT", `max_zones must be an integer between 1 and ${CLOUDFLARE_MAX_ZONES}.`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "max_zones" && key !== "maxZones" && key !== "account") {
      throw new Fault(400, "INVALID_INPUT", `max_zones must be an integer between 1 and ${CLOUDFLARE_MAX_ZONES}.`);
    }
  }
  // The bundle default (Python `max_zones: int = MAX_ZONES`) is preserved:
  // an omitted key inventories the full bound. The parsed camelCase form is
  // accepted too: submit persists parsed input and prepareExecution
  // re-parses it, so the parser must be idempotent over its own output.
  const raw =
    record.maxZones === undefined
      ? record.max_zones === undefined
        ? CLOUDFLARE_MAX_ZONES
        : record.max_zones
      : record.maxZones;
  if (typeof raw === "boolean" || typeof raw !== "number" || !Number.isInteger(raw)) {
    throw new Fault(400, "INVALID_INPUT", `max_zones must be an integer between 1 and ${CLOUDFLARE_MAX_ZONES}.`);
  }
  if (raw < 1 || raw > CLOUDFLARE_MAX_ZONES) {
    throw new Fault(400, "INVALID_INPUT", `max_zones must be an integer between 1 and ${CLOUDFLARE_MAX_ZONES}.`);
  }
  const account = parseCloudflareAccountBinding(record.account);
  return account === undefined ? { maxZones: raw } : { maxZones: raw, account };
}
export interface CloudflareAccountRef {
  readonly id: string;
  readonly name: string;
}
export interface CloudflareCredentialStatus {
  readonly status: string;
  readonly expiresOn: string | null;
  readonly notBefore: string | null;
}
export interface CloudflareVerifyResult {
  readonly status: "healthy" | "unhealthy";
  readonly readOnly: true;
  readonly integration: "Cloudflare";
  readonly account: CloudflareAccountRef;
  readonly credential: CloudflareCredentialStatus;
  readonly apiCalls: 1;
}
export interface CloudflareZoneSummary {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly type: string;
  readonly paused: boolean;
  readonly developmentModeActive: boolean;
  readonly accountId: string;
  readonly accountName: string;
  readonly plan: string;
  readonly nameServers: readonly string[];
  readonly activatedOn: string | null;
  readonly modifiedOn: string | null;
}
export interface CloudflareInventorySummary {
  readonly statusCounts: Readonly<Record<string, number>>;
  readonly typeCounts: Readonly<Record<string, number>>;
  readonly paused: number;
  readonly developmentModeActive: number;
}
export interface CloudflareInventoryResult {
  readonly status: "completed";
  readonly readOnly: true;
  readonly integration: "Cloudflare";
  readonly account: CloudflareAccountRef;
  readonly zoneCount: number;
  readonly totalAvailable: number | null;
  readonly truncated: boolean;
  readonly apiCalls: number;
  readonly summary: CloudflareInventorySummary;
  readonly zones: readonly CloudflareZoneSummary[];
}
// Account posture slice (issue #252): read-only posture validation of the
// Cloudflare account/zone configuration itself. New Wrangnarok-native
// surface, no upstream counterpart. All vendor reads reuse the existing
// Cloudflare Integration discipline (exact-base endpoint, Bearer token as a
// transient secret handle, bounded JSON, shaped safe fields, scrubbed
// errors); findings persist only as bounded shaped summaries on the standard
// submit/ExecutionHistory path — no new D1 tables, no new primitive, no new
// secrets path (single provider-global CLOUDFLARE_API_TOKEN per ADR 005).
export const CLOUDFLARE_AUDIT_LOGS_SUFFIX = "/logs/audit";
export const CLOUDFLARE_INSIGHTS_SUFFIX = "/security-center/insights";
export const CLOUDFLARE_ZONE_SETTINGS_SUFFIX = "/settings";
/** Per-run posture bounds (D1 retention posture: findings live only in
 * ExecutionHistory, so every shaped summary stays small and truncated). */
export const CLOUDFLARE_POSTURE_MAX_ENTRIES = 100;
export const CLOUDFLARE_POSTURE_PAGE_SIZE = 50;
export const CLOUDFLARE_POSTURE_MAX_PAGES = 2;
/** Zone settings the benchmark may read (verified Free-available zone
 * settings endpoints, 2026-09-19). Anything else rejects locally with
 * INVALID_INPUT and is never sent to the vendor. */
export const CLOUDFLARE_ZONE_SETTING_ALLOWLIST: readonly string[] = Object.freeze([
  "ssl",
  "min_tls_version",
  "always_use_https",
  "automatic_https_rewrites",
  "security_header",
]);
/** Zone-settings fan-out bound for the benchmark (checked zones x settings
 * stays small and the exact vendor call count is reported). */
export const CLOUDFLARE_BENCHMARK_DEFAULT_CHECKED_ZONES = 10;
export const CLOUDFLARE_BENCHMARK_MAX_CHECKED_ZONES = 25;
/** Shaped-string bound: vendor prose never persists unbounded. */
export const CLOUDFLARE_POSTURE_MAX_TEXT = 300;

export type AuditEventClass = "token" | "membership" | "zone-config" | "other";
export type AuditActorKind = "human" | "service" | "unknown";
export type InsightSeverity = "critical" | "high" | "medium" | "low" | "info" | "unknown";
export type PostureVerdict = "advisory" | "failing";
export type PostureCheckStatus = "pass" | "fail" | "manual" | "deferred" | "unknown";

export interface CloudflareAuditInput {
  readonly account?: CloudflareAccountBinding;
  /** RFC3339/UTC-date lower bound; defaults to the trailing 24h at execution. */
  readonly since?: string;
  readonly limit?: number;
  readonly classes?: readonly AuditEventClass[];
}
export interface CloudflareAuditEntry {
  readonly id: string;
  readonly actionType: string;
  readonly actionDescription: string | null;
  readonly actionResult: string | null;
  readonly occurredAt: string | null;
  readonly actorKind: AuditActorKind;
  readonly actorEmail: string | null;
  readonly actorTokenName: string | null;
  readonly resourceType: string | null;
  readonly resourceScope: string | null;
  readonly zoneId: string | null;
  readonly zoneName: string | null;
  readonly eventClass: AuditEventClass;
}
export interface CloudflareAuditResult {
  readonly status: "completed";
  readonly readOnly: true;
  readonly integration: "Cloudflare";
  readonly account: CloudflareAccountRef;
  readonly entryCount: number;
  readonly totalAvailable: number | null;
  readonly truncated: boolean;
  readonly apiCalls: number;
  readonly classCounts: Readonly<Record<string, number>>;
  readonly actorKindCounts: Readonly<Record<string, number>>;
  readonly entries: readonly CloudflareAuditEntry[];
}
export interface CloudflareInsightsInput {
  readonly account?: CloudflareAccountBinding;
  readonly limit?: number;
  readonly includeDismissed?: boolean;
  readonly baseline?: PostureBaseline;
}
export interface CloudflareInsightIssue {
  readonly id: string;
  readonly name: string | null;
  readonly issueClass: string | null;
  readonly issueType: string | null;
  readonly severity: InsightSeverity;
  readonly dismissed: boolean;
  readonly zoneId: string | null;
  readonly zoneName: string | null;
}
export interface CloudflareInsightsResult {
  readonly status: "completed";
  readonly readOnly: true;
  readonly integration: "Cloudflare";
  readonly account: CloudflareAccountRef;
  readonly issueCount: number;
  readonly totalAvailable: number | null;
  readonly truncated: boolean;
  readonly apiCalls: number;
  readonly severityCounts: Readonly<Record<string, number>>;
  readonly unresolvedCriticalIds: readonly string[];
  /** Advisory-first: "failing" only when a recorded baseline exists AND a
   * new (unacknowledged) unresolved Critical remains. */
  readonly verdict: PostureVerdict;
  readonly baselineRecordedAt: string | null;
  readonly issues: readonly CloudflareInsightIssue[];
}
/** Recorded baseline + suppressions (canonical file:
 * docs/posture/baseline.json; travels as Saga input so scheduled rows carry
 * the reviewed baseline as input_json). Reviewers: steward + security PR
 * review. Expired suppressions are ignored, never applied. */
export interface PostureSuppression {
  readonly checkId: string;
  readonly reason: string;
  readonly reviewer: string;
  readonly expiresAt: string;
}
export interface PostureZoneExpectations {
  readonly ssl: readonly string[];
  readonly minTlsVersionMin: string;
  readonly alwaysUseHttps: string;
  readonly automaticHttpsRewrites: string;
  readonly securityHeaderEnabled: boolean;
}
export interface PostureBaseline {
  readonly recordedAt: string | null;
  readonly acknowledgedCriticalIds: readonly string[];
  readonly suppressions: readonly PostureSuppression[];
  readonly zoneExpectations: PostureZoneExpectations;
}
export interface CloudflarePostureInput {
  readonly account?: CloudflareAccountBinding;
  readonly maxZones?: number;
  readonly maxCheckedZones?: number;
  readonly settings?: readonly string[];
  readonly baseline?: PostureBaseline;
}
export interface PostureCheck {
  readonly id: string;
  readonly title: string;
  readonly status: PostureCheckStatus;
  readonly detail: string;
  readonly suppressed: boolean;
}
export interface CloudflarePostureResult {
  readonly status: "completed";
  readonly readOnly: true;
  readonly integration: "Cloudflare";
  readonly account: CloudflareAccountRef;
  readonly verdict: PostureVerdict;
  readonly apiCalls: number;
  readonly checks: readonly PostureCheck[];
  readonly manual: readonly PostureCheck[];
  readonly deferred: readonly PostureCheck[];
}
/** Stable benchmark check IDs (suppression keys; never rename). */
export const POSTURE_CHECK_IDS: readonly string[] = Object.freeze([
  "token-active",
  "zone-hygiene",
  "zone-setting-ssl",
  "zone-setting-min_tls_version",
  "zone-setting-always_use_https",
  "zone-setting-automatic_https_rewrites",
  "zone-setting-security_header",
  "insights-no-unresolved-critical",
  "audit-visibility",
]);
/** Honestly-manual controls (no read-only API reports them; never faked). */
export const POSTURE_MANUAL_IDS: readonly string[] = Object.freeze([
  "global-api-key-non-use",
  "token-least-privilege",
  "env-binding-separation",
  "membership-staleness-review",
  "dns-origin-exposure-review",
]);
export const POSTURE_DEFAULT_ZONE_EXPECTATIONS: PostureZoneExpectations = Object.freeze({
  ssl: Object.freeze(["strict"]),
  minTlsVersionMin: "1.2",
  alwaysUseHttps: "on",
  automaticHttpsRewrites: "on",
  securityHeaderEnabled: true,
});

function postureFault(message: string): Fault {
  return new Fault(400, "INVALID_INPUT", message);
}
export function postureBoundedText(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.length > CLOUDFLARE_POSTURE_MAX_TEXT ? value.slice(0, CLOUDFLARE_POSTURE_MAX_TEXT) : value;
}
function parsePostureLimit(raw: unknown, name: string): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > CLOUDFLARE_POSTURE_MAX_ENTRIES) {
    throw postureFault(`${name} must be an integer between 1 and ${CLOUDFLARE_POSTURE_MAX_ENTRIES}.`);
  }
  return raw;
}
function parsePostureSince(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 64) {
    throw postureFault("since must be a non-empty date string (RFC3339 or UTC date).");
  }
  return raw;
}
const AUDIT_EVENT_CLASSES: readonly AuditEventClass[] = Object.freeze(["token", "membership", "zone-config", "other"]);
function parseAuditClasses(raw: unknown): readonly AuditEventClass[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > AUDIT_EVENT_CLASSES.length) {
    throw postureFault("classes must be a non-empty list of token, membership, zone-config, other.");
  }
  const out: AuditEventClass[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !(AUDIT_EVENT_CLASSES as readonly string[]).includes(entry)) {
      throw postureFault("classes must be a non-empty list of token, membership, zone-config, other.");
    }
    if (!out.includes(entry as AuditEventClass)) out.push(entry as AuditEventClass);
  }
  return Object.freeze(out);
}
/** Pure classifier: map one audit entry onto the issue's filter classes from
 * the vendor action/resource text (Audit Logs v2: action.{type,description},
 * resource.{type,scope,product}). First match wins: token > membership >
 * zone-config > other. Unknown shapes are "other", never dropped. */
export function classifyAuditEvent(parts: {
  readonly actionType?: unknown;
  readonly actionDescription?: unknown;
  readonly resourceType?: unknown;
  readonly resourceScope?: unknown;
  readonly resourceProduct?: unknown;
}): AuditEventClass {
  const haystack = [
    parts.actionType,
    parts.actionDescription,
    parts.resourceType,
    parts.resourceScope,
    parts.resourceProduct,
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" ")
    .toLowerCase();
  if (
    haystack.includes("token") ||
    haystack.includes("api key") ||
    haystack.includes("apikey") ||
    haystack.includes("api_key") ||
    haystack.includes("secret")
  ) {
    return "token";
  }
  if (
    haystack.includes("member") ||
    haystack.includes("invit") ||
    haystack.includes("role") ||
    haystack.includes("permission")
  ) {
    return "membership";
  }
  if (
    haystack.includes("zone") ||
    haystack.includes("dns") ||
    haystack.includes("ssl") ||
    haystack.includes("tls") ||
    haystack.includes("firewall") ||
    haystack.includes("waf") ||
    haystack.includes("rule") ||
    haystack.includes("setting") ||
    haystack.includes("certificate")
  ) {
    return "zone-config";
  }
  return "other";
}
/** Pure attribution: deployment/service credentials must stay
 * distinguishable from human actions (Audit Logs v2 actor.{type,email,
 * token_id,token_name}). token_id/token_name presence decides first; the
 * actor type string decides second; anything else is "unknown", never
 * guessed human. */
export function attributeAuditActor(actor: {
  readonly type?: unknown;
  readonly email?: unknown;
  readonly tokenId?: unknown;
  readonly tokenName?: unknown;
}): AuditActorKind {
  if (
    (typeof actor.tokenId === "string" && actor.tokenId.length > 0) ||
    (typeof actor.tokenName === "string" && actor.tokenName.length > 0)
  ) {
    return "service";
  }
  const type = typeof actor.type === "string" ? actor.type.toLowerCase() : "";
  if (
    type.includes("token") ||
    type.includes("api") ||
    type.includes("key") ||
    type.includes("oauth") ||
    type.includes("service") ||
    type.includes("system") ||
    type.includes("bot")
  ) {
    return "service";
  }
  if (type === "user" || type.includes("user") || (typeof actor.email === "string" && actor.email.length > 0)) {
    return "human";
  }
  return "unknown";
}
/** Pure severity normalizer: unrecognized vendor severities are "unknown"
 * (advisory-only downstream), never coerced into a known bucket. */
export function normalizeInsightSeverity(value: unknown): InsightSeverity {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  if (
    normalized === "critical" ||
    normalized === "high" ||
    normalized === "medium" ||
    normalized === "low" ||
    normalized === "info"
  ) {
    return normalized;
  }
  return "unknown";
}
/** Pure verdict: Critical promotes to CI-failing ONLY after a recorded
 * baseline exists (else every new account fails day one). Without
 * recordedAt, even unacknowledged Criticals stay advisory. */
export function evaluateInsightsVerdict(
  unresolvedCriticalIds: readonly string[],
  baseline: PostureBaseline | undefined,
): { readonly verdict: PostureVerdict; readonly newCriticalIds: readonly string[] } {
  if (baseline?.recordedAt == null) {
    return { verdict: "advisory", newCriticalIds: Object.freeze([...unresolvedCriticalIds]) };
  }
  const acknowledged = new Set(baseline.acknowledgedCriticalIds);
  const fresh = unresolvedCriticalIds.filter((id) => !acknowledged.has(id));
  return { verdict: fresh.length > 0 ? "failing" : "advisory", newCriticalIds: Object.freeze(fresh) };
}
/** Pure suppression check: active only when unexpired (ISO lexicographic
 * compare); unknown check IDs and expired rows never suppress. */
export function suppressionActive(
  suppressions: readonly PostureSuppression[],
  checkId: string,
  nowIso: string,
): PostureSuppression | null {
  for (const suppression of suppressions) {
    if (suppression.checkId === checkId && suppression.expiresAt > nowIso) return suppression;
  }
  return null;
}
function parseIsoString(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 64) {
    throw postureFault(`${field} must be a non-empty ISO date string.`);
  }
  return raw;
}
function parseNonEmptyString(raw: unknown, field: string, bound: number): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > bound) {
    throw postureFault(`${field} must be a non-empty string up to ${bound} characters.`);
  }
  return raw;
}
function parseStringList(raw: unknown, field: string, bound: number, itemBound: number): readonly string[] {
  if (!Array.isArray(raw)) throw postureFault(`${field} must be a list of strings.`);
  if (raw.length > bound) throw postureFault(`${field} must hold at most ${bound} entries.`);
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > itemBound) {
      throw postureFault(`${field} must hold non-empty strings up to ${itemBound} characters each.`);
    }
    if (!out.includes(entry)) out.push(entry);
  }
  return Object.freeze(out);
}
/** Pure parser for the recorded baseline (docs/posture/baseline.json shape,
 * also accepted inline as Saga input). Suppression check IDs must name a
 * known automated ("zone-setting-*" has one entry per allowlisted setting)
 * or manual check; typos fail closed instead of silently doing nothing. */
export function parsePostureBaseline(value: unknown): PostureBaseline {
  if (!object(value))
    throw postureFault(
      "baseline must be an object with recordedAt, acknowledgedCriticalIds, suppressions, zoneExpectations.",
    );
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["recordedAt", "acknowledgedCriticalIds", "suppressions", "zoneExpectations"].includes(key)) {
      throw postureFault(`Unknown baseline field "${key}".`);
    }
  }
  const recordedAtRaw = record.recordedAt ?? null;
  const recordedAt = recordedAtRaw === null ? null : parseIsoString(recordedAtRaw, "baseline.recordedAt");
  const acknowledgedCriticalIds = parseStringList(
    record.acknowledgedCriticalIds ?? [],
    "baseline.acknowledgedCriticalIds",
    200,
    128,
  );
  const suppressionsRaw = record.suppressions ?? [];
  if (!Array.isArray(suppressionsRaw) || suppressionsRaw.length > 100) {
    throw postureFault("baseline.suppressions must hold at most 100 entries.");
  }
  const knownIds = new Set<string>([...POSTURE_CHECK_IDS, ...POSTURE_MANUAL_IDS]);
  const suppressions: PostureSuppression[] = [];
  for (const entry of suppressionsRaw) {
    if (!object(entry)) throw postureFault("baseline.suppressions entries must be objects.");
    const row = entry as Record<string, unknown>;
    for (const key of Object.keys(row)) {
      if (!["checkId", "reason", "reviewer", "expiresAt"].includes(key)) {
        throw postureFault(`Unknown suppression field "${key}".`);
      }
    }
    const checkId = parseNonEmptyString(row.checkId, "suppression.checkId", 64);
    if (!knownIds.has(checkId)) throw postureFault(`Unknown suppression checkId "${checkId}".`);
    suppressions.push(
      Object.freeze({
        checkId,
        reason: parseNonEmptyString(row.reason, "suppression.reason", 300),
        reviewer: parseNonEmptyString(row.reviewer, "suppression.reviewer", 128),
        expiresAt: parseIsoString(row.expiresAt, "suppression.expiresAt"),
      }),
    );
  }
  const expectationsRaw = record.zoneExpectations ?? {};
  if (!object(expectationsRaw)) throw postureFault("baseline.zoneExpectations must be an object.");
  const expectationsRecord = expectationsRaw as Record<string, unknown>;
  for (const key of Object.keys(expectationsRecord)) {
    if (
      !["ssl", "minTlsVersionMin", "alwaysUseHttps", "automaticHttpsRewrites", "securityHeaderEnabled"].includes(key)
    ) {
      throw postureFault(`Unknown zoneExpectations field "${key}".`);
    }
  }
  const defaults = POSTURE_DEFAULT_ZONE_EXPECTATIONS;
  const sslRaw = expectationsRecord.ssl;
  if (sslRaw !== undefined && (!Array.isArray(sslRaw) || sslRaw.length === 0)) {
    throw postureFault("zoneExpectations.ssl must be a non-empty list when present.");
  }
  const ssl = sslRaw === undefined ? defaults.ssl : parseStringList(sslRaw, "zoneExpectations.ssl", 8, 32);
  const zoneExpectations: PostureZoneExpectations = Object.freeze({
    ssl,
    minTlsVersionMin:
      expectationsRecord.minTlsVersionMin === undefined
        ? defaults.minTlsVersionMin
        : parseNonEmptyString(expectationsRecord.minTlsVersionMin, "zoneExpectations.minTlsVersionMin", 16),
    alwaysUseHttps:
      expectationsRecord.alwaysUseHttps === undefined
        ? defaults.alwaysUseHttps
        : parseNonEmptyString(expectationsRecord.alwaysUseHttps, "zoneExpectations.alwaysUseHttps", 16),
    automaticHttpsRewrites:
      expectationsRecord.automaticHttpsRewrites === undefined
        ? defaults.automaticHttpsRewrites
        : parseNonEmptyString(expectationsRecord.automaticHttpsRewrites, "zoneExpectations.automaticHttpsRewrites", 16),
    securityHeaderEnabled:
      expectationsRecord.securityHeaderEnabled === undefined
        ? defaults.securityHeaderEnabled
        : (() => {
            if (typeof expectationsRecord.securityHeaderEnabled !== "boolean") {
              throw postureFault("zoneExpectations.securityHeaderEnabled must be a boolean.");
            }
            return expectationsRecord.securityHeaderEnabled;
          })(),
  });
  return { recordedAt, acknowledgedCriticalIds, suppressions: Object.freeze(suppressions), zoneExpectations };
}
export interface PostureSettingEvidence {
  readonly setting: string;
  readonly zoneId: string;
  readonly ok: boolean;
  readonly valueJson: string | null;
  readonly valueText: string | null;
}
/** Numeric TLS-version floor compare ("1.2" <= "1.3", "1.10" handled
 * numerically, not lexicographically). Unparseable values return false. */
export function tlsVersionAtLeast(value: string, minimum: string): boolean {
  const parts = (text: string): number[] | null => {
    const segments = text.trim().toLowerCase().replace(/^v/, "").split(".");
    if (segments.length === 0) return null;
    const numbers: number[] = [];
    for (const segment of segments) {
      if (!/^\d+$/.test(segment)) return null;
      numbers.push(Number(segment));
    }
    return numbers;
  };
  const actual = parts(value);
  const floor = parts(minimum);
  if (actual === null || floor === null) return false;
  const width = Math.max(actual.length, floor.length);
  for (let index = 0; index < width; index += 1) {
    const left = actual[index] ?? 0;
    const right = floor[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}
function settingCompliant(
  setting: string,
  evidence: PostureSettingEvidence,
  expectations: PostureZoneExpectations,
): boolean | null {
  // True/false per zone; null when the value cannot be compared.
  if (!evidence.ok) return null;
  if (setting === "ssl" || setting === "always_use_https" || setting === "automatic_https_rewrites") {
    if (evidence.valueText === null) return false;
    if (setting === "ssl") return expectations.ssl.includes(evidence.valueText);
    if (setting === "always_use_https") return evidence.valueText === expectations.alwaysUseHttps;
    return evidence.valueText === expectations.automaticHttpsRewrites;
  }
  if (setting === "min_tls_version") {
    if (evidence.valueText === null) return false;
    return tlsVersionAtLeast(evidence.valueText, expectations.minTlsVersionMin);
  }
  if (setting === "security_header") {
    const raw = evidence.valueJson;
    if (raw === null) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false;
    }
    if (!object(parsed)) return false;
    const enabled = (parsed as Record<string, unknown>).enabled;
    if (typeof enabled !== "boolean") {
      // Some accounts surface HSTS as max_age presence; without an enabled
      // flag the value is uncomparable, not compliant.
      return null;
    }
    return enabled === expectations.securityHeaderEnabled;
  }
  return null;
}
const POSTURE_CHECK_TITLES: Readonly<Record<string, string>> = Object.freeze({
  "token-active": "API token is active",
  "zone-hygiene": "No zones left in development mode",
  "zone-setting-ssl": "Zone SSL mode matches baseline",
  "zone-setting-min_tls_version": "Zone minimum TLS version matches baseline",
  "zone-setting-always_use_https": "Zone Always Use HTTPS matches baseline",
  "zone-setting-automatic_https_rewrites": "Zone Automatic HTTPS Rewrites matches baseline",
  "zone-setting-security_header": "Zone HSTS header matches baseline",
  "insights-no-unresolved-critical": "Security Insights has no unresolved Critical findings",
  "audit-visibility": "Audit-log visibility exists for security-sensitive changes",
});
const POSTURE_MANUAL_TITLES: Readonly<Record<string, string>> = Object.freeze({
  "global-api-key-non-use": "Global API Key is not used by automation (procedural)",
  "token-least-privilege": "tokens are least privilege and scoped (dashboard review)",
  "env-binding-separation": "Test/dev/prod do not share sensitive bindings",
  "membership-staleness-review": "Account membership and service credentials reviewed",
  "dns-origin-exposure-review": "DNS records reviewed for origin exposure",
});
/** Pure benchmark evaluation: typed checks over already-called APIs plus
 * honestly-manual and deferred items. Automated checks fail closed on
 * concrete misconfiguration; manual/deferred items never fail. An active
 * (unexpired) suppression flips a failing check to pass and is recorded on
 * the check; expired rows are ignored. */
export function evaluatePostureChecks(args: {
  readonly verifyStatus: "healthy" | "unhealthy";
  readonly zoneCount: number;
  readonly pausedZones: number;
  readonly developmentModeActive: number;
  readonly checkedZoneIds: readonly string[];
  readonly settingEvidence: readonly PostureSettingEvidence[];
  readonly checkedSettings: readonly string[];
  readonly baseline: PostureBaseline | undefined;
  readonly nowIso: string;
}): { readonly verdict: PostureVerdict; readonly checks: readonly PostureCheck[] } {
  const suppressions = args.baseline?.suppressions ?? [];
  const expectations = args.baseline?.zoneExpectations ?? POSTURE_DEFAULT_ZONE_EXPECTATIONS;
  const applySuppression = (id: string, status: PostureCheckStatus, detail: string): PostureCheck => {
    if (status !== "fail") return { id, title: POSTURE_CHECK_TITLES[id] ?? id, status, detail, suppressed: false };
    const suppression = suppressionActive(suppressions, id, args.nowIso);
    if (suppression === null) return { id, title: POSTURE_CHECK_TITLES[id] ?? id, status, detail, suppressed: false };
    return {
      id,
      title: POSTURE_CHECK_TITLES[id] ?? id,
      status: "pass",
      detail: `${detail} Suppressed by ${suppression.reviewer}: ${suppression.reason} (expires ${suppression.expiresAt}).`,
      suppressed: true,
    };
  };
  const checks: PostureCheck[] = [];
  checks.push(
    applySuppression(
      "token-active",
      args.verifyStatus === "healthy" ? "pass" : "fail",
      args.verifyStatus === "healthy"
        ? "Token verification reports healthy."
        : "Token verification reports unhealthy; automation calls will fail.",
    ),
  );
  checks.push(
    applySuppression(
      "zone-hygiene",
      args.developmentModeActive > 0 ? "fail" : "pass",
      `${args.zoneCount} zone(s) inventoried, ${args.pausedZones} paused, ${args.developmentModeActive} in development mode.`,
    ),
  );
  for (const setting of args.checkedSettings) {
    const id = `zone-setting-${setting}`;
    const evidence = args.settingEvidence.filter((row) => row.setting === setting);
    const readable = evidence.filter((row) => row.ok);
    if (args.checkedZoneIds.length === 0) {
      checks.push({
        id,
        title: POSTURE_CHECK_TITLES[id] ?? id,
        status: "unknown",
        detail: "No zones inventoried; nothing to compare.",
        suppressed: false,
      });
      continue;
    }
    if (readable.length === 0) {
      checks.push({
        id,
        title: POSTURE_CHECK_TITLES[id] ?? id,
        status: "unknown",
        detail: `${evidence.length} read(s) attempted, none readable (see error codes in Execution input history).`,
        suppressed: false,
      });
      continue;
    }
    const bad: string[] = [];
    // Every attempted read counts: an errored zone (!ok) is unreadable
    // evidence and fails the check — missing evidence never passes. Only a
    // fully-unreadable setting (no ok reads at all) degrades to unknown.
    for (const row of evidence) {
      const compliant = settingCompliant(setting, row, expectations);
      if (compliant !== true) bad.push(compliant === null ? `${row.zoneId} (unreadable)` : row.zoneId);
    }
    if (bad.length === 0) {
      checks.push({
        id,
        title: POSTURE_CHECK_TITLES[id] ?? id,
        status: "pass",
        detail: `${readable.length} zone(s) match baseline.`,
        suppressed: false,
      });
    } else {
      checks.push(
        applySuppression(
          id,
          "fail",
          `${bad.length} zone(s) drift from baseline: ${bad.slice(0, 10).join(", ")}${bad.length > 10 ? ", …" : ""}.`,
        ),
      );
    }
  }
  const deferred = (id: string, detail: string): PostureCheck => ({
    id,
    title: POSTURE_CHECK_TITLES[id] ?? id,
    status: "deferred",
    detail,
    suppressed: false,
  });
  checks.push(
    deferred(
      "insights-no-unresolved-critical",
      `Covered by the ${cloudflareInsightsSaga.name} Saga (${cloudflareInsightsSaga.id}); this benchmark does not re-call Insights.`,
    ),
  );
  checks.push(
    deferred(
      "audit-visibility",
      `Covered by the ${cloudflareAuditSaga.name} Saga (${cloudflareAuditSaga.id}); this benchmark does not re-read audit logs.`,
    ),
  );
  const verdict: PostureVerdict = checks.some((check) => check.status === "fail") ? "failing" : "advisory";
  return { verdict, checks: Object.freeze(checks) };
}
/** Pure manual-control list: procedural items no read-only API reports.
 * An active suppression records the accepted exception on the item. */
export function postureManualControls(baseline: PostureBaseline | undefined, nowIso: string): readonly PostureCheck[] {
  const suppressions = baseline?.suppressions ?? [];
  return Object.freeze(
    POSTURE_MANUAL_IDS.map((id): PostureCheck => {
      const suppression = suppressionActive(suppressions, id, nowIso);
      if (suppression === null) {
        return {
          id,
          title: POSTURE_MANUAL_TITLES[id] ?? id,
          status: "manual",
          detail: "Manual review required; see docs/posture.md.",
          suppressed: false,
        };
      }
      return {
        id,
        title: POSTURE_MANUAL_TITLES[id] ?? id,
        status: "manual",
        detail: `Accepted exception by ${suppression.reviewer}: ${suppression.reason} (expires ${suppression.expiresAt}).`,
        suppressed: true,
      };
    }),
  );
}
export function parseCloudflareAuditInput(value: unknown): CloudflareAuditInput {
  if (!object(value))
    throw postureFault("The cloudflare-audit-logs Saga takes an object with optional account, since, limit, classes.");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["account", "since", "limit", "classes"].includes(key)) {
      throw postureFault(
        "The cloudflare-audit-logs Saga takes an object with optional account, since, limit, classes.",
      );
    }
  }
  const account = parseCloudflareAccountBinding(record.account);
  const since = parsePostureSince(record.since);
  const limit = parsePostureLimit(record.limit, "limit");
  const classes = parseAuditClasses(record.classes);
  const out: Record<string, unknown> = {};
  if (account !== undefined) out.account = account;
  if (since !== undefined) out.since = since;
  if (limit !== undefined) out.limit = limit;
  if (classes !== undefined) out.classes = classes;
  return out as CloudflareAuditInput;
}
export function parseCloudflareInsightsInput(value: unknown): CloudflareInsightsInput {
  if (!object(value))
    throw postureFault(
      "The cloudflare-security-insights Saga takes an object with optional account, limit, includeDismissed, baseline.",
    );
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["account", "limit", "includeDismissed", "baseline"].includes(key)) {
      throw postureFault(
        "The cloudflare-security-insights Saga takes an object with optional account, limit, includeDismissed, baseline.",
      );
    }
  }
  const account = parseCloudflareAccountBinding(record.account);
  const limit = parsePostureLimit(record.limit, "limit");
  let includeDismissed: boolean | undefined;
  if (record.includeDismissed !== undefined) {
    if (typeof record.includeDismissed !== "boolean") {
      throw postureFault("includeDismissed must be a boolean.");
    }
    includeDismissed = record.includeDismissed;
  }
  const out: Record<string, unknown> = {};
  if (account !== undefined) out.account = account;
  if (limit !== undefined) out.limit = limit;
  if (includeDismissed !== undefined) out.includeDismissed = includeDismissed;
  if (record.baseline !== undefined) out.baseline = parsePostureBaseline(record.baseline);
  return out as CloudflareInsightsInput;
}
export function parseCloudflarePostureInput(value: unknown): CloudflarePostureInput {
  if (!object(value))
    throw postureFault(
      "The cloudflare-posture-benchmark Saga takes an object with optional account, maxZones, maxCheckedZones, settings, baseline.",
    );
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["account", "maxZones", "max_zones", "maxCheckedZones", "settings", "baseline"].includes(key)) {
      throw postureFault(
        "The cloudflare-posture-benchmark Saga takes an object with optional account, maxZones, maxCheckedZones, settings, baseline.",
      );
    }
  }
  const account = parseCloudflareAccountBinding(record.account);
  const maxZonesRaw = record.maxZones ?? record.max_zones;
  let maxZones: number | undefined;
  if (maxZonesRaw !== undefined) {
    if (
      typeof maxZonesRaw !== "number" ||
      !Number.isInteger(maxZonesRaw) ||
      maxZonesRaw < 1 ||
      maxZonesRaw > CLOUDFLARE_MAX_ZONES
    ) {
      throw postureFault(`maxZones must be an integer between 1 and ${CLOUDFLARE_MAX_ZONES}.`);
    }
    maxZones = maxZonesRaw;
  }
  let maxCheckedZones: number | undefined;
  if (record.maxCheckedZones !== undefined) {
    if (
      typeof record.maxCheckedZones !== "number" ||
      !Number.isInteger(record.maxCheckedZones) ||
      record.maxCheckedZones < 1 ||
      record.maxCheckedZones > CLOUDFLARE_BENCHMARK_MAX_CHECKED_ZONES
    ) {
      throw postureFault(`maxCheckedZones must be an integer between 1 and ${CLOUDFLARE_BENCHMARK_MAX_CHECKED_ZONES}.`);
    }
    maxCheckedZones = record.maxCheckedZones;
  }
  let settings: readonly string[] | undefined;
  if (record.settings !== undefined) {
    if (!Array.isArray(record.settings) || record.settings.length === 0) {
      throw postureFault("settings must be a non-empty list of allowlisted zone setting names.");
    }
    const out: string[] = [];
    for (const entry of record.settings) {
      if (typeof entry !== "string" || !(CLOUDFLARE_ZONE_SETTING_ALLOWLIST as readonly string[]).includes(entry)) {
        throw postureFault(`Unknown zone setting "${String(entry)}".`);
      }
      if (!out.includes(entry)) out.push(entry);
    }
    settings = Object.freeze(out);
  }
  const out: Record<string, unknown> = {};
  if (account !== undefined) out.account = account;
  if (maxZones !== undefined) out.maxZones = maxZones;
  if (maxCheckedZones !== undefined) out.maxCheckedZones = maxCheckedZones;
  if (settings !== undefined) out.settings = settings;
  if (record.baseline !== undefined) out.baseline = parsePostureBaseline(record.baseline);
  return out as CloudflarePostureInput;
}
// Digest census names shown in the echoed summary. The persisted echo output
// stays under the echo input bound (1024 UTF-8 bytes) via truncation below,
// so the digest never inherits an unbounded vendor list.
export const DIGEST_MAX_NAMES = 5;
/** Pure transform: shape a NinjaOne organization list into an echoable digest message. */
export function shapeDigest(orgs: NinjaOrgsResult): EchoInput {
  const names = orgs.organizations.slice(0, DIGEST_MAX_NAMES).map((org) => org.name);
  let message = `NinjaOne organizations (${orgs.organizationCount} total): ${names.join(", ") || "none"}`;
  const bytes = new TextEncoder().encode(message);
  if (bytes.length > 1024) {
    let end = 1024;
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    message = new TextDecoder().decode(bytes.slice(0, end));
  }
  return parseInput({ message });
}
export interface SagaDef {
  readonly id: string;
  readonly name: string;
  readonly revision: string;
  readonly description: string;
  readonly parse: (value: unknown) => unknown;
}
const catalog: SagaDef[] = [
  { ...echoSaga, parse: parseInput },
  { ...ninjaSaga, parse: parseNinjaOrgsInput },
  { ...digestSaga, parse: parseDigestInput },
  { ...smokeSaga, parse: parseSmokeInput },
  { ...helloSaga, parse: parseHelloInput },
  { ...helloParentSaga, parse: parseHelloParentInput },
  { ...cloudflareVerifySaga, parse: parseCloudflareVerifyInput },
  { ...cloudflareInventorySaga, parse: parseCloudflareInventoryInput },
  { ...cloudflareAuditSaga, parse: parseCloudflareAuditInput },
  { ...cloudflareInsightsSaga, parse: parseCloudflareInsightsInput },
  { ...cloudflarePostureSaga, parse: parseCloudflarePostureInput },
  { ...onboardingSaga, parse: parseOnboardingInput },
  { ...ninjaLookupSaga, parse: parseNinjaLookupInput },
];
export function parseSubmission(value: unknown): { saga: SagaDef; input: unknown } {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !["sagaId", "input"].includes(key)) ||
    typeof value.sagaId !== "string"
  ) {
    throw new Fault(400, "INVALID_SUBMISSION", "Provide a built-in Saga ID and its input only.");
  }
  const saga = catalog.find((entry) => entry.id === value.sagaId);
  if (!saga) throw new Fault(400, "UNKNOWN_SAGA", "Provide a built-in Saga ID and its input only.");
  return { saga, input: saga.parse(value.input) };
}
/** Resolve one stable Saga UUID to its submission definition without parsing
 * input (RUN-03 provider route): lets the provider parser validate the body
 * shape first, then parse input against the resolved Saga. Unknown IDs return
 * undefined so the provider parser answers UNKNOWN_SAGA. */
export function resolveSubmissionSaga(sagaId: string): SagaDef | undefined {
  return catalog.find((entry) => entry.id === sagaId);
}
/** Internal key shape: 16-128 safe characters. Used by executionId and by
 * endpoint-derived keys. Callers go through parseCallerKey instead, which
 * additionally reserves the `wep-` endpoint namespace. */
export function parseKeyShape(key: string | null): string {
  if (key === null || !/^[a-zA-Z0-9._:-]{16,128}$/.test(key)) {
    throw new Fault(400, "INVALID_IDEMPOTENCY_KEY", "An Idempotency-Key of 16 to 128 safe characters is required.");
  }
  return key;
}
export function parseKey(key: string | null): string {
  return parseKeyShape(key);
}
/** Caller-supplied keys (the Idempotency-Key header on submit routes).
 * TRG-02 (issue #138, ADR 018): keys starting with `wep-` are reserved for
 * endpoint-derived delivery keys (endpointIdempotencyKey). TRG-01 (issue
 * #137, ADR 012): keys starting with `sch-` are reserved for
 * schedule-window delivery keys (scheduleWindowKey). TRG-03 (issue #139
 * S2): keys starting with `evt-` are reserved for subscription-delivery
 * keys (subscriptionDeliveryKey). A caller that squats any of these
 * namespaces could replay against or collide with a Trigger-owned
 * Execution, so caller keys fail closed here. */
export function parseCallerKey(key: string | null): string {
  const parsed = parseKeyShape(key);
  if (parsed.startsWith("wep-")) {
    throw new Fault(400, "INVALID_IDEMPOTENCY_KEY", "Keys starting with wep- are reserved for endpoint deliveries.");
  }
  if (parsed.startsWith("sch-")) {
    throw new Fault(400, "INVALID_IDEMPOTENCY_KEY", "Keys starting with sch- are reserved for schedule deliveries.");
  }
  if (parsed.startsWith("evt-")) {
    throw new Fault(400, "INVALID_IDEMPOTENCY_KEY", "Keys starting with evt- are reserved for event deliveries.");
  }
  return parsed;
}
export async function hash(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function executionId(principal: Principal, key: string): Promise<string> {
  return hash(JSON.stringify(["wrangnarok.execution.v1", principal.orgId, principal.userId, parseKeyShape(key)]));
}

/** Shared byte bound, also used before parsing an external Integration response.
 * Callers with a known vendor shape may pass a higher transport cap; what
 * gets persisted is still governed by the D1 result CHECK constraints. */
export async function boundedJson(body: ReadableStream<Uint8Array> | null, limit = BODY_LIMIT): Promise<unknown> {
  if (body === null) throw new Fault(400, "INVALID_JSON", "A JSON body is required.");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new Fault(413, "BODY_TOO_LARGE", `The body exceeds ${limit} bytes.`);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new Fault(400, "INVALID_JSON", "The body must be valid UTF-8 JSON.");
  }
}

// --- ExecutionHistory querying (Phase 2, issues #76 then #152) --------------
// GET /api/executions is the only route that accepts a query string, and only
// these keys: status (one canonical ExecutionStatus or a comma-separated
// multi-status set, mirroring upstream's comma-separated status filter),
// sagaId (stable Saga UUID), sagaName (exact Saga name, mirroring upstream's
// workflowName), startDate/endDate (ISO 8601 datetime or plain YYYY-MM-DD day
// bounds, applied to created_at so dispatched-but-unstarted Pending rows stay
// visible — upstream filters started_at, which would silently drop them),
// limit (1-50, default 20), cursor (opaque page marker). Anything else is
// UNSUPPORTED_QUERY — the hardening posture stays deny-by-default.
//
// Non-applicable upstream keys are deliberately absent, not silently ignored:
// scope (single org/requester scope here, never a superuser-wide listing) and
// excludeLocal (no local-runner concept) have no local meaning; free-text
// search is a client-side slice over loaded pages (upstream exposes no search
// param on the executions list either — message_search lives only on the
// admin-only logs surface).
export const HISTORY_LIMIT_DEFAULT = 20;
export const HISTORY_LIMIT_MAX = 50;
const HISTORY_STATUSES: readonly string[] = [
  "Pending",
  "Running",
  "Succeeded",
  "Failed",
  "TimedOut",
  "Cancelling",
  "Cancelled",
];
export interface HistoryCursor {
  readonly createdAt: string;
  readonly id: string;
}
export interface HistoryQuery {
  /** Empty means all statuses. One entry behaves exactly like the old singular filter. */
  readonly statuses: readonly ExecutionStatus[];
  readonly sagaId?: string;
  /** Exact Saga name match (upstream workflowName parity). */
  readonly sagaName?: string;
  /** Inclusive lower bound on created_at (normalized ISO instant). */
  readonly startAt?: string;
  /** Exclusive upper bound on created_at (normalized ISO instant). */
  readonly endBefore?: string;
  readonly limit: number;
  readonly cursor?: HistoryCursor;
}
/** Opaque page marker: base64url of {createdAt, id}. Clients treat it as an
 * inscrutable string; the listing query resumes strictly below the tuple in
 * (created_at DESC, id DESC) order. */
export function encodeHistoryCursor(cursor: HistoryCursor): string {
  return btoa(JSON.stringify({ createdAt: cursor.createdAt, id: cursor.id }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
export function decodeHistoryCursor(value: string): HistoryCursor {
  let cursor: unknown;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/");
    cursor = JSON.parse(atob(padded));
  } catch {
    throw new Fault(400, "INVALID_CURSOR", "The history cursor is not a valid page marker.");
  }
  if (
    !object(cursor) ||
    typeof cursor.createdAt !== "string" ||
    cursor.createdAt.length === 0 ||
    typeof cursor.id !== "string" ||
    !EXECUTION_ID.test(cursor.id)
  ) {
    throw new Fault(400, "INVALID_CURSOR", "The history cursor is not a valid page marker.");
  }
  return { createdAt: cursor.createdAt, id: cursor.id };
}
/** Normalize a date filter to an ISO instant. Accepts a full ISO 8601 datetime
 * or a plain calendar day ("YYYY-MM-DD", interpreted as UTC midnight). Throws
 * a Fault with the given code on anything else — never silently ignores a
 * caller-supplied bound the way upstream's repository does. */
export function parseDateBound(value: string, code: string): string {
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const instant = dayOnly ? `${value}T00:00:00.000Z` : value.replace(/Z$/i, "+00:00");
  const parsed = Date.parse(dayOnly ? instant : value.includes("T") ? instant : value);
  if (Number.isNaN(parsed)) {
    throw new Fault(400, code, "startDate and endDate must be ISO 8601 date-times (YYYY-MM-DD accepted).");
  }
  return new Date(parsed).toISOString();
}
/** Pure parser for the history list query string. Throws Faults with
 * machine-readable codes; unit-tested without any runtime binding. */
export function parseHistoryQuery(params: URLSearchParams): HistoryQuery {
  for (const key of params.keys()) {
    if (!["status", "sagaId", "sagaName", "startDate", "endDate", "limit", "cursor"].includes(key)) {
      throw new Fault(
        400,
        "UNSUPPORTED_QUERY",
        "Only status, sagaId, sagaName, startDate, endDate, limit, and cursor are supported here.",
      );
    }
  }
  const statuses: ExecutionStatus[] = [];
  const rawStatus = params.get("status");
  if (rawStatus !== null) {
    // Comma-separated multi-status, mirroring upstream's status filter: the
    // UI's failure pills can ask for the whole group in one server-side
    // filter. A single value behaves exactly as before. Duplicates collapse;
    // an empty/blank entry is INVALID_STATUS, never a silent match-all.
    for (const part of rawStatus.split(",")) {
      const candidate = part.trim();
      if (!HISTORY_STATUSES.includes(candidate)) {
        throw new Fault(400, "INVALID_STATUS", "Status must be canonical Execution statuses, comma-separated.");
      }
      const status = candidate as ExecutionStatus;
      if (!statuses.includes(status)) statuses.push(status);
    }
    if (statuses.length === 0) {
      throw new Fault(400, "INVALID_STATUS", "Status must be canonical Execution statuses, comma-separated.");
    }
  }
  let sagaId: string | undefined;
  const rawSaga = params.get("sagaId");
  if (rawSaga !== null) {
    if (!UUID.test(rawSaga)) {
      throw new Fault(400, "INVALID_SAGA_ID", "sagaId must be a stable Saga UUID.");
    }
    sagaId = rawSaga;
  }
  let sagaName: string | undefined;
  const rawName = params.get("sagaName");
  if (rawName !== null) {
    if (rawName.length === 0 || rawName.length > 256) {
      throw new Fault(400, "INVALID_SAGA_NAME", "sagaName must be 1 to 256 characters.");
    }
    sagaName = rawName;
  }
  let limit = HISTORY_LIMIT_DEFAULT;
  const rawLimit = params.get("limit");
  if (rawLimit !== null) {
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > HISTORY_LIMIT_MAX) {
      throw new Fault(400, "INVALID_LIMIT", `Limit must be an integer from 1 to ${HISTORY_LIMIT_MAX}.`);
    }
    limit = Number(rawLimit);
  }
  let startAt: string | undefined;
  const rawStart = params.get("startDate");
  if (rawStart !== null) startAt = parseDateBound(rawStart, "INVALID_START_DATE");
  let endAtRaw: string | undefined;
  const rawEnd = params.get("endDate");
  if (rawEnd !== null) endAtRaw = parseDateBound(rawEnd, "INVALID_END_DATE");
  // Plain-day endDates ("YYYY-MM-DD") are exclusive of the whole day: they
  // normalize to the next midnight so a From/To day-range pair covers the full
  // To day. Full datetimes stay exact.
  const endBefore =
    endAtRaw === undefined
      ? undefined
      : /^\d{4}-\d{2}-\d{2}$/.test(rawEnd ?? "")
        ? new Date(Date.parse(endAtRaw) + 24 * 60 * 60 * 1000).toISOString()
        : endAtRaw;
  if (startAt !== undefined && endBefore !== undefined && startAt >= endBefore) {
    throw new Fault(400, "INVALID_DATE_RANGE", "startDate must be before endDate.");
  }
  const rawCursor = params.get("cursor");
  return {
    statuses,
    ...(sagaId === undefined ? {} : { sagaId }),
    ...(sagaName === undefined ? {} : { sagaName }),
    ...(startAt === undefined ? {} : { startAt }),
    ...(endBefore === undefined ? {} : { endBefore }),
    limit,
    ...(rawCursor === null ? {} : { cursor: decodeHistoryCursor(rawCursor) }),
  };
}
