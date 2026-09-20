// SPDX-License-Identifier: AGPL-3.0
// Adapted from upstream gobifrost/bifrost client/src/lib/api-client.ts
// (reference: vendor/upstream). Structure borrowed; Wrangnarök Bearer fixture only.
//
// Auth: the fixture token is supplied by the operator (localStorage, set via
// the Token field in the UI) and sent as `Authorization: Bearer <token>`.
// Secrets are never bundled in client code.
import { parseApiError } from "./api-error";
import type {
  AiAssignmentResponse,
  AiAssignmentsResponse,
  AiAssignmentSummary,
  AiBehaviorResponse,
  AiEmbeddingResponse,
  AiEmbeddingSummary,
  AiProfilesResponse,
  AiProfileSummary,
  AiResolutionResponse,
  AppDependency,
  AppDetail,
  AppFile,
  AppJob,
  AppNotification,
  AppRevision,
  AppsResponse,
  AppSummary,
  AuditEvent,
  AuditResponse,
  ArtifactDetail,
  BrandingResponse,
  BrandingView,
  CallerResponse,
  ProfileResponse,
  ProfileTheme,
  ProfileView,
  ArtifactFormat,
  ArtifactsResponse,
  ArtifactSummary,
  ConfigEntry,
  ConfigListResponse,
  ConnectionsResponse,
  ConnectionSummary,
  ConnectionTestResponse,
  ExecutionDetail,
  ExecutionHistoryResponse,
  ExecutionStatus,
  LogEntry,
  LogPage,
  NotificationsResponse,
  FileLocation,
  FileLocationsResponse,
  FileMeta,
  FilesResponse,
  AppEmbedGrantIssuedResponse,
  AppEmbedGrantResponse,
  AppEmbedGrantsResponse,
  AppEmbedGrantSummary,
  EmbedGrantIssuedResponse,
  EmbedGrantResponse,
  EmbedGrantsResponse,
  EmbedGrantSummary,
  FormDetail,
  FormPublicationResponse,
  FormPublicationSummary,
  FormProvidersResponse,
  FormStartupResponse,
  FormSubmitResponse,
  FormsResponse,
  FormSummary,
  IntegrationsResponse,
  IntegrationSummary,
  McpCatalogResponse,
  McpCatalogTool,
  McpConnectionsResponse,
  McpConnectionSummary,
  McpConsentState,
  McpRefreshSummary,
  McpServersResponse,
  McpServerSummary,
  OpenapiOperation,
  OpenapiSearchResponse,
  SagasResponse,
  SagaSummary,
  ToolsResponse,
  ToolSummary,
} from "./client-types";

const TOKEN_KEY = "wrangnarok.token";

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage unavailable (e.g. SSR render in tests); callers still work.
  }
}

async function get(path: string): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const response = await fetch(path, { headers });
  if (!response.ok) throw await parseApiError(response);
  return (await response.json()) as unknown;
}

function isHistoryResponse(value: unknown): value is ExecutionHistoryResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v["executions"]) || typeof v["hasMore"] !== "boolean") return false;
  // nextCursor is new (Phase 2 querying); older payloads without it still read.
  return !("nextCursor" in v) || typeof v["nextCursor"] === "string" || v["nextCursor"] === null;
}

function isSagasResponse(value: unknown): value is SagasResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v["sagas"])) return false;
  return (v["sagas"] as unknown[]).every((entry): entry is SagaSummary => {
    if (typeof entry !== "object" || entry === null) return false;
    const e = entry as Record<string, unknown>;
    return (
      typeof e["id"] === "string" &&
      typeof e["name"] === "string" &&
      typeof e["revision"] === "string" &&
      typeof e["description"] === "string"
    );
  });
}

function isDetailResponse(value: unknown): value is ExecutionDetail {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v["executionId"] !== "string" || !Array.isArray(v["operations"]) || !("runtimeStatus" in v)) {
    return false;
  }
  const detail = v as unknown as ExecutionDetail;
  // Lineage is new (RUN-02); older payloads without it still read.
  if (!("parentExecutionId" in v) || v["parentExecutionId"] === undefined) detail.parentExecutionId = null;
  if (!("parentStep" in v) || v["parentStep"] === undefined) detail.parentStep = null;
  if (!("children" in v) || v["children"] === undefined) detail.children = [];
  return (
    (detail.parentExecutionId === null || typeof detail.parentExecutionId === "string") &&
    (detail.parentStep === null || typeof detail.parentStep === "string") &&
    Array.isArray(detail.children)
  );
}

/** Server-side history filters (allowlisted query keys; anything else is UNSUPPORTED_QUERY). */
export interface HistoryListQuery {
  /** One status or a comma-separated multi-status set (mirrors upstream). */
  status?: ExecutionStatus | ExecutionStatus[];
  sagaId?: string;
  /** Exact Saga name (upstream workflowName parity). */
  sagaName?: string;
  /** Inclusive ISO lower bound on created_at (YYYY-MM-DD accepted). */
  startDate?: string;
  /** Inclusive-day / exact-datetime upper bound on created_at. */
  endDate?: string;
  limit?: number;
  /** Opaque page marker from a previous response. */
  cursor?: string;
}

function statusParam(status: ExecutionStatus | ExecutionStatus[]): string {
  return (Array.isArray(status) ? status : [status]).join(",");
}

/**
 * GET /api/executions — ExecutionHistory list (summaries + hasMore + nextCursor).
 * Status/Saga/date-range filters run server-side; free-text search stays
 * client-side over each loaded slice (see lib/history-view.ts), and is never
 * presented as a server total.
 */
export async function fetchExecutionHistory(query: HistoryListQuery = {}): Promise<ExecutionHistoryResponse> {
  const params = new URLSearchParams();
  if (query.status) params.set("status", statusParam(query.status));
  if (query.sagaId) params.set("sagaId", query.sagaId);
  if (query.sagaName) params.set("sagaName", query.sagaName);
  if (query.startDate) params.set("startDate", query.startDate);
  if (query.endDate) params.set("endDate", query.endDate);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const data = await get(`/api/executions${suffix}`);
  if (!isHistoryResponse(data)) throw new Error("Unexpected history response shape.");
  return data;
}

/** GET /api/sagas — Sagas catalog (read-only discovery metadata). */
export async function listSagas(): Promise<SagasResponse> {
  const data = await get("/api/sagas");
  if (!isSagasResponse(data)) throw new Error("Unexpected sagas response shape.");
  return data;
}

/** GET /api/executions/:id — Execution detail with Operations + runtimeStatus. */
export async function fetchExecutionDetail(id: string): Promise<ExecutionDetail> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Unexpected Execution ID shape.");
  const data = await get(`/api/executions/${id}`);
  if (!isDetailResponse(data)) throw new Error("Unexpected detail response shape.");
  return data;
}

/** Terminal Execution statuses: polling stops here (mirrors upstream's terminal set). */
export const TERMINAL_STATUSES: readonly ExecutionStatus[] = ["Succeeded", "Failed", "TimedOut", "Cancelled"];

function isLogEntry(value: unknown): value is LogEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["seq"] === "number" &&
    typeof v["executionId"] === "string" &&
    typeof v["level"] === "string" &&
    typeof v["message"] === "string" &&
    typeof v["createdAt"] === "string"
  );
}

function isLogPage(value: unknown): value is LogPage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v["logs"]) || typeof v["hasMore"] !== "boolean") return false;
  if (!(v["logs"] as unknown[]).every(isLogEntry)) return false;
  return !("nextCursor" in v) || typeof v["nextCursor"] === "string" || v["nextCursor"] === null;
}

export interface LogTailQuery {
  level?: string;
  limit?: number;
  cursor?: string;
}

/** GET /api/executions/:id/logs — scoped author-log tail for one Execution.
 * DEBUG rows are hidden unless the caller asks (level=DEBUG). Polling view
 * over durable rows: reconnect by refetching from nextCursor. */
export async function fetchExecutionLogs(id: string, query: LogTailQuery = {}): Promise<LogPage> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Unexpected Execution ID shape.");
  const params = new URLSearchParams();
  if (query.level) params.set("level", query.level);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const data = await get(`/api/executions/${id}/logs${suffix}`);
  if (!isLogPage(data)) throw new Error("Unexpected log page shape.");
  return data;
}

/** Merge a freshly polled page into the client's durable view: dedupe by seq
 * (reconnect replays are idempotent) and keep deterministic seq order. Pure;
 * shared with the CLI follow mode. */
export function mergeLogPages(existing: readonly LogEntry[], page: readonly LogEntry[]): LogEntry[] {
  const seen = new Set(existing.map((entry) => entry.seq));
  const merged = [...existing];
  for (const entry of page) {
    if (!seen.has(entry.seq)) {
      seen.add(entry.seq);
      merged.push(entry);
    }
  }
  merged.sort((a, b) => a.seq - b.seq);
  return merged;
}

export function isTerminalStatus(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** POST /api/executions/:id/cancel — owner-only cancellation. */
export async function cancelExecution(
  id: string,
): Promise<{ executionId: string; status: string; cancelled: boolean }> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Unexpected Execution ID shape.");
  const token = getToken();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const response = await fetch(`/api/executions/${id}/cancel`, { method: "POST", headers });
  if (!response.ok) throw await parseApiError(response);
  const data = (await response.json()) as { executionId?: unknown; status?: unknown; cancelled?: unknown };
  if (typeof data.executionId !== "string" || typeof data.status !== "string" || typeof data.cancelled !== "boolean") {
    throw new Error("Unexpected cancel response shape.");
  }
  return { executionId: data.executionId, status: data.status, cancelled: data.cancelled };
}

const APP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isAppSummary(value: unknown): value is AppSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    typeof v["name"] === "string" &&
    typeof v["slug"] === "string" &&
    (v["ownerKind"] === "independent" || v["ownerKind"] === "solution") &&
    ["created", "ready", "building", "live", "failed"].includes(v["status"] as string)
  );
}

function isAppDetail(value: unknown): value is AppDetail {
  if (!isAppSummary(value)) return false;
  const v = value as unknown as Record<string, unknown>;
  return Array.isArray(v["revisions"]) && Array.isArray(v["jobs"]);
}

function isAppJob(value: unknown): value is AppJob {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    typeof v["revision"] === "number" &&
    ["queued", "running", "succeeded", "failed"].includes(v["status"] as string)
  );
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const token = getToken();
  const headers: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const response = await fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
  if (!response.ok) throw await parseApiError(response);
  return (await response.json()) as unknown;
}

async function putJson(path: string, body: unknown): Promise<unknown> {
  const token = getToken();
  const headers: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const response = await fetch(path, { method: "PUT", headers, body: JSON.stringify(body) });
  if (!response.ok) throw await parseApiError(response);
  return (await response.json()) as unknown;
}

/** GET /api/apps — Applications for this Organization (ADR 017). */
export async function listApps(): Promise<AppsResponse> {
  const data = await get("/api/apps");
  if (typeof data !== "object" || data === null || !Array.isArray((data as { apps?: unknown }).apps)) {
    throw new Error("Unexpected apps response shape.");
  }
  const apps = (data as { apps: unknown[] }).apps;
  if (!apps.every(isAppSummary)) throw new Error("Unexpected apps response shape.");
  return { apps };
}

/** POST /api/apps — create an independent app (no draft/publish step). */
export async function createApp(name: string, slug: string): Promise<AppSummary> {
  const data = await postJson("/api/apps", { name, slug });
  const app = (data as { app?: unknown }).app;
  if (!isAppSummary(app)) throw new Error("Unexpected app response shape.");
  return app;
}

/** GET /api/apps/:id — app detail with revisions, jobs, active deployment. */
export async function fetchAppDetail(id: string): Promise<AppDetail> {
  if (!APP_ID.test(id)) throw new Error("Unexpected App ID shape.");
  const data = await get(`/api/apps/${id}`);
  const app = (data as { app?: unknown }).app;
  if (!isAppDetail(app)) throw new Error("Unexpected app response shape.");
  return app;
}

/** PUT /api/apps/:id/source — edit source declarations (independent only). */
export async function editAppSource(id: string, files: AppFile[], dependencies: AppDependency[]): Promise<AppRevision> {
  if (!APP_ID.test(id)) throw new Error("Unexpected App ID shape.");
  const data = await putJson(`/api/apps/${id}/source`, { files, dependencies });
  const revision = (data as { revision?: unknown }).revision;
  if (typeof revision !== "object" || revision === null) throw new Error("Unexpected revision response shape.");
  return revision as AppRevision;
}

/** POST /api/apps/:id/validate — validate the current revision. */
export async function validateApp(id: string): Promise<AppRevision> {
  if (!APP_ID.test(id)) throw new Error("Unexpected App ID shape.");
  const data = await postJson(`/api/apps/${id}/validate`, {});
  const revision = (data as { revision?: unknown }).revision;
  if (typeof revision !== "object" || revision === null) throw new Error("Unexpected revision response shape.");
  return revision as AppRevision;
}

/** POST /api/apps/:id/builds — start an async deploy job (validate-gated). */
export async function startAppBuild(id: string): Promise<AppJob> {
  if (!APP_ID.test(id)) throw new Error("Unexpected App ID shape.");
  const data = await postJson(`/api/apps/${id}/builds`, {});
  const job = (data as { job?: unknown }).job;
  if (!isAppJob(job)) throw new Error("Unexpected job response shape.");
  return job;
}

/** GET /api/apps/:id/builds — inspect the async deploy-job queue. */
export async function listAppJobs(id: string): Promise<AppJob[]> {
  if (!APP_ID.test(id)) throw new Error("Unexpected App ID shape.");
  const data = await get(`/api/apps/${id}/builds`);
  const jobs = (data as { jobs?: unknown }).jobs;
  if (!Array.isArray(jobs) || !jobs.every(isAppJob)) throw new Error("Unexpected jobs response shape.");
  return jobs;
}

/** GET /api/apps/:id/builds/:jobId — inspect one deploy job. */
export async function fetchAppJob(id: string, jobId: string): Promise<AppJob> {
  if (!APP_ID.test(id) || !APP_ID.test(jobId)) throw new Error("Unexpected App ID shape.");
  const data = await get(`/api/apps/${id}/builds/${jobId}`);
  const job = (data as { job?: unknown }).job;
  if (!isAppJob(job)) throw new Error("Unexpected job response shape.");
  return job;
}

/** POST /api/apps/:id/swap — parked-old-app slug-swap recovery. */
export async function swapAppSlugs(id: string, otherAppId: string): Promise<{ app: AppSummary; other: AppSummary }> {
  if (!APP_ID.test(id) || !APP_ID.test(otherAppId)) throw new Error("Unexpected App ID shape.");
  const data = await postJson(`/api/apps/${id}/swap`, { otherAppId });
  const body = data as { app?: unknown; other?: unknown };
  if (!isAppSummary(body.app) || !isAppSummary(body.other)) throw new Error("Unexpected swap response shape.");
  return { app: body.app, other: body.other };
}

/** DELETE /api/apps/:id — delete an independent app (owned rows refuse). */
export async function deleteApp(id: string): Promise<void> {
  if (!APP_ID.test(id)) throw new Error("Unexpected App ID shape.");
  const token = getToken();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const response = await fetch(`/api/apps/${id}`, { method: "DELETE", headers });
  if (!response.ok) throw await parseApiError(response);
}

/** Server-side audit filters (allowlisted query keys; anything else is UNSUPPORTED_QUERY). */
export interface AuditListQuery {
  /** Dotted action prefix, e.g. "app." or "execution.cancel". */
  action?: string;
  outcome?: "success" | "failure";
  /** Bounded free-text match over action/target/detail. */
  search?: string;
  /** Inclusive ISO lower bound on created_at (YYYY-MM-DD accepted). */
  startDate?: string;
  /** Inclusive-day / exact-datetime upper bound on created_at. */
  endDate?: string;
  limit?: number;
  /** Opaque page marker from a previous response. */
  cursor?: string;
}

function isAuditEvent(value: unknown): value is AuditEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    typeof v["orgId"] === "string" &&
    typeof v["actorUserId"] === "string" &&
    typeof v["action"] === "string" &&
    (v["targetType"] === null || typeof v["targetType"] === "string") &&
    (v["targetId"] === null || typeof v["targetId"] === "string") &&
    (v["outcome"] === "success" || v["outcome"] === "failure") &&
    "detail" in v &&
    typeof v["createdAt"] === "string"
  );
}

function isArtifactSummary(value: unknown): value is ArtifactSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    typeof v["name"] === "string" &&
    typeof v["mime"] === "string" &&
    typeof v["sizeBytes"] === "number" &&
    typeof v["version"] === "number" &&
    (v["status"] === "active" || v["status"] === "deleted")
  );
}

function isConfigEntry(value: unknown): value is ConfigEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    typeof v["key"] === "string" &&
    typeof v["type"] === "string" &&
    "value" in v &&
    (v["description"] === null || typeof v["description"] === "string") &&
    (v["managedBy"] === null || typeof v["managedBy"] === "string") &&
    typeof v["updatedAt"] === "string" &&
    typeof v["updatedBy"] === "string"
  );
}

/** GET /api/config — typed config rows for this Organization (CON-02, ADR
 * 019). Secret rows answer "[SECRET]", never values. */
export async function listConfigs(): Promise<ConfigListResponse> {
  const data = await get("/api/config");
  if (typeof data !== "object" || data === null || !Array.isArray((data as { configs?: unknown }).configs)) {
    throw new Error("Unexpected configs response shape.");
  }
  const configs = (data as { configs: unknown[] }).configs;
  if (!configs.every(isConfigEntry)) throw new Error("Unexpected configs response shape.");
  return { configs };
}

/** POST /api/config — set a non-secret value or provision a secret
 * reference (upsert by key; managed rows refuse). */
export async function setConfigEntry(body: {
  key: string;
  type: string;
  value?: unknown;
  description?: string;
}): Promise<ConfigEntry> {
  const data = await postJson("/api/config", body);
  const config = (data as { config?: unknown }).config;
  if (!isConfigEntry(config)) throw new Error("Unexpected config response shape.");
  return config;
}

/** PUT /api/config/:id — update one row; omitted secret values preserve the
 * reference. */
export async function updateConfigEntry(
  id: string,
  body: { key?: string; type?: string; value?: unknown; description?: string },
): Promise<ConfigEntry> {
  if (!APP_ID.test(id)) throw new Error("Unexpected Config ID shape.");
  const data = await putJson(`/api/config/${id}`, body);
  const config = (data as { config?: unknown }).config;
  if (!isConfigEntry(config)) throw new Error("Unexpected config response shape.");
  return config;
}

async function deleteJson(path: string): Promise<unknown> {
  const token = getToken();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const response = await fetch(path, { method: "DELETE", headers });
  if (!response.ok) throw await parseApiError(response);
  return (await response.json()) as unknown;
}

/** DELETE /api/config/:id — delete one row (managed rows refuse). */
export async function deleteConfigEntry(id: string): Promise<void> {
  if (!APP_ID.test(id)) throw new Error("Unexpected Config ID shape.");
  await deleteJson(`/api/config/${id}`);
}

const LOCATION_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isFileLocation(value: unknown): value is FileLocation {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["name"] === "string" &&
    typeof v["maxBytes"] === "number" &&
    Array.isArray(v["contentTypes"]) &&
    typeof v["sharedRead"] === "boolean"
  );
}

function isFileMeta(value: unknown): value is FileMeta {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["location"] === "string" &&
    typeof v["path"] === "string" &&
    typeof v["version"] === "number" &&
    (v["status"] === "pending" || v["status"] === "ready")
  );
}

/** GET /api/file-locations — declared locations for this Organization (FILE-01). */
export async function listFileLocations(): Promise<FileLocationsResponse> {
  const data = await get("/api/file-locations");
  if (typeof data !== "object" || data === null || !Array.isArray((data as { locations?: unknown }).locations)) {
    throw new Error("Unexpected file locations response shape.");
  }
  const locations = (data as { locations: unknown[] }).locations;
  if (!locations.every(isFileLocation)) throw new Error("Unexpected file locations response shape.");
  return { locations };
}

/** POST /api/file-locations — declare a write location. */
export async function createFileLocation(
  name: string,
  options: { maxBytes?: number; contentTypes?: string[]; sharedRead?: boolean } = {},
): Promise<FileLocation> {
  if (!LOCATION_NAME.test(name)) throw new Error("Unexpected location name shape.");
  const data = await postJson("/api/file-locations", { name, ...options });
  const location = (data as { location?: unknown }).location;
  if (!isFileLocation(location)) throw new Error("Unexpected file location response shape.");
  return location;
}

/** GET /api/files — Organization-scoped structural listing for one location. */
export async function listFiles(location: string, prefix?: string): Promise<FilesResponse> {
  if (!LOCATION_NAME.test(location)) throw new Error("Unexpected location name shape.");
  const params = new URLSearchParams({ location });
  if (prefix) params.set("prefix", prefix);
  const data = await get(`/api/files?${params.toString()}`);
  const body = data as { files?: unknown; nextCursor?: unknown };
  if (!Array.isArray(body.files) || !body.files.every(isFileMeta)) {
    throw new Error("Unexpected files response shape.");
  }
  if (body.nextCursor !== null && typeof body.nextCursor !== "string") {
    throw new Error("Unexpected files response shape.");
  }
  return { files: body.files, nextCursor: body.nextCursor ?? null };
}

/** Download one ready file through the authorized Bearer-shape route. */
export async function downloadFile(location: string, path: string): Promise<Blob> {
  const params = new URLSearchParams({ location, path });
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const response = await fetch(`/api/files/content?${params.toString()}`, { headers });
  if (!response.ok) throw await parseApiError(response);
  return await response.blob();
}

const INTEGRATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isIntegrationSummary(value: unknown): value is IntegrationSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    typeof v["name"] === "string" &&
    typeof v["description"] === "string" &&
    Array.isArray(v["secretFields"]) &&
    Array.isArray(v["configSchema"]) &&
    Array.isArray(v["requiredSecrets"])
  );
}

function isAuditResponse(value: unknown): value is AuditResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v["events"]) || typeof v["hasMore"] !== "boolean") return false;
  if (!(v["events"] as unknown[]).every(isAuditEvent)) return false;
  return !("nextCursor" in v) || typeof v["nextCursor"] === "string" || v["nextCursor"] === null;
}

/**
 * GET /api/audit — administrative audit trail (Organization-scoped events +
 * hasMore + nextCursor). Action-prefix/outcome/search/date filters run
 * server-side.
 */
export async function fetchAuditEvents(query: AuditListQuery = {}): Promise<AuditResponse> {
  const params = new URLSearchParams();
  if (query.action) params.set("action", query.action);
  if (query.outcome) params.set("outcome", query.outcome);
  if (query.search) params.set("search", query.search);
  if (query.startDate) params.set("startDate", query.startDate);
  if (query.endDate) params.set("endDate", query.endDate);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const data = await get(`/api/audit${suffix}`);
  if (!isAuditResponse(data)) throw new Error("Unexpected audit response shape.");
  return data;
}

function isArtifactDetail(value: unknown): value is ArtifactDetail {
  if (!isArtifactSummary(value)) return false;
  const v = value as unknown as Record<string, unknown>;
  return Array.isArray(v["versions"]) && Array.isArray(v["bindings"]);
}

/** GET /api/artifacts — Artifact summaries for this Organization (FILE-02). */
export async function listArtifacts(limit?: number): Promise<ArtifactsResponse> {
  const suffix = limit === undefined ? "" : `?limit=${encodeURIComponent(String(limit))}`;
  const data = await get(`/api/artifacts${suffix}`);
  if (typeof data !== "object" || data === null || !Array.isArray((data as { artifacts?: unknown }).artifacts)) {
    throw new Error("Unexpected artifacts response shape.");
  }
  const artifacts = (data as { artifacts: unknown[] }).artifacts;
  if (!artifacts.every(isArtifactSummary)) throw new Error("Unexpected artifacts response shape.");
  return { artifacts, hasMore: (data as { hasMore?: unknown }).hasMore === true };
}

/** GET /api/artifacts/:id — Artifact detail with versions and bindings. */
export async function fetchArtifactDetail(id: string): Promise<ArtifactDetail> {
  if (!APP_ID.test(id)) throw new Error("Unexpected Artifact ID shape.");
  const data = await get(`/api/artifacts/${id}`);
  const artifact = (data as { artifact?: unknown }).artifact;
  if (!isArtifactDetail(artifact)) throw new Error("Unexpected artifact response shape.");
  return artifact;
}

/** DELETE /api/artifacts/:id — soft-delete (metadata survives, bytes removed). */
export async function deleteArtifact(id: string): Promise<void> {
  if (!APP_ID.test(id)) throw new Error("Unexpected Artifact ID shape.");
  const token = getToken();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const response = await fetch(`/api/artifacts/${id}`, { method: "DELETE", headers });
  if (!response.ok) throw await parseApiError(response);
}

/** GET /api/artifacts/formats — generated-output format subcapabilities. */
export async function listArtifactFormats(): Promise<ArtifactFormat[]> {
  const data = await get("/api/artifacts/formats");
  const formats = (data as { formats?: unknown }).formats;
  if (!Array.isArray(formats)) throw new Error("Unexpected formats response shape.");
  return formats as ArtifactFormat[];
}

function isConnectionSummary(value: unknown): value is ConnectionSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    typeof v["integrationId"] === "string" &&
    typeof v["integrationName"] === "string" &&
    typeof v["orgId"] === "string" &&
    (v["displayName"] === null || typeof v["displayName"] === "string") &&
    typeof v["endpoint"] === "string" &&
    typeof v["enabled"] === "boolean" &&
    (v["managedBy"] === null || typeof v["managedBy"] === "string") &&
    (v["ownerKind"] === "managed" || v["ownerKind"] === "loose") &&
    Array.isArray(v["secretsRequired"]) &&
    Array.isArray(v["secretsProvisioned"])
  );
}

function isNotification(value: unknown): value is AppNotification {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    typeof v["orgId"] === "string" &&
    typeof v["userId"] === "string" &&
    (v["scope"] === "personal" || v["scope"] === "org") &&
    typeof v["category"] === "string" &&
    typeof v["title"] === "string" &&
    (v["body"] === null || typeof v["body"] === "string") &&
    typeof v["status"] === "string" &&
    (v["progressPercent"] === null || typeof v["progressPercent"] === "number") &&
    "detail" in v &&
    typeof v["createdAt"] === "string" &&
    typeof v["updatedAt"] === "string" &&
    (v["dismissedAt"] === null || typeof v["dismissedAt"] === "string")
  );
}

function isNotificationsResponse(value: unknown): value is NotificationsResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v["notifications"]) && (v["notifications"] as unknown[]).every(isNotification);
}

/** GET /api/notifications — operational inbox (own personal + same-org rows). */
export async function listNotifications(limit?: number): Promise<NotificationsResponse> {
  const suffix = limit === undefined ? "" : `?limit=${encodeURIComponent(String(limit))}`;
  const data = await get(`/api/notifications${suffix}`);
  if (!isNotificationsResponse(data)) throw new Error("Unexpected notifications response shape.");
  return data;
}

/** GET /api/notifications/:id — one notification (owner-only for personal rows). */
export async function fetchNotification(id: string): Promise<AppNotification> {
  if (!APP_ID.test(id)) throw new Error("Unexpected Notification ID shape.");
  const data = await get(`/api/notifications/${id}`);
  const notification = (data as { notification?: unknown }).notification;
  if (!isNotification(notification)) throw new Error("Unexpected notification response shape.");
  return notification;
}

/** DELETE /api/notifications/:id — dismiss (owner-only for personal rows). */
export async function dismissNotification(id: string): Promise<void> {
  if (!APP_ID.test(id)) throw new Error("Unexpected Notification ID shape.");
  const token = getToken();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const response = await fetch(`/api/notifications/${id}`, { method: "DELETE", headers });
  if (!response.ok) throw await parseApiError(response);
}

/** GET /api/integrations — portable definitions (no org state, no secrets). */
export async function listIntegrations(): Promise<IntegrationsResponse> {
  const data = await get("/api/integrations");
  if (typeof data !== "object" || data === null || !Array.isArray((data as { integrations?: unknown }).integrations)) {
    throw new Error("Unexpected integrations response shape.");
  }
  const integrations = (data as { integrations: unknown[] }).integrations;
  if (!integrations.every(isIntegrationSummary)) throw new Error("Unexpected integrations response shape.");
  return { integrations };
}

/** GET /api/connections — this Organization's mappings (no secret values). */
export async function listConnections(): Promise<ConnectionsResponse> {
  const data = await get("/api/connections");
  if (typeof data !== "object" || data === null || !Array.isArray((data as { connections?: unknown }).connections)) {
    throw new Error("Unexpected connections response shape.");
  }
  const connections = (data as { connections: unknown[] }).connections;
  if (!connections.every(isConnectionSummary)) throw new Error("Unexpected connections response shape.");
  return { connections };
}

export interface ConnectionWrite {
  integrationId: string;
  config: Record<string, string>;
  displayName?: string | null;
  enabled?: boolean;
}

/** POST /api/connections — create a loose mapping (non-secret config only). */
export async function createConnection(write: ConnectionWrite): Promise<ConnectionSummary> {
  if (!INTEGRATION_ID.test(write.integrationId)) throw new Error("Unexpected Integration ID shape.");
  const data = await postJson("/api/connections", {
    integrationId: write.integrationId,
    config: write.config,
    ...(write.displayName === undefined ? {} : { displayName: write.displayName }),
    ...(write.enabled === undefined ? {} : { enabled: write.enabled }),
  });
  const connection = (data as { connection?: unknown }).connection;
  if (!isConnectionSummary(connection)) throw new Error("Unexpected connection response shape.");
  return connection;
}

/** PUT /api/connections/:id — update a loose mapping (managed rows refuse). */
export async function updateConnection(
  integrationId: string,
  patch: { config?: Record<string, string>; displayName?: string | null; enabled?: boolean },
): Promise<ConnectionSummary> {
  if (!INTEGRATION_ID.test(integrationId)) throw new Error("Unexpected Integration ID shape.");
  const data = await putJson(`/api/connections/${integrationId}`, patch);
  const connection = (data as { connection?: unknown }).connection;
  if (!isConnectionSummary(connection)) throw new Error("Unexpected connection response shape.");
  return connection;
}

/** DELETE /api/connections/:id — delete a loose mapping. */
export async function deleteConnection(integrationId: string): Promise<void> {
  if (!INTEGRATION_ID.test(integrationId)) throw new Error("Unexpected Integration ID shape.");
  const token = getToken();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const response = await fetch(`/api/connections/${integrationId}`, { method: "DELETE", headers });
  if (!response.ok) throw await parseApiError(response);
}

/** POST /api/connections/:id/test — read-only connectivity test. */
export async function testConnection(integrationId: string): Promise<ConnectionTestResponse> {
  if (!INTEGRATION_ID.test(integrationId)) throw new Error("Unexpected Integration ID shape.");
  const data = await postJson(`/api/connections/${integrationId}/test`, {});
  const test = (data as { test?: unknown }).test;
  if (typeof test !== "object" || test === null || typeof (test as { ok?: unknown }).ok !== "boolean") {
    throw new Error("Unexpected connection test response shape.");
  }
  return { test: test as ConnectionTestResponse["test"] };
}

function isAiProfileSummary(value: unknown): value is AiProfileSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    typeof v["name"] === "string" &&
    typeof v["connectionId"] === "string" &&
    typeof v["integrationId"] === "string" &&
    typeof v["integrationName"] === "string" &&
    typeof v["enabledForChat"] === "boolean" &&
    typeof v["capabilities"] === "object" &&
    v["capabilities"] !== null &&
    (v["capabilityState"] === "unknown" ||
      v["capabilityState"] === "supported" ||
      v["capabilityState"] === "unsupported") &&
    (v["openaiTransport"] === null || typeof v["openaiTransport"] === "string") &&
    typeof v["createdAt"] === "string" &&
    typeof v["updatedAt"] === "string"
  );
}

function isAiAssignmentSummary(value: unknown): value is AiAssignmentSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["key"] === "string" &&
    (v["profile"] === null || isAiProfileSummary(v["profile"])) &&
    (v["updatedAt"] === null || typeof v["updatedAt"] === "string")
  );
}

function isAiEmbeddingSummary(value: unknown): value is AiEmbeddingSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["connectionId"] === "string" &&
    typeof v["integrationId"] === "string" &&
    typeof v["integrationName"] === "string" &&
    (v["dimensions"] === null || typeof v["dimensions"] === "number") &&
    typeof v["updatedAt"] === "string"
  );
}

/** GET /api/ai/profiles — model profile identities (never model ids or keys). */
export async function listAiProfiles(): Promise<AiProfilesResponse> {
  const data = await get("/api/ai/profiles");
  if (typeof data !== "object" || data === null || !Array.isArray((data as { profiles?: unknown }).profiles)) {
    throw new Error("Unexpected AI profiles response shape.");
  }
  const profiles = (data as { profiles: unknown[] }).profiles;
  if (!profiles.every(isAiProfileSummary)) throw new Error("Unexpected AI profiles response shape.");
  return { profiles };
}

/** GET /api/ai/assignments — the six capability keys with mapped identities. */
export async function listAiAssignments(): Promise<AiAssignmentsResponse> {
  const data = await get("/api/ai/assignments");
  if (typeof data !== "object" || data === null || !Array.isArray((data as { assignments?: unknown }).assignments)) {
    throw new Error("Unexpected AI assignments response shape.");
  }
  const assignments = (data as { assignments: unknown[] }).assignments;
  if (!assignments.every(isAiAssignmentSummary)) throw new Error("Unexpected AI assignments response shape.");
  return { assignments };
}

const AI_ASSIGNMENT_KEY = /^(primary|summarization|tuning|image_generation|video_generation|chat_default)$/;

/** PUT /api/ai/assignments/:key — set (profile id) or clear (null); the
 * server rejects clearing primary/chat_default. Admin-gated. */
export async function setAiAssignment(key: string, profileId: string | null): Promise<AiAssignmentResponse> {
  if (!AI_ASSIGNMENT_KEY.test(key)) throw new Error("Unexpected AI assignment key shape.");
  if (profileId !== null && !INTEGRATION_ID.test(profileId)) throw new Error("Unexpected AI profile ID shape.");
  const data = await putJson(`/api/ai/assignments/${key}`, { profileId });
  const assignment = (data as { assignment?: unknown }).assignment;
  if (!isAiAssignmentSummary(assignment)) throw new Error("Unexpected AI assignment response shape.");
  return { assignment };
}

/** GET /api/ai/resolve/:key — fail-closed read-only resolution. */
export async function resolveAiAssignment(key: string): Promise<AiResolutionResponse> {
  if (!AI_ASSIGNMENT_KEY.test(key)) throw new Error("Unexpected AI assignment key shape.");
  const data = await get(`/api/ai/resolve/${key}`);
  const resolution = (data as { resolution?: unknown }).resolution;
  if (
    typeof resolution !== "object" ||
    resolution === null ||
    typeof (resolution as { key?: unknown }).key !== "string" ||
    !isAiProfileSummary((resolution as { profile?: unknown }).profile)
  ) {
    throw new Error("Unexpected AI resolution response shape.");
  }
  return { resolution: resolution as AiResolutionResponse["resolution"] };
}

/** GET /api/ai/embedding — embedding singleton identity (or null). */
export async function getAiEmbedding(): Promise<AiEmbeddingResponse> {
  const data = await get("/api/ai/embedding");
  const embedding = (data as { embedding?: unknown }).embedding;
  if (embedding !== null && !isAiEmbeddingSummary(embedding)) {
    throw new Error("Unexpected AI embedding response shape.");
  }
  return { embedding };
}

/** GET /api/ai/behavior — behavior row (or null when unconfigured). */
export async function getAiBehavior(): Promise<AiBehaviorResponse> {
  const data = await get("/api/ai/behavior");
  const behavior = (data as { behavior?: unknown }).behavior;
  if (
    behavior !== null &&
    (typeof behavior !== "object" ||
      behavior === null ||
      typeof (behavior as { defaultSystemPrompt?: unknown }).defaultSystemPrompt !== "string" ||
      typeof (behavior as { updatedAt?: unknown }).updatedAt !== "string")
  ) {
    throw new Error("Unexpected AI behavior response shape.");
  }
  return { behavior: behavior as AiBehaviorResponse["behavior"] };
}

const FORM_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const STABLE_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Closed form field type set (mirrors FORM_FIELD_TYPES in src/forms.ts;
 * duplicated rather than imported so the browser bundle never depends on
 * Worker domain modules; drift is pinned by test/form-ui.test.tsx). */
const FORM_FIELD_TYPES = [
  "text",
  "number",
  "boolean",
  "email",
  "date",
  "time",
  "datetime",
  "select",
  "multiselect",
  "textarea",
  "url",
  "tel",
  "file",
  "hidden",
  "heading",
  "paragraph",
  "divider",
] as const;

function isFormFieldDef(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["name"] === "string" &&
    typeof v["type"] === "string" &&
    (FORM_FIELD_TYPES as readonly string[]).includes(v["type"] as string) &&
    typeof v["required"] === "boolean" &&
    typeof v["maxLength"] === "number"
  );
}

function checkFormName(name: string): void {
  if (!FORM_NAME.test(name)) throw new Error("Unexpected form name shape.");
}

function isFormSummary(value: unknown): value is FormSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    STABLE_UUID.test(v["id"]) &&
    typeof v["name"] === "string" &&
    FORM_NAME.test(v["name"]) &&
    typeof v["sagaId"] === "string" &&
    STABLE_UUID.test(v["sagaId"])
  );
}

function isFormDetail(value: unknown): value is FormDetail {
  if (!isFormSummary(value)) return false;
  const v = value as unknown as Record<string, unknown>;
  return (
    Array.isArray(v["fields"]) &&
    (v["fields"] as unknown[]).every(isFormFieldDef) &&
    typeof v["allowPrefill"] === "boolean" &&
    (v["title"] === undefined || typeof v["title"] === "string") &&
    (v["description"] === undefined || typeof v["description"] === "string")
  );
}

/** GET /api/forms — org-scoped form summaries (FORM-02 designer list). */
export async function listForms(): Promise<FormsResponse> {
  const data = await get("/api/forms");
  if (typeof data !== "object" || data === null || !Array.isArray((data as { forms?: unknown }).forms)) {
    throw new Error("Unexpected forms response shape.");
  }
  const forms = (data as { forms: unknown[] }).forms;
  if (!forms.every(isFormSummary)) throw new Error("Unexpected forms response shape.");
  return { forms };
}

/** GET /api/forms/:name — one declaration (server-authoritative fields). */
export async function fetchFormDetail(name: string): Promise<FormDetail> {
  checkFormName(name);
  const data = await get(`/api/forms/${name}`);
  const form = (data as { form?: unknown }).form;
  if (!isFormDetail(form)) throw new Error("Unexpected form response shape.");
  return form;
}

/** POST /api/forms — create a declaration (400 INVALID_FORM on bad fields). */
export async function createForm(body: {
  name: string;
  sagaId: string;
  title?: string;
  description?: string;
  allowPrefill?: boolean;
  fields: unknown[];
}): Promise<FormDetail> {
  checkFormName(body.name);
  const data = await postJson("/api/forms", body);
  const form = (data as { form?: unknown }).form;
  if (!isFormDetail(form)) throw new Error("Unexpected form response shape.");
  return form;
}

/** PUT /api/forms/:name — replace a declaration wholesale. */
export async function updateForm(
  name: string,
  body: { sagaId: string; title?: string; description?: string; allowPrefill?: boolean; fields: unknown[] },
): Promise<FormDetail> {
  checkFormName(name);
  const data = await putJson(`/api/forms/${name}`, body);
  const form = (data as { form?: unknown }).form;
  if (!isFormDetail(form)) throw new Error("Unexpected form response shape.");
  return form;
}

/** DELETE /api/forms/:name — delete a declaration. */
export async function deleteForm(name: string): Promise<void> {
  checkFormName(name);
  const token = getToken();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const response = await fetch(`/api/forms/${name}`, { method: "DELETE", headers });
  if (!response.ok) throw await parseApiError(response);
}

/** POST /api/forms/:name/startup — mint a session-bound handle plus the
 * resolved snapshot (defaults, opt-in prefill, provider options). */
export async function startFormSession(name: string, prefill?: Record<string, unknown>): Promise<FormStartupResponse> {
  checkFormName(name);
  const data = await postJson(`/api/forms/${name}/startup`, prefill === undefined ? {} : { prefill });
  const body = data as { form?: unknown; handle?: unknown; expiresAt?: unknown; snapshot?: unknown; options?: unknown };
  if (
    typeof body.form !== "string" ||
    typeof body.handle !== "string" ||
    typeof body.expiresAt !== "string" ||
    typeof body.snapshot !== "object" ||
    body.snapshot === null ||
    typeof body.options !== "object" ||
    body.options === null
  ) {
    throw new Error("Unexpected form startup response shape.");
  }
  return {
    form: body.form,
    handle: body.handle,
    expiresAt: body.expiresAt,
    snapshot: body.snapshot as Record<string, unknown>,
    options: body.options as Record<string, string[]>,
  };
}

/** GET /api/forms/:name/providers — resolved select options (denied tables
 * yield empty lists with per-field errors, never a leak). */
export async function fetchFormProviders(name: string): Promise<FormProvidersResponse> {
  checkFormName(name);
  const data = await get(`/api/forms/${name}/providers`);
  const body = data as { form?: unknown; options?: unknown; errors?: unknown };
  if (typeof body.form !== "string" || typeof body.options !== "object" || body.options === null) {
    throw new Error("Unexpected form providers response shape.");
  }
  return {
    form: body.form,
    options: body.options as Record<string, string[]>,
    errors: (body.errors ?? {}) as Record<string, string>,
  };
}

/** POST /api/forms/:name/submit — consume a startup handle and submit
 * (immediate dispatch or { scheduleAt } deferred receipt). */
export async function submitForm(
  name: string,
  body: { handle: string; values?: Record<string, unknown>; scheduleAt?: string },
  idempotencyKey: string,
): Promise<FormSubmitResponse> {
  checkFormName(name);
  const token = getToken();
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Idempotency-Key": idempotencyKey,
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const response = await fetch(`/api/forms/${name}/submit`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await parseApiError(response);
  const data = (await response.json()) as {
    form?: unknown;
    executionId?: unknown;
    replayed?: unknown;
    statusUrl?: unknown;
    scheduled?: unknown;
    scheduleAt?: unknown;
  };
  if (typeof data.form !== "string" || typeof data.executionId !== "string" || typeof data.statusUrl !== "string") {
    throw new Error("Unexpected form submit response shape.");
  }
  return {
    form: data.form,
    executionId: data.executionId,
    replayed: data.replayed === true,
    statusUrl: data.statusUrl,
    ...(data.scheduled === true ? { scheduled: true as const } : {}),
    ...(typeof data.scheduleAt === "string" ? { scheduleAt: data.scheduleAt } : {}),
  };
}

function isEmbedGrantSummary(value: unknown): value is EmbedGrantSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    STABLE_UUID.test(v["id"]) &&
    typeof v["formName"] === "string" &&
    FORM_NAME.test(v["formName"]) &&
    Array.isArray(v["allowedOrigins"]) &&
    (v["allowedOrigins"] as unknown[]).every((entry) => typeof entry === "string") &&
    typeof v["fingerprint"] === "string" &&
    typeof v["enabled"] === "boolean" &&
    (v["expiresAt"] === null || typeof v["expiresAt"] === "string") &&
    typeof v["createdAt"] === "string" &&
    (v["rotatedAt"] === null || typeof v["rotatedAt"] === "string") &&
    (v["lastUsedAt"] === null || typeof v["lastUsedAt"] === "string")
  );
}

function checkGrantId(grantId: string): void {
  if (!STABLE_UUID.test(grantId)) throw new Error("Unexpected embed grant ID shape.");
}

/** GET /api/forms/:name/embeds — admin grant inventory (summaries only,
 * never secret material). */
export async function listFormEmbeds(name: string): Promise<EmbedGrantsResponse> {
  checkFormName(name);
  const data = await get(`/api/forms/${name}/embeds`);
  const embeds = (data as { embeds?: unknown }).embeds;
  if (!Array.isArray(embeds) || !embeds.every(isEmbedGrantSummary)) {
    throw new Error("Unexpected embed grants response shape.");
  }
  return { embeds };
}

/** POST /api/forms/:name/embeds — issue a grant. The raw secret renders
 * once from this response and is never fetched again. */
export async function createFormEmbed(
  name: string,
  body: { allowedOrigins: string[]; expiresAt?: string | null },
): Promise<EmbedGrantIssuedResponse> {
  checkFormName(name);
  const data = await postJson(`/api/forms/${name}/embeds`, body);
  const grant = (data as { grant?: unknown }).grant;
  const secret = (data as { secret?: unknown }).secret;
  if (!isEmbedGrantSummary(grant) || typeof secret !== "string") {
    throw new Error("Unexpected embed grant response shape.");
  }
  return { grant, secret };
}

/** POST /api/forms/:name/embeds/:id/rotate — fresh secret plus a
 * re-fingerprint against the live declaration (secret shown once). */
export async function rotateFormEmbed(name: string, grantId: string): Promise<EmbedGrantIssuedResponse> {
  checkFormName(name);
  checkGrantId(grantId);
  const data = await postJson(`/api/forms/${name}/embeds/${grantId}/rotate`, {});
  const grant = (data as { grant?: unknown }).grant;
  const secret = (data as { secret?: unknown }).secret;
  if (!isEmbedGrantSummary(grant) || typeof secret !== "string") {
    throw new Error("Unexpected embed grant response shape.");
  }
  return { grant, secret };
}

/** POST /api/forms/:name/embeds/:id/revoke — terminal disable. */
export async function revokeFormEmbed(name: string, grantId: string): Promise<EmbedGrantResponse> {
  checkFormName(name);
  checkGrantId(grantId);
  const data = await postJson(`/api/forms/${name}/embeds/${grantId}/revoke`, {});
  const grant = (data as { grant?: unknown }).grant;
  if (!isEmbedGrantSummary(grant)) throw new Error("Unexpected embed grant response shape.");
  return { grant };
}

function isAppEmbedGrantSummary(value: unknown): value is AppEmbedGrantSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    STABLE_UUID.test(v["id"]) &&
    typeof v["appSlug"] === "string" &&
    Array.isArray(v["allowedOrigins"]) &&
    (v["allowedOrigins"] as unknown[]).every((entry) => typeof entry === "string") &&
    typeof v["fingerprint"] === "string" &&
    typeof v["enabled"] === "boolean" &&
    (v["expiresAt"] === null || typeof v["expiresAt"] === "string") &&
    typeof v["createdAt"] === "string" &&
    (v["rotatedAt"] === null || typeof v["rotatedAt"] === "string") &&
    (v["lastUsedAt"] === null || typeof v["lastUsedAt"] === "string")
  );
}

function checkAppId(appId: string): void {
  if (!STABLE_UUID.test(appId)) throw new Error("Unexpected app ID shape.");
}

/** GET /api/apps/:id/embeds — admin grant inventory (summaries only,
 * never secret material). */
export async function listAppEmbeds(appId: string): Promise<AppEmbedGrantsResponse> {
  checkAppId(appId);
  const data = await get(`/api/apps/${appId}/embeds`);
  const embeds = (data as { embeds?: unknown }).embeds;
  if (!Array.isArray(embeds) || !embeds.every(isAppEmbedGrantSummary)) {
    throw new Error("Unexpected app embed grants response shape.");
  }
  return { embeds };
}

/** POST /api/apps/:id/embeds — issue a grant. The raw secret renders
 * once from this response and is never fetched again. */
export async function createAppEmbed(
  appId: string,
  body: { allowedOrigins: string[]; expiresAt?: string | null },
): Promise<AppEmbedGrantIssuedResponse> {
  checkAppId(appId);
  const data = await postJson(`/api/apps/${appId}/embeds`, body);
  const grant = (data as { grant?: unknown }).grant;
  const secret = (data as { secret?: unknown }).secret;
  if (!isAppEmbedGrantSummary(grant) || typeof secret !== "string") {
    throw new Error("Unexpected app embed grant response shape.");
  }
  return { grant, secret };
}

/** POST /api/apps/:id/embeds/:id/rotate — fresh secret plus a
 * re-fingerprint against the live deployment (secret shown once). */
export async function rotateAppEmbed(appId: string, grantId: string): Promise<AppEmbedGrantIssuedResponse> {
  checkAppId(appId);
  checkGrantId(grantId);
  const data = await postJson(`/api/apps/${appId}/embeds/${grantId}/rotate`, {});
  const grant = (data as { grant?: unknown }).grant;
  const secret = (data as { secret?: unknown }).secret;
  if (!isAppEmbedGrantSummary(grant) || typeof secret !== "string") {
    throw new Error("Unexpected app embed grant response shape.");
  }
  return { grant, secret };
}

/** POST /api/apps/:id/embeds/:id/revoke — terminal disable. */
export async function revokeAppEmbed(appId: string, grantId: string): Promise<AppEmbedGrantResponse> {
  checkAppId(appId);
  checkGrantId(grantId);
  const data = await postJson(`/api/apps/${appId}/embeds/${grantId}/revoke`, {});
  const grant = (data as { grant?: unknown }).grant;
  if (!isAppEmbedGrantSummary(grant)) throw new Error("Unexpected app embed grant response shape.");
  return { grant };
}

function isPublicationSummary(value: unknown): value is FormPublicationSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    STABLE_UUID.test(v["id"]) &&
    typeof v["formName"] === "string" &&
    FORM_NAME.test(v["formName"]) &&
    typeof v["honeypotField"] === "string" &&
    typeof v["fingerprint"] === "string" &&
    typeof v["enabled"] === "boolean" &&
    typeof v["stale"] === "boolean" &&
    typeof v["createdAt"] === "string" &&
    (v["reviewedAt"] === null || typeof v["reviewedAt"] === "string") &&
    (v["lastUsedAt"] === null || typeof v["lastUsedAt"] === "string")
  );
}

/** GET /api/forms/:name/publication — admin publication summary (or null
 * when never published). No secret material exists in this class. */
export async function getFormPublication(name: string): Promise<FormPublicationResponse> {
  checkFormName(name);
  const data = await get(`/api/forms/${name}/publication`);
  const publication = (data as { publication?: unknown }).publication;
  if (publication !== null && !isPublicationSummary(publication)) {
    throw new Error("Unexpected publication response shape.");
  }
  return { publication };
}

/** POST /api/forms/:name/publication — publish (or re-publish, healing
 * drift) with an optional honeypotField. */
export async function publishForm(name: string, body: { honeypotField?: string }): Promise<FormPublicationResponse> {
  checkFormName(name);
  const data = await postJson(`/api/forms/${name}/publication`, body);
  const publication = (data as { publication?: unknown }).publication;
  if (!isPublicationSummary(publication)) throw new Error("Unexpected publication response shape.");
  return { publication };
}

/** DELETE /api/forms/:name/publication — block the publication. */
export async function unpublishForm(name: string): Promise<FormPublicationResponse> {
  checkFormName(name);
  const data = await deleteJson(`/api/forms/${name}/publication`);
  const publication = (data as { publication?: unknown }).publication;
  if (publication !== null && !isPublicationSummary(publication)) {
    throw new Error("Unexpected publication response shape.");
  }
  return { publication };
}

/** POST /api/forms/:name/publication/review — re-bind the publication to
 * the live declaration after a capability change. */
export async function reviewPublication(name: string): Promise<FormPublicationResponse> {
  checkFormName(name);
  const data = await postJson(`/api/forms/${name}/publication/review`, { approve: true });
  const publication = (data as { publication?: unknown }).publication;
  if (!isPublicationSummary(publication)) throw new Error("Unexpected publication response shape.");
  return { publication };
}

const ORG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isBrandingView(value: unknown): value is BrandingView {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const logo = v["logo"] as Record<string, unknown> | null;
  return (
    typeof v["orgId"] === "string" &&
    typeof v["appName"] === "string" &&
    typeof v["primaryColor"] === "string" &&
    typeof v["accentColor"] === "string" &&
    (logo === null ||
      (typeof logo === "object" &&
        typeof logo["contentType"] === "string" &&
        typeof logo["sizeBytes"] === "number" &&
        typeof logo["sha256"] === "string")) &&
    (v["updatedAt"] === null || typeof v["updatedAt"] === "string")
  );
}

function isProfileView(value: unknown): value is ProfileView {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const avatar = v["avatar"] as Record<string, unknown> | null;
  return (
    typeof v["orgId"] === "string" &&
    typeof v["userId"] === "string" &&
    typeof v["displayName"] === "string" &&
    (v["theme"] === "light" || v["theme"] === "dark" || v["theme"] === "system") &&
    (avatar === null ||
      (typeof avatar === "object" &&
        typeof avatar["contentType"] === "string" &&
        typeof avatar["sizeBytes"] === "number" &&
        typeof avatar["sha256"] === "string")) &&
    (v["updatedAt"] === null || typeof v["updatedAt"] === "string")
  );
}

/** GET /api/branding — Organization branding for this Organization (UX-01). */
export async function fetchBranding(): Promise<BrandingResponse> {
  const data = await get("/api/branding");
  const branding = (data as { branding?: unknown }).branding;
  if (!isBrandingView(branding)) throw new Error("Unexpected branding response shape.");
  return { branding };
}

/** GET /api/branding/public/:orgId — safe public read, no token sent. */
export async function fetchPublicBranding(orgId: string): Promise<BrandingResponse> {
  if (!ORG_ID.test(orgId)) throw new Error("Unexpected Organization ID shape.");
  const response = await fetch(`/api/branding/public/${orgId}`, { headers: { Accept: "application/json" } });
  if (!response.ok) throw await parseApiError(response);
  const branding = ((await response.json()) as { branding?: unknown }).branding;
  if (!isBrandingView(branding)) throw new Error("Unexpected branding response shape.");
  return { branding };
}

/** PUT /api/branding — admin-only name/color write (partial merge). */
export async function updateBranding(body: {
  appName?: string;
  primaryColor?: string;
  accentColor?: string;
}): Promise<BrandingResponse> {
  const data = await putJson("/api/branding", body);
  const branding = (data as { branding?: unknown }).branding;
  if (!isBrandingView(branding)) throw new Error("Unexpected branding response shape.");
  return { branding };
}

/** POST /api/branding/reset — admin-only reset to static defaults. */
export async function resetBranding(): Promise<BrandingResponse> {
  const data = await postJson("/api/branding/reset", {});
  const branding = (data as { branding?: unknown }).branding;
  if (!isBrandingView(branding)) throw new Error("Unexpected branding response shape.");
  return { branding };
}

async function putImageBytes(path: string, bytes: Uint8Array, contentType: string): Promise<unknown> {
  const token = getToken();
  const headers: Record<string, string> = { Accept: "application/json", "Content-Type": contentType };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const response = await fetch(path, { method: "PUT", headers, body: bytes as Uint8Array<ArrayBuffer> });
  if (!response.ok) throw await parseApiError(response);
  return (await response.json()) as unknown;
}

/** PUT /api/branding/logo — admin-only logo upload (image bytes). */
export async function uploadLogo(bytes: Uint8Array, contentType: string): Promise<BrandingResponse> {
  const data = await putImageBytes("/api/branding/logo", bytes, contentType);
  const branding = (data as { branding?: unknown }).branding;
  if (!isBrandingView(branding)) throw new Error("Unexpected branding response shape.");
  return { branding };
}

/** DELETE /api/branding/logo — admin-only logo removal. */
export async function deleteLogo(): Promise<BrandingResponse> {
  const data = await deleteJson("/api/branding/logo");
  const branding = (data as { branding?: unknown }).branding;
  if (!isBrandingView(branding)) throw new Error("Unexpected branding response shape.");
  return { branding };
}

/** GET /api/profile — the caller's own profile (UX-01). */
export async function fetchProfile(): Promise<ProfileResponse> {
  const data = await get("/api/profile");
  const profile = (data as { profile?: unknown }).profile;
  if (!isProfileView(profile)) throw new Error("Unexpected profile response shape.");
  return { profile };
}

/** PUT /api/profile — own display name / theme write (partial merge). */
export async function updateProfile(body: { displayName?: string; theme?: ProfileTheme }): Promise<ProfileResponse> {
  const data = await putJson("/api/profile", body);
  const profile = (data as { profile?: unknown }).profile;
  if (!isProfileView(profile)) throw new Error("Unexpected profile response shape.");
  return { profile };
}

/** PUT /api/profile/avatar — own avatar upload (image bytes). */
export async function uploadAvatar(bytes: Uint8Array, contentType: string): Promise<ProfileResponse> {
  const data = await putImageBytes("/api/profile/avatar", bytes, contentType);
  const profile = (data as { profile?: unknown }).profile;
  if (!isProfileView(profile)) throw new Error("Unexpected profile response shape.");
  return { profile };
}

/** DELETE /api/profile/avatar — own avatar removal. */
export async function deleteAvatar(): Promise<ProfileResponse> {
  const data = await deleteJson("/api/profile/avatar");
  const profile = (data as { profile?: unknown }).profile;
  if (!isProfileView(profile)) throw new Error("Unexpected profile response shape.");
  return { profile };
}

/** GET /api/profile/avatar — own avatar bytes through the authorized route. */
export async function downloadAvatar(): Promise<Blob> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const response = await fetch("/api/profile/avatar", { headers });
  if (!response.ok) throw await parseApiError(response);
  return await response.blob();
}

// Tool and external MCP administration (issue #559). Read-only discovery,
// catalog, health, and safe management over the existing Worker routes.
// Secret-free by server construction: no function here accepts, posts, or
// returns a credential value. Client-secret provisioning, OAuth authorize,
// and consent callback stay outside this UI (the server owns those flows).

const TOOL_NAME = /^[a-z][a-z0-9_]{2,63}$/;
const MCP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VENDOR_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;

function checkToolName(name: string): void {
  if (!TOOL_NAME.test(name)) throw new Error("Unexpected tool name shape.");
}

function checkMcpId(id: string, label: string): void {
  if (!MCP_ID.test(id)) throw new Error(`Unexpected ${label} ID shape.`);
}

function isToolSummary(value: unknown): value is ToolSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["name"] === "string" &&
    typeof v["sagaId"] === "string" &&
    typeof v["sagaRevision"] === "string" &&
    typeof v["description"] === "string" &&
    typeof v["enabled"] === "boolean"
  );
}

/** GET /api/tools — enrolled live tools for this Organization. */
export async function listTools(): Promise<ToolsResponse> {
  const data = await get("/api/tools");
  if (typeof data !== "object" || data === null || !Array.isArray((data as { tools?: unknown }).tools)) {
    throw new Error("Unexpected tools response shape.");
  }
  const tools = (data as { tools: unknown[] }).tools;
  if (!tools.every(isToolSummary)) throw new Error("Unexpected tools response shape.");
  return { tools };
}

/** POST /api/tools — enroll one Saga as a tool (sagaId + optional name/description). */
export async function enrollTool(body: { sagaId: string; name?: string; description?: string }): Promise<ToolSummary> {
  if (!MCP_ID.test(body.sagaId)) throw new Error("Unexpected Saga ID shape.");
  const data = await postJson("/api/tools", body);
  const tool = (data as { tool?: unknown }).tool;
  if (!isToolSummary(tool)) throw new Error("Unexpected tool response shape.");
  return tool;
}

/** POST /api/tools/:name/disable — disable one enrollment (never deletes). */
export async function disableTool(name: string): Promise<ToolSummary> {
  checkToolName(name);
  const data = await postJson(`/api/tools/${name}/disable`, {});
  const tool = (data as { tool?: unknown }).tool;
  if (!isToolSummary(tool)) throw new Error("Unexpected tool response shape.");
  return tool;
}

function isOpenapiOperation(value: unknown): value is OpenapiOperation {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["operationId"] === "string" &&
    typeof v["method"] === "string" &&
    typeof v["path"] === "string" &&
    typeof v["summary"] === "string" &&
    typeof v["risk"] === "string" &&
    typeof v["deprecated"] === "boolean"
  );
}

/** GET /api/openapi/search — progressive discovery over the pinned Halo contract. */
export async function searchOpenapiOperations(query: string): Promise<OpenapiSearchResponse> {
  const params = new URLSearchParams({ integration: "halo" });
  if (query) params.set("q", query);
  const data = await get(`/api/openapi/search?${params.toString()}`);
  if (typeof data !== "object" || data === null) throw new Error("Unexpected OpenAPI search response shape.");
  const v = data as { integration?: unknown; operations?: unknown };
  if (v["integration"] !== "halo" || !Array.isArray(v["operations"])) {
    throw new Error("Unexpected OpenAPI search response shape.");
  }
  if (!(v["operations"] as unknown[]).every(isOpenapiOperation)) {
    throw new Error("Unexpected OpenAPI search response shape.");
  }
  return { integration: "halo", operations: v["operations"] as OpenapiOperation[] };
}

/** GET /api/openapi/operations/:operationId — inspect one pinned operation. */
export async function inspectOpenapiOperation(operationId: string): Promise<OpenapiOperation> {
  if (!VENDOR_TOOL_NAME.test(operationId)) throw new Error("Unexpected operation ID shape.");
  const data = await get(`/api/openapi/operations/${operationId}`);
  const operation = (data as { operation?: unknown }).operation;
  if (!isOpenapiOperation(operation)) throw new Error("Unexpected OpenAPI operation response shape.");
  return operation;
}

function isMcpServerSummary(value: unknown): value is McpServerSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    typeof v["name"] === "string" &&
    typeof v["serverUrl"] === "string" &&
    (v["orgId"] === null || typeof v["orgId"] === "string") &&
    typeof v["providerFlow"] === "string" &&
    "discoveryMetadata" in v &&
    typeof v["isActive"] === "boolean" &&
    typeof v["createdAt"] === "string" &&
    typeof v["updatedAt"] === "string"
  );
}

/** GET /api/mcp-servers — portable templates (secretless by schema). */
export async function listMcpServers(includeInactive = false): Promise<McpServersResponse> {
  const suffix = includeInactive ? "?include_inactive=1" : "";
  const data = await get(`/api/mcp-servers${suffix}`);
  if (typeof data !== "object" || data === null || !Array.isArray((data as { servers?: unknown }).servers)) {
    throw new Error("Unexpected MCP servers response shape.");
  }
  const servers = (data as { servers: unknown[] }).servers;
  if (!servers.every(isMcpServerSummary)) throw new Error("Unexpected MCP servers response shape.");
  return { servers };
}

/** POST /api/mcp-servers — create a template (admin-only; platform rows need instance admin). */
export async function createMcpServer(body: {
  name: string;
  serverUrl: string;
  orgId?: string | null;
  providerFlow?: string;
}): Promise<McpServerSummary> {
  const data = await postJson("/api/mcp-servers", body);
  const server = (data as { server?: unknown }).server;
  if (!isMcpServerSummary(server)) throw new Error("Unexpected MCP server response shape.");
  return server;
}

/** POST /api/mcp-servers/:id/(enable|disable) — flip the active flag. */
export async function setMcpServerActive(id: string, active: boolean): Promise<McpServerSummary> {
  checkMcpId(id, "MCP server");
  const data = await postJson(`/api/mcp-servers/${id}/${active ? "enable" : "disable"}`, {});
  const server = (data as { server?: unknown }).server;
  if (!isMcpServerSummary(server)) throw new Error("Unexpected MCP server response shape.");
  return server;
}

/** DELETE /api/mcp-servers/:id — soft delete (hard=true destroys). */
export async function deleteMcpServer(id: string, hard = false): Promise<void> {
  checkMcpId(id, "MCP server");
  const token = getToken();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const response = await fetch(`/api/mcp-servers/${id}${hard ? "?hard=true" : ""}`, { method: "DELETE", headers });
  if (!response.ok) throw await parseApiError(response);
}

function isMcpConnectionSummary(value: unknown): value is McpConnectionSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    typeof v["orgId"] === "string" &&
    typeof v["serverId"] === "string" &&
    typeof v["serverName"] === "string" &&
    typeof v["effectiveServerUrl"] === "string" &&
    (v["serverUrlOverride"] === null || typeof v["serverUrlOverride"] === "string") &&
    (v["tokenPath"] === null || typeof v["tokenPath"] === "string") &&
    (v["clientId"] === null || typeof v["clientId"] === "string") &&
    typeof v["clientSecretProvisioned"] === "boolean" &&
    typeof v["providerFlow"] === "string" &&
    typeof v["availableInChat"] === "boolean" &&
    typeof v["availableToAutonomous"] === "boolean" &&
    typeof v["enabled"] === "boolean" &&
    typeof v["createdAt"] === "string" &&
    typeof v["updatedAt"] === "string"
  );
}

/** GET /api/mcp-connections — this Organization's Connections (flags only, never secrets). */
export async function listMcpConnections(): Promise<McpConnectionsResponse> {
  const data = await get("/api/mcp-connections");
  if (typeof data !== "object" || data === null || !Array.isArray((data as { connections?: unknown }).connections)) {
    throw new Error("Unexpected MCP connections response shape.");
  }
  const connections = (data as { connections: unknown[] }).connections;
  if (!connections.every(isMcpConnectionSummary)) throw new Error("Unexpected MCP connections response shape.");
  return { connections };
}

export interface McpConnectionWrite {
  serverId: string;
  serverUrlOverride?: string | null;
  tokenPath?: string | null;
  clientId?: string | null;
  availableInChat?: boolean;
  availableToAutonomous?: boolean;
  enabled?: boolean;
}

/** POST /api/mcp-connections — bind one template to this Organization (admin-only). */
export async function createMcpConnection(write: McpConnectionWrite): Promise<McpConnectionSummary> {
  checkMcpId(write.serverId, "MCP server");
  const data = await postJson("/api/mcp-connections", write);
  const connection = (data as { connection?: unknown }).connection;
  if (!isMcpConnectionSummary(connection)) throw new Error("Unexpected MCP connection response shape.");
  return connection;
}

/** POST /api/mcp-connections/:id — update flags/override (admin-only; no secret fields). */
export async function updateMcpConnection(
  id: string,
  patch: Omit<Partial<McpConnectionWrite>, "serverId">,
): Promise<McpConnectionSummary> {
  checkMcpId(id, "MCP connection");
  const data = await postJson(`/api/mcp-connections/${id}`, patch);
  const connection = (data as { connection?: unknown }).connection;
  if (!isMcpConnectionSummary(connection)) throw new Error("Unexpected MCP connection response shape.");
  return connection;
}

/** DELETE /api/mcp-connections/:id — hard-delete the binding (admin-only). */
export async function deleteMcpConnection(id: string): Promise<void> {
  checkMcpId(id, "MCP connection");
  const token = getToken();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const response = await fetch(`/api/mcp-connections/${id}`, { method: "DELETE", headers });
  if (!response.ok) throw await parseApiError(response);
}

function isMcpCatalogTool(value: unknown): value is McpCatalogTool {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["connectionId"] === "string" &&
    typeof v["toolName"] === "string" &&
    typeof v["qualifiedName"] === "string" &&
    typeof v["description"] === "string" &&
    "inputSchema" in v &&
    typeof v["enabled"] === "boolean" &&
    (v["autoDisabledReason"] === null || typeof v["autoDisabledReason"] === "string") &&
    typeof v["syncedAt"] === "string" &&
    typeof v["updatedAt"] === "string"
  );
}

/** GET /api/mcp-connections/:id/tools — verbatim per-Connection tool catalog. */
export async function listMcpConnectionTools(connectionId: string): Promise<McpCatalogResponse> {
  checkMcpId(connectionId, "MCP connection");
  const data = await get(`/api/mcp-connections/${connectionId}/tools`);
  if (typeof data !== "object" || data === null || !Array.isArray((data as { tools?: unknown }).tools)) {
    throw new Error("Unexpected MCP catalog response shape.");
  }
  const tools = (data as { tools: unknown[] }).tools;
  if (!tools.every(isMcpCatalogTool)) throw new Error("Unexpected MCP catalog response shape.");
  return { tools };
}

/** POST /api/mcp-connections/:id/refresh-tools — sync the catalog (needs a service credential; admin-only). */
export async function refreshMcpConnectionTools(connectionId: string): Promise<McpRefreshSummary> {
  checkMcpId(connectionId, "MCP connection");
  const data = await postJson(`/api/mcp-connections/${connectionId}/refresh-tools`, {});
  const catalog = (data as { catalog?: unknown }).catalog;
  if (
    typeof catalog !== "object" ||
    catalog === null ||
    typeof (catalog as { total?: unknown }).total !== "number" ||
    typeof (catalog as { enabled?: unknown }).enabled !== "number" ||
    typeof (catalog as { disabled?: unknown }).disabled !== "number"
  ) {
    throw new Error("Unexpected MCP refresh response shape.");
  }
  return catalog as McpRefreshSummary;
}

/** POST /api/mcp-connections/:id/tools/:tool/(enable|disable) — flip one catalog tool (admin-only). */
export async function setMcpCatalogToolEnabled(
  connectionId: string,
  toolName: string,
  enabled: boolean,
): Promise<McpCatalogTool> {
  checkMcpId(connectionId, "MCP connection");
  if (!VENDOR_TOOL_NAME.test(toolName)) throw new Error("Unexpected catalog tool name shape.");
  const data = await postJson(
    `/api/mcp-connections/${connectionId}/tools/${toolName}/${enabled ? "enable" : "disable"}`,
    {},
  );
  const tool = (data as { tool?: unknown }).tool;
  if (!isMcpCatalogTool(tool)) throw new Error("Unexpected MCP catalog tool response shape.");
  return tool;
}

function isMcpConsentState(value: unknown): value is McpConsentState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["connectionId"] === "string" &&
    typeof v["userId"] === "string" &&
    typeof v["orgId"] === "string" &&
    typeof v["scope"] === "string" &&
    typeof v["consentGrantedAt"] === "string" &&
    (v["consentExpiresAt"] === null || typeof v["consentExpiresAt"] === "string") &&
    typeof v["generation"] === "number" &&
    "health" in v
  );
}

/** GET /api/mcp-connections/:id/consent — own non-secret consent state (null when none).
 * OAuth authorize/callback stay outside this UI: this surface reports state
 * only and never implies the browser consent flow is complete. */
export async function getMcpConnectionConsent(connectionId: string): Promise<McpConsentState | null> {
  checkMcpId(connectionId, "MCP connection");
  const data = await get(`/api/mcp-connections/${connectionId}/consent`);
  const consent = (data as { consent?: unknown }).consent;
  if (consent === null || consent === undefined) return null;
  if (!isMcpConsentState(consent)) throw new Error("Unexpected MCP consent response shape.");
  return consent;
}

/** GET /api/auth/me — caller identity plus membership role (UX-01 admin cue).
 * The server enforces every boundary; the role only decides which affordances
 * the settings pages render. A null role means the instance-admin path, which
 * the server gates — never a client-side denial. */
export async function fetchCaller(): Promise<CallerResponse> {
  const data = await get("/api/auth/me");
  const v = data as Record<string, unknown>;
  const caller = v["caller"] as Record<string, unknown> | undefined;
  if (
    typeof caller !== "object" ||
    caller === null ||
    typeof caller["userId"] !== "string" ||
    typeof caller["orgId"] !== "string" ||
    (v["role"] !== null && v["role"] !== "member" && v["role"] !== "admin") ||
    (v["kind"] !== null && v["kind"] !== "ordinary" && v["kind"] !== "external")
  ) {
    throw new Error("Unexpected caller response shape.");
  }
  return data as CallerResponse;
}
