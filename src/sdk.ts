// SPDX-License-Identifier: AGPL-3.0
// DEV-01 (issue #140): versioned public author and automation SDK contract.
//
// The single typed surface fresh authors and automation callers program
// against: Saga discovery/inspection metadata (CatalogEntry), validated
// input/output schemas (IoSchema), execute/status/cancel/history over the
// same authenticated Worker routes as the browser UI, plus offline
// scaffold/inspect/diagnose helpers. Python import or wire compatibility
// with upstream Bifrost is not promised; capability parity is mapped in
// docs/sdk-capability-map.md (upstream `api/bifrost/*` versus this module).
//
// Versioning: SDK_VERSION bumps on any breaking change to these exports or
// to the served GET /api/sdk descriptor. test/sdk.test.ts pins the version
// and asserts the descriptor, schemas, and error codes agree with the live
// Worker, so drift fails CI instead of surprising callers.
import { SAGA_CATALOG } from "./sagas";
import type { CatalogEntry, IoSchema } from "./saga";

/** Public SDK contract version. Bump on any breaking change to these
 * exports or to the served GET /api/sdk descriptor. */
export const SDK_VERSION = "1" as const;

/** Route serving the machine-readable contract descriptor (see
 * describeContract). Authenticated like every other /api/* route. */
export const SDK_DOC_PATH = "/api/sdk" as const;

/** Terminal Execution statuses: polling stops here (ADR 001). */
export const SDK_TERMINAL_STATUSES = ["Succeeded", "Failed", "TimedOut", "Cancelled"] as const;

export type SdkTerminalStatus = (typeof SDK_TERMINAL_STATUSES)[number];

/** Machine-readable error codes the SDK surfaces. These are the exact
 * `error.code` values served by the Worker (plus SDK_CLIENT_* for failures
 * that happen before a Worker response exists); the human message is never
 * the contract. Codes owned by not-yet-implemented parity modules stay
 * listed under docs/sdk-capability-map.md, never invented here. */
export const SDK_ERROR_CODES = [
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "UNIMPLEMENTED",
  "INTERNAL_ERROR",
  "INVALID_JSON",
  "BODY_TOO_LARGE",
  "JSON_REQUIRED",
  "INVALID_SUBMISSION",
  "UNKNOWN_SAGA",
  "INVALID_INPUT",
  "INVALID_IDEMPOTENCY_KEY",
  "IDEMPOTENCY_CONFLICT",
  "EXECUTION_CANCELLED",
  "RECOVERY_EXPIRED",
  "DISPATCH_UNCONFIRMED",
  "EXECUTION_NOT_FOUND",
  "EXECUTION_NOT_CANCELLABLE",
  "CANCELLATION_UNCONFIRMED",
  "UNSUPPORTED_QUERY",
  "INVALID_STATUS",
  "INVALID_SAGA_ID",
  "INVALID_LIMIT",
  "INVALID_CURSOR",
  "INVALID_ACTION_PREFIX",
  "INVALID_OUTCOME",
  "INVALID_SEARCH",
  "INVALID_NOTIFICATION",
  "INVALID_NOTIFICATION_ID",
  "NOTIFICATION_NOT_FOUND",
  "INTEGRATION_REQUIREMENT_UNSATISFIED",
  "FORM_VALIDATION_FAILED",
  "ECHO_VENDOR_TIMEOUT",
  "ECHO_INTEGRATION_FAILED",
  "NINJA_NOT_CONFIGURED",
  "NINJA_VENDOR_TIMEOUT",
  "NINJA_VENDOR_FAILED",
  "NINJA_UNAUTHORIZED",
  "NINJA_RATE_LIMITED",
  "NINJA_BAD_RESPONSE",
  "NINJA_AUTH_FAILED",
  "NINJA_INTEGRATION_FAILED",
  "SMOKE_WRITE_UNVERIFIED",
  "SMOKE_READ_UNVERIFIED",
  "EXECUTION_FAILED",
  "INVALID_ARTIFACT",
  "INVALID_ARTIFACT_ID",
  "ARTIFACT_NOT_FOUND",
  "ARTIFACT_FORBIDDEN",
  "ARTIFACT_GONE",
  "ARTIFACT_TOO_LARGE",
  "EMPTY_ARTIFACT",
  "BYTES_REQUIRED",
  "ARTIFACT_WRITE_FAILED",
  "ARTIFACT_BYTES_MISSING",
  "ARTIFACT_STORE_NOT_CONFIGURED",
  "INVALID_VERSION",
  "VERSION_LIMIT",
  "VERSION_RACE",
  "INVALID_BINDING",
  "BINDING_EXISTS",
  "BINDING_NOT_FOUND",
  "INVALID_RETENTION",
  "RETENTION_FORBIDDEN",
  "INVALID_APP",
  "INVALID_SLUG",
  "INVALID_APP_ID",
  "INVALID_SOURCE",
  "APP_VALIDATION_FAILED",
  "APP_NOT_FOUND",
  "NO_REVISION",
  "REVISION_INVALID",
  "BUILD_SUPERSEDED",
  "BUILD_FAILED",
  "SLUG_CONFLICT",
  "MANAGED_RESOURCE",
  "UNKNOWN_INTEGRATION",
  "CONNECTION_NOT_FOUND",
  "CONNECTION_EXISTS",
  "CONNECTION_DISABLED",
  "CONNECTION_SCHEMA_INVALID",
  "INVALID_CONNECTION",
  "SECRET_NOT_CONFIGURED",
  "CONNECTION_TEST_FAILED",
  "INVALID_SWAP",
  "INVALID_TABLE",
  "TABLE_CONFLICT",
  "TABLE_NOT_FOUND",
  "TABLE_FORBIDDEN",
  "TABLE_BATCH_DENIED",
  "INVALID_DOCUMENT",
  "INVALID_DOCUMENT_ID",
  "DOCUMENT_CONFLICT",
  "DOCUMENT_NOT_FOUND",
  "DOCUMENT_TOO_LARGE",
  "DOCUMENT_WRITE_FAILED",
  "INVALID_BATCH",
  "INVALID_FILTER",
  "TOO_MANY_FILTERS",
  "INVALID_PREFIX",
  "INVALID_ORDER",
  "INVALID_SKIP_COUNT",
  "INVALID_ACTION",
  "INVALID_GRANT",
  "INVALID_GRANTEE",
  "INVALID_CONFIG",
  "INVALID_CONFIG_KEY",
  "INVALID_CONFIG_TYPE",
  "INVALID_CONFIG_VALUE",
  "INVALID_CONFIG_ID",
  "INVALID_CONFIG_UPDATE",
  "INVALID_CONFIG_DESCRIPTION",
  "CONFIG_NOT_FOUND",
  "CONFIG_CONFLICT",
  "CONFIG_REQUIREMENT_UNSATISFIED",
  "CREDENTIAL_IN_VALUE",
  "SECRET_NOT_CONFIGURED",
  "SECRET_SCHEMA_MISMATCH",
  "INVALID_JOB_ID",
  "JOB_NOT_FOUND",
  "APP_NOT_LIVE",
  "INVALID_ASSET",
  "ASSET_NOT_FOUND",
  "INVALID_APP_GRANT",
  "APP_GRANT_CONFLICT",
  "APP_GRANT_NOT_FOUND",
  "APP_SAGA_FORBIDDEN",
  "APP_TABLE_FORBIDDEN",
  "APP_FILE_FORBIDDEN",
  "INVALID_APP_TABLE",
  "INVALID_TABLE_QUERY",
  "APP_TABLE_QUERY_UNSUPPORTED",
  "APP_TABLE_NOT_FOUND",
  "INVALID_TABLE_ROW",
  "APP_ROW_NOT_FOUND",
  "APP_TABLE_FULL",
  "INVALID_APP_FILE",
  "APP_FILE_NOT_FOUND",
  "APP_FILE_TOKEN_INVALID",
  "APP_FILE_TOKEN_EXPIRED",
  "APP_FILE_METADATA_MISMATCH",
  "APP_FILE_TOO_LARGE",
  "APP_FILE_NOT_READY",
  "APP_FILE_VERSION_CONFLICT",
  "APP_SDK_MISMATCH",
  "INVALID_LOCATION",
  "LOCATION_CONFLICT",
  "LOCATION_NOT_EMPTY",
  "INVALID_PATH",
  "INVALID_POLICY",
  "INVALID_POLICY_ACTION",
  "INVALID_POLICY_TEST",
  "INVALID_BATCH",
  "INVALID_EXPIRY",
  "INVALID_FINALIZE",
  "INVALID_DELETE",
  "INVALID_LIMIT",
  "INVALID_CURSOR",
  "EMPTY_UPLOAD",
  "FILE_TOO_LARGE",
  "CONTENT_TYPE_REJECTED",
  "FILE_MISSING",
  "VERSION_CONFLICT",
  "COMPLETION_MISMATCH",
  "STABLE_IDENTITY_REMAP_REQUIRED",
  "SYNC_CONFLICT",
  "INVALID_GIT_TARGET",
  "DEPLOY_BLOCKED",
  "INVALID_ENDPOINT",
  "ENDPOINT_EXISTS",
  "ENDPOINT_UNAUTHORIZED",
  "ENDPOINT_KEY_EXPIRED",
  "ENDPOINT_DISABLED",
  "ENDPOINT_EVENT_ID_REQUIRED",
  "ENDPOINT_IDENTITY_FORBIDDEN",
  "ENDPOINT_RATE_LIMITED",
  "ENDPOINT_MISCONFIGURED",
  "INVALID_CHALLENGE",
  "LOCAL_AUTH_NOT_CONFIGURED",
  "ACCESS_NOT_CONFIGURED",
  "SDK_CLIENT_MISMATCH",
  "SDK_CLIENT_NETWORK",
  "SDK_CLIENT_TIMEOUT",
  "SDK_SAGA_NOT_FOUND",
  "SDK_SAGA_AMBIGUOUS",
  "SDK_INVALID_REF",
] as const;

export type SdkErrorCode = (typeof SDK_ERROR_CODES)[number];

/** Structured error mirroring the Worker envelope `{ error: { code,
 * message } }`. Callers switch on `code`, never on the message. */
export class SdkError extends Error {
  readonly code: SdkErrorCode;
  readonly status: number | null;

  constructor(code: SdkErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "SdkError";
    this.code = code;
    this.status = status;
  }

  toJSON(): { error: { code: SdkErrorCode; message: string } } {
    return { error: { code: this.code, message: this.message } };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isErrorCode(value: unknown): value is SdkErrorCode {
  return typeof value === "string" && (SDK_ERROR_CODES as readonly string[]).includes(value);
}

/** Parse a failed Worker response into an SdkError. Never throws: an
 * unreadable body becomes SDK_CLIENT_MISMATCH, never a crash. */
export async function parseSdkError(response: Response): Promise<SdkError> {
  let code: SdkErrorCode = "SDK_CLIENT_MISMATCH";
  let message = `Request failed with status ${response.status}.`;
  try {
    const body: unknown = await response.json();
    if (isRecord(body) && isRecord(body.error)) {
      if (isErrorCode(body.error.code)) code = body.error.code;
      if (typeof body.error.message === "string" && body.error.message.length > 0) message = body.error.message;
    }
  } catch {
    // Keep the status-based fallback.
  }
  return new SdkError(code, message, response.status);
}

// --- Wire types (SDK-owned mirrors of the served shapes) --------------------
// Deliberately duplicated from client/src/lib/client-types.ts rather than
// imported: the Worker bundle must not depend on the browser app, and the
// drift test (test/sdk.test.ts) asserts both agree with live responses.

export interface SdkSaga {
  readonly id: string;
  readonly name: string;
  readonly revision: string;
  readonly description: string;
  readonly category?: string;
  readonly tags?: readonly string[];
  readonly requiredIntegrations: readonly string[];
  readonly inputSchema?: IoSchema;
  readonly outputSchema?: IoSchema;
}

export interface SdkOperation {
  readonly name: string;
  readonly status: string;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly result: unknown;
  readonly error: unknown;
}

export interface SdkExecutionSummary {
  readonly executionId: string;
  readonly sagaId: string;
  readonly sagaName: string;
  readonly sagaRevision: string;
  readonly orgId: string;
  readonly userId: string;
  readonly status: string;
  readonly dispatchConfirmed: boolean;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface SdkExecutionDetail extends SdkExecutionSummary {
  readonly runtimeStatus: string | null;
  readonly input: unknown;
  readonly result: unknown;
  readonly error: unknown;
  readonly operations: readonly SdkOperation[];
}

export interface SdkHistoryPage {
  readonly executions: readonly SdkExecutionSummary[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

export interface SdkSubmitReceipt {
  readonly executionId: string;
  readonly replayed: boolean;
  readonly statusUrl: string;
}

export interface SdkCancelReceipt {
  readonly executionId: string;
  readonly status: string;
  readonly cancelled: boolean;
}

// --- Administrative audit trail and operational notifications (OPS-01) -----
// Wire mirrors of the served shapes in src/ops.ts. Deliberately duplicated
// from client/src/lib/client-types.ts: the Worker bundle must not depend on
// the browser app, and the drift test asserts both agree with live responses.

export interface SdkAuditEvent {
  readonly id: string;
  readonly orgId: string;
  readonly actorUserId: string;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly outcome: string;
  readonly detail: unknown;
  readonly createdAt: string;
}

export interface SdkAuditPage {
  readonly events: readonly SdkAuditEvent[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

export interface SdkAuditQuery {
  readonly action?: string;
  readonly outcome?: string;
  readonly search?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface SdkNotification {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly scope: string;
  readonly category: string;
  readonly title: string;
  readonly body: string | null;
  readonly status: string;
  readonly progressPercent: number | null;
  readonly detail: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dismissedAt: string | null;
}

function isAuditEvent(value: unknown): value is SdkAuditEvent {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.orgId === "string" &&
    typeof value.actorUserId === "string" &&
    typeof value.action === "string" &&
    (value.targetType === null || typeof value.targetType === "string") &&
    (value.targetId === null || typeof value.targetId === "string") &&
    typeof value.outcome === "string" &&
    "detail" in value &&
    typeof value.createdAt === "string"
  );
}

/** Guard a GET /api/audit payload. Throws SDK_CLIENT_MISMATCH on drift. */
export function parseAuditPage(value: unknown): SdkAuditPage {
  if (!isRecord(value) || !Array.isArray(value.events) || typeof value.hasMore !== "boolean") {
    throw new SdkError("SDK_CLIENT_MISMATCH", "The audit trail has an unexpected shape.");
  }
  for (const entry of value.events) {
    if (!isAuditEvent(entry)) throw new SdkError("SDK_CLIENT_MISMATCH", "The audit trail has an unexpected shape.");
  }
  const nextCursor = value.nextCursor;
  if (nextCursor !== undefined && nextCursor !== null && typeof nextCursor !== "string") {
    throw new SdkError("SDK_CLIENT_MISMATCH", "The audit trail has an unexpected shape.");
  }
  return {
    events: value.events as unknown as readonly SdkAuditEvent[],
    hasMore: value.hasMore,
    nextCursor: (nextCursor ?? null) as string | null,
  };
}

function isNotification(value: unknown): value is SdkNotification {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.orgId === "string" &&
    typeof value.userId === "string" &&
    typeof value.scope === "string" &&
    typeof value.category === "string" &&
    typeof value.title === "string" &&
    (value.body === null || typeof value.body === "string") &&
    typeof value.status === "string" &&
    (value.progressPercent === null || typeof value.progressPercent === "number") &&
    "detail" in value &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    (value.dismissedAt === null || typeof value.dismissedAt === "string")
  );
}

/** Guard a GET /api/notifications payload. Throws SDK_CLIENT_MISMATCH. */
export function parseNotifications(value: unknown): readonly SdkNotification[] {
  if (!isRecord(value) || !Array.isArray(value.notifications) || !value.notifications.every(isNotification)) {
    throw new SdkError("SDK_CLIENT_MISMATCH", "The notifications inbox has an unexpected shape.");
  }
  return value.notifications;
}

/** Guard a GET /api/notifications/:id payload. Throws SDK_CLIENT_MISMATCH. */
export function parseNotification(value: unknown): SdkNotification {
  if (!isRecord(value) || !isNotification(value.notification)) {
    throw new SdkError("SDK_CLIENT_MISMATCH", "The notification has an unexpected shape.");
  }
  return value.notification;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isSaga(value: unknown): value is SdkSaga {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.revision === "string" &&
    typeof value.description === "string" &&
    (value.category === undefined || typeof value.category === "string") &&
    (value.tags === undefined || isStringArray(value.tags)) &&
    isStringArray(value.requiredIntegrations)
  );
}

/** Guard a GET /api/sagas payload. Throws SDK_CLIENT_MISMATCH on drift. */
export function parseSagaCatalog(value: unknown): readonly SdkSaga[] {
  if (!isRecord(value) || !Array.isArray(value.sagas) || !value.sagas.every(isSaga)) {
    throw new SdkError("SDK_CLIENT_MISMATCH", "The Saga catalog has an unexpected shape.");
  }
  return value.sagas;
}

function isOperation(value: unknown): value is SdkOperation {
  if (!isRecord(value)) return false;
  return (
    typeof value.name === "string" &&
    typeof value.status === "string" &&
    typeof value.startedAt === "string" &&
    (value.completedAt === null || typeof value.completedAt === "string") &&
    "result" in value &&
    "error" in value
  );
}

/** Guard a GET /api/executions/:id payload. Throws SDK_CLIENT_MISMATCH. */
export function parseExecutionDetail(value: unknown): SdkExecutionDetail {
  if (!isRecord(value)) throw new SdkError("SDK_CLIENT_MISMATCH", "The Execution detail has an unexpected shape.");
  const operations = value.operations;
  if (
    typeof value.executionId !== "string" ||
    typeof value.sagaId !== "string" ||
    typeof value.sagaName !== "string" ||
    typeof value.sagaRevision !== "string" ||
    typeof value.orgId !== "string" ||
    typeof value.userId !== "string" ||
    typeof value.status !== "string" ||
    typeof value.dispatchConfirmed !== "boolean" ||
    typeof value.createdAt !== "string" ||
    (value.startedAt !== null && typeof value.startedAt !== "string") ||
    (value.completedAt !== null && typeof value.completedAt !== "string") ||
    (value.runtimeStatus !== null && typeof value.runtimeStatus !== "string") ||
    !("input" in value) ||
    !("result" in value) ||
    !("error" in value) ||
    !Array.isArray(operations) ||
    !operations.every(isOperation)
  ) {
    throw new SdkError("SDK_CLIENT_MISMATCH", "The Execution detail has an unexpected shape.");
  }
  return value as unknown as SdkExecutionDetail;
}

/** Guard a GET /api/executions payload. Throws SDK_CLIENT_MISMATCH. */
export function parseHistoryPage(value: unknown): SdkHistoryPage {
  if (!isRecord(value) || !Array.isArray(value.executions) || typeof value.hasMore !== "boolean") {
    throw new SdkError("SDK_CLIENT_MISMATCH", "The Execution history has an unexpected shape.");
  }
  for (const entry of value.executions) {
    if (
      !isRecord(entry) ||
      typeof entry.executionId !== "string" ||
      typeof entry.sagaId !== "string" ||
      typeof entry.status !== "string"
    ) {
      throw new SdkError("SDK_CLIENT_MISMATCH", "The Execution history has an unexpected shape.");
    }
  }
  const nextCursor = value.nextCursor;
  if (nextCursor !== undefined && nextCursor !== null && typeof nextCursor !== "string") {
    throw new SdkError("SDK_CLIENT_MISMATCH", "The Execution history has an unexpected shape.");
  }
  return {
    executions: value.executions as unknown as readonly SdkExecutionSummary[],
    hasMore: value.hasMore,
    nextCursor: (nextCursor ?? null) as string | null,
  };
}

export interface SdkPreviewEnvironment {
  readonly integrationId: string;
  readonly configured: boolean;
  readonly detail: string;
}

export interface SdkPreview {
  readonly saga: SdkSaga;
  readonly input: unknown;
  readonly environmentChecked: boolean;
  readonly environment: readonly SdkPreviewEnvironment[];
  readonly persisted: false;
  readonly dispatched: false;
}

export interface SdkPreviewOptions {
  readonly saga: string;
  readonly input?: unknown;
  readonly checkEnvironment?: boolean;
}

function isPreviewEnvironment(value: unknown): value is SdkPreviewEnvironment {
  return (
    isRecord(value) &&
    typeof value.integrationId === "string" &&
    typeof value.configured === "boolean" &&
    typeof value.detail === "string"
  );
}

/** Guard a POST /api/dev/preview payload (DEV-02, issue #141). Throws
 * SDK_CLIENT_MISMATCH on drift. */
export function parsePreview(value: unknown): SdkPreview {
  if (!isRecord(value) || !isRecord(value.preview)) {
    throw new SdkError("SDK_CLIENT_MISMATCH", "The Saga preview has an unexpected shape.");
  }
  const preview = value.preview;
  if (
    !isRecord(preview.saga) ||
    !("input" in preview) ||
    typeof preview.environmentChecked !== "boolean" ||
    !Array.isArray(preview.environment) ||
    !preview.environment.every(isPreviewEnvironment) ||
    preview.persisted !== false ||
    preview.dispatched !== false
  ) {
    throw new SdkError("SDK_CLIENT_MISMATCH", "The Saga preview has an unexpected shape.");
  }
  return preview as unknown as SdkPreview;
}

// --- Scoped config (CON-02, ADR 020) -----------------------------------------
// Typed key/value rows for the caller's own Organization. Secret rows answer
// "[SECRET]" on every read surface; secret values never cross the wire.

/** Upstream list-masking parity: secret values never serialize. */
export const SDK_SECRET_MASK = "[SECRET]";

export interface SdkConfigEntry {
  readonly id: string;
  readonly key: string;
  readonly type: string;
  readonly value: unknown;
  readonly description: string | null;
  readonly managedBy: string | null;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

function isConfigEntry(value: unknown): value is SdkConfigEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.key === "string" &&
    typeof value.type === "string" &&
    "value" in value &&
    (value.description === null || typeof value.description === "string") &&
    (value.managedBy === null || typeof value.managedBy === "string") &&
    typeof value.updatedAt === "string" &&
    typeof value.updatedBy === "string"
  );
}

/** Guard a GET /api/config payload. Throws SDK_CLIENT_MISMATCH on drift. */
export function parseConfigList(value: unknown): readonly SdkConfigEntry[] {
  if (!isRecord(value) || !Array.isArray(value.configs) || !value.configs.every(isConfigEntry)) {
    throw new SdkError("SDK_CLIENT_MISMATCH", "The config list has an unexpected shape.");
  }
  return value.configs;
}

/** Guard a POST /api/config or PUT /api/config/:id payload. Throws
 * SDK_CLIENT_MISMATCH on drift. */
export function parseConfigEntry(value: unknown): SdkConfigEntry {
  if (!isRecord(value) || !isConfigEntry(value.config)) {
    throw new SdkError("SDK_CLIENT_MISMATCH", "The config entry has an unexpected shape.");
  }
  return value.config;
}

export interface SdkSetConfigOptions {
  readonly key: string;
  readonly type: string;
  readonly value?: unknown;
  readonly description?: string;
}

export interface SdkUpdateConfigOptions {
  readonly id: string;
  readonly key?: string;
  readonly type?: string;
  readonly value?: unknown;
  readonly description?: string;
}

// --- Offline authoring helpers ----------------------------------------------

const SAGA_SLUG = /^[a-z0-9][a-z0-9.-]*$/;
const STABLE_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export interface ScaffoldInput {
  /** Saga slug, e.g. "hello". Lowercase alphanumerics, dots, dashes. */
  readonly name: string;
  /** Stable UUID identity (ADR 002): changing it mints a different Saga. */
  readonly id: string;
  /** One to 280 chars of discovery text. */
  readonly description: string;
  /** Diagnostic revision marker, e.g. "hello-v1". Defaults to `${name}-v1`. */
  readonly revision?: string;
}

export interface ScaffoldFile {
  readonly path: string;
  readonly content: string;
}

function checkScaffoldInput(input: ScaffoldInput): { revision: string } {
  if (!SAGA_SLUG.test(input.name)) {
    throw new SdkError("SDK_INVALID_REF", `Saga name ${JSON.stringify(input.name)} must be a simple slug.`);
  }
  if (!STABLE_UUID.test(input.id)) {
    throw new SdkError(
      "SDK_INVALID_REF",
      `Saga id ${JSON.stringify(input.id)} must be a stable UUID (ADR 002); changing it mints a different Saga.`,
    );
  }
  if (input.description.length === 0 || input.description.length > 280) {
    throw new SdkError("SDK_INVALID_REF", "Saga description must be 1-280 chars of discovery text.");
  }
  const revision = input.revision ?? `${input.name}-v1`;
  if (revision.length === 0 || revision.length > 64) {
    throw new SdkError("SDK_INVALID_REF", "Saga revision must be a non-empty diagnostic marker.");
  }
  return { revision };
}

/** Offline Saga scaffold: returns the new Saga module source plus the
 * registration checklist. Pure and network-free; the CLI `scaffold`
 * command writes these files. The template mirrors src/sagas/hello.ts
 * (the migration pilot): prepare input, do durable work in step.do(),
 * persist a terminal checkpoint. Determinism markers (defineSaga,
 * requiredIntegrations, step.do("prepare-input-v1")) are pinned by
 * test/sdk.test.ts against scripts/wrangnarok.mjs so the two scaffolds
 * cannot drift apart silently. */
export function scaffoldSaga(input: ScaffoldInput): { files: readonly ScaffoldFile[]; next: readonly string[] } {
  const { revision } = checkScaffoldInput(input);
  const file = `src/sagas/${input.name}.ts`;
  const content = `// SPDX-License-Identifier: AGPL-3.0
// ${input.name} Saga (scaffolded with the Wrangnarok SDK v${SDK_VERSION}).
// Stable identity per ADR 002: id ${input.id}. Changing the id below mints
// a DIFFERENT Saga; ordinary edits keep it and bump nothing.
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Bindings } from "../bindings";
import { EXECUTION_ID } from "../domain";
import type { ExecutionParams, SafeError } from "../domain";
import { defineSaga } from "../saga";
import { failExecution, prepareExecution } from "../executions";
import { executeSaga } from "./shared";

export const ${input.name.replace(/[^a-zA-Z0-9_]/g, "_")}SagaDef = defineSaga<unknown>({
  id: ${JSON.stringify(input.id)},
  name: ${JSON.stringify(input.name)},
  revision: ${JSON.stringify(revision)},
  description: ${JSON.stringify(input.description)},
  // Declare every Integration this Saga needs, even when empty. A
  // declared-but-missing Connection fails loud with 424
  // INTEGRATION_REQUIREMENT_UNSATISFIED; undeclared access resolves to
  // None and never throws.
  requiredIntegrations: [],
  inputSchema: Object.freeze({
    type: "object" as const,
    properties: Object.freeze({}),
    additionalProperties: false,
  }),
  parse: (value: unknown) => value,
  run: async (ctx, step): Promise<unknown> => {
    const id = ctx.executionId;
    if (typeof id !== "string" || !EXECUTION_ID.test(id)) {
      throw new NonRetryableError("Invalid local Execution invocation.");
    }
    let expectedFailure: SafeError | undefined;
    try {
      const prepared = await step.do("prepare-input-v1", () =>
        prepareExecution(ctx.db, id, ${JSON.stringify(input.id)}, ${JSON.stringify(revision)}, (v) => v),
      );
      const output = await step.do("work-v1", async () => prepared.input);
      await step.do("persist-success-v1", async () => {
        await ctx.db
          .prepare(
            "UPDATE executions SET status='Succeeded',completed_at=?,result_json=? WHERE id=? AND status='Running'",
          )
          .bind(new Date().toISOString(), JSON.stringify(output), id)
          .run();
      });
      return output;
    } catch {
      const safe: SafeError = expectedFailure ?? {
        code: "EXECUTION_FAILED",
        message: "The Execution could not complete. Inspect local runtime diagnostics.",
      };
      await step.do("persist-failure-v1", () => failExecution(ctx.db, id, safe));
      throw new NonRetryableError(safe.code);
    }
  },
});

export class ${input.name.replace(/[^a-zA-Z0-9]/g, "")}Workflow extends WorkflowEntrypoint<Bindings, ExecutionParams> {
  async run(event: WorkflowEvent<ExecutionParams>, step: WorkflowStep): Promise<unknown> {
    return executeSaga(this.env, event, step, ${input.name.replace(/[^a-zA-Z0-9_]/g, "_")}SagaDef);
  }
}
`;
  return {
    files: Object.freeze([{ path: file, content }]),
    next: Object.freeze([
      `Add the definition to SAGA_DEFINITIONS in src/sagas/index.ts and the Workflow binding in wrangler.jsonc.`,
      `Add the stable identity to sagas.manifest.json (the saga-contract test fails loudly otherwise).`,
      `Run npm run check:sagas and npm test before opening a PR.`,
    ]),
  };
}

/** Resolve one Saga from an offline catalog by stable UUID or exact name.
 * Names are unique (buildCatalog throws on duplicates), so ambiguity is a
 * loud SDK_SAGA_AMBIGUOUS rather than a guess. */
export function inspectSaga(catalog: readonly CatalogEntry[], ref: string): CatalogEntry {
  if (STABLE_UUID.test(ref)) {
    const byId = catalog.find((entry) => entry.id.toLowerCase() === ref.toLowerCase());
    if (!byId) throw new SdkError("SDK_SAGA_NOT_FOUND", `No Saga with stable id ${JSON.stringify(ref)}.`);
    return byId;
  }
  const matches = catalog.filter((entry) => entry.name === ref);
  if (matches.length === 0) {
    throw new SdkError("SDK_SAGA_NOT_FOUND", `No Saga named ${JSON.stringify(ref)} in the catalog.`);
  }
  const first = matches[0];
  if (matches.length > 1 || first === undefined) {
    throw new SdkError("SDK_SAGA_AMBIGUOUS", `Multiple Sagas named ${JSON.stringify(ref)}; pass a stable UUID.`);
  }
  return first;
}

export type SchemaCheck = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** Validate one input value against a Saga IoSchema (offline, before
 * submit). This mirrors what the server parse functions enforce for the
 * built-in Sagas; the server remains authoritative and test/sdk.test.ts
 * asserts the two agree on the happy and denied shapes. */
export function validateAgainstSchema(value: unknown, schema: IoSchema | undefined): SchemaCheck {
  if (schema === undefined) return { ok: true };
  if (!isRecord(value)) return { ok: false, error: "Input must be a JSON object." };
  for (const key of Object.keys(value)) {
    if (!(key in schema.properties)) {
      if (schema.additionalProperties === false) {
        return { ok: false, error: `Unknown input field ${JSON.stringify(key)}.` };
      }
      continue;
    }
  }
  for (const key of schema.required ?? []) {
    if (!(key in value)) return { ok: false, error: `Missing required input field ${JSON.stringify(key)}.` };
  }
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (!(key in value)) continue;
    const actual = value[key];
    switch (prop.type) {
      case "string":
        if (typeof actual !== "string")
          return { ok: false, error: `Input field ${JSON.stringify(key)} must be a string.` };
        break;
      case "number":
        if (typeof actual !== "number")
          return { ok: false, error: `Input field ${JSON.stringify(key)} must be a number.` };
        break;
      case "boolean":
        if (typeof actual !== "boolean") {
          return { ok: false, error: `Input field ${JSON.stringify(key)} must be a boolean.` };
        }
        break;
      case "array":
        if (!Array.isArray(actual)) return { ok: false, error: `Input field ${JSON.stringify(key)} must be an array.` };
        break;
      case "object":
        if (!isRecord(actual)) return { ok: false, error: `Input field ${JSON.stringify(key)} must be an object.` };
        break;
      default:
        return { ok: false, error: `Unknown schema type for ${JSON.stringify(key)}.` };
    }
  }
  return { ok: true };
}

// --- Automation client ------------------------------------------------------
// Thin typed calls over the Worker HTTP API only — no Saga logic here, the
// same rule as scripts/wrangnarok.mjs. Caller policy matches the browser UI
// exactly: `Authorization: Bearer <token>` (local fixture token or Access
// service identity), Organization from the auth context (never a header or
// body field), exact 64-hex Execution IDs only.

export interface SdkAccessCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface SdkClientOptions {
  readonly base: string;
  readonly token: string;
  readonly access?: SdkAccessCredentials;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface SdkSubmitOptions {
  readonly saga: string;
  readonly input?: unknown;
  readonly key?: string;
  readonly wait?: boolean;
}

export interface SdkHistoryQuery {
  /** One status or a comma-separated set (mirrors the server + upstream
   * multi-status filter). Unknown values fail server-side with INVALID_STATUS. */
  readonly status?: string;
  readonly saga?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

const EXECUTION_ID_RE = /^[a-f0-9]{64}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{16,128}$/;
const NOTIFICATION_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function checkExecutionId(id: string): void {
  if (!EXECUTION_ID_RE.test(id)) {
    throw new SdkError("SDK_INVALID_REF", "Execution lookups need the exact 64-hex Execution ID.");
  }
}

function checkNotificationId(id: string): void {
  if (!NOTIFICATION_ID_RE.test(id)) {
    throw new SdkError("SDK_INVALID_REF", "Notification lookups need the exact notification UUID.");
  }
}

function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `sdk-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export interface SdkDiagnosis {
  readonly executionId: string;
  readonly status: string;
  readonly sagaName: string;
  readonly operations: readonly SdkOperation[];
  readonly result: unknown;
  readonly error: unknown;
  /** Operator hint for known failure codes; null when there is nothing actionable to add. */
  readonly hint: string | null;
}

function hintFor(code: unknown): string | null {
  if (!isRecord(code)) return null;
  switch (code.code) {
    case "INTEGRATION_REQUIREMENT_UNSATISFIED":
      return "This Saga requires an Integration Connection that is not configured for this Organization.";
    case "ECHO_VENDOR_TIMEOUT":
    case "NINJA_VENDOR_TIMEOUT":
      return "The vendor exceeded its deadline; the timeout-mark checkpoint wrote TimedOut. Retry with a fresh key.";
    case "NINJA_UNAUTHORIZED":
    case "NINJA_NOT_CONFIGURED":
      return "NinjaOne credentials are missing or rejected; check the server environment, not the Saga source.";
    case "EXECUTION_CANCELLED":
      return "The Execution was cancelled; submit a fresh Idempotency-Key to run again.";
    case "DISPATCH_UNCONFIRMED":
      return "Work may have started. Retry the same request and Idempotency-Key.";
    default:
      return null;
  }
}

export interface SdkClient {
  listSagas(): Promise<readonly SdkSaga[]>;
  inspectSaga(ref: string): Promise<SdkSaga>;
  /** DEV-02 read-only preview (POST /api/dev/preview): validates against the
   * static Catalog with no D1 writes and no Workflow dispatch. */
  previewSaga(options: SdkPreviewOptions): Promise<SdkPreview>;
  submitExecution(options: SdkSubmitOptions): Promise<SdkSubmitReceipt | SdkExecutionDetail>;
  getExecution(id: string): Promise<SdkExecutionDetail>;
  cancelExecution(id: string): Promise<SdkCancelReceipt>;
  listHistory(query?: SdkHistoryQuery): Promise<SdkHistoryPage>;
  diagnoseExecution(id: string): Promise<SdkDiagnosis>;
  /** OPS-01 audit trail (GET /api/audit): Organization-scoped events. */
  listAuditEvents(query?: SdkAuditQuery): Promise<SdkAuditPage>;
  /** OPS-01 notifications inbox (GET /api/notifications). */
  listNotifications(limit?: number): Promise<readonly SdkNotification[]>;
  /** OPS-01 notification detail (GET /api/notifications/:id). */
  getNotification(id: string): Promise<SdkNotification>;
  /** OPS-01 dismissal (DELETE /api/notifications/:id). */
  dismissNotification(id: string): Promise<void>;
  /** CON-02 scoped config (GET /api/config): typed rows for this
   * Organization; secret rows answer "[SECRET]", never values. */
  listConfigs(): Promise<readonly SdkConfigEntry[]>;
  /** CON-02 scoped config (POST /api/config): set a non-secret value or
   * provision a secret reference (upsert by key; managed rows refuse). */
  setConfig(options: SdkSetConfigOptions): Promise<SdkConfigEntry>;
  /** CON-02 scoped config (PUT /api/config/:id): omitted secret values
   * preserve the reference. */
  updateConfig(options: SdkUpdateConfigOptions): Promise<SdkConfigEntry>;
  /** CON-02 scoped config (DELETE /api/config/:id). */
  deleteConfig(id: string): Promise<void>;
  getContract(): Promise<SdkContractDescriptor>;
}

export function createSdkClient(options: SdkClientOptions): SdkClient {
  const base = options.base.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) {
    throw new SdkError("SDK_INVALID_REF", "The SDK base must be an http(s) URL.");
  }
  if (!options.token) throw new SdkError("UNAUTHORIZED", "The SDK needs a bearer token.");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 120000;
  const pollMs = options.pollMs ?? 2000;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (options.access) {
    headers["CF-Access-Client-Id"] = options.access.clientId;
    headers["CF-Access-Client-Secret"] = options.access.clientSecret;
  }

  async function readJson(response: Response, what: string): Promise<unknown> {
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new SdkError("SDK_CLIENT_MISMATCH", `${what} returned a non-JSON body.`, response.status);
    }
    if (!response.ok) {
      // The body is already consumed: extract the envelope directly instead
      // of re-reading it through parseSdkError.
      let code: SdkErrorCode = "SDK_CLIENT_MISMATCH";
      let message = `${what} failed with status ${response.status}.`;
      if (isRecord(data) && isRecord(data.error)) {
        if (isErrorCode(data.error.code)) code = data.error.code;
        if (typeof data.error.message === "string" && data.error.message.length > 0) message = data.error.message;
      }
      throw new SdkError(code, message, response.status);
    }
    return data;
  }

  async function fetchSagas(): Promise<readonly SdkSaga[]> {
    const response = await guard(() => fetchImpl(`${base}/api/sagas`, { headers }), "saga catalog");
    return parseSagaCatalog(await readJson(response, "saga catalog"));
  }

  async function resolveSagaId(ref: string): Promise<string> {
    if (STABLE_UUID.test(ref)) return ref;
    const sagas = await fetchSagas();
    const matches = sagas.filter((entry) => entry.name === ref);
    if (matches.length === 0) throw new SdkError("SDK_SAGA_NOT_FOUND", `No Saga named ${JSON.stringify(ref)}.`);
    const first = matches[0];
    if (matches.length > 1 || first === undefined) {
      throw new SdkError("SDK_SAGA_AMBIGUOUS", `Multiple Sagas named ${JSON.stringify(ref)}; pass a stable UUID.`);
    }
    return first.id;
  }

  async function pollDetail(executionId: string, wait: boolean): Promise<SdkExecutionDetail> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const response = await guard(() => fetchImpl(`${base}/api/executions/${executionId}`, { headers }), "detail");
      const detail = parseExecutionDetail(await readJson(response, "execution detail"));
      if ((SDK_TERMINAL_STATUSES as readonly string[]).includes(detail.status) || !wait) return detail;
      if (Date.now() >= deadline) {
        throw new SdkError("SDK_CLIENT_TIMEOUT", `Execution ${executionId} did not settle in time.`);
      }
      await sleep(pollMs);
    }
  }

  async function guard<T>(fn: () => Promise<T>, what: string): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof SdkError) throw error;
      throw new SdkError(
        "SDK_CLIENT_NETWORK",
        `${what} request failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  return {
    async listSagas(): Promise<readonly SdkSaga[]> {
      return fetchSagas();
    },
    async inspectSaga(ref: string): Promise<SdkSaga> {
      if (STABLE_UUID.test(ref)) {
        const sagas = await fetchSagas();
        return inspectSaga(sagas, ref);
      }
      const sagas = await fetchSagas();
      return inspectSaga(sagas, ref);
    },
    async previewSaga(preview: SdkPreviewOptions): Promise<SdkPreview> {
      const sagaId = await resolveSagaId(preview.saga);
      const response = await guard(
        () =>
          fetchImpl(`${base}/api/dev/preview`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              sagaId,
              input: preview.input ?? {},
              ...(preview.checkEnvironment === true ? { checkEnvironment: true } : {}),
            }),
          }),
        "saga preview",
      );
      return parsePreview(await readJson(response, "saga preview"));
    },
    async submitExecution(submit: SdkSubmitOptions): Promise<SdkSubmitReceipt | SdkExecutionDetail> {
      const key = submit.key ?? randomKey();
      if (!IDEMPOTENCY_KEY_RE.test(key)) {
        throw new SdkError("SDK_INVALID_REF", "Idempotency-Key must be 16-128 chars [A-Za-z0-9._:-].");
      }
      const sagaId = await resolveSagaId(submit.saga);
      const response = await guard(
        () =>
          fetchImpl(`${base}/api/executions`, {
            method: "POST",
            headers: { ...headers, "Idempotency-Key": key },
            body: JSON.stringify({ sagaId, input: submit.input ?? {} }),
          }),
        "execution submit",
      );
      const data: unknown = await readJson(response, "execution submit");
      if (!isRecord(data) || typeof data.executionId !== "string") {
        throw new SdkError("SDK_CLIENT_MISMATCH", "Submit returned no executionId.");
      }
      if (submit.wait === false) {
        return {
          executionId: data.executionId,
          replayed: data.replayed === true,
          statusUrl: typeof data.statusUrl === "string" ? data.statusUrl : `/api/executions/${data.executionId}`,
        };
      }
      return pollDetail(data.executionId, true);
    },
    async getExecution(id: string): Promise<SdkExecutionDetail> {
      checkExecutionId(id);
      return pollDetail(id, false);
    },
    async cancelExecution(id: string): Promise<SdkCancelReceipt> {
      checkExecutionId(id);
      const response = await guard(
        () => fetchImpl(`${base}/api/executions/${id}/cancel`, { method: "POST", headers }),
        "execution cancel",
      );
      const data: unknown = await readJson(response, "execution cancel");
      if (!isRecord(data) || typeof data.executionId !== "string" || typeof data.status !== "string") {
        throw new SdkError("SDK_CLIENT_MISMATCH", "Cancel returned an unexpected shape.");
      }
      return { executionId: data.executionId, status: data.status, cancelled: data.cancelled === true };
    },
    async listHistory(query: SdkHistoryQuery = {}): Promise<SdkHistoryPage> {
      const params = new URLSearchParams();
      if (query.status !== undefined) params.set("status", query.status);
      if (query.saga !== undefined) params.set("sagaId", await resolveSagaId(query.saga));
      if (query.from !== undefined) params.set("startDate", query.from);
      if (query.to !== undefined) params.set("endDate", query.to);
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      if (query.cursor !== undefined) params.set("cursor", query.cursor);
      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      const response = await guard(() => fetchImpl(`${base}/api/executions${suffix}`, { headers }), "history");
      return parseHistoryPage(await readJson(response, "history"));
    },
    async diagnoseExecution(id: string): Promise<SdkDiagnosis> {
      const detail = await this.getExecution(id);
      return {
        executionId: detail.executionId,
        status: detail.status,
        sagaName: detail.sagaName,
        operations: detail.operations,
        result: detail.result,
        error: detail.error,
        hint: hintFor(detail.error),
      };
    },
    async listAuditEvents(query: SdkAuditQuery = {}): Promise<SdkAuditPage> {
      const params = new URLSearchParams();
      if (query.action !== undefined) params.set("action", query.action);
      if (query.outcome !== undefined) params.set("outcome", query.outcome);
      if (query.search !== undefined) params.set("search", query.search);
      if (query.from !== undefined) params.set("startDate", query.from);
      if (query.to !== undefined) params.set("endDate", query.to);
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      if (query.cursor !== undefined) params.set("cursor", query.cursor);
      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      const response = await guard(() => fetchImpl(`${base}/api/audit${suffix}`, { headers }), "audit trail");
      return parseAuditPage(await readJson(response, "audit trail"));
    },
    async listNotifications(limit?: number): Promise<readonly SdkNotification[]> {
      const params = new URLSearchParams();
      if (limit !== undefined) params.set("limit", String(limit));
      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      const response = await guard(() => fetchImpl(`${base}/api/notifications${suffix}`, { headers }), "notifications");
      return parseNotifications(await readJson(response, "notifications"));
    },
    async getNotification(id: string): Promise<SdkNotification> {
      checkNotificationId(id);
      const response = await guard(() => fetchImpl(`${base}/api/notifications/${id}`, { headers }), "notification");
      return parseNotification(await readJson(response, "notification"));
    },
    async dismissNotification(id: string): Promise<void> {
      checkNotificationId(id);
      const response = await guard(
        () => fetchImpl(`${base}/api/notifications/${id}`, { method: "DELETE", headers }),
        "notification dismissal",
      );
      await readJson(response, "notification dismissal");
    },
    async listConfigs(): Promise<readonly SdkConfigEntry[]> {
      const response = await guard(() => fetchImpl(`${base}/api/config`, { headers }), "config list");
      return parseConfigList(await readJson(response, "config list"));
    },
    async setConfig(options: SdkSetConfigOptions): Promise<SdkConfigEntry> {
      const response = await guard(
        () =>
          fetchImpl(`${base}/api/config`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              key: options.key,
              type: options.type,
              ...(options.value === undefined ? {} : { value: options.value }),
              ...(options.description === undefined ? {} : { description: options.description }),
            }),
          }),
        "config set",
      );
      return parseConfigEntry(await readJson(response, "config set"));
    },
    async updateConfig(options: SdkUpdateConfigOptions): Promise<SdkConfigEntry> {
      if (!STABLE_UUID.test(options.id)) {
        throw new SdkError("SDK_INVALID_REF", "Config updates need the exact config UUID.");
      }
      const response = await guard(
        () =>
          fetchImpl(`${base}/api/config/${options.id}`, {
            method: "PUT",
            headers,
            body: JSON.stringify({
              ...(options.key === undefined ? {} : { key: options.key }),
              ...(options.type === undefined ? {} : { type: options.type }),
              ...(options.value === undefined ? {} : { value: options.value }),
              ...(options.description === undefined ? {} : { description: options.description }),
            }),
          }),
        "config update",
      );
      return parseConfigEntry(await readJson(response, "config update"));
    },
    async deleteConfig(id: string): Promise<void> {
      if (!STABLE_UUID.test(id)) {
        throw new SdkError("SDK_INVALID_REF", "Config deletes need the exact config UUID.");
      }
      const response = await guard(
        () => fetchImpl(`${base}/api/config/${id}`, { method: "DELETE", headers }),
        "config delete",
      );
      await readJson(response, "config delete");
    },
    async getContract(): Promise<SdkContractDescriptor> {
      const response = await guard(() => fetchImpl(`${base}${SDK_DOC_PATH}`, { headers }), "sdk contract");
      const data: unknown = await readJson(response, "sdk contract");
      if (!isRecord(data) || data.version !== SDK_VERSION) {
        throw new SdkError("SDK_CLIENT_MISMATCH", "The server SDK contract version does not match this SDK.");
      }
      return data as unknown as SdkContractDescriptor;
    },
  };
}

// --- Served contract descriptor (GET /api/sdk) -------------------------------

export interface SdkContractRoute {
  readonly method: string;
  readonly path: string;
  readonly description: string;
}

export interface SdkContractDescriptor {
  readonly contract: "wrangnarok.sdk";
  readonly version: typeof SDK_VERSION;
  readonly routes: readonly SdkContractRoute[];
  readonly errorCodes: readonly string[];
  readonly capabilities: readonly { readonly name: string; readonly status: string; readonly detail: string }[];
  readonly docs: readonly { readonly name: string; readonly path: string }[];
}

/** Machine-readable SDK contract served by GET /api/sdk and pinned by
 * test/sdk.test.ts. Capabilities name the author/automation surface this
 * SDK version actually provides; everything else lives in
 * docs/sdk-capability-map.md against its owning parity issue. */
export function describeContract(): SdkContractDescriptor {
  return {
    contract: "wrangnarok.sdk",
    version: SDK_VERSION,
    routes: [
      { method: "GET", path: "/api/sdk", description: "This contract descriptor (authenticated)." },
      { method: "GET", path: "/api/sagas", description: "Saga discovery catalog (read-only metadata)." },
      {
        method: "POST",
        path: "/api/dev/preview",
        description:
          "No-registration local preview: authoritative parse, no D1 writes, no dispatch. Opt-in read-only environment check.",
      },
      { method: "POST", path: "/api/executions", description: "Submit an Execution (Idempotency-Key required)." },
      {
        method: "GET",
        path: "/api/executions",
        description: "ExecutionHistory summaries (status/sagaId/sagaName/startDate/endDate/limit/cursor).",
      },
      {
        method: "GET",
        path: "/api/executions/:id",
        description: "Execution detail with Operations, result, and safe error.",
      },
      { method: "POST", path: "/api/executions/:id/cancel", description: "Owner-only cancellation (exact ID)." },
      {
        method: "GET",
        path: "/api/forms/:name",
        description: "Form declaration for this Organization (FORM-01 binding slice; renderer belongs to FORM-02).",
      },
      {
        method: "POST",
        path: "/api/forms/:name/submit",
        description: "Validate against the declaration (422 FORM_VALIDATION_FAILED) then submit the bound Saga.",
      },
      { method: "GET", path: "/api/apps", description: "Application summaries." },
      { method: "POST", path: "/api/apps", description: "Create an independent app." },
      {
        method: "GET",
        path: "/api/apps/:id",
        description: "App detail with revisions, jobs, and the active deployment.",
      },
      { method: "DELETE", path: "/api/apps/:id", description: "Delete an independent app." },
      {
        method: "PUT",
        path: "/api/apps/:id/source",
        description: "Edit source declarations.",
      },
      {
        method: "POST",
        path: "/api/apps/:id/validate",
        description: "Validate the current revision.",
      },
      {
        method: "POST",
        path: "/api/apps/:id/builds",
        description: "Start a deploy job.",
      },
      { method: "GET", path: "/api/apps/:id/builds", description: "Inspect the deploy-job queue." },
      { method: "GET", path: "/api/apps/:id/builds/:jobId", description: "Inspect one deploy job." },
      {
        method: "POST",
        path: "/api/apps/:id/swap",
        description: "Slug-swap recovery.",
      },
      {
        method: "GET",
        path: "/api/apps/:id/assets/*",
        description: "Serve one active-deployment file.",
      },
      { method: "GET", path: "/api/artifacts", description: "Artifact summaries for this Organization (FILE-02)." },
      {
        method: "PUT",
        path: "/api/artifacts",
        description: "Upload bytes (?name=, ?mime=, octet-stream body); same-filename re-upload versions the same row.",
      },
      {
        method: "GET",
        path: "/api/artifacts/:id",
        description: "Artifact detail with versions and attachment bindings (creator-or-admin).",
      },
      { method: "DELETE", path: "/api/artifacts/:id", description: "Soft-delete: metadata survives, bytes removed." },
      { method: "GET", path: "/api/artifacts/:id/preview", description: "Current-version bytes inline." },
      {
        method: "GET",
        path: "/api/artifacts/:id/download",
        description: "Current-version bytes as an attachment download.",
      },
      {
        method: "GET",
        path: "/api/artifacts/:id/versions/:n",
        description: "One addressed older-version byte snapshot.",
      },
      {
        method: "PUT",
        path: "/api/artifacts/:id/bytes",
        description: "Upload a new version to one Artifact row (octet-stream body).",
      },
      { method: "POST", path: "/api/artifacts/:id/rename", description: "Rename the canonical record." },
      {
        method: "POST",
        path: "/api/artifacts/:id/bindings",
        description: "Bind the Artifact to an execution/workspace/conversation reference.",
      },
      {
        method: "DELETE",
        path: "/api/artifacts/:id/bindings",
        description: "Remove one attachment binding (bytes untouched).",
      },
      {
        method: "GET",
        path: "/api/artifacts/bindings",
        description: "List attachment triples for one (?scope=, ?refId=) reference (no bytes).",
      },
      {
        method: "GET",
        path: "/api/artifacts/:id/export",
        description: "Portable metadata-only manifest (never runtime bytes).",
      },
      { method: "GET", path: "/api/artifacts/formats", description: "Generated-output format subcapabilities." },
      { method: "GET", path: "/api/artifacts/retention", description: "Read the retention policy (default 90 days)." },
      {
        method: "PUT",
        path: "/api/artifacts/retention",
        description: "Set the retention window, 1-3650 days (admin only).",
      },
      {
        method: "GET",
        path: "/api/artifacts/cleanup/preview",
        description: "List what retention cleanup would delete (no writes).",
      },
      {
        method: "POST",
        path: "/api/artifacts/cleanup/run",
        description: "Delete one bounded expired batch with per-row outcomes (admin only).",
      },
      { method: "GET", path: "/api/apps/:id/grants", description: "List app grants." },
      { method: "POST", path: "/api/apps/:id/grants", description: "Create an app grant." },
      {
        method: "POST",
        path: "/api/apps/:id/grants/:grantId/revoke",
        description: "Revoke an app grant.",
      },
      {
        method: "GET",
        path: "/api/apps/:id/tables",
        description: "List declared Tables (includes hidden).",
      },
      { method: "POST", path: "/api/apps/:id/tables", description: "Declare an app Table." },
      { method: "GET", path: "/api/apps/:id/sdk", description: "App SDK handshake (version tripwire)." },
      {
        method: "GET",
        path: "/api/apps/:id/runtime/tables",
        description: "List granted visible Tables.",
      },
      {
        method: "GET",
        path: "/api/apps/:id/runtime/tables/:name/rows",
        description: "Filtered Table page read (filter/limit/cursor/sinceRevision).",
      },
      {
        method: "POST",
        path: "/api/apps/:id/runtime/tables/:name/rows",
        description: "Insert one Table row.",
      },
      {
        method: "PATCH",
        path: "/api/apps/:id/runtime/tables/:name/rows/:rowId",
        description: "Replace one Table row.",
      },
      {
        method: "DELETE",
        path: "/api/apps/:id/runtime/tables/:name/rows/:rowId",
        description: "Delete one Table row.",
      },
      {
        method: "POST",
        path: "/api/apps/:id/runtime/invoke",
        description: "Invoke a granted Saga (Idempotency-Key required).",
      },
      {
        method: "GET",
        path: "/api/apps/:id/runtime/executions",
        description: "Scoped invocation tail (result via Execution detail).",
      },
      { method: "GET", path: "/api/apps/:id/runtime/files", description: "List read-granted files." },
      {
        method: "POST",
        path: "/api/apps/:id/runtime/files",
        description: "Declare a file location.",
      },
      {
        method: "POST",
        path: "/api/apps/:id/runtime/files/tokens",
        description: "Issue a single-use file token.",
      },
      {
        method: "POST",
        path: "/api/apps/:id/runtime/files/upload",
        description: "Redeem an upload token (verified).",
      },
      {
        method: "POST",
        path: "/api/apps/:id/runtime/files/download",
        description: "Redeem a download token.",
      },
      {
        method: "DELETE",
        path: "/api/apps/:id/runtime/files/*",
        description: "Version-aware file delete.",
      },
      {
        method: "GET",
        path: "/api/audit",
        description:
          "Administrative audit trail (action/outcome/search/startDate/endDate/limit/cursor; Organization-scoped).",
      },
      {
        method: "GET",
        path: "/api/notifications",
        description: "Operational inbox: own personal rows plus same-org org-scoped rows.",
      },
      {
        method: "GET",
        path: "/api/notifications/:id",
        description: "One notification (owner-only for personal rows).",
      },
      {
        method: "DELETE",
        path: "/api/notifications/:id",
        description: "Dismiss a notification (owner-only for personal rows).",
      },
      {
        method: "GET",
        path: "/api/file-locations",
        description: "Declared file locations for this Organization.",
      },
      {
        method: "POST",
        path: "/api/file-locations",
        description: "Declare a write location (mints read/write/delete policies).",
      },
      {
        method: "GET",
        path: "/api/file-locations/:name",
        description: "Location detail with policies.",
      },
      {
        method: "DELETE",
        path: "/api/file-locations/:name",
        description: "Delete an empty location (policies and tokens revoked).",
      },
      {
        method: "POST",
        path: "/api/files/uploads",
        description: "Bounded batch upload-slot issuance (per-path allow/deny).",
      },
      {
        method: "POST",
        path: "/api/files/downloads",
        description: "Bounded batch download-token issuance (per-path allow/deny).",
      },
      {
        method: "PUT",
        path: "/api/files/content?token=",
        description: "Stage upload bytes under a single-use slot token.",
      },
      {
        method: "GET",
        path: "/api/files/content",
        description: "Download ready bytes (capability token or Bearer read).",
      },
      {
        method: "POST",
        path: "/api/files/finalize",
        description: "Finalize-after-upload: server verifies size/digest/type/version.",
      },
      {
        method: "GET",
        path: "/api/files",
        description: "Organization-scoped structural listing (never shared rows).",
      },
      {
        method: "DELETE",
        path: "/api/files",
        description: "Version-fenced delete (FILE_MISSING / VERSION_CONFLICT).",
      },
      {
        method: "POST",
        path: "/api/file-policies",
        description: "Grant one policy row.",
      },
      {
        method: "DELETE",
        path: "/api/file-policies",
        description: "Revoke one policy row (outstanding tokens invalidated).",
      },
      {
        method: "POST",
        path: "/api/file-policies/test",
        description: "Evaluate a hypothetical access triple, issuing nothing.",
      },
      {
        method: "GET",
        path: "/api/integrations",
        description: "Portable Integration definitions with schema, defaults, and health (CON-01; no org state).",
      },
      { method: "GET", path: "/api/connections", description: "This Organization's Connection mappings (CON-01)." },
      { method: "POST", path: "/api/connections", description: "Create a loose Connection mapping (CON-01)." },
      {
        method: "GET",
        path: "/api/connections/:integrationId",
        description: "Read one Connection mapping for this Organization (CON-01).",
      },
      {
        method: "PUT",
        path: "/api/connections/:integrationId",
        description: "Update a loose Connection mapping; managed rows reject MANAGED_RESOURCE (CON-01).",
      },
      {
        method: "DELETE",
        path: "/api/connections/:integrationId",
        description: "Delete a loose Connection mapping (CON-01).",
      },
      {
        method: "POST",
        path: "/api/connections/:integrationId/test",
        description: "Read-only connectivity test: no writes, no dispatch (CON-01).",
      },
      { method: "GET", path: "/api/tables", description: "Tables visible to this caller in this Organization." },
      { method: "POST", path: "/api/tables", description: "Create a Table declaration (owner: the creator)." },
      { method: "GET", path: "/api/tables/:name", description: "Table declaration." },
      {
        method: "DELETE",
        path: "/api/tables/:name",
        description: "Delete a Table and its rows and grants (owner-only).",
      },
      {
        method: "GET",
        path: "/api/tables/:name/rows",
        description: "Policy-safe bounded query: nested-JSON filters, prefix, order, cursor pagination.",
      },
      {
        method: "GET",
        path: "/api/tables/:name/count",
        description: "Scoped filtered count; skip_count answers total=-1 without scanning.",
      },
      { method: "PUT", path: "/api/tables/:name/rows/:id", description: "Insert one document." },
      { method: "GET", path: "/api/tables/:name/rows/:id", description: "Read one document." },
      { method: "PATCH", path: "/api/tables/:name/rows/:id", description: "Replace one document wholesale." },
      { method: "DELETE", path: "/api/tables/:name/rows/:id", description: "Delete one document." },
      {
        method: "POST",
        path: "/api/tables/:name/rows/batch",
        description: "Batch insert: all-or-denied policy preflight, per-item operational results.",
      },
      {
        method: "PUT",
        path: "/api/tables/:name/rows/batch-update",
        description: "Batch update: all-or-denied policy preflight, per-item operational results.",
      },
      {
        method: "POST",
        path: "/api/tables/:name/rows/batch-delete",
        description: "Batch delete: all-or-denied policy preflight, per-item operational results.",
      },
      {
        method: "POST",
        path: "/api/tables/:name/grants",
        description: "Grant one action to a user (owner-only; revocation converges on next call).",
      },
      {
        method: "DELETE",
        path: "/api/tables/:name/grants",
        description: "Revoke one action grant (owner-only).",
      },
      { method: "GET", path: "/api/config", description: "Typed config rows for this Organization (secrets masked)." },
      {
        method: "POST",
        path: "/api/config",
        description: "Set a non-secret value or provision a secret reference (upsert by key).",
      },
      {
        method: "PUT",
        path: "/api/config/:id",
        description: "Update one config row by ID; omitted secret values preserve the reference.",
      },
      {
        method: "DELETE",
        path: "/api/config/:id",
        description: "Delete one config row by ID (managed rows refuse).",
      },
      { method: "GET", path: "/api/endpoints", description: "Operator endpoint inventory (this Organization)." },
      {
        method: "POST",
        path: "/api/endpoints",
        description: "Create a scoped endpoint bound to a deployed Saga (raw credential returned once).",
      },
      { method: "GET", path: "/api/endpoints/:name", description: "Read one scoped endpoint summary." },
      {
        method: "PATCH",
        path: "/api/endpoints/:name",
        description: "Update endpoint policy (enabled, rateLimitPerMinute, keyExpiresAt).",
      },
      { method: "POST", path: "/api/endpoints/:name/rotate", description: "Rotate the endpoint credential." },
      { method: "GET", path: "/api/endpoints/:name/events", description: "Delivery history for replay visibility." },
      {
        method: "POST",
        path: "/api/endpoints/:name",
        description: "Public credential-authenticated api-key delivery (X-Endpoint-Key or Bearer).",
      },
      {
        method: "POST",
        path: "/hooks/:name",
        description: "Public HMAC-signed webhook delivery (X-Webhook-Signature; echo-param challenge supported).",
      },
    ],
    errorCodes: [...SDK_ERROR_CODES],
    capabilities: [
      {
        name: "author-discovery",
        status: "supported",
        detail: "List and inspect Sagas (id, revision, description, schemas, requiredIntegrations).",
      },
      {
        name: "author-registration",
        status: "git-owned",
        detail:
          "Sagas register through Git-owned TypeScript plus sagas.manifest.json (ADR 002); no runtime register endpoint.",
      },
      {
        name: "validated-input",
        status: "supported",
        detail: "Offline validateAgainstSchema plus server parse; the server remains authoritative.",
      },
      { name: "execute-status-cancel", status: "supported", detail: "Submit, poll, detail, history, and cancel." },
      {
        name: "generated-artifacts",
        status: "supported",
        detail:
          "Generated/uploaded Artifacts on Worker + D1 + R2 (FILE-02, ADR 019): upload with same-filename versioning, list/preview/download/rename/delete, execution/workspace/conversation attachment bindings with the canonical-versus-binding access split, configurable retention with explicit preview/run cleanup. Portable exports are metadata-only; Python rendering libraries are not required.",
      },
      {
        name: "authored-apps",
        status: "supported",
        detail: "Independent apps: create, edit, validate, build, jobs, swap, delete, asset serving (ADR 017).",
      },
      {
        name: "app-runtime",
        status: "supported",
        detail:
          "Scoped browser App SDK runtime (ADR 019): grant-scoped Saga invoke, visible-Table read/write with revision polling, versioned files with single-use tokens, handshake tripwire. No WebSocket; no Forms/config hooks.",
      },
      {
        name: "managed-files",
        status: "supported",
        detail:
          "Managed file locations: declare, policy-checked proxy upload/download, finalize-after-upload verification, versioned mutation, access-test (ADR 018). Retention/multipart stay tracked under FILE-02.",
      },
      {
        name: "local-preview",
        status: "supported",
        detail:
          "No-registration local preview (POST /api/dev/preview): authoritative parse, no D1 writes, no dispatch; opt-in read-only environment check. Sync/Git/lock/deploy guidance lives in docs/dev-preview.md (DEV-02).",
      },
      {
        name: "ops-audit-notifications",
        status: "supported",
        detail:
          "Administrative audit trail (GET /api/audit) plus operational notifications inbox with dismiss (ADR 020).",
      },
      {
        name: "connection-management",
        status: "supported",
        detail:
          "Non-secret Connection mappings: list, create, read, update, delete, and read-only test through the authorized Worker API (CON-01). Managed rows reject live mutation with MANAGED_RESOURCE.",
      },
      {
        name: "author-tables",
        status: "supported",
        detail:
          "Author Tables over D1 (TABLE-02 query/count/batch slice): declarations, deny-by-absence per-action grants, bounded keyset queries, scoped counts with skip_count, all-or-denied batches. Realtime subscriptions stay deferred.",
      },
      {
        name: "author-config",
        status: "supported",
        detail:
          "Scoped config over D1 (CON-02, ADR 020): typed string/int/bool/json rows plus secret references, org-only resolution, [SECRET] list masking, managed-row ownership. No global tier.",
      },
      {
        name: "endpoint-triggers",
        status: "supported",
        detail:
          "Scoped api-key and HMAC webhook endpoints bound to deployed Sagas (TRG-02, ADR 019): operator create/disable/rotate, vendor deliveries with deterministic replay, rate limits, and delivery history.",
      },
      {
        name: "resource-management",
        status: "tracked",
        detail:
          "Author Tables/files/forms/agents SDK commands belong to their owning parity issues (see docs/sdk-capability-map.md); the scoped browser app runtime is the separate app-runtime capability.",
      },
    ],
    docs: [
      { name: "Author and automation SDK", path: "docs/sdk.md" },
      { name: "Python SDK capability map", path: "docs/sdk-capability-map.md" },
      { name: "AI-agent authoring instructions", path: "docs/sdk-agents.md" },
    ],
  };
}

/** Offline catalog snapshot for callers that cannot reach the Worker (the
 * static Git-owned Catalog; D1 mirrors it but never drives behavior). */
export function localCatalog(): readonly CatalogEntry[] {
  return SAGA_CATALOG;
}
