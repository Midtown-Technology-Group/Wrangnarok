// SPDX-License-Identifier: AGPL-3.0
// Adapted from upstream gobifrost/bifrost client/src/lib/api-client.ts
// (reference: vendor/upstream). Structure borrowed; Wrangnarök Bearer fixture only.
//
// Auth: the fixture token is supplied by the operator (localStorage, set via
// the Token field in the UI) and sent as `Authorization: Bearer <token>`.
// Secrets are never bundled in client code.
import { parseApiError } from "./api-error";
import type {
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
  FormDetail,
  FormProvidersResponse,
  FormStartupResponse,
  FormSubmitResponse,
  FormsResponse,
  FormSummary,
  IntegrationsResponse,
  IntegrationSummary,
  SagasResponse,
  SagaSummary,
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
    Array.isArray(v["secretsRequired"])
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
