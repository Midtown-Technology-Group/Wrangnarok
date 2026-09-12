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
// auto-swept; Scheduled distinct (deferred); operator step-retry ceiling 2.
export const STEP_RETRY_CEILING = 2;
// Explicit vendor deadline (issue #16): the echo vendor step enforces its own
// deadline and surfaces ECHO_VENDOR_TIMEOUT. TimedOut is only ever written by
// the explicit timeout-mark-v1 checkpoint, never inferred from introspection.
export const VENDOR_TIMEOUT_MS = 1000;
// NinjaOne vendor deadline (Phase 2, issue #76): same posture as echo — the
// Integration enforces its own deadline and surfaces NINJA_VENDOR_TIMEOUT
// for both aborted and merely-late vendors. Sagas route it to timeout-mark-v1.
export const NINJA_TIMEOUT_MS = 5000;
export const EXECUTION_ID = /^[a-f0-9]{64}$/;
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export type ExecutionStatus = "Pending" | "Running" | "Succeeded" | "Failed" | "TimedOut" | "Cancelling" | "Cancelled";
// Retry policy table (upstream finding 14, issue #16): vendor/Integration
// steps never auto-retry (0) unless destination-side idempotency is proven and
// an explicit policy exists; only idempotent D1 checkpoint steps may retry, up
// to the operator ceiling. Unknown step names fail closed to 0. Unit-tested as
// pure TypeScript; Sagas must resolve every step.do retry limit through here.
const CHECKPOINT_STEPS: ReadonlySet<string> = new Set([
  "prepare-input-v1",
  "persist-success-v1",
  "persist-failure-v1",
  "timeout-mark-v1",
]);
export function stepRetryLimit(stepName: string): number {
  return CHECKPOINT_STEPS.has(stepName) ? STEP_RETRY_CEILING : 0;
}
// Canonical transition table (ADR 001). Cancelling is transient:
// Pending/Running -> Cancelling -> Cancelled. Once the owner-requested
// Cancelling marker is written, cancel wins: a terminal checkpoint that
// lands after it is the stale one and no-ops, so an acknowledged
// cancellation is never flipped to Failed afterward. Terminal states have
// no outgoing transitions. Unit-tested as pure TypeScript.
const EXECUTION_TRANSITIONS: Record<ExecutionStatus, readonly ExecutionStatus[]> = {
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
export interface HelloResult {
  greeting: string;
  name: string;
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
export function parseSmokeInput(value: unknown): SmokeInput {
  if (!object(value) || Object.keys(value).length !== 0) {
    throw new Fault(400, "INVALID_INPUT", "The system.smoke Saga takes an empty input object.");
  }
  return {};
}
export function parseHelloInput(value: unknown): HelloInput {
  if (
    !object(value) ||
    Object.keys(value).some((key) => key !== "name") ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    new TextEncoder().encode(value.name).length > 1024
  ) {
    throw new Fault(400, "INVALID_INPUT", "Expected one name of 1 to 1024 UTF-8 bytes.");
  }
  return { name: value.name };
}
export function parseDigestInput(value: unknown): DigestInput {
  if (!object(value) || Object.keys(value).length !== 0) {
    throw new Fault(400, "INVALID_INPUT", "The ninjaone-echo-digest Saga takes an empty input object.");
  }
  return {};
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
 * endpoint-derived delivery keys (endpointIdempotencyKey). A caller that
 * squats the namespace could replay against or collide with an endpoint
 * Execution, so caller keys fail closed here. */
export function parseCallerKey(key: string | null): string {
  const parsed = parseKeyShape(key);
  if (parsed.startsWith("wep-")) {
    throw new Fault(400, "INVALID_IDEMPOTENCY_KEY", "Keys starting with wep- are reserved for endpoint deliveries.");
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
