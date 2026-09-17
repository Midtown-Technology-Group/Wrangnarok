// SPDX-License-Identifier: AGPL-3.0
import { authenticate, describeCaller } from "./auth";
import type { Bindings } from "./bindings";
import {
  appDetail,
  createApp,
  deleteApp,
  editAppSource,
  jobDetail,
  listApps,
  listJobs,
  loadApp,
  parseAppBody,
  parseAppId,
  parseSwapBody,
  serveAsset,
  startBuild,
  swapSlugs,
  validateApp,
} from "./apps";
import { cancelDirectChildren, isMissingLineageColumn } from "./children";
import {
  artifactDetail,
  ARTIFACT_FORMAT_STATUS,
  ARTIFACT_FORMATS,
  ARTIFACT_LIST_LIMIT_MAX,
  bindAttachment,
  bindingsForRef,
  createOrVersionArtifact,
  deleteArtifact,
  downloadArtifact,
  exportManifest,
  getRetention,
  isAdminCaller,
  listArtifacts,
  parseArtifactId,
  parseArtifactVersion,
  parseBindingRef,
  parseBindingScope,
  previewArtifact,
  previewCleanup,
  renameArtifact,
  runCleanup,
  setRetention,
  unbindAttachment,
  uploadArtifactVersion,
} from "./artifacts";
import {
  APP_SDK_VERSION,
  createAppGrant,
  declareAppFile,
  declareAppTable,
  deleteAppFile,
  deleteTableRow,
  describeAppHandshake,
  insertTableRow,
  issueFileToken,
  listAppExecutions,
  listAppGrants,
  listDeclaredTables,
  listRuntimeFiles,
  listRuntimeTables,
  loadRuntimeApp,
  parseTableQuery as parseAppTableQuery,
  patchTableRow,
  readTableRows,
  recordAppExecution,
  redeemFileDownload,
  redeemFileUpload,
  requireAppGrant,
  revokeAppGrant,
} from "./app-runtime";
import { previewEnvironment, previewLocal } from "./dev";
import {
  HALO_INTEGRATION_ID,
  executeHaloOperation,
  haloLabSpec,
  inspectHaloOperation,
  searchHaloOperations,
  HALO_CLASSIFICATIONS,
  HALO_DEFAULT_POLICY,
  HALO_SPEC_VERSION,
} from "./integrations/halo";
import {
  mcpResult,
  parseMcpCallParams,
  parseMcpDescribeParams,
  parseMcpRequest,
  parseMcpSearchParams,
  searchTools,
} from "./mcp";
import { indexOperations, inspectOperation, searchOperations } from "./openapi";
import type { CodeModeProvenance } from "./openapi";
import { toolRegistry } from "./tools";
import {
  boundedJson,
  canTransition,
  classifyTerminateError,
  cloudflareInventorySaga,
  cloudflareVerifySaga,
  digestSaga,
  echoSaga,
  executionId,
  Fault,
  helloParentSaga,
  helloSaga,
  ninjaSaga,
  object,
  parseCallerKey,
  parseCloudflareInventoryInput,
  parseCloudflareVerifyInput,
  parseDigestInput,
  parseHelloInput,
  parseHelloParentInput,
  parseHistoryQuery,
  parseInput,
  parseKey,
  parseNinjaOrgsInput,
  parseSmokeInput,
  parseSubmission,
  resolveSubmissionSaga,
  smokeSaga,
  UUID,
} from "./domain";
import type { Principal, TerminateOutcome } from "./domain";
import {
  authenticateEndpointKey,
  authenticateWebhook,
  checkEndpointRateLimit,
  createEndpoint,
  endpointSummary,
  executeEndpointDelivery,
  findChallengeEndpoint,
  listEndpointEvents,
  listEndpoints,
  loadEndpoint,
  loadEndpointsByName,
  parseEndpointName,
  parseVendorEventId,
  parseWebhookSecrets,
  readWebhookBody,
  resolveEndpointSagaId,
  rotateEndpointCredential,
  updateEndpoint,
  vendorChallenge,
} from "./endpoints";
import {
  createEventSource,
  deleteEventSource,
  emitEvent,
  listEventSources,
  listEvents,
  parseEventSourceName,
  setEventSourceEnabled,
} from "./events";
import {
  createSchedule,
  deleteSchedule,
  deliveryForWindow,
  listSchedules,
  loadSchedule,
  parseScheduleBody,
  parseScheduleName,
  promoteDueSchedules,
  setScheduleEnabled,
} from "./schedules";
import {
  consumeAfterAdmission,
  deleteForm,
  FORM_NAME,
  type FormDefinition,
  listForms,
  loadForm,
  mayStartForm,
  parseFileRef,
  parseScheduleAt,
  parseStartupHandle,
  peekStartupHandle,
  resolveFormProviders,
  saveForm,
  startFormSession,
  validateAndMerge,
} from "./forms";
import { deleteConfig, listConfigs, parseUpdateConfigInput, setConfig, updateConfig } from "./config";
import {
  createNotification,
  dismissNotification,
  inspectRepair,
  listAudit,
  listNotifications,
  opsConnectionHealth,
  opsJobs,
  opsMetrics,
  opsPreflight,
  opsScheduledTasks,
  opsVersion,
  parseAuditQuery,
  parseNotificationId,
  parseNotificationLimit,
  parseRepairBody,
  recordAudit,
  runRepair,
  visibleNotification,
} from "./ops";
import {
  consumeUploadToken,
  createLocation,
  deleteFile,
  deleteLocation,
  finalizeUpload,
  grantPolicy,
  issueDownloadBatch,
  issueUploadBatch,
  listFiles,
  listLocations,
  listPolicies,
  loadLocation,
  objectKey,
  parseBatchEntries,
  parseFileListQuery,
  parseFilePath,
  parseFinalizeBody,
  parseLocationName,
  readBoundedBytes,
  resolveBearerRead,
  resolveDownloadToken,
  revokePolicy,
  testAccess,
} from "./files";
import {
  createConnection,
  deleteConnection,
  getConnection,
  listConnections,
  putConnectionSecrets,
  scrubConnectionPayload,
  testConnection,
  updateConnection,
} from "./connections";
import { describeIntegrations } from "./integrations";

import {
  canManageOrg,
  createOrg,
  deleteOrg,
  deletePreview,
  getOrgSummary,
  inviteMember,
  listMembers,
  listOrgs,
  listOrgHistory,
  parseOrgId,
  parseUserId,
  requireInstanceAdmin,
  requireManageOrg,
  resolveCaller,
  resolveUser,
  setOrgStatus,
  setUserStatus,
  updateMember,
  type CallerCtx,
  type MembershipKind,
  type MembershipStatus,
  type MemberUpdate,
  type OrgRole,
} from "./orgs";
import {
  batchDelete,
  batchInsert,
  batchUpdate,
  countRows,
  createTable,
  deleteRow,
  deleteTable,
  grantTable,
  insertRow,
  listTables,
  loadTable,
  parseBatchBody,
  parseBatchDeleteBody,
  parseTableName,
  parseTableQuery,
  queryRows,
  readRow,
  requireVisibleTable,
  revokeTable,
  TABLE_NAME,
  updateRow,
} from "./tables";
import {
  assignRole,
  createPolicyRule,
  createRole,
  deletePolicyRule,
  deleteRole,
  listAssignments,
  listGrants,
  listPolicyRules,
  listRoles,
  parseRoleId,
  parseRuleId,
  policyConsumers,
  removeGrant,
  requireGrant,
  revokeAll,
  revokeAssignment,
  roleConsumers,
  addGrant as addRoleGrant,
  type ResourceAction,
  type ResourceKind,
} from "./roles";
import { SAGA_CATALOG, SAGA_DEFINITIONS } from "./sagas";
import { describeContract, SDK_DOC_PATH, SDK_VERSION } from "./sdk";
import { isProviderEligible, parseProviderSubmission, providerSummary, runProvider } from "./sync";
import {
  cancelExecution,
  listHistory,
  loadSagaPolicy,
  parseStoredPolicy,
  policySnapshot,
  storeSagaPolicy,
  submit,
  summary,
  visibleExecution,
  workflowForSaga,
} from "./executions";
import { listExecutionLogs, parseLogSearchQuery, parseLogTailQuery, searchExecutionLogs } from "./logs";
import { deploymentSecretsFromEnv, scrubValueWithDeploymentSecrets } from "./secrets";
import { logRequest } from "./usage";
export {
  CloudflareInventoryWorkflow,
  CloudflareVerifyWorkflow,
  EchoWorkflow,
  HelloParentWorkflow,
  HelloWorkflow,
  NinjaEchoDigestWorkflow,
  NinjaOrgsWorkflow,
  SmokeWorkflow,
} from "./sagas";
// OAUTH-01 follow-up (issue #149): the cross-instance rotating-refresh fence
// Durable Object, bound as OAUTH_REFRESH_FENCE in wrangler.jsonc.
export { OAuthRefreshFence } from "./oauth-refresh-fence";

/** Baseline defense headers for every user-facing response (issue #237).
 * JSON API responses already carried no-store + nosniff; this extends the same
 * posture to Static Assets pass-through and raw file/byte responses so the
 * public UI and the API share one baseline: no MIME sniffing, no framing, a
 * locked-down referrer, no powerful browser features, and HSTS on HTTPS.
 * Content-Type/Cache-Control stay caller-owned (JSON defaults, file types).
 * apiBytes/json build the baseline inline (one Response, no re-wrap); only
 * the ASSETS pass-through copies headers, since fetched responses may be
 * immutable. */
/** Content-Security-Policy per surface: the JSON/file API carries no active
 * content, so default-src 'none'; the Static Assets UI shell needs its own
 * scripts, styles, and images, so self-only. */
const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";
const ASSET_CSP = "default-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'";
const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Content-Security-Policy": API_CSP,
};
function withAssetSecurity(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const name of Object.keys(SECURITY_HEADERS)) {
    if (name === "Content-Security-Policy") continue;
    const value = SECURITY_HEADERS[name];
    if (value !== undefined && !headers.has(name)) headers.set(name, value);
  }
  if (!headers.has("Content-Security-Policy")) headers.set("Content-Security-Policy", ASSET_CSP);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
function apiBytes(body: BodyInit | null, status: number, headers: Record<string, string>): Response {
  return new Response(body, { status, headers: { ...SECURITY_HEADERS, ...headers } });
}
function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return Response.json(body, {
    status,
    headers: { ...SECURITY_HEADERS, "Cache-Control": "no-store", ...extra },
  });
}
/** Log route for the access log: raw /api/* pathname or "static". Query
 * strings never leave the URL object. */
function routeOf(request: Request): string {
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith("/api/")) return "static";
  return `${request.method} ${pathname}`;
}
/** Guard for JSON write routes: unencoded application/json only, matching
 * the /api/executions submit gate. Shared by the app write routes below.
 * Beyond shape validation this is the CSRF control for Access-authenticated
 * browser sessions (codex #349 #352 #355): a cross-origin HTML form can only
 * send simple content types, never unencoded application/json, so the check
 * rejects cross-site state-changing requests. LAB bearer authentication is
 * not ambient and needs no CSRF control; the guard still applies uniformly
 * so both credential classes share one authoritative write path. */
function requireJson(request: Request): void {
  if (
    request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" ||
    request.headers.has("Content-Encoding")
  )
    throw new Fault(415, "JSON_REQUIRED", "Unencoded JSON is required.");
}
/** Guard for query-less routes: anything after `?` is UNSUPPORTED_QUERY,
 * matching the /api/executions submit gate. Shared by the app runtime routes
 * below so the deny-by-default rule stays one line per route. */
function rejectQuery(url: URL): void {
  if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
}
/** Bearer token from the Authorization header, or null. Endpoint deliveries
 * accept it as the api-key transport alongside X-Endpoint-Key. */
function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  const match = /^Bearer (.+)$/.exec(header);
  return match?.[1] ?? null;
}
/** TOOL-01 shared Code Mode execution (issue #170): one host-mediated call
 * used by POST /api/openapi/execute and the MCP halo_api_execute path.
 * Takes operation selection + params only (never credentials, never a URL);
 * resolves the caller-org Connection, validates against the pinned
 * contract, applies policy, enforces egress, injects auth outside
 * model-visible state, and audits every attempt — success AND failure — with
 * sanitized evidence. Denials and vendor faults carry caller/org/Connection-
 * resolution context, operationId, and spec revision where known, never
 * credential material or vendor body bytes. recordAudit is best-effort, so a
 * failed audit insert never masks the execution Fault. */
async function runCodeModeExecute(
  env: Bindings,
  caller: Principal,
  call: { operationId: string; path?: Record<string, string>; query?: Record<string, string>; body?: unknown },
  ctx?: { readonly isInstanceAdmin: boolean; readonly isOrgAdmin: boolean },
): Promise<{ result: unknown; provenance: CodeModeProvenance }> {
  const secrets = deploymentSecretsFromEnv(env);
  try {
    const executed = await executeHaloOperation(
      env.DB,
      caller,
      { clientId: env.HALO_CLIENT_ID, clientSecret: env.HALO_CLIENT_SECRET },
      {
        operationId: call.operationId,
        ...(call.path === undefined ? {} : { path: call.path }),
        ...(call.query === undefined ? {} : { query: call.query }),
        ...(call.body === undefined ? {} : { body: call.body }),
      },
      {},
      ctx === undefined ? { isInstanceAdmin: false, isOrgAdmin: false } : ctx,
    );
    await recordAudit(
      env.DB,
      caller,
      "codemode.execute",
      { type: "integration", id: HALO_INTEGRATION_ID },
      "success",
      executed.provenance,
      secrets,
    );
    return executed;
  } catch (error) {
    // Failure evidence mirrors the success row: the operation the caller
    // attempted plus the stable denial/fault code. HALO_SPEC_VERSION is the
    // pinned lab revision — known before any Connection or vendor contact.
    await recordAudit(
      env.DB,
      caller,
      "codemode.execute",
      { type: "integration", id: HALO_INTEGRATION_ID },
      "failure",
      {
        operationId: call.operationId,
        code: error instanceof Fault ? error.code : "INTERNAL_ERROR",
        specVersion: HALO_SPEC_VERSION,
      },
      secrets,
    );
    throw error;
  }
}
/** Public TRG-02 deliveries (issue #138, ADR 019): vendor-facing webhook and
 * endpoint receivers. Authenticated by credential (per-endpoint key or HMAC
 * secret), never by the operator session — so they run BEFORE the
 * authenticated /api/* gate below. Name resolution is global by name (names
 * are not secret); the credential disambiguates across Organizations. */
async function handlePublicDelivery(request: Request, env: Bindings): Promise<Response | null> {
  const url = new URL(request.url);
  const delivery = /^\/(api\/endpoints|hooks)\/([a-z0-9][a-z0-9-]{0,63})$/.exec(url.pathname);
  if (!delivery?.[1] || !delivery[2] || request.method !== "POST") return null;
  const expected = delivery[1] === "api/endpoints" ? "api-key" : "webhook";
  const name = parseEndpointName(delivery[2]);
  // Query strings stay deny-by-default here except the vendor challenge
  // handshake (?challenge=<token> on echo-param webhook endpoints). Any
  // other query answers UNSUPPORTED_QUERY like the rest of the API.
  const queryKeys = [...url.searchParams.keys()];
  if (queryKeys.some((entry) => entry !== "challenge")) {
    throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
  }
  // Fail closed: a D1/query/schema fault propagates to the sanitized 5xx
  // path (a retryable infrastructure error for vendors), never to a
  // permanent-looking 404. Only a genuine empty result answers NOT_FOUND.
  const rows = await loadEndpointsByName(env.DB, name);
  if (rows.length === 0) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
  const challengeRow = findChallengeEndpoint(rows.filter((row) => row.kind === "webhook"));
  const challenge = challengeRow ? vendorChallenge(challengeRow, url) : null;
  if (challenge !== null) {
    return apiBytes(challenge, 200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
  }
  if (url.search) {
    throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
  }
  // Read the wire body exactly once: api-key deliveries parse it as JSON;
  // webhook deliveries keep the raw bytes for HMAC and parse from them.
  if (
    request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" ||
    request.headers.has("Content-Encoding")
  )
    throw new Fault(415, "JSON_REQUIRED", "Unencoded JSON is required.");
  const { raw, parsed } = await readWebhookBody(request.body);
  const headers = request.headers;
  const secrets = parseWebhookSecrets(env.ENDPOINT_WEBHOOK_SECRETS);
  const authed =
    expected === "api-key"
      ? await authenticateEndpointKey(
          rows.filter((row) => row.kind === "api-key"),
          request.headers.get("X-Endpoint-Key") ?? bearerToken(request),
        )
      : await authenticateWebhook(
          rows.filter((row) => row.kind === "webhook"),
          raw,
          headers.get("X-Webhook-Signature"),
          secrets,
        );
  await checkEndpointRateLimit(env.DB, authed.endpoint);
  const eventId = parseVendorEventId(headers, parsed);
  resolveEndpointSagaId(authed.endpoint, SAGA_CATALOG);
  const saga = SAGA_DEFINITIONS.find((entry) => entry.id === authed.endpoint.saga_id);
  if (!saga) throw new Fault(500, "ENDPOINT_MISCONFIGURED", "This endpoint is not configured correctly.");
  const accepted = await executeEndpointDelivery(env.DB, submit, env, authed.principal, authed.endpoint, {
    saga: { id: saga.id, name: saga.name, revision: saga.revision, description: saga.description, parse: saga.parse },
    eventId,
    payload: parsed,
  });
  const responseHeaders: Record<string, string> = { Location: accepted.statusUrl };
  if (accepted.eventReplayed) responseHeaders["X-Endpoint-Replayed"] = "true";
  return json(
    {
      executionId: accepted.executionId,
      replayed: accepted.replayed,
      eventReplayed: accepted.eventReplayed,
      statusUrl: accepted.statusUrl,
    },
    accepted.replayed ? 200 : 202,
    responseHeaders,
  );
}
export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    const started = Date.now();
    const response = await handleFetch(request, env);
    logRequest({
      method: request.method,
      route: routeOf(request),
      status: response.status,
      durationMs: Date.now() - started,
    });
    return response;
  },
  async scheduled(controller: ScheduledController, env: Bindings): Promise<void> {
    // TRG-01 Cron tick (issue #137, ADR 012): promote due schedule rows
    // through the submit protocol. Bounded scan, single-winner discipline,
    // overdue promotion, disabled/deleted rows never promoted. The tick
    // never writes timeouts, never sweeps Pending, and never resurrects a
    // cancelled window — promotion is the only write path here.
    void controller;
    // A failed tick must be visible: promoteDueSchedules rethrows backend
    // faults (only per-schedule fences become skips), so log the failure
    // for the Cron/telemetry surface instead of swallowing it. The throw
    // preserves the failed-Cron signal; the log carries the cause.
    try {
      await promoteDueSchedules(env.DB, env, SAGA_DEFINITIONS, submit);
    } catch (error) {
      console.error(`[schedules] tick failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  },
} satisfies ExportedHandler<Bindings>;

/** Serialize a form definition for the designer/read surface (FORM-02):
 * full declaration metadata; the server stays authoritative. */
function serializeForm(def: FormDefinition): unknown {
  return {
    id: def.id,
    name: def.name,
    sagaId: def.sagaId,
    ...(def.title === undefined ? {} : { title: def.title }),
    ...(def.description === undefined ? {} : { description: def.description }),
    allowPrefill: def.allowPrefill,
    fields: def.fields.map((field) => ({
      name: field.name,
      type: field.type,
      ...(field.label === undefined ? {} : { label: field.label }),
      required: field.required,
      maxLength: field.maxLength,
      ...(field.default === undefined ? {} : { default: field.default }),
      ...(field.options === undefined ? {} : { options: field.options }),
      ...(field.provider === undefined ? {} : { provider: field.provider }),
      ...(field.autoFill === undefined ? {} : { autoFill: field.autoFill }),
      ...(field.visibleWhen === undefined ? {} : { visibleWhen: field.visibleWhen }),
      ...(field.file === undefined ? {} : { file: field.file }),
      ...(field.min === undefined ? {} : { min: field.min }),
      ...(field.max === undefined ? {} : { max: field.max }),
      ...(field.pattern === undefined ? {} : { pattern: field.pattern }),
      ...(field.content === undefined ? {} : { content: field.content }),
    })),
  };
}

/** Provider row scan for FORM-02 select/multiselect options and declared
 * auto-fill targets: one caller-authorized queryRows result per
 * table-provider source field (read grant required, at most 50 rows).
 * Denied or missing tables throw (the resolver converts to safe per-field
 * errors, never a leak). Option extraction, the 50-key cap, and the 64 KiB
 * auto-fill output bound live in the resolver, not the scan. */
async function readProviderRows(
  db: D1Database,
  caller: Principal,
  table: string,
): Promise<readonly Record<string, unknown>[]> {
  const def = await loadTable(db, caller.orgId, table);
  if (!def) throw new Fault(404, "TABLE_NOT_FOUND", "Table not found.");
  const page = await queryRows(db, caller, def, {
    filters: [],
    order: "asc",
    skipCount: true,
    limit: 50,
  });
  return page.rows.map((row) => row.data);
}

/** Re-validate file-field references against the live FILE-01 rows: the
 * reference must name the declared location, resolve to a ready file in
 * this Organization, and satisfy the per-field size/type bounds. Stale,
 * foreign, pending, or over-bounds pointers fail closed with 422. */
async function checkFormFiles(
  db: D1Database,
  caller: Principal,
  def: FormDefinition,
  input: Record<string, unknown>,
): Promise<void> {
  for (const field of def.fields) {
    if (field.type !== "file" || !field.file) continue;
    const ref = input[field.name];
    if (ref === undefined) continue;
    const { location, path } = parseFileRef(field, ref);
    const row = await db
      .prepare("SELECT status,size,content_type FROM files WHERE org_id=? AND location=? AND path=?")
      .bind(caller.orgId, location, path)
      .first<{ status: string; size: number; content_type: string }>()
      .catch(() => null);
    if (!row || row.status !== "ready") {
      throw new Fault(422, "FORM_VALIDATION_FAILED", "The form submission did not pass validation.", [
        { field: field.name, code: "FILE_NOT_READY", message: "The referenced file is not ready." },
      ]);
    }
    const maxBytes = (field.file.maxMb ?? 25) * 1024 * 1024;
    if (row.size > maxBytes) {
      throw new Fault(422, "FORM_VALIDATION_FAILED", "The form submission did not pass validation.", [
        { field: field.name, code: "FILE_TOO_LARGE", message: "The referenced file exceeds the field bound." },
      ]);
    }
    if (field.file.contentTypes && !field.file.contentTypes.includes(row.content_type)) {
      throw new Fault(422, "FORM_VALIDATION_FAILED", "The form submission did not pass validation.", [
        { field: field.name, code: "FILE_TYPE_REJECTED", message: "The referenced file type is not accepted." },
      ]);
    }
  }
}

/** Deferred form submission: persist an undispatched Pending Execution row
 * with the due instant recorded in the input (`__scheduleAt`) and no
 * Workflow dispatch (TRG-01 owns promotion; this lane only records the
 * inspectable linkage through the standard Execution detail + history).
 * Same-key same-input replays answer 200. No new DDL: Pending +
 * undispatched is the canonical not-yet-dispatched shape. */
async function scheduleFormExecution(
  db: D1Database,
  caller: Principal,
  key: string,
  formName: string,
  saga: { id: string; name: string; revision: string; parse: (value: unknown) => unknown },
  input: unknown,
  scheduleAt: string,
): Promise<{ executionId: string; replayed: boolean; statusUrl: string; scheduled: true; scheduleAt: string }> {
  const id = await executionId(caller, key);
  const inputJson = JSON.stringify({
    ...(input as Record<string, unknown>),
    __form: formName,
    __scheduleAt: scheduleAt,
  });
  const now = new Date().toISOString();
  const inserted = await db
    .prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,created_at) VALUES (?,?,?,?,?,?,?,0,?) ON CONFLICT(id) DO NOTHING",
    )
    .bind(id, saga.id, saga.name, saga.revision, caller.orgId, caller.userId, inputJson, now)
    .run();
  if (inserted.meta.changes === 0) {
    // Same-key replay: the existing row must carry the same Saga input,
    // mirroring the immediate submit path's IDEMPOTENCY_CONFLICT fence —
    // a recycled key over different input answers 409, never a replay.
    const existing = await db
      .prepare("SELECT saga_id,input_json FROM executions WHERE id=?")
      .bind(id)
      .first<{ saga_id: string; input_json: string }>();
    if (!existing || existing.saga_id !== saga.id || existing.input_json !== inputJson) {
      throw new Fault(409, "IDEMPOTENCY_CONFLICT", "This key already identifies different input.");
    }
    return {
      executionId: id,
      replayed: true,
      statusUrl: `/api/executions/${id}`,
      scheduled: true,
      scheduleAt,
    };
  }
  return {
    executionId: id,
    replayed: false,
    statusUrl: `/api/executions/${id}`,
    scheduled: true,
    scheduleAt,
  };
}

async function handleFetch(request: Request, env: Bindings): Promise<Response> {
  const url = new URL(request.url);
  // Single-Worker full-stack app (ADR 008): the browser UI ships as Static
  // Assets and needs no auth; only /api/* is authenticated JSON.
  if (!url.pathname.startsWith("/api/")) {
    // Public vendor receivers live outside /api/* precisely so they do not
    // require the operator session (ADR 019): /hooks/:name for webhooks.
    if (url.pathname.startsWith("/hooks/")) {
      try {
        const delivered = await handlePublicDelivery(request, env);
        if (delivered) return delivered;
      } catch (error) {
        const fault =
          error instanceof Fault ? error : new Fault(500, "INTERNAL_ERROR", "The request could not be completed.");
        return json({ error: { code: fault.code, message: fault.message } }, fault.status);
      }
    }
    if (env.ASSETS) return withAssetSecurity(await env.ASSETS.fetch(request));
    return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
  }
  try {
    // Public credential-authenticated endpoint deliveries share the /api/*
    // prefix (POST /api/endpoints/:name) but carry no operator session, so
    // they run after the public /hooks/* path but before the membership
    // gate below: vendor credentials, never the operator session.
    const apiDelivery = /^\/api\/endpoints\/[a-z0-9][a-z0-9-]{0,63}$/.exec(url.pathname);
    if (apiDelivery && request.method === "POST") {
      const delivered = await handlePublicDelivery(request, env);
      if (delivered) return delivered;
      return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
    }
    const identity = await authenticate(request, env);
    // AUTH-01 membership gate (ADR 015): every /api/* request resolves the
    // caller against D1. The effective org is the path target for org admin
    // routes (/api/orgs/:id/…), else X-Organization-Id scope selection, else
    // the auth-context org. Selection only narrows to Organizations the
    // caller already belongs to — never an elevation.
    const requestedOrg = request.headers.get("X-Organization-Id");
    const pathOrg = /^\/api\/orgs\/([0-9a-fA-F-]{36})(?:\/|$)/.exec(url.pathname)?.[1];
    // Collection routes address no single org: user-level gate (any known
    // active user lists; only instance admins create). All other routes
    // resolve against the path target or the selected org.
    const isCollection = url.pathname === "/api/orgs";
    const ctx = isCollection
      ? await resolveUser(env.DB, env, identity)
      : await resolveCaller(
          env.DB,
          env,
          identity,
          pathOrg !== undefined
            ? parseOrgId(pathOrg)
            : requestedOrg === null
              ? undefined
              : parseOrgId(requestedOrg.trim()),
        );
    const caller: Principal = ctx.principal;
    // AUTH-01 admin surface (ADR 015): Organization and user lifecycle.
    // Noninteractive management APIs — the same caller policies as the UI.
    // The org history list is the only other route that takes query strings,
    // with the same allowlisted keys as the owner listing.
    const isOrgPath =
      url.pathname === "/api/orgs" ||
      url.pathname.startsWith("/api/orgs/") ||
      url.pathname.startsWith("/api/users/") ||
      url.pathname === "/api/policy-rules" ||
      url.pathname.startsWith("/api/policy-rules/");
    const isOrgHistory = /^\/api\/orgs\/[0-9a-fA-F-]{36}\/executions$/.test(url.pathname) && request.method === "GET";
    // Query strings are deny-by-default: only the history list routes, the
    // table query/count routes, the file structural list and byte routes,
    // the OBS-02 log tail and log search, plus the OPS-01/FILE-02/APP-02
    // routes take them, each through its own allowlisted parser (anything
    // else is UNSUPPORTED_QUERY).
    const historyList = url.pathname === "/api/executions" || isOrgHistory;
    // OBS-02 (issue #153): scoped log tail plus operator search.
    const logQueryList =
      (url.pathname === "/api/logs" && request.method === "GET") ||
      (/^\/api\/executions\/[a-f0-9]{64}\/logs$/.test(url.pathname) && request.method === "GET");
    const tableQueryList =
      request.method === "GET" && /^\/api\/tables\/[a-z0-9][a-z0-9-]{0,63}\/(rows|count)$/.test(url.pathname);
    // OPS-01 (ADR 020): the audit list and notifications list take query
    // strings too, each through its own allowlisted parser. OPS-02 (issue
    // #173): the ops metrics/jobs reads take the same allowlisted keys as
    // the Execution history list (status filters, cursor paging); each
    // route validates its keys below.
    const opsQueryList =
      (url.pathname === "/api/audit" || url.pathname === "/api/notifications") && request.method === "GET";
    const opsDiagQueryList =
      request.method === "GET" &&
      (url.pathname === "/api/ops/metrics" ||
        url.pathname === "/api/ops/jobs" ||
        url.pathname === "/api/ops/scheduled-tasks" ||
        url.pathname === "/api/ops/preflight" ||
        url.pathname === "/api/ops/connections");
    // FILE-02 artifact routes take their own allowlisted keys (upload
    // ?name=/?mime=, list ?limit=, binding ?scope=/?refId=); each route
    // validates its keys below.
    const artifactQuery = url.pathname === "/api/artifacts" || url.pathname.startsWith("/api/artifacts/");
    // APP-02 runtime query keys (ADR 019): the Table page read and the
    // version-aware file delete take query strings through their own
    // allowlisted parsers, like the table query/count routes above.
    const appTableRowsRead =
      request.method === "GET" && /^\/api\/apps\/[0-9a-f-]{36}\/runtime\/tables\/[^/]+\/rows$/.test(url.pathname);
    const appRuntimeFileDelete =
      request.method === "DELETE" && /^\/api\/apps\/[0-9a-f-]{36}\/runtime\/files\/.+$/.test(url.pathname);
    const fileList = url.pathname === "/api/files" && request.method === "GET";
    const fileBytes = url.pathname === "/api/files/content" && (request.method === "GET" || request.method === "PUT");
    // AUTH-02 (ADR 018): the policy-consumer inspection route takes exactly
    // resourceKind/resourceId/action (parsed by parseTripleQuery at the
    // route); every other query shape on admin routes stays rejected.
    const isPolicyConsumers =
      /^\/api\/orgs\/[0-9a-fA-F-]{36}\/policy-consumers$/.test(url.pathname) && request.method === "GET";
    // TOOL-01 Code Mode search (issue #170): ?integration= + ?q= through the
    // route's own allowlisted parser below.
    const openapiSearch = request.method === "GET" && url.pathname === "/api/openapi/search";
    // TRG-01 delivery visibility (issue #137): ?window= through the route's
    // own allowlisted parser below.
    const scheduleDeliveriesRead =
      request.method === "GET" && /^\/api\/schedules\/[a-z0-9][a-z0-9-]{0,63}\/deliveries$/.test(url.pathname);
    if (
      url.search &&
      !(historyList && request.method === "GET") &&
      !logQueryList &&
      !tableQueryList &&
      !opsQueryList &&
      !opsDiagQueryList &&
      !artifactQuery &&
      !appTableRowsRead &&
      !appRuntimeFileDelete &&
      !fileList &&
      !fileBytes &&
      !isPolicyConsumers &&
      !openapiSearch &&
      !scheduleDeliveriesRead
    )
      throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
    if (isOrgPath) {
      const orgRoute = await routeOrgs(request, env, ctx, url);
      if (orgRoute) return orgRoute;
    }
    if (url.pathname === "/api/auth/me" && request.method === "GET") {
      // AUTH-03 caller identity (issue #144): read-only proof of which
      // credential class verified this caller (human, service, fixture, or
      // endpoint). The membership gate above already proved authorization, so
      // strangers and revoked callers never reach this view. Query strings
      // stay deny-by-default like every other single-resource route.
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      return json({ caller: describeCaller(identity, request), role: ctx.role, kind: ctx.kind });
    }
    if (url.pathname === "/api/sagas" && request.method === "GET")
      // Static Git-owned Catalog (ADR 002): discovery metadata only.
      // D1 Execution rows mirror saga_id/name/revision but never drive behavior.
      return json({ sagas: SAGA_CATALOG });
    const policyRoute = /^\/api\/sagas\/([0-9a-f-]{36})\/policy$/.exec(url.pathname);
    if (policyRoute?.[1]) {
      // RUN-01 persisted runtime policy (ADR 018): operator-managed,
      // Organization-scoped environment state, never Saga source. GET inspects
      // the effective policy (persisted row or code default); PUT merges a
      // partial body over the current row. Caller scoping is the same
      // org/requester boundary as reads: unknown Sagas 404, never a leak.
      const sagaId = policyRoute[1].toLowerCase();
      if (!UUID.test(sagaId)) throw new Fault(400, "INVALID_SAGA_ID", "sagaId must be a stable Saga UUID.");
      const entry = SAGA_CATALOG.find((saga) => saga.id.toLowerCase() === sagaId);
      if (!entry) throw new Fault(404, "NOT_FOUND", "Not found.");
      if (request.method === "GET") {
        const record = await loadSagaPolicy(env.DB, caller.orgId, entry.id);
        return json({
          policy: {
            sagaId: entry.id,
            sagaName: entry.name,
            version: record.version,
            updatedAt: record.updatedAt,
            ...record.policy,
          },
        });
      }
      if (request.method === "PUT") {
        // Runtime policy changes affect every caller in this Organization.
        // Authorize through the trusted membership context resolved above;
        // request headers are attacker-controlled and are never an operator
        // identity boundary. Instance admins retain the recovery path.
        await requireManageOrg(env.DB, ctx, caller.orgId);
        requireJson(request);
        const record = await storeSagaPolicy(env.DB, caller.orgId, entry.id, await boundedJson(request.body));
        return json({
          policy: {
            sagaId: entry.id,
            sagaName: entry.name,
            version: record.version,
            updatedAt: record.updatedAt,
            ...record.policy,
          },
        });
      }
    }
    if (url.pathname === SDK_DOC_PATH && request.method === "GET")
      // DEV-01 versioned SDK contract (issue #140): machine-readable
      // descriptor of the public author/automation surface. Authenticated
      // like every other /api/* route; drift is pinned by test/sdk.test.ts.
      return json(describeContract());
    if (url.pathname === "/api/schedules" && request.method === "GET") {
      // TRG-01 schedule inventory (issue #137, ADR 012): org-scoped
      // summaries. Cadence, timezone, enablement, input, and run-as stay
      // persisted environment state, never Saga source metadata.
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      return json({ schedules: await listSchedules(env.DB, caller, SAGA_DEFINITIONS) });
    }
    if (url.pathname === "/api/schedules" && request.method === "POST") {
      // TRG-01 schedule create: any active member may author; run-as always
      // resolves to the creating caller (the schedule owner), never a
      // caller-supplied identity. Same-org duplicate names answer 409.
      await requireManageOrg(env.DB, ctx, caller.orgId);
      requireJson(request);
      const parsed = parseScheduleBody(await boundedJson(request.body), SAGA_DEFINITIONS);
      return json({ schedule: await createSchedule(env.DB, caller, parsed, SAGA_DEFINITIONS) }, 201);
    }
    const scheduleDetail = /^\/api\/schedules\/([a-z0-9][a-z0-9-]{0,63})$/.exec(url.pathname);
    if (scheduleDetail?.[1] && (request.method === "GET" || request.method === "DELETE")) {
      const name = parseScheduleName(scheduleDetail[1]);
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      if (request.method === "GET") {
        const row = await loadSchedule(env.DB, caller.orgId, name);
        if (!row) throw new Fault(404, "NOT_FOUND", "Not found.");
        const [listed] = await listSchedules(env.DB, caller, SAGA_DEFINITIONS).then((all) =>
          all.filter((entry) => entry.name === name),
        );
        return json({ schedule: listed ?? null });
      }
      // Deleting removes the row; already-promoted Executions keep their
      // identity and history. Gone-or-foreign answers 404, never a leak.
      if (request.method === "DELETE") await requireManageOrg(env.DB, ctx, caller.orgId);
      await deleteSchedule(env.DB, caller, name);
      return json({ deleted: true });
    }
    const scheduleEnable = /^\/api\/schedules\/([a-z0-9][a-z0-9-]{0,63})\/(enable|disable)$/.exec(url.pathname);
    if (scheduleEnable?.[1] && scheduleEnable?.[2] && request.method === "POST") {
      // Enablement is operator-managed environment state: disabling fences
      // future promotion while in-flight Executions run to terminal.
      await requireManageOrg(env.DB, ctx, caller.orgId);
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      const name = parseScheduleName(scheduleEnable[1]);
      return json({
        schedule: await setScheduleEnabled(env.DB, caller, name, scheduleEnable[2] === "enable", SAGA_DEFINITIONS),
      });
    }
    const scheduleDeliveries = /^\/api\/schedules\/([a-z0-9][a-z0-9-]{0,63})\/deliveries$/.exec(url.pathname);
    // Unknown name shapes (uppercase, dots, slashes beyond one segment)
    // answer 404 like parseScheduleName does — never UNIMPLEMENTED theater.
    if (
      /^\/api\/schedules\/[^/]+(\/[^/]+)?$/.exec(url.pathname) &&
      !scheduleDeliveries &&
      !/^\/api\/schedules\/([a-z0-9][a-z0-9-]{0,63})$/.exec(url.pathname) &&
      !/^\/api\/schedules\/([a-z0-9][a-z0-9-]{0,63})\/(enable|disable)$/.exec(url.pathname)
    ) {
      return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
    }
    if (scheduleDeliveries?.[1] && request.method === "GET") {
      // Delivery visibility: which window promoted to which Execution.
      // Window selection travels in the allowlisted ?window= key only.
      const name = parseScheduleName(scheduleDeliveries[1]);
      const keys = [...url.searchParams.keys()];
      if (keys.length !== 1 || keys[0] !== "window") {
        throw new Fault(400, "UNSUPPORTED_QUERY", "Only window is supported here.");
      }
      const window = url.searchParams.get("window") ?? "";
      const row = await loadSchedule(env.DB, caller.orgId, name);
      if (!row) throw new Fault(404, "NOT_FOUND", "Not found.");
      const delivery = await deliveryForWindow(env.DB, row.id, window);
      if (!delivery) throw new Fault(404, "NOT_FOUND", "Not found.");
      return json({ delivery: { schedule: name, window, executionId: delivery.execution_id } });
    }
    // TRG-03 S1 event sources (issue #139): org-scoped source registry plus
    // a durable append-only event log. Registration and emission are
    // operator-managed environment state (requireManageOrg), reads are
    // member-open, and foreign rows answer 404 — the same posture as the
    // schedule surface above. Subscriptions, fan-out, and operator replay
    // are deferred: this block owns the registry plus the log only.
    if (url.pathname === "/api/event-sources" && request.method === "GET") {
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      return json({ sources: await listEventSources(env.DB, caller.orgId) });
    }
    if (url.pathname === "/api/event-sources" && request.method === "POST") {
      await requireManageOrg(env.DB, ctx, caller.orgId);
      requireJson(request);
      const body = await boundedJson(request.body);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new Fault(400, "INVALID_EVENT_SOURCE", "Provide name and kind.");
      }
      const record = body as Record<string, unknown>;
      if (typeof record.name === "string") parseEventSourceName(record.name);
      return json(
        {
          source: await createEventSource(env.DB, caller, {
            name: record.name,
            kind: record.kind,
            ...(record.refId === undefined ? {} : { refId: record.refId }),
          }),
        },
        201,
      );
    }
    const eventSourceDetail = /^\/api\/event-sources\/([a-z0-9][a-z0-9-]{0,63})$/.exec(url.pathname);
    if (eventSourceDetail?.[1] && (request.method === "GET" || request.method === "DELETE")) {
      const name = parseEventSourceName(eventSourceDetail[1]);
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      if (request.method === "GET") {
        const [found] = await listEventSources(env.DB, caller.orgId).then((all) =>
          all.filter((entry) => entry.name === name),
        );
        if (!found) throw new Fault(404, "NOT_FOUND", "Not found.");
        return json({ source: found });
      }
      // Deleting removes the source plus its log rows; ExecutionHistory
      // provenance survives on the executions rows. Gone-or-foreign 404s.
      await requireManageOrg(env.DB, ctx, caller.orgId);
      await deleteEventSource(env.DB, caller, name);
      return json({ deleted: true });
    }
    const eventSourceEnable = /^\/api\/event-sources\/([a-z0-9][a-z0-9-]{0,63})\/(enable|disable)$/.exec(url.pathname);
    if (eventSourceEnable?.[1] && eventSourceEnable?.[2] && request.method === "POST") {
      // Enablement fences future emits and delivery appends while logged
      // events keep their rows and history.
      await requireManageOrg(env.DB, ctx, caller.orgId);
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      const name = parseEventSourceName(eventSourceEnable[1]);
      return json({
        source: await setEventSourceEnabled(env.DB, caller, name, eventSourceEnable[2] === "enable"),
      });
    }
    const sourceEvents = /^\/api\/event-sources\/([a-z0-9][a-z0-9-]{0,63})\/events$/.exec(url.pathname);
    // Unknown name shapes answer 404 like parseEventSourceName does — never
    // UNIMPLEMENTED theater.
    if (
      /^\/api\/event-sources\/[^/]+(\/[^/]+)?$/.exec(url.pathname) &&
      !sourceEvents &&
      !/^\/api\/event-sources\/([a-z0-9][a-z0-9-]{0,63})$/.exec(url.pathname) &&
      !/^\/api\/event-sources\/([a-z0-9][a-z0-9-]{0,63})\/(enable|disable)$/.exec(url.pathname)
    ) {
      return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
    }
    if (sourceEvents?.[1] && request.method === "POST") {
      // Operator emission into the log: deterministic (source, event) key,
      // same-content replays, mismatched content 409s. The tick and endpoint
      // delivery paths append internally without passing through here.
      await requireManageOrg(env.DB, ctx, caller.orgId);
      requireJson(request);
      const name = parseEventSourceName(sourceEvents[1]);
      const body = await boundedJson(request.body);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new Fault(400, "INVALID_EVENT", "Provide eventId, topic, and payload.");
      }
      const record = body as Record<string, unknown>;
      const emitted = await emitEvent(env.DB, caller, name, {
        eventId: record.eventId,
        topic: record.topic,
        payload: record.payload,
      });
      return json({ event: emitted.event, replayed: emitted.replayed }, emitted.replayed ? 200 : 201);
    }
    if (sourceEvents?.[1] && request.method === "GET") {
      // Log history for replay visibility: newest first, bounded 50.
      const name = parseEventSourceName(sourceEvents[1]);
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      return json({ events: await listEvents(env.DB, caller.orgId, name, 50) });
    }
    if (url.pathname === "/api/executions" && request.method === "POST") {
      const key = parseCallerKey(request.headers.get("Idempotency-Key"));
      if (
        request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" ||
        request.headers.has("Content-Encoding")
      )
        throw new Fault(415, "JSON_REQUIRED", "Unencoded JSON is required.");
      const body: unknown = await boundedJson(request.body);
      // RUN-03 (ADR 023): caller-chosen sync on the async route is a named
      // rejection, never a silent poll. Eligible Sagas use the provider
      // route; everything else polls the receipt. Checked on the raw body
      // BEFORE parseSubmission, which rejects extra keys.
      if (body !== null && typeof body === "object" && !Array.isArray(body)) {
        const record = body as Record<string, unknown>;
        if (record.sync === true) {
          throw new Fault(
            400,
            "SYNC_NOT_SUPPORTED",
            "Inline results ride POST /api/executions/provider for eligible Sagas; this route returns receipts only.",
          );
        }
        if (record.transient === true) {
          throw new Fault(
            501,
            "TRANSIENT_NOT_SUPPORTED",
            "No-persistence execution is not supported; provider calls persist their receipt.",
          );
        }
      }
      const { saga, input } = parseSubmission(body);
      // AUTH-02 (ADR 018): direct Saga execution needs the saga execute
      // grant. Org/instance admins bypass via `can`; everyone else denies by
      // absence with 403 GRANT_REQUIRED.
      await requireGrant(
        env.DB,
        ctx,
        { orgId: caller.orgId, resourceKind: "saga", resourceId: saga.id.toLowerCase(), action: "execute" },
        "Executing this Saga requires an execute grant.",
      );
      const accepted = await submit(env, caller, key, saga, input);
      // Canonical replay: first submit 202, same-key same-input replay 200 + replayed:true (ADR 001 #15).
      return json(accepted, accepted.replayed ? 200 : 202, { Location: accepted.statusUrl });
    }
    if (url.pathname === "/api/executions/provider" && request.method === "POST") {
      // RUN-03 (ADR 023): bounded inline data-provider execution. Same
      // admission (install gate, idempotency, policy snapshot) as async
      // submit, then the read-only Integration Action runs inside the
      // request deadline and checkpoints terminal state directly. No
      // Workflow binding, no queue wait. Query strings stay denied by the
      // global gate above like every other non-allowlisted route.
      const key = parseCallerKey(request.headers.get("Idempotency-Key"));
      if (
        request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" ||
        request.headers.has("Content-Encoding")
      )
        throw new Fault(415, "JSON_REQUIRED", "Unencoded JSON is required.");
      const { saga, input, rejected } = parseProviderSubmission(await boundedJson(request.body), resolveSubmissionSaga);
      if (rejected.sync === true) {
        throw new Fault(
          400,
          "SYNC_NOT_SUPPORTED",
          "Sync is chosen by route: this provider route already returns inline results.",
        );
      }
      if (rejected.transient === true) {
        throw new Fault(
          501,
          "TRANSIENT_NOT_SUPPORTED",
          "No-persistence execution is not supported; provider calls persist their receipt.",
        );
      }
      // AUTH-02 (ADR 018): provider execution is Saga execution under
      // another route. Require the saga execute grant exactly as the direct
      // submit path does; enrollment or eligibility alone must not authorize.
      // Mode-shape rejections above stay first so malformed requests keep
      // their named codes.
      await requireGrant(
        env.DB,
        ctx,
        { orgId: caller.orgId, resourceKind: "saga", resourceId: saga.id.toLowerCase(), action: "execute" },
        "Executing this provider requires an execute grant on its Saga.",
      );
      if (!isProviderEligible(saga.id)) {
        throw new Fault(
          501,
          "PROVIDER_NOT_SUPPORTED",
          "This Saga runs through the async Execution path only; submit to POST /api/executions and poll the receipt.",
        );
      }
      const outcome = await runProvider(env, caller, key, saga, input);
      return json(providerSummary(outcome), 200, { Location: outcome.statusUrl });
    }
    const formList = url.pathname === "/api/forms";
    if (formList && request.method === "GET") {
      // FORM-02 designer list: org-scoped summaries (id, name, sagaId).
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      return json({ forms: await listForms(env.DB, caller) });
    }
    if (formList && request.method === "POST") {
      // FORM-02 designer create: persisted declaration (server
      // authoritative). Validation failures are 400 INVALID_FORM; unknown
      // Saga IDs fail closed (forms bind to catalog Sagas by name).
      requireJson(request);
      const created: unknown = await boundedJson(request.body);
      if (created === null || typeof created !== "object" || Array.isArray(created)) {
        throw new Fault(400, "INVALID_FORM", "Form declarations must be a JSON object.");
      }
      const createdRecord = created as Record<string, unknown>;
      if (
        typeof createdRecord.sagaId !== "string" ||
        !SAGA_CATALOG.some((entry) => entry.id === (createdRecord.sagaId as string).toLowerCase())
      ) {
        throw new Fault(400, "INVALID_FORM", "Form sagaId must be a known Saga UUID.");
      }
      // AUTH-02: Form authoring needs the form write grant. Creation names
      // its own form, so gate on the kind-wide wildcard target.
      await requireGrant(
        env.DB,
        ctx,
        { orgId: caller.orgId, resourceKind: "form", resourceId: "*", action: "write" },
        "Creating Forms requires a form write grant.",
      );
      const saved = await saveForm(env.DB, caller, created);
      return json({ form: serializeForm(saved) }, 201);
    }
    const formDetail = /^\/api\/forms\/([a-z0-9][a-z0-9-]{0,63})$/.exec(url.pathname);
    if (formDetail?.[1] && request.method === "GET") {
      // Form declaration read (server-authoritative binding plus FORM-02
      // metadata): persisted fields for this Organization only. Unknown or
      // foreign names answer 404 FORM_NOT_FOUND, never a leak.
      const name = formDetail[1];
      if (!FORM_NAME.test(name)) return json({ error: { code: "FORM_NOT_FOUND", message: "Form not found." } }, 404);
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      const def = await loadForm(env.DB, caller.orgId, name);
      if (!def) return json({ error: { code: "FORM_NOT_FOUND", message: "Form not found." } }, 404);
      // AUTH-02 (ADR 018): reading a Form declaration needs the form read
      // grant. Listings and hidden references never bypass: unknown or
      // foreign names already 404'd above, before grant evaluation.
      await requireGrant(
        env.DB,
        ctx,
        { orgId: caller.orgId, resourceKind: "form", resourceId: name, action: "read" },
        "Reading this Form requires a read grant.",
      );
      return json({ form: serializeForm(def) });
    }
    if (formDetail?.[1] && request.method === "PUT") {
      // FORM-02 designer edit: replace the declaration wholesale (server
      // re-validates; unknown or foreign names answer 404 FORM_NOT_FOUND).
      const name = formDetail[1];
      if (!FORM_NAME.test(name)) return json({ error: { code: "FORM_NOT_FOUND", message: "Form not found." } }, 404);
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      requireJson(request);
      const body: unknown = await boundedJson(request.body);
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new Fault(400, "INVALID_FORM", "Form declarations must be a JSON object.");
      }
      const existing = await loadForm(env.DB, caller.orgId, name);
      if (!existing) return json({ error: { code: "FORM_NOT_FOUND", message: "Form not found." } }, 404);
      // AUTH-02: Form authoring needs the form write grant on the target.
      await requireGrant(
        env.DB,
        ctx,
        { orgId: caller.orgId, resourceKind: "form", resourceId: name, action: "write" },
        "Editing this Form requires a write grant.",
      );
      const patch = body as Record<string, unknown>;
      if (
        typeof patch.sagaId !== "string" ||
        !SAGA_CATALOG.some((entry) => entry.id === (patch.sagaId as string).toLowerCase())
      ) {
        throw new Fault(400, "INVALID_FORM", "Form sagaId must be a known Saga UUID.");
      }
      const saved = await saveForm(env.DB, caller, { ...patch, name });
      return json({ form: serializeForm(saved) });
    }
    if (formDetail?.[1] && request.method === "DELETE") {
      // FORM-02 designer delete: unknown or foreign names answer 404 FORM_NOT_FOUND.
      const name = formDetail[1];
      if (!FORM_NAME.test(name)) return json({ error: { code: "FORM_NOT_FOUND", message: "Form not found." } }, 404);
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      // AUTH-02: Form deletion needs the form write grant on the target.
      await requireGrant(
        env.DB,
        ctx,
        { orgId: caller.orgId, resourceKind: "form", resourceId: name, action: "write" },
        "Deleting this Form requires a write grant.",
      );
      await deleteForm(env.DB, caller, name);
      return json({ deleted: name });
    }
    const formStartup = /^\/api\/forms\/([a-z0-9][a-z0-9-]{0,63})\/startup$/.exec(url.pathname);
    if (formStartup?.[1] && request.method === "POST") {
      // FORM-02 startup: mint a session-bound 30-minute handle plus the
      // resolved snapshot (defaults under declared auto-fill under opt-in
      // prefill merge, provider options through the caller-scoped Table
      // gate). Query strings and display-only/unknown prefill fail closed.
      const name = formStartup[1];
      if (!FORM_NAME.test(name)) return json({ error: { code: "FORM_NOT_FOUND", message: "Form not found." } }, 404);
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      requireJson(request);
      const def = await loadForm(env.DB, caller.orgId, name);
      if (!def) return json({ error: { code: "FORM_NOT_FOUND", message: "Form not found." } }, 404);
      // FORM-02 authorization (#155): startup mints a capability and reads
      // provider-derived state, so it needs a form read-or-submit grant —
      // never a separate saga execute grant (delegation), never nothing.
      if (!(await mayStartForm(env.DB, ctx, caller.orgId, name))) {
        throw new Fault(403, "GRANT_REQUIRED", "Starting this Form requires a read or submit grant.");
      }
      const started = await startFormSession(env.DB, caller, def, await boundedJson(request.body), readProviderRows);
      return json(
        {
          form: name,
          handle: started.handle,
          expiresAt: started.expiresAt,
          snapshot: started.snapshot,
          options: started.options,
        },
        201,
      );
    }
    const formProviders = /^\/api\/forms\/([a-z0-9][a-z0-9-]{0,63})\/providers$/.exec(url.pathname);
    if (formProviders?.[1] && request.method === "GET") {
      // FORM-02 provider fetch: resolved select/multiselect options for
      // this Organization through the caller-scoped Table gate. Denied or
      // foreign tables yield empty lists with per-field errors, never a
      // leak. Declared auto-fill targets resolve through the same gate and
      // surface fetch/validation failures here too (startup carries no
      // error channel). Query strings are unsupported (options ride the
      // declaration).
      const name = formProviders[1];
      if (!FORM_NAME.test(name)) return json({ error: { code: "FORM_NOT_FOUND", message: "Form not found." } }, 404);
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      const def = await loadForm(env.DB, caller.orgId, name);
      if (!def) return json({ error: { code: "FORM_NOT_FOUND", message: "Form not found." } }, 404);
      // FORM-02 authorization (#155): provider resolution reads
      // Table-backed state through the declaration, so it needs the same
      // form read-or-submit grant as startup — never a separate saga
      // execute grant, never nothing.
      if (!(await mayStartForm(env.DB, ctx, caller.orgId, name))) {
        throw new Fault(403, "GRANT_REQUIRED", "Reading this Form's providers requires a read or submit grant.");
      }
      const resolved = await resolveFormProviders(env.DB, caller, def.fields, readProviderRows);
      return json({ form: name, options: resolved.options, errors: resolved.errors });
    }
    const formSubmit = /^\/api\/forms\/([a-z0-9][a-z0-9-]{0,63})\/submit$/.exec(url.pathname);
    if (formSubmit?.[1] && request.method === "POST") {
      // Form-to-Saga submission (FORM-01 binding, FORM-02 lifecycle):
      // the caller presents a live startup handle bound to (org, user,
      // form); the server peeks it, re-resolves provider options,
      // validates against the persisted declaration (422 + per-field
      // details), re-validates file references against the live FILE-01
      // rows, merges validated values over declared defaults, and submits
      // down the standard Execution path, consuming the handle only after
      // validation passes so failed validation leaves it live for retry. `{
      // scheduleAt }` defers dispatch (deferred receipt, undispatched
      // Pending row with `__scheduleAt` linkage for TRG-01 promotion).
      // Unknown, expired, foreign, or replayed handles answer 422
      // STALE_FORM_HANDLE and dispatch nothing. The consumed handle is
      // the form-to-Saga grant: no separate direct-Saga grant required.
      const name = formSubmit[1];
      if (!FORM_NAME.test(name)) return json({ error: { code: "FORM_NOT_FOUND", message: "Form not found." } }, 404);
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      const key = parseCallerKey(request.headers.get("Idempotency-Key"));
      requireJson(request);
      const def = await loadForm(env.DB, caller.orgId, name);
      if (!def) return json({ error: { code: "FORM_NOT_FOUND", message: "Form not found." } }, 404);
      // AUTH-02 (ADR 018): the authorized Form IS the delegation — submit
      // needs the form submit grant, never a separate saga execute grant on
      // the bound Saga. Requiring both would make delegation meaningless.
      await requireGrant(
        env.DB,
        ctx,
        { orgId: caller.orgId, resourceKind: "form", resourceId: name, action: "submit" },
        "Submitting this Form requires a submit grant.",
      );
      const body: unknown = await boundedJson(request.body);
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new Fault(422, "FORM_VALIDATION_FAILED", "The form submission must be a JSON object.", [
          { field: "", code: "NOT_OBJECT", message: "The form submission must be a JSON object." },
        ]);
      }
      const record = body as Record<string, unknown>;
      if (Object.keys(record).some((entry) => !["handle", "values", "scheduleAt"].includes(entry))) {
        throw new Fault(422, "FORM_VALIDATION_FAILED", "Submissions carry handle, values, and scheduleAt only.", [
          { field: "", code: "UNKNOWN_FIELD", message: "Submissions carry handle, values, and scheduleAt only." },
        ]);
      }
      const handle = parseStartupHandle(record.handle);
      const scheduleAt = parseScheduleAt(record.scheduleAt);
      // Peek the session without consuming: validation, provider refresh,
      // and the file check all run first so a submission that fails them
      // leaves the handle live for a corrected retry. The handle binds to
      // the current definition id, so delete/recreate under the same name
      // invalidates sessions minted against the old form. The caller's key
      // rides along so a handle spent by THIS key still peeks live for
      // same-key retries and canonical replays.
      const session = await peekStartupHandle(env.DB, caller, name, handle, def.id, key);
      // One provider pass per submit too: fresh options re-check membership
      // while auto-fill values ride the persisted snapshot, never the scan.
      const fresh = await resolveFormProviders(env.DB, caller, def.fields, readProviderRows);
      const values = record.values === undefined ? {} : record.values;
      // Order matters: form-gate validation + defaults merge first, then
      // the live FILE-01 file check, then the Saga parse gate last — so a
      // stale file pointer answers 422 even when the declaration drifts
      // from its Saga schema (which answers the Saga 400 instead).
      const merged = validateAndMerge(def, values, { allowedOptions: fresh.options, values: session.snapshot });
      await checkFormFiles(env.DB, caller, def, merged);
      const { saga, input } = parseSubmission({ sagaId: def.sagaId, input: merged });
      // FORM-02 recovery (#155): consume AFTER durable admission, not
      // before. The old consume-then-dispatch order burned the one-time
      // handle when submit answered 503 DISPATCH_UNCONFIRMED, making the
      // documented same-request retry impossible (STALE_FORM_HANDLE instead
      // of the idempotent recovery path). The flow below:
      // 1. peek the fence (unused + live + same form id),
      // 2. dispatch (or durable schedule insert) first,
      // 3. consume only on success, tolerating a lost consume race only
      //    when the Execution row proves OUR submission admitted (same
      //    deterministic execution id + same input). A lost race over a
      //    foreign admission still answers stale, never a replay of ours.
      if (scheduleAt !== null) {
        const scheduled = await scheduleFormExecution(env.DB, caller, key, name, saga, input, scheduleAt);
        // Consume on every confirmed admission, including idempotent
        // replay: the replay proves OUR key admitted, so the handle binds
        // to it here. A live handle after replay would stay reusable under
        // a different key (PR 320 review).
        const scheduledInput = { ...(input as Record<string, unknown>), __form: name, __scheduleAt: scheduleAt };
        await consumeAfterAdmission(env.DB, caller, name, handle, def.id, key, saga, scheduledInput);
        return json({ form: name, ...scheduled }, scheduled.replayed ? 200 : 202, {
          Location: scheduled.statusUrl,
        });
      }
      // Defensive strip before the immediate Saga parse gate: a form
      // field can never declare __-prefixed names (FIELD_NAME), so any
      // such key would be internal linkage, never caller input.
      const { __form: _internalForm, __scheduleAt: _internalAt, ...sagaInput } = input as Record<string, unknown>;
      void _internalForm;
      void _internalAt;
      const accepted = await submit(env, caller, key, saga, sagaInput);
      // Consume on every confirmed admission, including idempotent replay
      // (same rationale as the scheduled path above): the replayed row
      // proves OUR key, so the handle binds to it and cannot be reused
      // under a different key afterwards.
      await consumeAfterAdmission(env.DB, caller, name, handle, def.id, key, saga, sagaInput);
      // Canonical replay: first submit 202, same-key same-input replay 200 + replayed:true (ADR 001 #15).
      return json({ form: name, ...accepted }, accepted.replayed ? 200 : 202, { Location: accepted.statusUrl });
    }
    if (url.pathname === "/api/dev/preview" && request.method === "POST") {
      // DEV-02 no-registration local preview (ADR 017): read-only by
      // construction. Runs the authoritative server parse against the static
      // Git-owned Catalog with no D1 writes and no Workflow dispatch. The
      // environment section is off by default; opting in only SELECTs
      // Connection presence for the caller's own Organization (never
      // foreign rows, never secret values). Production resources are never
      // touched: this route performs no writes and no vendor calls.
      if (
        request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" ||
        request.headers.has("Content-Encoding")
      )
        throw new Fault(415, "JSON_REQUIRED", "Unencoded JSON is required.");
      const body: unknown = await boundedJson(request.body);
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new Fault(400, "INVALID_SUBMISSION", "Preview needs a stable Saga UUID and its input only.");
      }
      const record = body as Record<string, unknown>;
      if (Object.keys(record).some((key) => !["sagaId", "input", "checkEnvironment"].includes(key))) {
        throw new Fault(400, "INVALID_SUBMISSION", "Preview needs a stable Saga UUID and its input only.");
      }
      const parsers = new Map<string, (value: unknown) => unknown>([
        [echoSaga.id, parseInput],
        [ninjaSaga.id, parseNinjaOrgsInput],
        [digestSaga.id, parseDigestInput],
        [smokeSaga.id, parseSmokeInput],
        [helloSaga.id, parseHelloInput],
        [helloParentSaga.id, parseHelloParentInput],
        [cloudflareVerifySaga.id, parseCloudflareVerifyInput],
        [cloudflareInventorySaga.id, parseCloudflareInventoryInput],
      ]);
      const { meta, parsed, requiredIntegrations } = previewLocal(SAGA_CATALOG, parsers, record.sagaId, record.input);
      const withEnv = record.checkEnvironment === true;
      if (
        record.checkEnvironment !== undefined &&
        record.checkEnvironment !== true &&
        record.checkEnvironment !== false
      ) {
        throw new Fault(400, "INVALID_SUBMISSION", "checkEnvironment must be true or omitted/false.");
      }
      const environment = withEnv ? await previewEnvironment(env.DB, caller.orgId, requiredIntegrations) : [];
      return json({
        preview: {
          saga: meta,
          input: parsed,
          environmentChecked: withEnv,
          environment,
          persisted: false,
          dispatched: false,
        },
      });
    }
    if (url.pathname === "/api/executions" && request.method === "GET") {
      // ExecutionHistory querying (Phase 2): status/sagaId filters plus
      // cursor pagination over org-scoped summaries. The parser rejects
      // unknown keys; the listing never claims completeness (hasMore).
      return json(await listHistory(env.DB, caller, parseHistoryQuery(url.searchParams)));
    }
    const cancel = /^\/api\/executions\/([a-f0-9]{64})\/cancel$/.exec(url.pathname);
    if (cancel?.[1] && request.method === "POST") {
      // Owner-only cancellation (issues #16 then #151): same fixture auth plus
      // the same org/requester scoping as reads — foreign owners get 404, never
      // a leak. The route first writes the logical marker (Pending/Running ->
      // Cancelling, conditional), then attempts the native terminate() control,
      // then CLASSIFIES the native outcome before reporting anything. A
      // confirmed stop is never reported unless one was observed (RUN-04): a
      // resolved terminate, an already-settled engine (finite state), or a
      // vacuous not-found on an undispatched Pending row all confirm; anything
      // else rolls back Cancelling to the prior active status and answers 503
      // CANCELLATION_UNCONFIRMED so the caller retries the same cancel. Only
      // Pending/Running reach the marker write (the transition gate above
      // rejects everything else, including a second cancel that lands while
      // Cancelling); terminal states answer 409 and are never rewritten. A
      // loser that races the winner re-reads below.
      const row = await visibleExecution(env.DB, cancel[1], caller);
      if (!canTransition(row.status, "Cancelling")) {
        throw new Fault(409, "EXECUTION_NOT_CANCELLABLE", "Terminal Executions cannot be cancelled.");
      }
      const marked = await env.DB.prepare(
        "UPDATE executions SET status='Cancelling' WHERE id=? AND status IN ('Pending','Running')",
      )
        .bind(row.id)
        .run();
      if (marked.meta.changes === 0) {
        const current = await visibleExecution(env.DB, row.id, caller);
        if (current.status === "Cancelling") {
          return json({ executionId: row.id, status: "Cancelling", cancelled: false });
        }
        throw new Fault(409, "EXECUTION_NOT_CANCELLABLE", "Terminal Executions cannot be cancelled.");
      }
      const priorStatus = row.status;
      const priorDispatched = row.dispatched;
      const binding = workflowForSaga(env, row.saga_id);
      let terminateOutcome: TerminateOutcome = "stopped";
      try {
        await (await binding.get(row.id)).terminate();
      } catch (error) {
        terminateOutcome = classifyTerminateError(error);
      }
      // Known terminal outcomes confirm the logical cancel (ADR 001): a
      // delivered stop; an engine that already settled (complete/errored/
      // terminated — the terminal fence already guards racing checkpoints); or
      // a vacuous stop on an undispatched Pending row (dispatch was never
      // confirmed, so the native side has nothing left running).
      if (
        terminateOutcome === "stopped" ||
        terminateOutcome === "already-settled" ||
        (terminateOutcome === "not-found" && priorStatus === "Pending" && priorDispatched === 0)
      ) {
        // Best-effort child fan-out (RUN-02, ADR 018): still-active direct
        // children get the same mark-terminate-classify treatment. Ambiguous
        // children stay active and inspectable; parent confirmation never
        // depends on child outcomes. Fan-out failures (enumeration or per-child
        // D1 writes) must not strand a confirmed parent in Cancelling, so the
        // fan-out is isolated: on failure the parent still confirms.
        try {
          await cancelDirectChildren(env, caller, row.id);
        } catch {
          // Best-effort only: fall through to parent confirmation.
        }
        await cancelExecution(env.DB, row.id);
        // OPS-01 audit: owner cancellation confirmed (best-effort; a failed
        // insert never fails the cancel itself).
        await recordAudit(
          env.DB,
          caller,
          "execution.cancel",
          { type: "execution", id: row.id },
          "success",
          { sagaId: row.saga_id },
          deploymentSecretsFromEnv(env),
        );
        return json({ executionId: row.id, status: "Cancelled", cancelled: true });
      }
      // Ambiguous: a dispatched row whose native instance vanished, or any
      // transient/control-plane failure. No terminal or Operation writes — roll
      // back to the prior active status (a compensating write owned by this
      // route, not a product transition) so the caller can retry the same
      // cancel and the true terminal outcome can still land.
      await env.DB.prepare("UPDATE executions SET status=? WHERE id=? AND status='Cancelling'")
        .bind(priorStatus, row.id)
        .run();
      // OPS-01 audit: the cancel was requested but never confirmed (failure
      // outcome, retry-safe — the same record as the 503 below).
      await recordAudit(
        env.DB,
        caller,
        "execution.cancel_unconfirmed",
        { type: "execution", id: row.id },
        "failure",
        { outcome: terminateOutcome },
        deploymentSecretsFromEnv(env),
      );
      throw new Fault(
        503,
        "CANCELLATION_UNCONFIRMED",
        "Cancellation could not be confirmed. Retry the same cancel request.",
      );
    }
    if (url.pathname === "/api/logs" && request.method === "GET") {
      // Operator log search (OBS-02): the caller's own rows only, filterable
      // by date/level/Saga, cursor-paginated in seq order. D1 is the source
      // of truth; this is a polling view, never a live stream.
      return json(
        scrubValueWithDeploymentSecrets(
          await searchExecutionLogs(env.DB, caller, parseLogSearchQuery(url.searchParams)),
          env,
        ),
      );
    }
    const logTail = /^\/api\/executions\/([a-f0-9]{64})\/logs$/.exec(url.pathname);
    if (logTail?.[1] && request.method === "GET") {
      // Scoped read/tail for one Execution (OBS-02): owner-only, DEBUG hidden
      // unless explicitly requested, cursor-paginated in seq order. Reconnect
      // backfills by refetching from the last seen cursor (see mergeLogPages).
      return json(
        scrubValueWithDeploymentSecrets(
          await listExecutionLogs(env.DB, caller, logTail[1], parseLogTailQuery(url.searchParams)),
          env,
        ),
      );
    }
    const match = /^\/api\/executions\/([a-f0-9]{64})$/.exec(url.pathname);
    if (match?.[1] && request.method === "GET") {
      const row = await visibleExecution(env.DB, match[1], caller);
      const operations = await env.DB.prepare(
        "SELECT name,status,started_at,completed_at,result_json,error_json FROM operations WHERE execution_id=? ORDER BY position,name",
      )
        .bind(row.id)
        .all<{
          name: string;
          status: string;
          started_at: string;
          completed_at: string | null;
          result_json: string | null;
          error_json: string | null;
        }>();
      // RUN-02 lineage (ADR 018): direct children of this Execution, newest
      // first. The child's own detail carries its parentExecutionId; this
      // list makes the parent side inspectable without a history scan.
      // Pre-lineage stores (before migration 0015) degrade to an empty list:
      // the route 500s otherwise for fixtures that only applied 0001+0002.
      let children: { id: string; saga_id: string; saga_name: string; status: string; created_at: string }[];
      try {
        children = (
          await env.DB.prepare(
            "SELECT id,saga_id,saga_name,status,created_at FROM executions WHERE parent_execution_id=? AND org_id=? AND user_id=? ORDER BY created_at DESC,id DESC",
          )
            .bind(row.id, caller.orgId, caller.userId)
            .all<{ id: string; saga_id: string; saga_name: string; status: string; created_at: string }>()
        ).results;
      } catch (error) {
        if (!isMissingLineageColumn(error)) throw error;
        children = [];
      }
      let runtimeStatus: string | null = null;
      try {
        const binding = workflowForSaga(env, row.saga_id);
        runtimeStatus = (await (await binding.get(row.id)).status()).status;
      } catch {
        /* Unavailable or expired, not proof of failure. */
      }
      return json(
        scrubValueWithDeploymentSecrets(
          {
            ...summary(row),
            runtimeStatus,
            parentExecutionId: row.parent_execution_id,
            parentStep: row.parent_step,
            children: children.map((kid) => ({
              executionId: kid.id,
              sagaId: kid.saga_id,
              sagaName: kid.saga_name,
              status: kid.status,
              createdAt: kid.created_at,
            })),
            // RUN-01 (ADR 018): the applied policy snapshot rides detail so
            // operators can inspect what this Execution ran under, even after
            // later policy edits. Old rows (NULL) report the code default.
            policy: { sagaId: row.saga_id, ...JSON.parse(policySnapshot(parseStoredPolicy(row.policy_json ?? null))) },
            input: JSON.parse(row.input_json),
            result: row.result_json ? JSON.parse(row.result_json) : null,
            error: row.error_json ? JSON.parse(row.error_json) : null,
            operations: operations.results.map((op) => ({
              name: op.name,
              status: op.status,
              startedAt: op.started_at,
              completedAt: op.completed_at,
              result: op.result_json ? JSON.parse(op.result_json) : null,
              error: op.error_json ? JSON.parse(op.error_json) : null,
            })),
          },
          env,
        ),
      );
    }
    // Managed file locations (FILE-01, ADR 018): declared locations,
    // policy-checked proxy access, finalize-after-upload verification, and
    // versioned mutation. One explicit matcher per route, mirroring the
    // executions/apps style: boring and greppable beats a shared capture.
    // Query strings stay deny-by-default: only GET /api/files takes them,
    // and only its allowlisted keys (location/prefix/limit/cursor).
    // Capability tokens arrive as ?token= on the byte routes only; every
    // other file route reads the standard Authorization header.
    if (url.pathname === "/api/file-locations" && request.method === "GET") {
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      return json({ locations: await listLocations(env.DB, caller) });
    }
    if (url.pathname === "/api/file-locations" && request.method === "POST") {
      requireJson(request);
      return json({ location: await createLocation(env.DB, caller, await boundedJson(request.body)) }, 201);
    }
    const locationOne = /^\/api\/file-locations\/([a-z0-9][a-z0-9-]{0,63})$/.exec(url.pathname);
    if (locationOne?.[1] && request.method === "GET") {
      const found = await loadLocation(env.DB, caller.orgId, locationOne[1]);
      if (!found) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      const policies = await listPolicies(env.DB, caller, locationOne[1]);
      return json({ location: found, policies });
    }
    if (locationOne?.[1] && request.method === "DELETE") {
      await deleteLocation(env.DB, caller, locationOne[1]);
      return json({ deleted: true });
    }
    if (url.pathname === "/api/files/uploads" && request.method === "POST") {
      requireJson(request);
      const issued = await issueUploadBatch(env.DB, caller, parseBatchEntries(await boundedJson(request.body)));
      const denied = issued.some((entry) => !entry.allowed);
      return json(
        {
          entries: issued.map((entry) =>
            entry.allowed
              ? { path: entry.path, allowed: true, token: entry.token, expiresAt: entry.expiresAt }
              : { path: entry.path, allowed: false, code: entry.code, message: entry.message },
          ),
        },
        denied ? 207 : 200,
      );
    }
    if (url.pathname === "/api/files/downloads" && request.method === "POST") {
      requireJson(request);
      const issued = await issueDownloadBatch(env.DB, caller, parseBatchEntries(await boundedJson(request.body)));
      const denied = issued.some((entry) => !entry.allowed);
      return json(
        {
          entries: issued.map((entry) =>
            entry.allowed
              ? { path: entry.path, allowed: true, token: entry.token, expiresAt: entry.expiresAt }
              : { path: entry.path, allowed: false, code: entry.code, message: entry.message },
          ),
        },
        denied ? 207 : 200,
      );
    }
    if (url.pathname === "/api/files/content" && request.method === "PUT") {
      // Upload bytes to a staging key: the token is single-use-consumed and
      // the body is bounded at the location limit + 1 (413 past the cap).
      // Bearer uploads are not accepted: writes always go through an issued
      // slot so the finalize step can verify what was stored.
      const token = url.searchParams.get("token");
      const extra = [...url.searchParams.keys()].filter((key) => key !== "token");
      if (token === null || extra.length > 0)
        throw new Fault(400, "UNSUPPORTED_QUERY", "Uploads need exactly ?token= from an issued slot.");
      const consumed = await consumeUploadToken(env.DB, token);
      const declared = await loadLocation(env.DB, consumed.orgId, consumed.location);
      if (!declared) throw new Fault(404, "NOT_FOUND", "Not found.");
      if (!request.body) throw new Fault(400, "EMPTY_UPLOAD", "The upload body must not be empty.");
      const contentType = request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() || "";
      if (declared.contentTypes.length > 0 && !declared.contentTypes.includes(contentType)) {
        throw new Fault(415, "CONTENT_TYPE_REJECTED", `Content type "${contentType}" is not allowed in this location.`);
      }
      const bytes = await readBoundedBytes(request.body, declared.maxBytes + 1);
      await env.FILES.put(consumed.staging, bytes, { httpMetadata: { contentType: contentType || undefined } });
      return json({ staged: true, size: bytes.byteLength });
    }
    if (url.pathname === "/api/files/content" && request.method === "GET") {
      // Download bytes: capability token (?token=) or Bearer-shape read,
      // resolved through the existence-first read tier. Only ready rows are
      // readable; every denied read answers 404 (non-disclosure).
      const getToken = url.searchParams.get("token");
      if (getToken !== null) {
        const extra = [...url.searchParams.keys()].filter((key) => key !== "token");
        if (extra.length > 0)
          throw new Fault(400, "UNSUPPORTED_QUERY", "Only token is supported with capability downloads.");
      } else {
        for (const key of url.searchParams.keys()) {
          if (key !== "location" && key !== "path")
            throw new Fault(400, "UNSUPPORTED_QUERY", "Only location and path are supported here.");
        }
      }
      const token = getToken;
      const resolved =
        token !== null
          ? await resolveDownloadToken(env.DB, token)
          : await resolveBearerRead(
              env.DB,
              caller,
              parseLocationName(url.searchParams.get("location") ?? ""),
              parseFilePath(url.searchParams.get("path") ?? ""),
            );
      const row = await env.DB.prepare(
        "SELECT size,content_type,sha256,version FROM files WHERE org_id=? AND location=? AND path=? AND status='ready'",
      )
        .bind(resolved.sourceOrgId, resolved.location, resolved.path)
        .first<{ size: number; content_type: string; sha256: string; version: number }>();
      if (!row) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      const stored = await env.FILES.get(objectKey(resolved.sourceOrgId, resolved.location, resolved.path));
      if (!stored) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      return apiBytes(stored.body, 200, {
        "Content-Type": row.content_type,
        "Content-Length": String(row.size),
        ETag: `"${row.sha256}"`,
        "X-File-Version": String(row.version),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
    }
    if (url.pathname === "/api/files/finalize" && request.method === "POST") {
      requireJson(request);
      return json({
        file: await finalizeUpload(env.DB, env.FILES, caller, parseFinalizeBody(await boundedJson(request.body))),
      });
    }
    if (url.pathname === "/api/files" && request.method === "GET") {
      // Organization-scoped structural listing (never shared rows).
      if (!url.search) throw new Fault(400, "INVALID_LOCATION", "Listing needs a location.");
      const listed = await listFiles(env.DB, caller, parseFileListQuery(url.searchParams));
      return json({ files: listed.files, nextCursor: listed.nextCursor });
    }
    if (url.pathname === "/api/files" && request.method === "DELETE") {
      requireJson(request);
      await deleteFile(env.DB, env.FILES, caller, await boundedJson(request.body));
      return json({ deleted: true });
    }
    if (url.pathname === "/api/file-policies" && request.method === "POST") {
      requireJson(request);
      return json({ policy: await grantPolicy(env.DB, caller, await boundedJson(request.body)) }, 201);
    }
    if (url.pathname === "/api/file-policies" && request.method === "DELETE") {
      requireJson(request);
      await revokePolicy(env.DB, caller, await boundedJson(request.body));
      return json({ revoked: true });
    }
    if (url.pathname === "/api/file-policies/test" && request.method === "POST") {
      requireJson(request);
      return json({ access: await testAccess(env.DB, caller, await boundedJson(request.body)) });
    }
    // Authored Applications (APP-01, ADR 017): independent-app lifecycle
    // (create/edit/validate/build/inspect/swap/delete) plus authorized
    // active-deployment asset serving. Solution-owned rows reject live
    // mutation with MANAGED_RESOURCE; foreign-Organization rows 404. One
    // explicit matcher per route, mirroring the executions/cancel style
    // above: boring and greppable beats a shared capture.
    if (url.pathname === "/api/apps" && request.method === "GET") {
      rejectQuery(url);
      return json({ apps: await listApps(env.DB, caller) });
    }
    if (url.pathname === "/api/apps" && request.method === "POST") {
      requireJson(request);
      // AUTH-02 (ADR 018): creating an app needs the kind-wide app write
      // grant. Listing apps stays open metadata; creation does not.
      await requireGrant(
        env.DB,
        ctx,
        { orgId: caller.orgId, resourceKind: "app", resourceId: "*", action: "write" },
        "Creating an App requires a write grant.",
      );
      const { name, slug } = parseAppBody(await boundedJson(request.body));
      try {
        const app = await createApp(env.DB, caller, name, slug);
        // OPS-01 audit: app lifecycle emission (best-effort; never fails the mutation).
        await recordAudit(
          env.DB,
          caller,
          "app.create",
          { type: "app", id: app.id },
          "success",
          { slug: app.slug },
          deploymentSecretsFromEnv(env),
        );
        return json({ app }, 201);
      } catch (error) {
        if (error instanceof Fault) {
          await recordAudit(
            env.DB,
            caller,
            "app.create",
            { type: "app" },
            "failure",
            { code: error.code },
            deploymentSecretsFromEnv(env),
          );
        }
        throw error;
      }
    }
    const appBuilds = /^\/api\/apps\/([0-9a-f-]{36})\/builds$/.exec(url.pathname);
    if (appBuilds?.[1] && (request.method === "GET" || request.method === "POST")) {
      const id = parseAppId(appBuilds[1]);
      rejectQuery(url);
      // AUTH-02 (ADR 018): foreign-Organization ids 404 at loadApp below;
      // known apps need the app write grant for builds (read for job list).
      // Reading the build list is part of inspecting the app: read suffices.
      // Starting a build mutates: write required.
      // OPS-01: the validated build runs inside startBuild; on success the
      // route records app.build.start/app.build.complete audit events and
      // emits a terminal personal notification linked to the job (the one
      // long-running operation this product has). A denied or
      // unvalidatable build records the failure audit and emits nothing.
      if (request.method === "GET") {
        await requireAppVisible(env.DB, ctx, caller, id, "read", "Reading App builds requires a read grant.");
        return json({ jobs: await listJobs(env.DB, caller, id) });
      }
      await requireAppVisible(env.DB, ctx, caller, id, "write", "Building this App requires a write grant.");
      // Codex #355: starting a build mutates deploy state, so it shares the
      // JSON-write gate: unencoded application/json rejects cross-origin
      // form posts against Access-authenticated browser sessions.
      requireJson(request);
      try {
        const job = await startBuild(env.DB, caller, id);
        await recordAudit(
          env.DB,
          caller,
          "app.build.start",
          { type: "app", id },
          "success",
          { jobId: job.id, revision: job.revision },
          deploymentSecretsFromEnv(env),
        );
        await recordAudit(
          env.DB,
          caller,
          "app.build.complete",
          { type: "app", id },
          job.status === "succeeded" ? "success" : "failure",
          { jobId: job.id, revision: job.revision },
          deploymentSecretsFromEnv(env),
        );
        const terminal = job.status === "succeeded" ? "completed" : "failed";
        // Best-effort like audit: a notification-table failure must not fail
        // a build that already succeeded. The response carries the row when
        // stored, null when the table is unavailable.
        let notification: unknown = null;
        try {
          notification = await createNotification(
            env.DB,
            caller,
            {
              scope: "personal",
              category: "app_build",
              title: job.status === "succeeded" ? "App build succeeded" : "App build failed",
              status: terminal,
              detail: { appId: id, jobId: job.id, revision: job.revision },
              dedupKey: `app-build:${job.id}`,
            },
            deploymentSecretsFromEnv(env),
          );
        } catch {
          console.warn(`WRANGNAROK_NOTIFICATION_SKIPPED app-build:${job.id}`);
        }
        return json({ job, notification }, 202);
      } catch (error) {
        if (error instanceof Fault) {
          if (error.code === "MANAGED_RESOURCE") {
            await recordAudit(
              env.DB,
              caller,
              "app.managed_deny",
              { type: "app", id },
              "failure",
              { code: error.code },
              deploymentSecretsFromEnv(env),
            );
          } else {
            await recordAudit(
              env.DB,
              caller,
              "app.build.start",
              { type: "app", id },
              "failure",
              { code: error.code },
              deploymentSecretsFromEnv(env),
            );
          }
        }
        throw error;
      }
    }
    const appJob = /^\/api\/apps\/([0-9a-f-]{36})\/builds\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (appJob?.[1] && appJob[2] && request.method === "GET") {
      const id = parseAppId(appJob[1]);
      await requireAppVisible(env.DB, ctx, caller, id, "read", "Reading App builds requires a read grant.");
      return json({ job: await jobDetail(env.DB, caller, parseAppId(appJob[1]), appJob[2]) });
    }
    const appValidate = /^\/api\/apps\/([0-9a-f-]{36})\/validate$/.exec(url.pathname);
    if (appValidate?.[1] && request.method === "POST") {
      const id = parseAppId(appValidate[1]);
      await requireAppVisible(env.DB, ctx, caller, id, "write", "Validating this App requires a write grant.");
      return json({ revision: await validateApp(env.DB, caller, parseAppId(appValidate[1])) });
    }
    const appSource = /^\/api\/apps\/([0-9a-f-]{36})\/source$/.exec(url.pathname);
    if (appSource?.[1] && request.method === "PUT") {
      requireJson(request);
      const id = parseAppId(appSource[1]);
      await requireAppVisible(env.DB, ctx, caller, id, "write", "Editing this App requires a write grant.");
      try {
        const revision = await editAppSource(env.DB, caller, id, await boundedJson(request.body));
        await recordAudit(
          env.DB,
          caller,
          "app.source.edit",
          { type: "app", id },
          "success",
          { revision: revision.revision },
          deploymentSecretsFromEnv(env),
        );
        return json({ revision });
      } catch (error) {
        if (error instanceof Fault) {
          await recordAudit(
            env.DB,
            caller,
            error.code === "MANAGED_RESOURCE" ? "app.managed_deny" : "app.source.edit",
            { type: "app", id },
            "failure",
            { code: error.code },
            deploymentSecretsFromEnv(env),
          );
        }
        throw error;
      }
    }
    const appSwap = /^\/api\/apps\/([0-9a-f-]{36})\/swap$/.exec(url.pathname);
    if (appSwap?.[1] && request.method === "POST") {
      requireJson(request);
      const id = parseAppId(appSwap[1]);
      await requireAppVisible(env.DB, ctx, caller, id, "write", "Swapping this App requires a write grant.");
      const otherAppId = parseSwapBody(await boundedJson(request.body));
      // Both peers mutate: resolve the peer with hidden-reference discipline
      // (foreign/unknown -> 404) then require its write grant before swapping.
      await requireAppVisible(
        env.DB,
        ctx,
        caller,
        otherAppId,
        "write",
        "Swapping the other App requires a write grant.",
      );
      try {
        const swapped = await swapSlugs(env.DB, caller, id, otherAppId);
        await recordAudit(
          env.DB,
          caller,
          "app.swap",
          { type: "app", id },
          "success",
          { otherAppId },
          deploymentSecretsFromEnv(env),
        );
        return json({ app: swapped.app, other: swapped.other });
      } catch (error) {
        if (error instanceof Fault) {
          await recordAudit(
            env.DB,
            caller,
            error.code === "MANAGED_RESOURCE" ? "app.managed_deny" : "app.swap",
            { type: "app", id },
            "failure",
            { code: error.code },
            deploymentSecretsFromEnv(env),
          );
        }
        throw error;
      }
    }
    const appAsset = /^\/api\/apps\/([0-9a-f-]{36})\/assets\/(.+)$/.exec(url.pathname);
    if (appAsset?.[1] && appAsset[2] && request.method === "GET") {
      const id = parseAppId(appAsset[1]);
      // AUTH-02 (ADR 018): serving the active deployment is its own scoped
      // delegation — serve, not write and not any Saga grant.
      await requireAppVisible(env.DB, ctx, caller, id, "serve", "Serving this App requires a serve grant.");
      const served = await serveAsset(env.DB, caller, parseAppId(appAsset[1]), appAsset[2]);
      return apiBytes(served.content, 200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        ETag: `"${served.contentHash}"`,
        "X-Content-Type-Options": "nosniff",
      });
    }
    const appOne = /^\/api\/apps\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (appOne?.[1] && request.method === "GET") {
      const id = parseAppId(appOne[1]);
      await requireAppVisible(env.DB, ctx, caller, id, "read", "Reading this App requires a read grant.");
      return json({ app: await appDetail(env.DB, caller, parseAppId(appOne[1])) });
    }
    if (appOne?.[1] && request.method === "DELETE") {
      const id = parseAppId(appOne[1]);
      await requireAppVisible(env.DB, ctx, caller, id, "write", "Deleting this App requires a write grant.");
      try {
        await deleteApp(env.DB, caller, id);
        await recordAudit(
          env.DB,
          caller,
          "app.delete",
          { type: "app", id },
          "success",
          {},
          deploymentSecretsFromEnv(env),
        );
        return json({ deleted: true });
      } catch (error) {
        if (error instanceof Fault) {
          await recordAudit(
            env.DB,
            caller,
            error.code === "MANAGED_RESOURCE" ? "app.managed_deny" : "app.delete",
            { type: "app", id },
            "failure",
            { code: error.code },
            deploymentSecretsFromEnv(env),
          );
        }
        throw error;
      }
    }
    // Administrative audit trail (OPS-01, ADR 020): Organization-scoped event
    // list with action-prefix, outcome, search, date, and cursor filters.
    // No per-row detail route (upstream has none either).
    if (url.pathname === "/api/audit" && request.method === "GET") {
      // Outward path: scrubbed again on read (defense in depth — a secret
      // substring in a stored detail can never ride the list out). Non-admins
      // see only their own actor rows (issue #351); admins see the org.
      return json(
        scrubValueWithDeploymentSecrets(
          await listAudit(env.DB, caller, parseAuditQuery(url.searchParams), isAdminCaller(ctx)),
          env,
        ),
      );
    }
    // Operational notifications (OPS-01, ADR 020): durable personal/org inbox
    // with dismiss behavior. List is the caller's own personal rows plus
    // same-org org-scoped rows; reconnects re-read D1, never a stream.
    if (url.pathname === "/api/notifications" && request.method === "GET") {
      // Outward path: scrubbed again on read, like the audit list above.
      return json(
        scrubValueWithDeploymentSecrets(
          { notifications: await listNotifications(env.DB, caller, parseNotificationLimit(url.searchParams)) },
          env,
        ),
      );
    }
    // Loose segment matcher: parseNotificationId fails closed with
    // INVALID_NOTIFICATION_ID on bad shapes (never UNIMPLEMENTED), and
    // unknown UUIDs answer 404 below, never a leak.
    const notifOne = /^\/api\/notifications\/([^/]+)$/i.exec(url.pathname);
    if (notifOne?.[1] && request.method === "GET") {
      const notification = await visibleNotification(env.DB, caller, parseNotificationId(notifOne[1]));
      if (!notification) return json({ error: { code: "NOTIFICATION_NOT_FOUND", message: "Not found." } }, 404);
      return json(scrubValueWithDeploymentSecrets({ notification }, env));
    }
    if (notifOne?.[1] && request.method === "DELETE") {
      // Dismissal: personal rows by owner only, org rows by any same-org
      // caller. Gone-or-foreign answers 404, never a leak; a second dismiss
      // is gone, not an error to retry.
      const dismissed = await dismissNotification(env.DB, caller, parseNotificationId(notifOne[1]));
      if (!dismissed) return json({ error: { code: "NOTIFICATION_NOT_FOUND", message: "Not found." } }, 404);
      return json({ dismissed: true });
    }
    // Cloudflare-native diagnostics (OPS-02, issue #173): product health,
    // version, metrics, scheduled-task status, platform job progress, and
    // Connection health. Every read is Organization-scoped; missing
    // provider metrics answer unavailable, never fabricated. Query strings
    // stay deny-by-default: only the allowlisted keys below pass the gate.
    if (url.pathname === "/api/ops/version" && request.method === "GET") {
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      return json({
        version: await opsVersion(env.DB, { sdkVersion: SDK_VERSION, catalog: SAGA_CATALOG }),
      });
    }
    if (url.pathname === "/api/ops/health" && request.method === "GET") {
      // Liveness over durable state: the membership gate already read D1
      // before reaching this route, so a SELECT 1 here proves the Worker
      // can serve traffic. No vendor, no metering, no secrets. A genuine
      // storage failure surfaces as 500 via the shared handler, never a
      // fabricated degraded payload.
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
      return json({ status: "ok", database: "ok", worker: "ok", checkedAt: new Date().toISOString() });
    }
    if (url.pathname === "/api/ops/metrics" && request.method === "GET") {
      // Upstream metrics.py maps to per-status Execution counts plus the
      // undispatched-Pending admission backlog and recent failure codes.
      // ?recent=N bounds the failure tail (1-50, default 10).
      const recentRaw = url.searchParams.get("recent");
      for (const key of url.searchParams.keys()) {
        if (key !== "recent") {
          throw new Fault(400, "UNSUPPORTED_QUERY", "Only recent is supported here.");
        }
      }
      let recent = 10;
      if (recentRaw !== null) {
        if (!/^\d+$/.test(recentRaw) || Number(recentRaw) < 1 || Number(recentRaw) > 50) {
          throw new Fault(400, "INVALID_LIMIT", "Recent must be an integer from 1 to 50.");
        }
        recent = Number(recentRaw);
      }
      return json(scrubValueWithDeploymentSecrets({ metrics: await opsMetrics(env.DB, caller, recent) }, env));
    }
    if (url.pathname === "/api/ops/scheduled-tasks" && request.method === "GET") {
      // Upstream scheduler_diagnostics.py maps to the durable endpoint
      // inventory plus the TRG-01 schedule inventory (the trigger surfaces
      // that actually exist); schedule rows report their cron/timezone or
      // one-off cadence.
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      return json(await opsScheduledTasks(env.DB, caller));
    }
    if (url.pathname === "/api/ops/jobs" && request.method === "GET") {
      // Upstream jobs.py + platform_jobs.py map to Execution backlog
      // counters plus per-app deploy-job aggregates with interrupted flags.
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      return json(scrubValueWithDeploymentSecrets({ jobs: await opsJobs(env.DB, caller) }, env));
    }
    if (url.pathname === "/api/ops/preflight" && request.method === "GET") {
      // Upstream maintenance.py preflight maps to static per-Integration
      // mapping/credential presence: no vendor HTTP, no secret values.
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      return json(await opsPreflight(env.DB, caller, env as unknown as Record<string, string | undefined>));
    }
    if (url.pathname === "/api/ops/connections" && request.method === "GET") {
      // Upstream platform/workers.py maps to per-Integration Connection
      // health with registry test hints; live probes stay on the explicit
      // per-Connection test route.
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      return json(await opsConnectionHealth(env.DB, caller));
    }
    // Operational repairs (OPS-02, issue #173): inspect-then-act behind the
    // double-commit contract. POST with dryRun omitted or true only
    // inspects (no writes, no dispatch, no deletes); dryRun:false executes
    // behind the admin gate and emits a best-effort audit event. Production
    // stays manual per ADR 004; nothing here runs on a schedule.
    if (url.pathname === "/api/ops/repairs" && request.method === "POST") {
      requireJson(request);
      const repair = parseRepairBody(await boundedJson(request.body));
      const admin = isAdminCaller(ctx);
      if (repair.dryRun) {
        return json({ repair: await inspectRepair(env.DB, caller, repair, admin) });
      }
      if (!admin) {
        throw new Fault(403, "REPAIR_FORBIDDEN", "Only an admin may run operational repairs.");
      }
      const outcome = await runRepair(env.DB, caller, repair, {
        admin,
        secrets: deploymentSecretsFromEnv(env),
        retry: async (key: string, sagaId: string, retryInput: unknown) => {
          const target = SAGA_DEFINITIONS.find((entry) => entry.id === sagaId);
          if (!target) throw new Fault(404, "UNKNOWN_SAGA", "The Saga for this Execution is no longer deployed.");
          const accepted = await submit(env, caller, parseCallerKey(key), target, target.parse(retryInput));
          return { executionId: accepted.executionId, replayed: accepted.replayed };
        },
        cancel: async (executionId: string) => {
          // UPDATE-first like the interactive cancel route: the fenced
          // write decides, then the row is re-read. A lost race (or an
          // already-terminal row) answers the current status with
          // cancelled:false instead of rewriting history.
          const marked = await env.DB.prepare(
            "UPDATE executions SET status='Cancelling' WHERE id=? AND status IN ('Pending','Running')",
          )
            .bind(executionId)
            .run();
          const current = await visibleExecution(env.DB, executionId, caller);
          if (marked.meta.changes === 0) {
            return { status: current.status, cancelled: false };
          }
          try {
            await (await workflowForSaga(env, current.saga_id).get(executionId)).terminate();
          } catch {
            // Best-effort native stop: the D1 marker below is the durable
            // repair record either way (the interactive cancel route keeps
            // the stricter classify-and-confirm contract).
          }
          await cancelExecution(env.DB, executionId);
          return { status: "Cancelled", cancelled: true };
        },
      });
      await recordAudit(
        env.DB,
        caller,
        `ops.repair.${repair.kind}`,
        repair.targetId ? { type: "ops-repair", id: repair.targetId } : { type: "ops-repair" },
        "success",
        { kind: repair.kind, targetId: repair.targetId ?? null },
        deploymentSecretsFromEnv(env),
      );
      return json(scrubValueWithDeploymentSecrets({ repair: outcome }, env));
    }
    // Generated Artifacts (FILE-02, ADR 019): Organization-scoped records
    // with R2 bytes, attachment bindings, and explicit retention cleanup.
    // Canonical byte/metadata access is creator-or-admin; foreign rows 404.
    // One explicit matcher per route, mirroring the apps style above.
    const artifactStore = { db: env.DB, bucket: env.ARTIFACTS };
    const artifactAdmin = isAdminCaller(ctx);
    if (url.pathname === "/api/artifacts" && request.method === "GET") {
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw === null ? undefined : Number(limitRaw);
      if (limitRaw !== null && (!/^\d+$/.test(limitRaw) || limit === undefined)) {
        throw new Fault(400, "INVALID_LIMIT", `Limit must be an integer from 1 to ${ARTIFACT_LIST_LIMIT_MAX}.`);
      }
      for (const key of url.searchParams.keys()) {
        if (key !== "limit") {
          throw new Fault(400, "UNSUPPORTED_QUERY", "Only limit is supported here.");
        }
      }
      return json(await listArtifacts(env.DB, caller, limit === undefined ? {} : { limit }, artifactAdmin));
    }
    if (url.pathname === "/api/artifacts" && request.method === "PUT") {
      // Upload: bytes arrive as the raw octet-stream body; name and mime ride
      // the allowlisted query keys (the only query-bearing artifact route).
      // Same-filename re-upload appends a version to the same Artifact row
      // (201 on first upload, 200 on a new version), never a version-conflict
      // 409: current version always advances.
      const name = url.searchParams.get("name");
      const mime = url.searchParams.get("mime") ?? "application/octet-stream";
      for (const key of url.searchParams.keys()) {
        if (key !== "name" && key !== "mime") {
          throw new Fault(400, "UNSUPPORTED_QUERY", "Only name and mime are supported here.");
        }
      }
      if (name === null)
        throw new Fault(400, "INVALID_ARTIFACT", "Artifact upload needs ?name= and octet-stream bytes.");
      const contentType = request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() ?? "";
      if (contentType !== "application/octet-stream" || request.headers.has("Content-Encoding")) {
        throw new Fault(415, "BYTES_REQUIRED", "Artifact bytes require unencoded application/octet-stream.");
      }
      if (request.body === null) throw new Fault(400, "EMPTY_ARTIFACT", "Artifact bytes must not be empty.");
      const buffer = await request.arrayBuffer();
      const { artifact, created } = await createOrVersionArtifact(artifactStore, caller, {
        name,
        mime,
        bytes: new Uint8Array(buffer),
      });
      return json({ artifact }, created ? 201 : 200);
    }
    if (url.pathname === "/api/artifacts/formats" && request.method === "GET") {
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      return json({
        formats: ARTIFACT_FORMATS.map((format) => ({ format, status: ARTIFACT_FORMAT_STATUS[format] })),
      });
    }
    if (url.pathname === "/api/artifacts/retention" && request.method === "GET") {
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      return json({ retention: await getRetention(env.DB, caller.orgId) });
    }
    if (url.pathname === "/api/artifacts/retention" && request.method === "PUT") {
      requireJson(request);
      const body = (await boundedJson(request.body)) as { maxAgeDays?: unknown };
      return json({ retention: await setRetention(env.DB, caller, artifactAdmin, body?.maxAgeDays) });
    }
    if (url.pathname === "/api/artifacts/cleanup/preview" && request.method === "GET") {
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      return json({ cleanup: await previewCleanup(env.DB, caller, Date.now()) });
    }
    if (url.pathname === "/api/artifacts/cleanup/run" && request.method === "POST") {
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      return json({ cleanup: await runCleanup(artifactStore, caller, artifactAdmin, Date.now()) });
    }
    if (url.pathname === "/api/artifacts/bindings" && request.method === "GET") {
      const scope = parseBindingScope(url.searchParams.get("scope"));
      const refId = parseBindingRef(url.searchParams.get("refId"));
      for (const key of url.searchParams.keys()) {
        if (key !== "scope" && key !== "refId") {
          throw new Fault(400, "UNSUPPORTED_QUERY", "Only scope and refId are supported here.");
        }
      }
      // Binding listing answers the triple only, never bytes or metadata.
      return json(await bindingsForRef(env.DB, caller, { scope, refId }));
    }
    const artifactVersion = /^\/api\/artifacts\/([0-9a-f-]{36})\/versions\/(\d+)$/.exec(url.pathname);
    if (artifactVersion?.[1] && artifactVersion[2] && request.method === "GET") {
      const served = await previewArtifact(
        artifactStore,
        caller,
        parseArtifactId(artifactVersion[1]),
        artifactAdmin,
        parseArtifactVersion(Number(artifactVersion[2])),
      );
      return apiBytes(served.bytes.slice().buffer as ArrayBuffer, 200, {
        "Content-Type": served.mime,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
    }
    const artifactBytes = /^\/api\/artifacts\/([0-9a-f-]{36})\/bytes$/.exec(url.pathname);
    if (artifactBytes?.[1] && request.method === "PUT") {
      const contentType = request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() ?? "";
      if (contentType !== "application/octet-stream" || request.headers.has("Content-Encoding")) {
        throw new Fault(415, "BYTES_REQUIRED", "Artifact bytes require unencoded application/octet-stream.");
      }
      if (request.body === null) throw new Fault(400, "EMPTY_ARTIFACT", "Artifact bytes must not be empty.");
      const buffer = await request.arrayBuffer();
      const uploaded = await uploadArtifactVersion(
        artifactStore,
        caller,
        parseArtifactId(artifactBytes[1]),
        artifactAdmin,
        {
          mime: url.searchParams.get("mime") ?? "application/octet-stream",
          bytes: new Uint8Array(buffer),
        },
      );
      return json({ artifact: uploaded });
    }
    const artifactPreview = /^\/api\/artifacts\/([0-9a-f-]{36})\/preview$/.exec(url.pathname);
    if (artifactPreview?.[1] && request.method === "GET") {
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      const served = await previewArtifact(artifactStore, caller, parseArtifactId(artifactPreview[1]), artifactAdmin);
      return apiBytes(served.bytes.slice().buffer as ArrayBuffer, 200, {
        "Content-Type": served.mime,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
    }
    const artifactDownload = /^\/api\/artifacts\/([0-9a-f-]{36})\/download$/.exec(url.pathname);
    if (artifactDownload?.[1] && request.method === "GET") {
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      const served = await downloadArtifact(artifactStore, caller, parseArtifactId(artifactDownload[1]), artifactAdmin);
      const filename = served.name.replace(/["\r\n]/g, "_");
      return apiBytes(served.bytes.slice().buffer as ArrayBuffer, 200, {
        "Content-Type": served.mime,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
    }
    const artifactRename = /^\/api\/artifacts\/([0-9a-f-]{36})\/rename$/.exec(url.pathname);
    if (artifactRename?.[1] && request.method === "POST") {
      requireJson(request);
      const body = (await boundedJson(request.body)) as { name?: unknown };
      return json({
        artifact: await renameArtifact(env.DB, caller, parseArtifactId(artifactRename[1]), artifactAdmin, body?.name),
      });
    }
    const artifactBind = /^\/api\/artifacts\/([0-9a-f-]{36})\/bindings$/.exec(url.pathname);
    if (artifactBind?.[1] && request.method === "POST") {
      requireJson(request);
      const body = (await boundedJson(request.body)) as { scope?: unknown; refId?: unknown };
      return json(
        {
          binding: await bindAttachment(env.DB, caller, parseArtifactId(artifactBind[1]), artifactAdmin, {
            scope: body?.scope,
            refId: body?.refId,
          }),
        },
        201,
      );
    }
    // Browser App SDK runtime (APP-02, ADR 019): scoped Tables/files/invoke
    // over the installed app context. Author routes trust the Organization
    // caller (same policy as the app lifecycle); runtime routes trust the
    // same caller PLUS a live (non-revoked) grant row per call
    // (requireAppGrant), so revocation is immediate and discovered-but-
    // ungranted refs fail. Hidden Tables stay 404 on the runtime paths.
    // One explicit matcher per route, mirroring the executions style above.
    const appGrants = /^\/api\/apps\/([0-9a-f-]{36})\/grants$/.exec(url.pathname);
    if (appGrants?.[1] && request.method === "GET") {
      rejectQuery(url);
      return json({ grants: await listAppGrants(env.DB, caller, parseAppId(appGrants[1])) });
    }
    if (appGrants?.[1] && request.method === "POST") {
      requireJson(request);
      await requireAppVisible(
        env.DB,
        ctx,
        caller,
        parseAppId(appGrants[1]),
        "write",
        "Managing App grants requires a write grant.",
      );
      const created = await createAppGrant(env.DB, caller, parseAppId(appGrants[1]), await boundedJson(request.body));
      return json({ grant: created }, 201);
    }
    const appGrantRevoke = /^\/api\/apps\/([0-9a-f-]{36})\/grants\/([^/]+)\/revoke$/.exec(url.pathname);
    if (appGrantRevoke?.[1] && appGrantRevoke[2] && request.method === "POST") {
      rejectQuery(url);
      await requireAppVisible(
        env.DB,
        ctx,
        caller,
        parseAppId(appGrantRevoke[1]),
        "write",
        "Revoking App grants requires a write grant.",
      );
      return json({
        grant: await revokeAppGrant(env.DB, caller, parseAppId(appGrantRevoke[1]), appGrantRevoke[2]),
      });
    }
    const appTables = /^\/api\/apps\/([0-9a-f-]{36})\/tables$/.exec(url.pathname);
    if (appTables?.[1] && request.method === "GET") {
      rejectQuery(url);
      return json({ tables: await listDeclaredTables(env.DB, caller, parseAppId(appTables[1])) });
    }
    if (appTables?.[1] && request.method === "POST") {
      requireJson(request);
      await requireAppVisible(
        env.DB,
        ctx,
        caller,
        parseAppId(appTables[1]),
        "write",
        "Declaring App tables requires a write grant.",
      );
      const app = await loadRuntimeApp(env.DB, caller, parseAppId(appTables[1]));
      return json({ table: await declareAppTable(env.DB, caller, app, await boundedJson(request.body)) }, 201);
    }
    const appHandshake = /^\/api\/apps\/([0-9a-f-]{36})\/sdk$/.exec(url.pathname);
    if (appHandshake?.[1] && request.method === "GET") {
      const app = await loadRuntimeApp(env.DB, caller, parseAppId(appHandshake[1]));
      const response = json(describeAppHandshake({ id: app.id, name: app.name, slug: app.slug, status: app.status }));
      response.headers.set("X-App-SDK-Version", APP_SDK_VERSION);
      return response;
    }
    const appRuntimeTables = /^\/api\/apps\/([0-9a-f-]{36})\/runtime\/tables$/.exec(url.pathname);
    if (appRuntimeTables?.[1] && request.method === "GET") {
      rejectQuery(url);
      const app = await loadRuntimeApp(env.DB, caller, parseAppId(appRuntimeTables[1]));
      return json({ tables: await listRuntimeTables(env.DB, app.id) });
    }
    const appRowsRead = /^\/api\/apps\/([0-9a-f-]{36})\/runtime\/tables\/([^/]+)\/rows$/.exec(url.pathname);
    if (appRowsRead?.[1] && appRowsRead[2] && request.method === "GET") {
      const app = await loadRuntimeApp(env.DB, caller, parseAppId(appRowsRead[1]));
      const tableName = decodeURIComponent(appRowsRead[2]);
      await requireAppGrant(env.DB, app.id, "table", tableName, "read");
      return json(await readTableRows(env.DB, app, tableName, parseAppTableQuery(url.searchParams)));
    }
    const appRowWrite = /^\/api\/apps\/([0-9a-f-]{36})\/runtime\/tables\/([^/]+)\/rows$/.exec(url.pathname);
    if (appRowWrite?.[1] && appRowWrite[2] && request.method === "POST") {
      requireJson(request);
      const app = await loadRuntimeApp(env.DB, caller, parseAppId(appRowWrite[1]));
      const tableName = decodeURIComponent(appRowWrite[2]);
      await requireAppGrant(env.DB, app.id, "table", tableName, "write");
      // Body cap sits above the max row envelope (row bytes plus the data
      // wrapper); the row byte bound itself is enforced in insertTableRow.
      const body = await boundedJson(request.body, 8192);
      if (!object(body) || !("data" in body)) {
        throw new Fault(400, "INVALID_TABLE_ROW", "Table row writes need a data object.");
      }
      return json({ row: await insertTableRow(env.DB, caller, app, tableName, body.data) }, 201);
    }
    const appRowPatch = /^\/api\/apps\/([0-9a-f-]{36})\/runtime\/tables\/([^/]+)\/rows\/([^/]+)$/.exec(url.pathname);
    if (appRowPatch?.[1] && appRowPatch[2] && appRowPatch[3] && request.method === "PATCH") {
      requireJson(request);
      const app = await loadRuntimeApp(env.DB, caller, parseAppId(appRowPatch[1]));
      const tableName = decodeURIComponent(appRowPatch[2]);
      await requireAppGrant(env.DB, app.id, "table", tableName, "write");
      const body = await boundedJson(request.body, 8192);
      if (!object(body) || !("data" in body)) {
        throw new Fault(400, "INVALID_TABLE_ROW", "Table row writes need a data object.");
      }
      return json({ row: await patchTableRow(env.DB, app, tableName, appRowPatch[3], body.data) });
    }
    if (appRowPatch?.[1] && appRowPatch[2] && appRowPatch[3] && request.method === "DELETE") {
      const app = await loadRuntimeApp(env.DB, caller, parseAppId(appRowPatch[1]));
      const tableName = decodeURIComponent(appRowPatch[2]);
      await requireAppGrant(env.DB, app.id, "table", tableName, "write");
      return json(await deleteTableRow(env.DB, app, tableName, appRowPatch[3]));
    }
    const appInvoke = /^\/api\/apps\/([0-9a-f-]{36})\/runtime\/invoke$/.exec(url.pathname);
    if (appInvoke?.[1] && request.method === "POST") {
      const app = await loadRuntimeApp(env.DB, caller, parseAppId(appInvoke[1]));
      const key = parseKey(request.headers.get("Idempotency-Key"));
      if (
        request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" ||
        request.headers.has("Content-Encoding")
      )
        throw new Fault(415, "JSON_REQUIRED", "Unencoded JSON is required.");
      const body = await boundedJson(request.body);
      if (!object(body) || typeof body.sagaId !== "string") {
        throw new Fault(400, "INVALID_SUBMISSION", "Provide a granted Saga ID and its input only.");
      }
      if (Object.keys(body).some((entry) => !["sagaId", "input"].includes(entry))) {
        throw new Fault(400, "INVALID_SUBMISSION", "Provide a granted Saga ID and its input only.");
      }
      // Grant-before-parse: the Saga ref is authorized before the input is
      // validated, so ungranted Sagas fail 403 without leaking which known
      // Saga IDs would parse.
      await requireAppGrant(env.DB, app.id, "saga", body.sagaId, "invoke");
      const { saga, input } = parseSubmission({ sagaId: body.sagaId, input: body.input });
      const accepted = await submit(env, caller, key, saga, input);
      await recordAppExecution(env.DB, caller, app.id, accepted.executionId, saga.id);
      return json(accepted, accepted.replayed ? 200 : 202, { Location: accepted.statusUrl });
    }
    const appExecutions = /^\/api\/apps\/([0-9a-f-]{36})\/runtime\/executions$/.exec(url.pathname);
    if (appExecutions?.[1] && request.method === "GET") {
      rejectQuery(url);
      const app = await loadRuntimeApp(env.DB, caller, parseAppId(appExecutions[1]));
      return json({ executions: await listAppExecutions(env.DB, app.id, 20) });
    }
    const appFilesList = /^\/api\/apps\/([0-9a-f-]{36})\/runtime\/files$/.exec(url.pathname);
    if (appFilesList?.[1] && request.method === "GET") {
      rejectQuery(url);
      const app = await loadRuntimeApp(env.DB, caller, parseAppId(appFilesList[1]));
      return json({ files: await listRuntimeFiles(env.DB, app.id) });
    }
    const appFileDeclare = /^\/api\/apps\/([0-9a-f-]{36})\/runtime\/files\/declare$/.exec(url.pathname);
    if (appFileDeclare?.[1] && request.method === "POST") {
      requireJson(request);
      const app = await loadRuntimeApp(env.DB, caller, parseAppId(appFileDeclare[1]));
      const body = await boundedJson(request.body);
      if (!object(body) || typeof body.name !== "string") {
        throw new Fault(400, "INVALID_APP_FILE", "A file declaration needs a name.");
      }
      await requireAppGrant(env.DB, app.id, "file", body.name, "write");
      return json({ file: await declareAppFile(env.DB, caller, app, body) }, 201);
    }
    const appFileTokens = /^\/api\/apps\/([0-9a-f-]{36})\/runtime\/files\/tokens$/.exec(url.pathname);
    if (appFileTokens?.[1] && request.method === "POST") {
      requireJson(request);
      const app = await loadRuntimeApp(env.DB, caller, parseAppId(appFileTokens[1]));
      const body = await boundedJson(request.body);
      if (!object(body) || typeof body.name !== "string" || (body.scope !== "upload" && body.scope !== "download")) {
        throw new Fault(400, "INVALID_APP_FILE", "File tokens need a name and an upload or download scope.");
      }
      const permission = body.scope === "upload" ? "write" : "read";
      await requireAppGrant(env.DB, app.id, "file", body.name, permission);
      return json(await issueFileToken(env.DB, app.id, body.name, body.scope), 201);
    }
    const appFileUpload = /^\/api\/apps\/([0-9a-f-]{36})\/runtime\/files\/upload$/.exec(url.pathname);
    if (appFileUpload?.[1] && request.method === "POST") {
      requireJson(request);
      const app = await loadRuntimeApp(env.DB, caller, parseAppId(appFileUpload[1]));
      const token = request.headers.get("X-File-Token");
      // Body cap sits above the max file envelope (base64 bytes plus
      // verification metadata); the file byte bound is enforced at redeem.
      const body = await boundedJson(request.body, 65536);
      if (!object(body) || !("content" in body)) {
        throw new Fault(400, "INVALID_APP_FILE", "File upload needs content, contentType, size, and sha256.");
      }
      return json({ file: await redeemFileUpload(env.DB, app.id, token ?? "", body) }, 201);
    }
    const appFileDownload = /^\/api\/apps\/([0-9a-f-]{36})\/runtime\/files\/download$/.exec(url.pathname);
    if (appFileDownload?.[1] && request.method === "POST") {
      requireJson(request);
      const app = await loadRuntimeApp(env.DB, caller, parseAppId(appFileDownload[1]));
      const token = request.headers.get("X-File-Token");
      return json(await redeemFileDownload(env.DB, app.id, token ?? ""));
    }
    const appFileDelete = /^\/api\/apps\/([0-9a-f-]{36})\/runtime\/files\/(.+)$/.exec(url.pathname);
    if (appFileDelete?.[1] && appFileDelete[2] && request.method === "DELETE") {
      const app = await loadRuntimeApp(env.DB, caller, parseAppId(appFileDelete[1]));
      const fileName = decodeURIComponent(appFileDelete[2]);
      await requireAppGrant(env.DB, app.id, "file", fileName, "write");
      const rawExpected = url.searchParams.get("expectedVersion");
      if ([...url.searchParams.keys()].some((key) => key !== "expectedVersion")) {
        throw new Fault(400, "UNSUPPORTED_QUERY", "Only expectedVersion is supported here.");
      }
      const expectedVersion = rawExpected === null ? undefined : Number(rawExpected);
      if (expectedVersion !== undefined && (!Number.isInteger(expectedVersion) || expectedVersion < 1)) {
        throw new Fault(400, "INVALID_APP_FILE", "expectedVersion must be a positive integer file version.");
      }
      return json(await deleteAppFile(env.DB, app, fileName, expectedVersion));
    }
    // Connection management (CON-01, issue #146): portable Integration
    // definitions plus per-Organization non-secret mappings through one
    // authorized boundary. Every response is scrubbed with the deployment
    // secrets before send; views carry required-secret names only, never
    // values. Secret values are never accepted on any path here (SEC-02
    // tripwire fired for Connection credentials, issue #411; OAuth token
    // persistence stays shut). One explicit matcher per route.
    if (url.pathname === "/api/integrations" && request.method === "GET") {
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      return json(scrubConnectionPayload({ integrations: describeIntegrations() }, env));
    }
    if (url.pathname === "/api/connections" && request.method === "GET") {
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      return json(scrubConnectionPayload({ connections: await listConnections(env.DB, caller) }, env));
    }
    if (url.pathname === "/api/connections" && request.method === "POST") {
      requireJson(request);
      // Issue #346: a Connection selects the provider-global vendor identity,
      // so only an admin may create or replace that routing.
      if (!isAdminCaller(ctx)) {
        throw new Fault(403, "CONNECTION_FORBIDDEN", "Only an admin may manage Connections.");
      }
      const body = (await boundedJson(request.body)) as { integrationId?: unknown } & Record<string, unknown>;
      if (typeof body.integrationId !== "string") {
        throw new Fault(400, "UNKNOWN_INTEGRATION", "A Connection write needs an integrationId.");
      }
      const created = await createConnection(
        env.DB,
        caller,
        body.integrationId,
        {
          config: body.config,
          ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
          ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
        },
        // Issue #239: echo endpoints gate on deployment environment — the
        // loopback default serves local only; non-local needs explicit HTTPS.
        { environment: (env as unknown as Record<string, string | undefined>).ENVIRONMENT },
      );
      return json(scrubConnectionPayload({ connection: created }, env), 201);
    }
    const connTest = /^\/api\/connections\/([0-9a-f-]{36})\/test$/.exec(url.pathname);
    if (connTest?.[1] && request.method === "POST") {
      const tested = await testConnection(env.DB, caller, connTest[1], env);
      if (!tested.ok) {
        const code = tested.code;
        const status =
          code === "UNKNOWN_INTEGRATION" || code === "CONNECTION_NOT_FOUND" || code === "CONNECTION_DISABLED"
            ? 404
            : code === "INTEGRATION_REQUIREMENT_UNSATISFIED"
              ? 424
              : code === "SECRET_NOT_CONFIGURED"
                ? 502
                : 502;
        return json(scrubConnectionPayload({ test: tested }, env), status);
      }
      return json(scrubConnectionPayload({ test: tested }, env));
    }
    const connOne = /^\/api\/connections\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (connOne?.[1] && request.method === "GET") {
      return json(scrubConnectionPayload({ connection: await getConnection(env.DB, caller, connOne[1]) }, env));
    }
    if (connOne?.[1] && request.method === "PUT") {
      requireJson(request);
      // Same admin rule as create above (issue #346).
      if (!isAdminCaller(ctx)) {
        throw new Fault(403, "CONNECTION_FORBIDDEN", "Only an admin may manage Connections.");
      }
      const body = (await boundedJson(request.body)) as Record<string, unknown>;
      const updated = await updateConnection(
        env.DB,
        caller,
        connOne[1],
        {
          ...(body.config === undefined ? {} : { config: body.config }),
          ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
          ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
        },
        // Issue #239: same environment gate as create above.
        { environment: (env as unknown as Record<string, string | undefined>).ENVIRONMENT },
      );
      return json(scrubConnectionPayload({ connection: updated }, env));
    }
    if (connOne?.[1] && request.method === "DELETE") {
      // Same admin rule as create above (issue #346).
      if (!isAdminCaller(ctx)) {
        throw new Fault(403, "CONNECTION_FORBIDDEN", "Only an admin may manage Connections.");
      }
      await deleteConnection(env.DB, caller, connOne[1]);
      return json({ deleted: true });
    }
    // Per-Organization secrets (SEC-02, issue #411): the exclusive route
    // that accepts secret values. Values arrive in the POST body only
    // (stdin-fed by the CLI in P2); the response carries the masked view,
    // never values. Same admin rule as the mapping writes above.
    const connSecrets = /^\/api\/connections\/([0-9a-f-]{36})\/secrets$/.exec(url.pathname);
    if (connSecrets?.[1] && request.method === "PUT") {
      requireJson(request);
      if (!isAdminCaller(ctx)) {
        throw new Fault(403, "CONNECTION_FORBIDDEN", "Only an admin may manage Connections.");
      }
      const body = (await boundedJson(request.body)) as { secrets?: unknown };
      const stored = await putConnectionSecrets(env.DB, caller, connSecrets[1], body.secrets, env.SECRETS_KEK);
      return json(scrubConnectionPayload({ connection: stored }, env));
    }
    // TOOL-01 opt-in Saga tools (issue #170, ADR 022): explicit enrollment
    // with stable identity, collision-safe names, and distinctive
    // descriptions. Discovery (GET) and execution (resolve below + the MCP
    // tools/call path) share the registry gate: disabled and stale rows
    // vanish from both identically. Query strings stay deny-by-default.
    if (url.pathname === "/api/tools" && request.method === "GET") {
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      return json(scrubConnectionPayload({ tools: await toolRegistry.list(env.DB, caller, SAGA_CATALOG) }, env));
    }
    if (url.pathname === "/api/tools" && request.method === "POST") {
      requireJson(request);
      const body = (await boundedJson(request.body)) as { sagaId?: unknown } & Record<string, unknown>;
      if (typeof body.sagaId !== "string") {
        throw new Fault(400, "UNKNOWN_SAGA", "A tool enrollment needs a sagaId.");
      }
      const saga = SAGA_CATALOG.find((entry) => entry.id === body.sagaId);
      if (!saga) throw new Fault(404, "UNKNOWN_SAGA", "Unknown Saga id.");
      const enrolled = await toolRegistry.enroll(env.DB, caller, saga, {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.description === undefined ? {} : { description: body.description }),
      });
      await recordAudit(
        env.DB,
        caller,
        "tool.enroll",
        { type: "tool", id: enrolled.name },
        "success",
        { sagaId: enrolled.sagaId },
        deploymentSecretsFromEnv(env),
      );
      return json(scrubConnectionPayload({ tool: enrolled }, env), 201);
    }
    const toolDisable = /^\/api\/tools\/([a-z][a-z0-9_]{2,63})\/disable$/.exec(url.pathname);
    if (toolDisable?.[1] && request.method === "POST") {
      const disabled = await toolRegistry.disable(env.DB, caller, toolDisable[1]);
      await recordAudit(
        env.DB,
        caller,
        "tool.disable",
        { type: "tool", id: disabled.name },
        "success",
        { sagaId: disabled.sagaId },
        deploymentSecretsFromEnv(env),
      );
      return json(scrubConnectionPayload({ tool: disabled }, env));
    }
    const toolExecute = /^\/api\/tools\/([a-z][a-z0-9_]{2,63})\/execute$/.exec(url.pathname);
    if (toolExecute?.[1] && request.method === "POST") {
      // Tool execution rides the standard Execution path: resolve the tool
      // through the registry gate, then submit its Saga with the standard
      // Idempotency-Key contract. The submit gate stays authoritative.
      requireJson(request);
      const tool = await toolRegistry.resolve(env.DB, caller, toolExecute[1], SAGA_CATALOG);
      const key = parseCallerKey(request.headers.get("Idempotency-Key"));
      const { saga, input } = parseSubmission({
        ...((await boundedJson(request.body)) as Record<string, unknown>),
        sagaId: tool.sagaId,
      });
      // AUTH-02: tool execution is Saga execution under another name.
      // Enrollment alone must not authorize it: require the saga execute
      // grant exactly as the direct submit path does.
      await requireGrant(
        env.DB,
        ctx,
        { orgId: caller.orgId, resourceKind: "saga", resourceId: saga.id.toLowerCase(), action: "execute" },
        "Executing this tool requires an execute grant on its Saga.",
      );
      const accepted = await submit(env, caller, key, saga, input);
      await recordAudit(
        env.DB,
        caller,
        "tool.execute",
        { type: "tool", id: tool.name },
        "success",
        { sagaId: tool.sagaId, executionId: accepted.executionId },
        deploymentSecretsFromEnv(env),
      );
      return json(scrubConnectionPayload({ tool: tool.name, ...accepted }, env), accepted.replayed ? 200 : 202, {
        Location: accepted.statusUrl,
      });
    }
    // TOOL-01 Code Mode discovery (issue #170, ADR 022): progressive
    // search/inspect over the pinned Halo contract. Query strings are
    // allowlisted per route (?integration= + ?q= here); unknown integrations
    // 404, never a leak. Execution lives on POST /api/openapi/execute below.
    if (url.pathname === "/api/openapi/search" && request.method === "GET") {
      const keys = [...url.searchParams.keys()];
      if (keys.some((key) => key !== "integration" && key !== "q")) {
        throw new Fault(400, "UNSUPPORTED_QUERY", "Only ?integration= and ?q= are supported here.");
      }
      const integration = url.searchParams.get("integration");
      if (integration !== "halo") throw new Fault(404, "UNKNOWN_INTEGRATION", "Unknown Integration id.");
      const operations = searchHaloOperations(url.searchParams.get("q") ?? "");
      return json(scrubConnectionPayload({ integration: "halo", operations }, env));
    }
    const openapiInspect = /^\/api\/openapi\/operations\/([A-Za-z][A-Za-z0-9_.-]{0,127})$/.exec(url.pathname);
    if (openapiInspect?.[1] && request.method === "GET") {
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      return json(scrubConnectionPayload({ operation: inspectHaloOperation(openapiInspect[1]) }, env));
    }
    if (url.pathname === "/api/openapi/execute" && request.method === "POST") {
      // Host-mediated Code Mode execution (ADR 022): the route resolves the
      // caller + Organization Connection, validates against the pinned
      // contract, applies policy, enforces egress, and injects credentials
      // outside model-visible state. The body carries operation selection +
      // params only — never credentials, never a URL.
      requireJson(request);
      const body = (await boundedJson(request.body)) as Record<string, unknown>;
      if (body.integration !== "halo") throw new Fault(404, "UNKNOWN_INTEGRATION", "Unknown Integration id.");
      if (typeof body.operationId !== "string") {
        throw new Fault(400, "OPENAPI_UNKNOWN_OPERATION", "Provide an operationId from the pinned contract.");
      }
      const params = (body.params ?? {}) as Record<string, unknown>;
      const { result, provenance } = await runCodeModeExecute(
        env,
        caller,
        {
          operationId: body.operationId,
          ...(params.path === undefined ? {} : { path: params.path as Record<string, string> }),
          ...(params.query === undefined ? {} : { query: params.query as Record<string, string> }),
          ...(body.input === undefined ? {} : { body: body.input }),
        },
        ctx,
      );
      return json(scrubConnectionPayload({ result, provenance }, env));
    }
    // TOOL-01 inbound MCP gateway (issue #170, ADR 022): JSON-RPC 2.0 over
    // POST behind the same membership gate as every /api/* route. tools/list
    // serves enrolled live tools plus the Code Mode search/execute pair;
    // tools/call executes enrolled tools through the standard submit path;
    // tools/search narrows live tools by text; tools/describe inspects one
    // tool or one pinned Halo operation. Envelope faults (auth/parse/
    // unknown-method) throw; call-level denials serialize as error results.
    if (url.pathname === "/api/mcp" && request.method === "POST") {
      requireJson(request);
      const envelope = parseMcpRequest(await boundedJson(request.body));
      if (envelope.method === "tools/list") {
        const tools = await toolRegistry.list(env.DB, caller, SAGA_CATALOG);
        return json(
          scrubConnectionPayload(
            mcpResult(envelope.id, {
              tools: [
                ...tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  inputSchema: tool.inputSchema,
                })),
                {
                  name: "halo_api_search",
                  description: "[halo_api_search] Search the pinned HaloPSA contract by free text.",
                  inputSchema: { type: "object" },
                },
                {
                  name: "halo_api_execute",
                  description: "[halo_api_execute] Execute one pinned HaloPSA operation through the org Connection.",
                  inputSchema: { type: "object" },
                },
              ],
            }),
            env,
          ),
        );
      }
      if (envelope.method === "tools/search") {
        const { query } = parseMcpSearchParams(envelope.params);
        const tools = await toolRegistry.list(env.DB, caller, SAGA_CATALOG);
        const views = tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }));
        return json(scrubConnectionPayload(mcpResult(envelope.id, { tools: searchTools(views, query) }), env));
      }
      if (envelope.method === "tools/describe") {
        const { name } = parseMcpDescribeParams(envelope.params);
        const tools = await toolRegistry.list(env.DB, caller, SAGA_CATALOG);
        const tool = tools.find((entry) => entry.name === name);
        if (tool) {
          return json(
            scrubConnectionPayload(
              mcpResult(envelope.id, {
                tool: { name: tool.name, description: tool.description, inputSchema: tool.inputSchema },
              }),
              env,
            ),
          );
        }
        const operations = indexOperations(haloLabSpec(), HALO_CLASSIFICATIONS);
        const operation = operations.find((entry) => entry.operationId === name);
        if (operation) {
          return json(
            scrubConnectionPayload(
              mcpResult(envelope.id, {
                operation: inspectOperation(operations, operation.operationId),
                policy: HALO_DEFAULT_POLICY,
              }),
              env,
            ),
          );
        }
        return json(
          scrubConnectionPayload(
            mcpResult(envelope.id, {
              error: { code: "MCP_TOOL_DENIED", message: `Unknown tool ${JSON.stringify(name)}.` },
            }),
            env,
          ),
        );
      }
      // tools/call: enrolled Saga tools execute through the standard submit
      // path; halo_api_search describes Code Mode discovery; halo_api_execute
      // runs the host-mediated execution. Unknown names deny as error
      // results (call-level), never envelope faults.
      const { tool, input } = parseMcpCallParams(envelope.params);
      if (tool === "halo_api_search") {
        const query = (input as Record<string, unknown>).query;
        const found = searchOperations(
          indexOperations(haloLabSpec(), HALO_CLASSIFICATIONS),
          typeof query === "string" ? query : "",
        );
        return json(scrubConnectionPayload(mcpResult(envelope.id, { tools: found }), env));
      }
      if (tool === "halo_api_execute") {
        const args = input as Record<string, unknown>;
        if (typeof args.operationId !== "string") {
          return json(
            scrubConnectionPayload(
              mcpResult(envelope.id, { error: { code: "MCP_INVALID_PARAMS", message: "Provide an operationId." } }),
              env,
            ),
          );
        }
        try {
          const params = (args.params ?? {}) as Record<string, unknown>;
          const { result, provenance } = await runCodeModeExecute(
            env,
            caller,
            {
              operationId: args.operationId,
              ...(params.path === undefined ? {} : { path: params.path as Record<string, string> }),
              ...(params.query === undefined ? {} : { query: params.query as Record<string, string> }),
              ...(args.input === undefined ? {} : { body: args.input }),
            },
            ctx,
          );
          return json(scrubConnectionPayload(mcpResult(envelope.id, { result, provenance }), env));
        } catch (error) {
          // Call-level denial: runCodeModeExecute already recorded the
          // sanitized codemode.execute failure row, so this layer only
          // serializes the error result (no second audit row).
          const code = error instanceof Fault ? error.code : "MCP_EXECUTION_FAILED";
          const message = error instanceof Fault ? error.message : "The Code Mode execution failed.";
          return json(scrubConnectionPayload(mcpResult(envelope.id, { error: { code, message } }), env));
        }
      }
      let resolved: { name: string; sagaId: string } | null = null;
      let resolveFault: Fault | null = null;
      try {
        resolved = await toolRegistry.resolve(env.DB, caller, tool, SAGA_CATALOG);
      } catch (error) {
        resolveFault =
          error instanceof Fault ? error : new Fault(500, "MCP_EXECUTION_FAILED", "The tool lookup failed.");
      }
      if (!resolved) {
        const code = resolveFault?.code ?? "MCP_TOOL_DENIED";
        const message = resolveFault?.message ?? `Unknown tool ${JSON.stringify(tool)}.`;
        return json(scrubConnectionPayload(mcpResult(envelope.id, { error: { code, message } }), env));
      }
      try {
        const args = input as Record<string, unknown>;
        const key = parseCallerKey(typeof args.idempotencyKey === "string" ? (args.idempotencyKey as string) : null);
        const { saga, input: parsed } = parseSubmission({ input: args.input ?? {}, sagaId: resolved.sagaId });
        // AUTH-02: same execute-grant gate as the REST tool path above.
        await requireGrant(
          env.DB,
          ctx,
          { orgId: caller.orgId, resourceKind: "saga", resourceId: saga.id.toLowerCase(), action: "execute" },
          "Executing this tool requires an execute grant on its Saga.",
        );
        const accepted = await submit(env, caller, key, saga, parsed);
        await recordAudit(
          env.DB,
          caller,
          "tool.execute",
          { type: "tool", id: resolved.name },
          "success",
          { sagaId: resolved.sagaId, executionId: accepted.executionId },
          deploymentSecretsFromEnv(env),
        );
        return json(scrubConnectionPayload(mcpResult(envelope.id, { tool: resolved.name, ...accepted }), env));
      } catch (error) {
        const code = error instanceof Fault ? error.code : "MCP_EXECUTION_FAILED";
        const message = error instanceof Fault ? error.message : "The tool execution failed.";
        return json(scrubConnectionPayload(mcpResult(envelope.id, { error: { code, message } }), env));
      }
    }
    // TRG-02 endpoint management (issue #138, ADR 018): operator-owned
    // inventory over this Organization's scoped endpoints. Create returns
    // the raw credential once (apiKey, or webhookSecret to plant in the
    // deployment secret store); summaries never carry digests or secrets.
    // Bad names answer 404 (never a leak); foreign-Organization rows 404.
    if (url.pathname === "/api/endpoints" && request.method === "GET") {
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      return json({ endpoints: await listEndpoints(env.DB, caller.orgId).catch(() => []) });
    }
    if (url.pathname === "/api/endpoints" && request.method === "POST") {
      requireJson(request);
      const body = await boundedJson(request.body);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new Fault(400, "INVALID_ENDPOINT", "Provide name, sagaId, and kind.");
      }
      const record = body as Record<string, unknown>;
      if (typeof record.name === "string") parseEndpointName(record.name);
      const created = await createEndpoint(
        env.DB,
        caller.orgId,
        {
          name: typeof record.name === "string" ? record.name : "",
          sagaId: typeof record.sagaId === "string" ? record.sagaId : "",
          kind: record.kind as "api-key" | "webhook",
          ...(record.rateLimitPerMinute === undefined
            ? {}
            : { rateLimitPerMinute: record.rateLimitPerMinute as number | null }),
          ...(record.challenge === undefined ? {} : { challenge: record.challenge as "none" | "echo-param" }),
          ...(record.keyExpiresAt === undefined ? {} : { keyExpiresAt: record.keyExpiresAt as string | null }),
        },
        SAGA_CATALOG.map((entry) => entry.id),
      );
      return json(
        {
          endpoint: endpointSummary(created.row),
          ...(created.row.kind === "api-key"
            ? { apiKey: created.rawCredential }
            : { webhookSecret: created.rawCredential }),
        },
        201,
      );
    }
    if (artifactBind?.[1] && request.method === "DELETE") {
      requireJson(request);
      const body = (await boundedJson(request.body)) as { scope?: unknown; refId?: unknown };
      await unbindAttachment(env.DB, caller, parseArtifactId(artifactBind[1]), artifactAdmin, {
        scope: (body as { scope?: unknown })?.scope,
        refId: (body as { refId?: unknown })?.refId,
      });
      return json({ deleted: true });
    }
    const artifactExport = /^\/api\/artifacts\/([0-9a-f-]{36})\/export$/.exec(url.pathname);
    if (artifactExport?.[1] && request.method === "GET") {
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      // Metadata-only by construction: the manifest never carries bytes.
      return json(await exportManifest(env.DB, caller, parseArtifactId(artifactExport[1]), artifactAdmin));
    }
    const artifactOne = /^\/api\/artifacts\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (artifactOne?.[1] && request.method === "GET") {
      return json({ artifact: await artifactDetail(env.DB, caller, parseArtifactId(artifactOne[1]), artifactAdmin) });
    }
    if (artifactOne?.[1] && request.method === "DELETE") {
      await deleteArtifact(artifactStore, caller, parseArtifactId(artifactOne[1]), artifactAdmin);
      return json({ deleted: true });
    }
    const endpointEvents = /^\/api\/endpoints\/([a-z0-9][a-z0-9-]{0,63})\/events$/.exec(url.pathname);
    // Unknown name shapes (uppercase, dots, slashes beyond one segment)
    // answer 404 like parseEndpointName does — never UNIMPLEMENTED theater.
    if (
      /^\/api\/endpoints\/[^/]+(\/[^/]+)?$/.exec(url.pathname) &&
      !endpointEvents &&
      !/^\/api\/endpoints\/([a-z0-9][a-z0-9-]{0,63})\/rotate$/.exec(url.pathname) &&
      !/^\/api\/endpoints\/([a-z0-9][a-z0-9-]{0,63})$/.exec(url.pathname)
    ) {
      return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
    }
    if (endpointEvents?.[1] && request.method === "GET") {
      const name = parseEndpointName(endpointEvents[1]);
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      return json({ events: await listEndpointEvents(env.DB, caller.orgId, name, 50).catch(() => []) });
    }
    const endpointRotate = /^\/api\/endpoints\/([a-z0-9][a-z0-9-]{0,63})\/rotate$/.exec(url.pathname);
    if (endpointRotate?.[1] && request.method === "POST") {
      const name = parseEndpointName(endpointRotate[1]);
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      // Codex #352: credential rotation is a state change, so it shares the
      // JSON-write gate: unencoded application/json rejects cross-origin
      // form posts against Access-authenticated browser sessions.
      requireJson(request);
      const rotated = await rotateEndpointCredential(env.DB, caller.orgId, name).catch(() => null);
      if (!rotated) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      return json({
        endpoint: endpointSummary(rotated.row),
        ...(rotated.row.kind === "api-key"
          ? { apiKey: rotated.rawCredential }
          : { webhookSecret: rotated.rawCredential }),
      });
    }
    const endpointOne = /^\/api\/endpoints\/([a-z0-9][a-z0-9-]{0,63})$/.exec(url.pathname);
    if (endpointOne?.[1] && (request.method === "GET" || request.method === "PATCH")) {
      const name = parseEndpointName(endpointOne[1]);
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      const row = await loadEndpoint(env.DB, caller.orgId, name).catch(() => null);
      if (!row) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      if (request.method === "GET") return json({ endpoint: endpointSummary(row) });
      requireJson(request);
      const body = await boundedJson(request.body);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new Fault(400, "INVALID_ENDPOINT", "Provide enabled, rateLimitPerMinute, or keyExpiresAt.");
      }
      const record = body as Record<string, unknown>;
      const updated = await updateEndpoint(env.DB, caller.orgId, name, {
        ...(record.enabled === undefined ? {} : { enabled: record.enabled as boolean }),
        ...(record.rateLimitPerMinute === undefined
          ? {}
          : { rateLimitPerMinute: record.rateLimitPerMinute as number | null }),
        ...(record.keyExpiresAt === undefined ? {} : { keyExpiresAt: record.keyExpiresAt as string | null }),
      });
      return json({ endpoint: endpointSummary(updated) });
    }
    // Author Tables over D1 (TABLE-01 minimal slice, TABLE-02 query/count/
    // batch; issues #117, #154): Organization-scoped declarations with
    // deny-by-absence per-action grants, policy-safe keyset queries, scoped
    // counts with skip_count, and all-or-denied batch mutations. One explicit
    // matcher per route, mirroring the apps style above: boring and greppable
    // beats a shared capture. Realtime subscriptions are deferred per the
    // multi-slice note in issue #154; polling repeats the GET rows route.
    if (url.pathname === "/api/tables" && request.method === "GET") {
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      return json({ tables: await listTables(env.DB, caller) });
    }
    if (url.pathname === "/api/tables" && request.method === "POST") {
      requireJson(request);
      const body: unknown = await boundedJson(request.body);
      if (body === null || typeof body !== "object" || Array.isArray(body) || !("name" in body)) {
        throw new Fault(400, "INVALID_TABLE", "Table creation needs { name }.");
      }
      return json({ table: await createTable(env.DB, caller, (body as Record<string, unknown>).name) }, 201);
    }
    const tableCount = /^\/api\/tables\/([a-z0-9][a-z0-9-]{0,63})\/count$/.exec(url.pathname);
    if (tableCount?.[1] && request.method === "GET") {
      // Scoped filtered count: same filters as the rows route. skip_count
      // answers total=-1 without scanning; a filled scan window answers -2.
      const table = await loadTable(env.DB, caller.orgId, tableCount[1]);
      if (!table) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      return json(await countRows(env.DB, caller, table, parseTableQuery(url.searchParams)));
    }
    const tableRows = /^\/api\/tables\/([a-z0-9][a-z0-9-]{0,63})\/rows$/.exec(url.pathname);
    if (tableRows?.[1] && request.method === "GET") {
      const table = await loadTable(env.DB, caller.orgId, tableRows[1]);
      if (!table) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      return json(await queryRows(env.DB, caller, table, parseTableQuery(url.searchParams)));
    }
    const tableBatchInsert = /^\/api\/tables\/([a-z0-9][a-z0-9-]{0,63})\/rows\/batch$/.exec(url.pathname);
    if (tableBatchInsert?.[1] && request.method === "POST") {
      // All-or-denied batch insert: policy/attribution denials fail the whole
      // batch first (403 TABLE_BATCH_DENIED); operational per-item failures
      // ride per-item results after the surviving writes land atomically.
      requireJson(request);
      const table = await loadTable(env.DB, caller.orgId, tableBatchInsert[1]);
      if (!table) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      return json(await batchInsert(env.DB, caller, table, parseBatchBody(await boundedJson(request.body))), 201);
    }
    const tableBatchUpdate = /^\/api\/tables\/([a-z0-9][a-z0-9-]{0,63})\/rows\/batch-update$/.exec(url.pathname);
    if (tableBatchUpdate?.[1] && request.method === "PUT") {
      requireJson(request);
      const table = await loadTable(env.DB, caller.orgId, tableBatchUpdate[1]);
      if (!table) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      return json(await batchUpdate(env.DB, caller, table, parseBatchBody(await boundedJson(request.body))));
    }
    const tableBatchDelete = /^\/api\/tables\/([a-z0-9][a-z0-9-]{0,63})\/rows\/batch-delete$/.exec(url.pathname);
    if (tableBatchDelete?.[1] && request.method === "POST") {
      requireJson(request);
      const table = await loadTable(env.DB, caller.orgId, tableBatchDelete[1]);
      if (!table) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      return json(await batchDelete(env.DB, caller, table, parseBatchDeleteBody(await boundedJson(request.body))));
    }
    const tableRow = /^\/api\/tables\/([a-z0-9][a-z0-9-]{0,63})\/rows\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(
      url.pathname,
    );
    if (tableRow?.[1] && tableRow[2]) {
      const table = await loadTable(env.DB, caller.orgId, tableRow[1]);
      if (!table) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      if (request.method === "PUT") {
        requireJson(request);
        const body: unknown = await boundedJson(request.body);
        if (body === null || typeof body !== "object" || Array.isArray(body) || !("data" in body)) {
          throw new Fault(400, "INVALID_DOCUMENT", "Row writes need { data } with a JSON object document.");
        }
        const row = await insertRow(env.DB, caller, table, tableRow[2], (body as Record<string, unknown>).data);
        return json({ row }, 201);
      }
      if (request.method === "GET") {
        return json({ row: await readRow(env.DB, caller, table, tableRow[2]) });
      }
      if (request.method === "PATCH") {
        requireJson(request);
        const body: unknown = await boundedJson(request.body);
        if (body === null || typeof body !== "object" || Array.isArray(body) || !("data" in body)) {
          throw new Fault(400, "INVALID_DOCUMENT", "Row updates need { data } with a JSON object document.");
        }
        return json({
          row: await updateRow(env.DB, caller, table, tableRow[2], (body as Record<string, unknown>).data),
        });
      }
      if (request.method === "DELETE") {
        await deleteRow(env.DB, caller, table, tableRow[2]);
        return json({ deleted: true });
      }
    }
    const tableGrant = /^\/api\/tables\/([a-z0-9][a-z0-9-]{0,63})\/grants$/.exec(url.pathname);
    if (tableGrant?.[1] && (request.method === "POST" || request.method === "DELETE")) {
      // Owner-only grant administration. Grants name user IDs in this slice;
      // role claims belong to AUTH-02. Revocation converges immediately for
      // subsequent calls (no live push until realtime subscriptions land).
      requireJson(request);
      const name = parseTableName(tableGrant[1]);
      const table = await loadTable(env.DB, caller.orgId, name);
      if (!table) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      const body: unknown = await boundedJson(request.body);
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new Fault(400, "INVALID_GRANT", "Grant bodies need { action, granteeUserId }.");
      }
      const record = body as Record<string, unknown>;
      if (request.method === "POST") {
        await grantTable(env.DB, caller, table, record.action, record.granteeUserId);
        return json({ granted: true });
      }
      await revokeTable(env.DB, caller, table, record.action, record.granteeUserId);
      return json({ revoked: true });
    }
    const tableOne = /^\/api\/tables\/([a-z0-9][a-z0-9-]{0,63})$/.exec(url.pathname);
    if (tableOne?.[1] && request.method === "GET") {
      if (!TABLE_NAME.test(tableOne[1])) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      const table = await loadTable(env.DB, caller.orgId, tableOne[1]);
      if (!table) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      // Same visibility rule as listTables (issue #353): owner or any
      // grant. Non-grantees answer 404, never owner identity metadata.
      try {
        await requireVisibleTable(env.DB, caller, table);
      } catch {
        return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      }
      return json({ table });
    }
    if (tableOne?.[1] && request.method === "DELETE") {
      const table = await loadTable(env.DB, caller.orgId, tableOne[1]);
      if (!table) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      await deleteTable(env.DB, caller, table);
      return json({ deleted: true });
    }
    // Scoped configuration (CON-02, ADR 031): typed key/value rows for the
    // caller's own Organization. Secret rows answer "[SECRET]" on every read
    // surface and provision only references — values resolve transiently at
    // the Integration Action boundary and never persist, log, or return.
    // One explicit matcher per route, mirroring the tables style: boring and
    // greppable beats a shared capture.
    // Codex #348: config administration is an org-admin operation. Every
    // route gates on requireManageOrg for the caller's own Organization, so
    // ordinary and external members cannot read or mutate config rows. The
    // finding asks for a narrower read permission if non-admin authors need
    // visibility; none exists yet (no shipped Saga reads ctx.config), so the
    // gate stays uniform across reads and writes.
    if (url.pathname === "/api/config" && request.method === "GET") {
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      await requireManageOrg(env.DB, ctx, caller.orgId);
      return json({ configs: await listConfigs(env.DB, caller) });
    }
    if (url.pathname === "/api/config" && request.method === "POST") {
      requireJson(request);
      await requireManageOrg(env.DB, ctx, caller.orgId);
      const body: unknown = await boundedJson(request.body);
      if (!object(body))
        throw new Fault(400, "INVALID_CONFIG", "Config writes need { key, type, value?, description? }.");
      const record = body as Record<string, unknown>;
      return json(
        {
          config: await setConfig(
            env.DB,
            caller,
            { key: record.key, type: record.type, value: record.value, description: record.description },
            env as unknown as Record<string, string | undefined>,
          ),
        },
        201,
      );
    }
    const configOne = /^\/api\/config\/([0-9a-fA-F-]{36})$/.exec(url.pathname);
    if (configOne?.[1]) {
      if (request.method === "PUT") {
        requireJson(request);
        await requireManageOrg(env.DB, ctx, caller.orgId);
        return json({
          config: await updateConfig(
            env.DB,
            caller,
            configOne[1],
            parseUpdateConfigInput(await boundedJson(request.body)),
            env as unknown as Record<string, string | undefined>,
          ),
        });
      }
      if (request.method === "DELETE") {
        await requireManageOrg(env.DB, ctx, caller.orgId);
        await deleteConfig(env.DB, caller, configOne[1]);
        return json({ deleted: true });
      }
    }
    // Gray-out is server-enforced: mapped /api/* routes serve, every other
    // /api/* path reports UNIMPLEMENTED (never a generic NOT_FOUND).
    return json(
      { error: { code: "UNIMPLEMENTED", message: "This API surface is not implemented in this slice." } },
      501,
    );
  } catch (error) {
    const fault =
      error instanceof Fault ? error : new Fault(500, "INTERNAL_ERROR", "The request could not be completed.");
    const headers: Record<string, string> = {};
    if (fault.status === 401) headers["WWW-Authenticate"] = "Bearer";
    if (fault.status === 503) headers["Retry-After"] = "5";
    // Outward error path: a secret substring embedded in a Fault message
    // (caller input echoed back, miswired env text) is replaced before send.
    // FORM-01 details channel: the 422 form-validation Fault carries its
    // per-field failure list here. No other Fault sets details; details are
    // field names and fixed reason strings, scrubbed like the rest.
    const faultBody =
      fault.details === undefined
        ? { code: fault.code, message: fault.message }
        : { code: fault.code, message: fault.message, details: fault.details };
    return json(scrubValueWithDeploymentSecrets({ error: faultBody }, env), fault.status, headers);
  }
}

function parseOrgBody(value: unknown): { name: string } {
  if (!object(value) || typeof value.name !== "string") {
    throw new Fault(400, "INVALID_ORG_NAME", "Provide an Organization name of 1 to 128 characters.");
  }
  return { name: value.name };
}

function parseMemberBody(value: unknown): { userId: string; role: OrgRole; kind: MembershipKind } {
  if (!object(value) || typeof value.userId !== "string") {
    throw new Fault(400, "INVALID_USER_ID", "Provide a userId string to invite.");
  }
  const role: OrgRole = value.role === undefined ? "member" : (value.role as OrgRole);
  const kind: MembershipKind = value.kind === undefined ? "ordinary" : (value.kind as MembershipKind);
  if (role !== "member" && role !== "admin") {
    throw new Fault(400, "INVALID_MEMBERSHIP", "Role must be member or admin.");
  }
  if (kind !== "ordinary" && kind !== "external") {
    throw new Fault(400, "INVALID_MEMBERSHIP", "Kind must be ordinary or external.");
  }
  return { userId: value.userId, role, kind };
}

function parseMemberUpdate(value: unknown): MemberUpdate {
  if (!object(value)) throw new Fault(400, "INVALID_MEMBERSHIP", "Provide role, status, or kind to change.");
  const known = ["role", "status", "kind"];
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) throw new Fault(400, "UNSUPPORTED_FIELD", `Field ${key} cannot be changed here.`);
  }
  const update: { role?: OrgRole; status?: MembershipStatus; kind?: MembershipKind } = {};
  if (value.role !== undefined) {
    if (value.role !== "member" && value.role !== "admin") {
      throw new Fault(400, "INVALID_MEMBERSHIP", "Role must be member or admin.");
    }
    update.role = value.role;
  }
  if (value.status !== undefined) {
    if (!["invited", "active", "suspended", "revoked"].includes(value.status as string)) {
      throw new Fault(400, "INVALID_MEMBERSHIP", "Status must be invited, active, suspended, or revoked.");
    }
    update.status = value.status as MembershipStatus;
  }
  if (value.kind !== undefined) {
    if (value.kind !== "ordinary" && value.kind !== "external") {
      throw new Fault(400, "INVALID_MEMBERSHIP", "Kind must be ordinary or external.");
    }
    update.kind = value.kind;
  }
  return update;
}

/** AUTH-02 body parsers (ADR 018): unknown keys are rejected here so the
 * domain functions only see known fields. Grant/rule triples re-validate in
 * roles.ts (fail closed twice: route shape, then domain semantics). */
function parseRoleBody(value: unknown): { name: string; description: string } {
  if (!object(value) || typeof value.name !== "string") {
    throw new Fault(400, "INVALID_ROLE", "Provide a role name of 1 to 64 characters.");
  }
  for (const key of Object.keys(value)) {
    if (!["name", "description"].includes(key)) {
      throw new Fault(400, "UNSUPPORTED_FIELD", `Field ${key} cannot be set here.`);
    }
  }
  const description = value.description === undefined ? "" : value.description;
  if (typeof description !== "string" || description.length > 256) {
    throw new Fault(400, "INVALID_ROLE", "Role description must be at most 256 characters.");
  }
  return { name: value.name, description };
}

function parseGrantBody(value: unknown): { resourceKind: ResourceKind; resourceId: string; action: ResourceAction } {
  if (!object(value)) throw new Fault(400, "INVALID_GRANT", "Provide resourceKind, resourceId, and action.");
  for (const key of Object.keys(value)) {
    if (!["resourceKind", "resourceId", "action"].includes(key)) {
      throw new Fault(400, "UNSUPPORTED_FIELD", `Field ${key} cannot be set here.`);
    }
  }
  if (
    typeof value.resourceKind !== "string" ||
    typeof value.resourceId !== "string" ||
    typeof value.action !== "string"
  ) {
    throw new Fault(400, "INVALID_GRANT", "Provide resourceKind, resourceId, and action.");
  }
  return {
    resourceKind: value.resourceKind as ResourceKind,
    resourceId: value.resourceId,
    action: value.action as ResourceAction,
  };
}

function parseRuleBody(value: unknown): {
  resourceKind: ResourceKind;
  resourceId: string;
  action: ResourceAction;
  subjectType: string;
  subjectRef: string;
} {
  if (!object(value)) throw new Fault(400, "INVALID_RULE", "Provide resourceKind, resourceId, action, and subject.");
  for (const key of Object.keys(value)) {
    if (!["resourceKind", "resourceId", "action", "subjectType", "subjectRef"].includes(key)) {
      throw new Fault(400, "UNSUPPORTED_FIELD", `Field ${key} cannot be set here.`);
    }
  }
  if (
    typeof value.resourceKind !== "string" ||
    typeof value.resourceId !== "string" ||
    typeof value.action !== "string" ||
    (value.subjectType !== undefined && typeof value.subjectType !== "string") ||
    (value.subjectRef !== undefined && typeof value.subjectRef !== "string")
  ) {
    throw new Fault(400, "INVALID_RULE", "Provide resourceKind, resourceId, action, and subject.");
  }
  return {
    resourceKind: value.resourceKind as ResourceKind,
    resourceId: value.resourceId,
    action: value.action as ResourceAction,
    subjectType: (value.subjectType ?? "user") as string,
    subjectRef: (value.subjectRef ?? "") as string,
  };
}

function parseAssignmentBody(value: unknown): { userId: string } {
  if (!object(value) || typeof value.userId !== "string") {
    throw new Fault(400, "INVALID_USER_ID", "Provide a userId string to assign.");
  }
  for (const key of Object.keys(value)) {
    if (!["userId"].includes(key)) throw new Fault(400, "UNSUPPORTED_FIELD", `Field ${key} cannot be set here.`);
  }
  return { userId: value.userId };
}

function parseRevokeBody(value: unknown): { userId?: string; roleId?: string } {
  if (!object(value)) throw new Fault(400, "INVALID_REVOCATION", "Revoke by user or by role.");
  for (const key of Object.keys(value)) {
    if (!["userId", "roleId"].includes(key)) {
      throw new Fault(400, "UNSUPPORTED_FIELD", `Field ${key} cannot be set here.`);
    }
  }
  if (typeof value.userId === "string" && typeof value.roleId === "string") {
    throw new Fault(400, "INVALID_REVOCATION", "Revoke by user or by role, not both.");
  }
  if (typeof value.userId === "string") return { userId: value.userId };
  if (typeof value.roleId === "string") return { roleId: value.roleId };
  throw new Fault(400, "INVALID_REVOCATION", "Revoke by user or by role.");
}

/** Query parser for GET .../policy-consumers: exactly resourceKind,
 * resourceId, and action, nothing else (deny-by-default query posture). */
function parseTripleQuery(params: URLSearchParams): {
  resourceKind: ResourceKind;
  resourceId: string;
  action: ResourceAction;
} {
  for (const key of params.keys()) {
    if (!["resourceKind", "resourceId", "action"].includes(key)) {
      throw new Fault(400, "UNSUPPORTED_QUERY", "Only resourceKind, resourceId, and action are supported here.");
    }
  }
  const kind = params.get("resourceKind");
  const id = params.get("resourceId");
  const action = params.get("action");
  if (kind === null || id === null || action === null) {
    throw new Fault(400, "INVALID_GRANT", "Provide resourceKind, resourceId, and action.");
  }
  return { resourceKind: kind as ResourceKind, resourceId: id, action: action as ResourceAction };
}

/** AUTH-02 (ADR 018): hidden-reference discipline for Apps. A foreign or
 * unknown App id answers 404 (same shape as loadForm: resolve-then-null),
 * never a grant-shaped 403 that would confirm existence. Only a visible app
 * reaches grant evaluation. */
async function requireAppVisible(
  db: D1Database,
  ctx: CallerCtx,
  caller: Principal,
  id: string,
  action: ResourceAction,
  message: string,
): Promise<void> {
  if (!(await loadApp(db, caller, id))) throw new Fault(404, "APP_NOT_FOUND", "App not found.");
  await requireGrant(
    db,
    ctx,
    { orgId: caller.orgId, resourceKind: "app", resourceId: id.toLowerCase(), action },
    message,
  );
}

/** AUTH-01 admin router: Organizations, members, users, and the org admin
 * history surface. Returns null when the path is not an org route. Query
 * strings stay deny-by-default: only the org history list takes them, with
 * the same allowlisted keys as the owner listing. */
async function routeOrgs(request: Request, env: Bindings, ctx: CallerCtx, url: URL): Promise<Response | null> {
  const pathname = url.pathname;
  if (pathname === "/api/orgs" && request.method === "GET") {
    return json({ orgs: await listOrgs(env.DB, ctx) });
  }
  if (pathname === "/api/orgs" && request.method === "POST") {
    requireInstanceAdmin(ctx);
    requireJson(request);
    const org = await createOrg(env.DB, parseOrgBody(await boundedJson(request.body)).name);
    return json(org, 201);
  }
  const orgDetail = /^\/api\/orgs\/([0-9a-fA-F-]{36})$/.exec(pathname);
  if (orgDetail?.[1]) {
    const orgId = parseOrgId(orgDetail[1]);
    if (request.method === "GET") {
      if (!(await canManageOrg(env.DB, ctx, orgId))) throw new Fault(404, "ORG_NOT_FOUND", "Organization not found.");
      return json(await getOrgSummary(env.DB, orgId));
    }
  }
  const disable = /^\/api\/orgs\/([0-9a-fA-F-]{36})\/(disable|enable)$/.exec(pathname);
  if (disable?.[1] && disable[2] && request.method === "POST") {
    requireInstanceAdmin(ctx);
    // Codex #349: status changes mutate global lifecycle state, so they
    // share the JSON-write gate: unencoded application/json rejects
    // cross-origin form posts against Access-authenticated sessions.
    requireJson(request);
    return json(await setOrgStatus(env.DB, parseOrgId(disable[1]), disable[2] === "disable"));
  }
  const del = /^\/api\/orgs\/([0-9a-fA-F-]{36})$/.exec(pathname);
  if (del?.[1] && request.method === "DELETE") {
    requireInstanceAdmin(ctx);
    return json(await deleteOrg(env.DB, parseOrgId(del[1]), { files: env.FILES, artifacts: env.ARTIFACTS }));
  }
  const preview = /^\/api\/orgs\/([0-9a-fA-F-]{36})\/delete-preview$/.exec(pathname);
  if (preview?.[1] && request.method === "GET") {
    requireInstanceAdmin(ctx);
    return json(await deletePreview(env.DB, parseOrgId(preview[1])));
  }
  const members = /^\/api\/orgs\/([0-9a-fA-F-]{36})\/members$/.exec(pathname);
  if (members?.[1]) {
    const orgId = parseOrgId(members[1]);
    if (request.method === "GET") {
      await requireManageOrg(env.DB, ctx, orgId);
      return json({ members: await listMembers(env.DB, orgId) });
    }
    if (request.method === "POST") {
      await requireManageOrg(env.DB, ctx, orgId);
      requireJson(request);
      const body = parseMemberBody(await boundedJson(request.body));
      const member = await inviteMember(env.DB, orgId, parseUserId(body.userId), body.role, body.kind);
      return json(member, 201);
    }
  }
  const member = /^\/api\/orgs\/([0-9a-fA-F-]{36})\/members\/(.+)$/.exec(pathname);
  if (member?.[1] && member[2] && (request.method === "PATCH" || request.method === "PUT")) {
    const orgId = parseOrgId(member[1]);
    await requireManageOrg(env.DB, ctx, orgId);
    requireJson(request);
    return json(
      await updateMember(
        env.DB,
        orgId,
        parseUserId(decodeURIComponent(member[2])),
        parseMemberUpdate(await boundedJson(request.body)),
      ),
    );
  }
  const orgHistory = /^\/api\/orgs\/([0-9a-fA-F-]{36})\/executions$/.exec(pathname);
  if (orgHistory?.[1] && request.method === "GET") {
    const orgId = parseOrgId(orgHistory[1]);
    await requireManageOrg(env.DB, ctx, orgId);
    return json(await listOrgHistory(env.DB, orgId, parseHistoryQuery(url.searchParams)));
  }
  // AUTH-02 role/policy administration (ADR 018): org admins own their
  // Organization's roles, grants, assignments, bulk revocation, and
  // Organization policy rules. Non-admin members reach no admin route.
  const roles = /^\/api\/orgs\/([0-9a-fA-F-]{36})\/roles$/.exec(pathname);
  if (roles?.[1]) {
    const orgId = parseOrgId(roles[1]);
    await requireManageOrg(env.DB, ctx, orgId);
    if (request.method === "GET") return json({ roles: await listRoles(env.DB, orgId) });
    if (request.method === "POST") {
      requireJson(request);
      const body = parseRoleBody(await boundedJson(request.body));
      return json(await createRole(env.DB, orgId, body.name, body.description), 201);
    }
  }
  const roleOne = /^\/api\/orgs\/([0-9a-fA-F-]{36})\/roles\/([0-9a-fA-F-]{36})$/.exec(pathname);
  if (roleOne?.[1] && roleOne[2] && request.method === "DELETE") {
    const orgId = parseOrgId(roleOne[1]);
    await requireManageOrg(env.DB, ctx, orgId);
    return json(await deleteRole(env.DB, orgId, parseRoleId(roleOne[2])));
  }
  const consumers = /^\/api\/orgs\/([0-9a-fA-F-]{36})\/roles\/([0-9a-fA-F-]{36})\/consumers$/.exec(pathname);
  if (consumers?.[1] && consumers[2] && request.method === "GET") {
    const orgId = parseOrgId(consumers[1]);
    await requireManageOrg(env.DB, ctx, orgId);
    return json(await roleConsumers(env.DB, orgId, parseRoleId(consumers[2])));
  }
  const grants = /^\/api\/orgs\/([0-9a-fA-F-]{36})\/roles\/([0-9a-fA-F-]{36})\/grants$/.exec(pathname);
  if (grants?.[1] && grants[2]) {
    const orgId = parseOrgId(grants[1]);
    await requireManageOrg(env.DB, ctx, orgId);
    if (request.method === "GET") return json({ grants: await listGrants(env.DB, orgId, parseRoleId(grants[2])) });
    if (request.method === "POST") {
      requireJson(request);
      const body = parseGrantBody(await boundedJson(request.body));
      return json(
        await addRoleGrant(env.DB, orgId, parseRoleId(grants[2]), body.resourceKind, body.resourceId, body.action),
        201,
      );
    }
  }
  const grantOne = /^\/api\/orgs\/([0-9a-fA-F-]{36})\/roles\/([0-9a-fA-F-]{36})\/grants\/([0-9a-fA-F-]{36})$/.exec(
    pathname,
  );
  if (grantOne?.[1] && grantOne[2] && grantOne[3] && request.method === "DELETE") {
    const orgId = parseOrgId(grantOne[1]);
    await requireManageOrg(env.DB, ctx, orgId);
    await removeGrant(env.DB, orgId, parseRoleId(grantOne[2]), grantOne[3]);
    return json({ deleted: true });
  }
  const assignments = /^\/api\/orgs\/([0-9a-fA-F-]{36})\/roles\/([0-9a-fA-F-]{36})\/assignments$/.exec(pathname);
  if (assignments?.[1] && assignments[2]) {
    const orgId = parseOrgId(assignments[1]);
    await requireManageOrg(env.DB, ctx, orgId);
    if (request.method === "GET") {
      return json({ assignments: await listAssignments(env.DB, orgId, parseRoleId(assignments[2])) });
    }
    if (request.method === "POST") {
      requireJson(request);
      const body = parseAssignmentBody(await boundedJson(request.body));
      return json(await assignRole(env.DB, orgId, parseRoleId(assignments[2]), body.userId), 201);
    }
  }
  const assignmentOne = /^\/api\/orgs\/([0-9a-fA-F-]{36})\/roles\/([0-9a-fA-F-]{36})\/assignments\/(.+)$/.exec(
    pathname,
  );
  if (assignmentOne?.[1] && assignmentOne[2] && assignmentOne[3] && request.method === "DELETE") {
    const orgId = parseOrgId(assignmentOne[1]);
    await requireManageOrg(env.DB, ctx, orgId);
    return json(
      await revokeAssignment(
        env.DB,
        orgId,
        parseRoleId(assignmentOne[2]),
        parseUserId(decodeURIComponent(assignmentOne[3])),
      ),
    );
  }
  const revokeBulk = /^\/api\/orgs\/([0-9a-fA-F-]{36})\/assignments\/revoke$/.exec(pathname);
  if (revokeBulk?.[1] && request.method === "POST") {
    const orgId = parseOrgId(revokeBulk[1]);
    await requireManageOrg(env.DB, ctx, orgId);
    requireJson(request);
    return json(await revokeAll(env.DB, orgId, parseRevokeBody(await boundedJson(request.body))));
  }
  const orgRules = /^\/api\/orgs\/([0-9a-fA-F-]{36})\/policy-rules$/.exec(pathname);
  if (orgRules?.[1]) {
    const orgId = parseOrgId(orgRules[1]);
    await requireManageOrg(env.DB, ctx, orgId);
    if (request.method === "GET") return json({ rules: await listPolicyRules(env.DB, orgId) });
    if (request.method === "POST") {
      requireJson(request);
      const body = parseRuleBody(await boundedJson(request.body));
      return json(
        await createPolicyRule(
          env.DB,
          orgId,
          body.resourceKind,
          body.resourceId,
          body.action,
          body.subjectType,
          body.subjectRef,
        ),
        201,
      );
    }
  }
  const orgRuleOne = /^\/api\/orgs\/([0-9a-fA-F-]{36})\/policy-rules\/([0-9a-fA-F-]{36})$/.exec(pathname);
  if (orgRuleOne?.[1] && orgRuleOne[2] && request.method === "DELETE") {
    const orgId = parseOrgId(orgRuleOne[1]);
    await requireManageOrg(env.DB, ctx, orgId);
    await deletePolicyRule(env.DB, orgId, parseRuleId(orgRuleOne[2]));
    return json({ deleted: true });
  }
  const policyConsumersRoute = /^\/api\/orgs\/([0-9a-fA-F-]{36})\/policy-consumers$/.exec(pathname);
  if (policyConsumersRoute?.[1] && request.method === "GET") {
    const orgId = parseOrgId(policyConsumersRoute[1]);
    await requireManageOrg(env.DB, ctx, orgId);
    const triple = parseTripleQuery(url.searchParams);
    return json(await policyConsumers(env.DB, orgId, triple.resourceKind, triple.resourceId, triple.action));
  }
  // Global policy rules (ADR 018): instance admins only. Globals apply across
  // Organizations; org admins never write them.
  if (pathname === "/api/policy-rules" && (request.method === "GET" || request.method === "POST")) {
    requireInstanceAdmin(ctx);
    if (request.method === "GET") return json({ rules: await listPolicyRules(env.DB, null) });
    requireJson(request);
    const body = parseRuleBody(await boundedJson(request.body));
    return json(
      await createPolicyRule(
        env.DB,
        null,
        body.resourceKind,
        body.resourceId,
        body.action,
        body.subjectType,
        body.subjectRef,
      ),
      201,
    );
  }
  const globalRuleOne = /^\/api\/policy-rules\/([0-9a-fA-F-]{36})$/.exec(pathname);
  if (globalRuleOne?.[1] && request.method === "DELETE") {
    requireInstanceAdmin(ctx);
    await deletePolicyRule(env.DB, null, parseRuleId(globalRuleOne[1]));
    return json({ deleted: true });
  }
  const user = /^\/api\/users\/(.+?)\/(disable|enable)$/.exec(pathname);
  if (user?.[1] && user[2] && request.method === "POST") {
    requireInstanceAdmin(ctx);
    // Codex #349: same JSON-write gate as the org status routes above.
    requireJson(request);
    return json(await setUserStatus(env.DB, parseUserId(decodeURIComponent(user[1])), user[2] === "disable"));
  }
  if (pathname.startsWith("/api/orgs") || pathname.startsWith("/api/users/")) {
    throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
  }
  return null;
}
