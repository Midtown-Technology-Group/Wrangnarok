// SPDX-License-Identifier: AGPL-3.0
// Zone Inventory migration (issues #116 MIG-01, #119 MIG-02): read-only
// Cloudflare bearer Actions, re-authored from
// `functions/cloudflare_inventory.py` (bundle `cloudflare-zone-inventory`
// 0.1.0). Two Actions: token verification (one GET) and bounded zone
// inventory (paginated GETs, max 250 zones, 50 per page). Bearer
// `api_token` arrives as a transient secret handle; the account mapping
// arrives as plain args (Connection holds endpoint + org mapping; D1 holds
// no per-tenant secrets per ADR 005). Every vendor call enforces its own
// 20s deadline and surfaces CLOUDFLARE_VENDOR_TIMEOUT for slow or late
// vendors; failSagaExecution classifies it as TimedOut (ADR-033-3, issue #414).
import {
  attributeAuditActor,
  boundedJson,
  classifyAuditEvent,
  CLOUDFLARE_ACCOUNT_ID_PATTERN,
  CLOUDFLARE_API_BASE,
  CLOUDFLARE_AUDIT_LOGS_SUFFIX,
  CLOUDFLARE_INSIGHTS_SUFFIX,
  CLOUDFLARE_INTEGRATION_ID,
  CLOUDFLARE_MAX_ZONES,
  CLOUDFLARE_PAGE_SIZE,
  CLOUDFLARE_POSTURE_MAX_ENTRIES,
  CLOUDFLARE_POSTURE_MAX_PAGES,
  CLOUDFLARE_POSTURE_PAGE_SIZE,
  CLOUDFLARE_TIMEOUT_MS,
  CLOUDFLARE_VERIFY_PATH,
  CLOUDFLARE_ZONES_PATH,
  CLOUDFLARE_ZONE_SETTINGS_SUFFIX,
  CLOUDFLARE_ZONE_SETTING_ALLOWLIST,
  Fault,
  normalizeInsightSeverity,
  object,
  postureBoundedText,
} from "../domain";
import type {
  AuditActorKind,
  AuditEventClass,
  CloudflareAccountRef,
  CloudflareAuditEntry,
  CloudflareAuditResult,
  CloudflareInsightIssue,
  CloudflareInsightsResult,
  CloudflareInventoryInput,
  CloudflareInventoryResult,
  CloudflareVerifyResult,
  CloudflareZoneSummary,
  InsightSeverity,
} from "../domain";
import { assertSafeEndpoint } from "./index";
import { registerExecutionSecrets, scrubTextWithSecrets } from "../secrets";

export const cloudflareIntegration = Object.freeze({ id: CLOUDFLARE_INTEGRATION_ID, name: "cloudflare" });

export interface CloudflareConnection {
  endpoint: string;
}

/** Credential handle as the Saga sees it: presence is NOT guaranteed. The
 * Action owns the presence check below, so Saga steps never branch on
 * credentials — they pass the handle through the Integration boundary and
 * map the resulting Fault like any other downstream error. */
export interface CloudflareSecrets {
  readonly apiToken?: string;
}

function cleanMessage(message: string, registered: readonly string[]): string {
  return scrubTextWithSecrets(message, registered);
}

function requireToken(secrets: CloudflareSecrets): string {
  const token = secrets.apiToken;
  if (typeof token !== "string" || token.length === 0) {
    throw new Fault(502, "CLOUDFLARE_NOT_CONFIGURED", "Cloudflare credentials are not configured.");
  }
  return token;
}

export function requireAccountId(accountId: unknown): string {
  if (typeof accountId !== "string" || !CLOUDFLARE_ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Fault(424, "CLOUDFLARE_ACCOUNT_MISSING", "Cloudflare integration is missing account mapping.");
  }
  return accountId;
}

function requireAccountName(accountName: unknown): string {
  return typeof accountName === "string" ? accountName : "";
}

interface CloudflareErrorItem {
  readonly code: number | null;
  readonly message: string;
}

function cloudflareErrors(payload: unknown): CloudflareErrorItem[] {
  if (!object(payload)) return [];
  const errors = (payload as Record<string, unknown>).errors;
  if (!Array.isArray(errors)) return [];
  const items: CloudflareErrorItem[] = [];
  for (const entry of errors) {
    if (!object(entry)) continue;
    const record = entry as Record<string, unknown>;
    items.push({
      code: typeof record.code === "number" ? record.code : null,
      message:
        typeof record.message === "string" && record.message.length > 0 ? record.message : "Cloudflare request failed",
    });
  }
  return items;
}

async function getJson(
  base: string,
  token: string,
  path: string,
  params: Readonly<Record<string, string | number>> | undefined,
  deadline: number,
  registered: readonly string[],
  started: number,
): Promise<Record<string, unknown>> {
  const timedOut = () => Date.now() - started >= deadline;
  // Root-relative paths would discard the base path (`/client/v4`): join
  // against the base directory explicitly so the version prefix survives.
  // Callers pass validated exact-base endpoints (no trailing slash), so no
  // conditional is needed here.
  const url = new URL(path.replace(/^\//, ""), `${base}/`);
  if (params !== undefined) {
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  }
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(deadline),
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    if (error instanceof Fault) throw error;
    if (
      timedOut() ||
      (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"))
    ) {
      throw new Fault(504, "CLOUDFLARE_VENDOR_TIMEOUT", "Cloudflare exceeded its deadline.");
    }
    throw new Fault(502, "CLOUDFLARE_INTEGRATION_FAILED", "The Cloudflare Integration could not complete.");
  }
  // Never persist a vendor response body, URL, request headers, or raw
  // exception: parse the bounded body, shape the safe fields, drop the rest.
  let payload: unknown;
  try {
    payload = await boundedJson(response.body);
  } catch {
    throw new Fault(502, "CLOUDFLARE_BAD_RESPONSE", `Cloudflare returned HTTP ${response.status} with invalid JSON.`);
  }
  if (!object(payload) || (payload as Record<string, unknown>).success !== true || !response.ok) {
    const errors = cloudflareErrors(payload);
    const detail = errors.length > 0 ? errors[0]!.message : "Cloudflare request failed";
    throw new Fault(
      502,
      "CLOUDFLARE_REQUEST_FAILED",
      cleanMessage(`Cloudflare returned HTTP ${response.status}: ${detail}`, registered),
    );
  }
  if (timedOut()) {
    throw new Fault(504, "CLOUDFLARE_VENDOR_TIMEOUT", "Cloudflare exceeded its deadline.");
  }
  return payload as Record<string, unknown>;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function zoneSummary(zone: Record<string, unknown>): CloudflareZoneSummary {
  const account = object(zone.account) ? (zone.account as Record<string, unknown>) : {};
  const plan = object(zone.plan) ? (zone.plan as Record<string, unknown>) : {};
  const developmentMode = zone.development_mode;
  const planName =
    typeof plan.name === "string" && plan.name.length > 0
      ? plan.name
      : typeof plan.legacy_id === "string" && plan.legacy_id.length > 0
        ? plan.legacy_id
        : "unknown";
  const rawServers = Array.isArray(zone.name_servers) ? zone.name_servers : [];
  const nameServers = rawServers
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .map(String)
    .sort();
  return {
    id: typeof zone.id === "string" ? zone.id : "",
    name: typeof zone.name === "string" ? zone.name : "",
    status: typeof zone.status === "string" ? zone.status : "unknown",
    type: typeof zone.type === "string" ? zone.type : "unknown",
    paused: zone.paused === true,
    developmentModeActive: typeof developmentMode === "number" && developmentMode > 0,
    accountId: typeof account.id === "string" ? account.id : "",
    accountName: typeof account.name === "string" ? account.name : "",
    plan: planName,
    nameServers: Object.freeze(nameServers),
    activatedOn: optionalText(zone.activated_on),
    modifiedOn: optionalText(zone.modified_on),
  };
}

/** Read-only Action: verify the Cloudflare token without returning
 * credential material. Exactly one vendor GET; never persists secrets. */
export async function verifyConnection(
  connection: CloudflareConnection,
  secrets: CloudflareSecrets,
  account: { readonly id: unknown; readonly name: unknown },
  executionId?: string,
  timeoutMs?: number,
): Promise<CloudflareVerifyResult> {
  const deadline = timeoutMs ?? CLOUDFLARE_TIMEOUT_MS;
  // Re-parse the persisted endpoint before any fetch: persist-time
  // validation covers new writes, this covers rows that predate it.
  assertSafeEndpoint("cloudflare", connection.endpoint);
  if (connection.endpoint !== CLOUDFLARE_API_BASE) {
    throw new Fault(500, "INVALID_CONNECTION", "The Cloudflare Integration requires its API base endpoint.");
  }
  const registered: string[] = [];
  if (typeof secrets.apiToken === "string" && secrets.apiToken.length > 0) registered.push(secrets.apiToken);
  const token = requireToken(secrets);
  const accountId = requireAccountId(account.id);
  const accountName = requireAccountName(account.name);
  if (executionId !== undefined) registerExecutionSecrets(executionId, [token]);
  const started = Date.now();
  const payload = await getJson(
    connection.endpoint,
    token,
    CLOUDFLARE_VERIFY_PATH,
    undefined,
    deadline,
    registered,
    started,
  );
  const result = object(payload.result) ? (payload.result as Record<string, unknown>) : {};
  const status = typeof result.status === "string" ? result.status : "unknown";
  return {
    status: status === "active" ? "healthy" : "unhealthy",
    readOnly: true,
    integration: "Cloudflare",
    account: { id: accountId, name: accountName },
    credential: {
      status,
      expiresOn: optionalText(result.expires_on),
      notBefore: optionalText(result.not_before),
    },
    apiCalls: 1,
  };
}

/** Read-only Action: bounded zone inventory. Paginates in vendor order
 * (page 1..N, 50 per page), stops after the final advertised page, caps at
 * maxZones, reports the exact external call count. Never persists secrets. */
export async function inventoryZones(
  connection: CloudflareConnection,
  secrets: CloudflareSecrets,
  account: { readonly id: unknown; readonly name: unknown },
  input: CloudflareInventoryInput,
  executionId?: string,
  timeoutMs?: number,
): Promise<CloudflareInventoryResult> {
  const deadline = timeoutMs ?? CLOUDFLARE_TIMEOUT_MS;
  assertSafeEndpoint("cloudflare", connection.endpoint);
  if (connection.endpoint !== CLOUDFLARE_API_BASE) {
    throw new Fault(500, "INVALID_CONNECTION", "The Cloudflare Integration requires its API base endpoint.");
  }
  const registered: string[] = [];
  if (typeof secrets.apiToken === "string" && secrets.apiToken.length > 0) registered.push(secrets.apiToken);
  const token = requireToken(secrets);
  const accountId = requireAccountId(account.id);
  const accountName = requireAccountName(account.name);
  if (executionId !== undefined) registerExecutionSecrets(executionId, [token]);
  const maxZones = input.maxZones;
  const zones: CloudflareZoneSummary[] = [];
  let totalAvailable: number | null = null;
  let page = 1;
  let apiCalls = 0;
  const started = Date.now();
  while (zones.length < maxZones) {
    const payload = await getJson(
      connection.endpoint,
      token,
      CLOUDFLARE_ZONES_PATH,
      { "account.id": accountId, direction: "asc", order: "name", page, per_page: CLOUDFLARE_PAGE_SIZE },
      deadline,
      registered,
      started,
    );
    apiCalls += 1;
    const raw = Array.isArray(payload.result) ? payload.result : [];
    const batch = raw.filter((entry): entry is Record<string, unknown> => object(entry));
    for (const entry of batch) zones.push(zoneSummary(entry));
    const info = object(payload.result_info) ? (payload.result_info as Record<string, unknown>) : {};
    if (typeof info.total_count === "number" && Number.isInteger(info.total_count) && info.total_count >= 0) {
      totalAvailable = info.total_count;
    }
    const totalPages = info.total_pages;
    // Termination follows the ADVERTISED page count, not the short-page
    // heuristic: a non-final page may legitimately carry fewer rows than
    // the page size (filters, vendor packing), and stopping early would
    // silently drop trailing pages. The bundle scenario
    // inventory-two-pages pins this: page 1 carries 2 of 50 rows with
    // total_pages=2, and the contract requires fetching page 2. The loop
    // still terminates: empty batches break, page>=totalPages breaks, and
    // every non-empty batch grows zones toward maxZones. Deliberate
    // divergence from the Python's `len(batch) < PAGE_SIZE` shortcut,
    // recorded in docs/migration-pilot.md.
    if (batch.length === 0 || (typeof totalPages === "number" && page >= totalPages)) {
      break;
    }
    page += 1;
    if (zones.length >= CLOUDFLARE_MAX_ZONES) break;
  }
  const capped = zones.slice(0, maxZones);
  const statusCounts: Record<string, number> = {};
  const typeCounts: Record<string, number> = {};
  let paused = 0;
  let developmentModeActive = 0;
  for (const zone of capped) {
    statusCounts[zone.status] = (statusCounts[zone.status] ?? 0) + 1;
    typeCounts[zone.type] = (typeCounts[zone.type] ?? 0) + 1;
    if (zone.paused) paused += 1;
    if (zone.developmentModeActive) developmentModeActive += 1;
  }
  const sortedStatus: Record<string, number> = {};
  for (const key of Object.keys(statusCounts).sort()) sortedStatus[key] = statusCounts[key]!;
  const sortedType: Record<string, number> = {};
  for (const key of Object.keys(typeCounts).sort()) sortedType[key] = typeCounts[key]!;
  return {
    status: "completed",
    readOnly: true,
    integration: "Cloudflare",
    account: { id: accountId, name: accountName },
    zoneCount: capped.length,
    totalAvailable,
    truncated: totalAvailable !== null && capped.length < totalAvailable,
    apiCalls,
    summary: {
      statusCounts: Object.freeze(sortedStatus),
      typeCounts: Object.freeze(sortedType),
      paused,
      developmentModeActive,
    },
    zones: Object.freeze(capped),
  };
}

function sortedCounts(counts: Record<string, number>): Readonly<Record<string, number>> {
  const sorted: Record<string, number> = {};
  for (const key of Object.keys(counts).sort()) sorted[key] = counts[key]!;
  return Object.freeze(sorted);
}

function requirePostureSetup(
  connection: CloudflareConnection,
  secrets: CloudflareSecrets,
  account: { readonly id: unknown; readonly name: unknown },
  executionId?: string,
): { readonly token: string; readonly accountId: string; readonly accountName: string; readonly registered: string[] } {
  assertSafeEndpoint("cloudflare", connection.endpoint);
  if (connection.endpoint !== CLOUDFLARE_API_BASE) {
    throw new Fault(500, "INVALID_CONNECTION", "The Cloudflare Integration requires its API base endpoint.");
  }
  const registered: string[] = [];
  if (typeof secrets.apiToken === "string" && secrets.apiToken.length > 0) registered.push(secrets.apiToken);
  const token = requireToken(secrets);
  const accountId = requireAccountId(account.id);
  const accountName = requireAccountName(account.name);
  if (executionId !== undefined) registerExecutionSecrets(executionId, [token]);
  return { token, accountId, accountName, registered };
}

function totalCountOf(payload: Record<string, unknown>): number | null {
  const info = object(payload.result_info) ? (payload.result_info as Record<string, unknown>) : {};
  return typeof info.total_count === "number" && Number.isInteger(info.total_count) && info.total_count >= 0
    ? info.total_count
    : null;
}

function nextAuditCursor(payload: Record<string, unknown>): string | null {
  // Audit Logs v2 paginates with an opaque cursor in result_info when the
  // window is large; older shapes carry total_pages. Prefer the cursor when
  // present, else fall back to page++ against the advertised page count.
  const info = object(payload.result_info) ? (payload.result_info as Record<string, unknown>) : {};
  const cursor = info.cursor;
  if (typeof cursor === "string" && cursor.length > 0) return cursor;
  const nested = object(info.result_info) ? (info.result_info as Record<string, unknown>) : null;
  const nestedCursor = nested?.cursor;
  return typeof nestedCursor === "string" && nestedCursor.length > 0 ? nestedCursor : null;
}

function shapeAuditEntry(raw: unknown): CloudflareAuditEntry | null {
  if (!object(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  const action = object(record.action) ? (record.action as Record<string, unknown>) : {};
  const actionType =
    typeof action.type === "string" && action.type.length > 0
      ? action.type
      : typeof record.action === "string"
        ? record.action
        : "unknown";
  const actionDescription = postureBoundedText(action.description);
  const actionResult =
    typeof action.result === "string"
      ? action.result
      : typeof action.result === "boolean"
        ? String(action.result)
        : null;
  const occurredAt = typeof action.time === "string" ? action.time : null;
  const actor = object(record.actor) ? (record.actor as Record<string, unknown>) : {};
  const actorKind: AuditActorKind = attributeAuditActor({
    type: actor.type,
    email: actor.email,
    tokenId: actor.token_id,
    tokenName: actor.token_name,
  });
  const resource = object(record.resource) ? (record.resource as Record<string, unknown>) : {};
  const resourceType = typeof resource.type === "string" ? resource.type : null;
  const resourceScope = typeof resource.scope === "string" ? resource.scope : null;
  const zone = object(record.zone) ? (record.zone as Record<string, unknown>) : {};
  const eventClass: AuditEventClass = classifyAuditEvent({
    actionType,
    actionDescription: action.description,
    resourceType: resource.type,
    resourceScope: resource.scope,
    resourceProduct: resource.product,
  });
  return {
    id: record.id,
    actionType,
    actionDescription,
    actionResult,
    occurredAt,
    actorKind,
    actorEmail: typeof actor.email === "string" ? actor.email : null,
    actorTokenName: typeof actor.token_name === "string" ? actor.token_name : null,
    resourceType,
    resourceScope,
    zoneId: typeof zone.id === "string" ? zone.id : null,
    zoneName: typeof zone.name === "string" ? zone.name : null,
    eventClass,
  };
}

/** Read-only Action: bounded Audit Logs v2 read. Paginates newest-first
 * (per_page 50, at most 2 pages), shapes safe fields only, classifies every
 * entry into the issue's filter classes with actor-vs-service attribution.
 * Never persists secrets. */
export async function listAuditLogs(
  connection: CloudflareConnection,
  secrets: CloudflareSecrets,
  account: { readonly id: unknown; readonly name: unknown },
  input: { readonly since?: string; readonly limit?: number; readonly classes?: readonly AuditEventClass[] },
  executionId?: string,
  timeoutMs?: number,
): Promise<CloudflareAuditResult> {
  const deadline = timeoutMs ?? CLOUDFLARE_TIMEOUT_MS;
  const { token, accountId, accountName, registered } = requirePostureSetup(connection, secrets, account, executionId);
  const limit = input.limit ?? CLOUDFLARE_POSTURE_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > CLOUDFLARE_POSTURE_MAX_ENTRIES) {
    throw new Fault(502, "CLOUDFLARE_INTEGRATION_FAILED", "The Cloudflare Integration could not complete.");
  }
  // Scheduled runs omit `since`: default to the trailing 24h at execution so
  // a stored schedule row never goes stale.
  const since = input.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const path = `/accounts/${accountId}${CLOUDFLARE_AUDIT_LOGS_SUFFIX}`;
  const entries: CloudflareAuditEntry[] = [];
  let totalAvailable: number | null = null;
  let apiCalls = 0;
  let cursor: string | null = null;
  let page = 1;
  const started = Date.now();
  for (let fetched = 0; fetched < CLOUDFLARE_POSTURE_MAX_PAGES && entries.length < limit; fetched += 1) {
    const params: Record<string, string | number> = {
      since,
      per_page: Math.min(limit - entries.length, CLOUDFLARE_POSTURE_PAGE_SIZE),
    };
    if (cursor !== null) params.cursor = cursor;
    else params.page = page;
    const payload = await getJson(connection.endpoint, token, path, params, deadline, registered, started);
    apiCalls += 1;
    const raw = Array.isArray(payload.result) ? payload.result : [];
    let shaped = 0;
    for (const entry of raw) {
      const entry_ = shapeAuditEntry(entry);
      if (entry_ === null) continue;
      if (input.classes !== undefined && !input.classes.includes(entry_.eventClass)) continue;
      entries.push(entry_);
      shaped += 1;
      if (entries.length >= limit) break;
    }
    if (totalAvailable === null) totalAvailable = totalCountOf(payload);
    if (shaped === 0) break;
    const next = nextAuditCursor(payload);
    if (next !== null) {
      cursor = next;
      continue;
    }
    const info = object(payload.result_info) ? (payload.result_info as Record<string, unknown>) : {};
    const totalPages = info.total_pages;
    if (typeof totalPages === "number" && page < totalPages) {
      page += 1;
      continue;
    }
    break;
  }
  const capped = entries.slice(0, limit);
  const classCounts: Record<string, number> = {};
  const actorKindCounts: Record<string, number> = {};
  for (const entry of capped) {
    classCounts[entry.eventClass] = (classCounts[entry.eventClass] ?? 0) + 1;
    actorKindCounts[entry.actorKind] = (actorKindCounts[entry.actorKind] ?? 0) + 1;
  }
  return {
    status: "completed",
    readOnly: true,
    integration: "Cloudflare",
    account: { id: accountId, name: accountName },
    entryCount: capped.length,
    totalAvailable,
    truncated: totalAvailable !== null && capped.length < totalAvailable,
    apiCalls,
    classCounts: sortedCounts(classCounts),
    actorKindCounts: sortedCounts(actorKindCounts),
    entries: Object.freeze(capped),
  };
}

function shapeInsight(raw: unknown): CloudflareInsightIssue | null {
  if (!object(raw)) return null;
  const record = raw as Record<string, unknown>;
  const id =
    typeof record.id === "string" && record.id.length > 0
      ? record.id
      : typeof record.issue_id === "string" && record.issue_id.length > 0
        ? record.issue_id
        : null;
  if (id === null) return null;
  const severity: InsightSeverity = normalizeInsightSeverity(record.severity);
  const dismissed =
    record.dismissed === true || (typeof record.status === "string" && record.status.toLowerCase() === "dismissed");
  const zone = object(record.zone) ? (record.zone as Record<string, unknown>) : {};
  return {
    id,
    name: postureBoundedText(record.name ?? record.title),
    issueClass:
      typeof record.class === "string"
        ? record.class
        : typeof record.issue_class === "string"
          ? record.issue_class
          : null,
    issueType:
      typeof record.type === "string" ? record.type : typeof record.issue_type === "string" ? record.issue_type : null,
    severity,
    dismissed,
    zoneId: typeof record.zone_id === "string" ? record.zone_id : typeof zone.id === "string" ? zone.id : null,
    zoneName:
      typeof record.zone_name === "string" ? record.zone_name : typeof zone.name === "string" ? zone.name : null,
  };
}

/** Read-only Action: bounded Security Insights list. Severity counts are
 * computed from the shaped list; unrecognized severities land in "unknown"
 * (advisory-only downstream) and unknown insight classes are shaped
 * generically, never failed on — paid-gated classes stay out of scope until
 * a live-account verification run (docs/posture.md). Never persists secrets. */
export async function listSecurityInsights(
  connection: CloudflareConnection,
  secrets: CloudflareSecrets,
  account: { readonly id: unknown; readonly name: unknown },
  input: { readonly limit?: number; readonly includeDismissed?: boolean },
  executionId?: string,
  timeoutMs?: number,
): Promise<CloudflareInsightsResult> {
  const deadline = timeoutMs ?? CLOUDFLARE_TIMEOUT_MS;
  const { token, accountId, accountName, registered } = requirePostureSetup(connection, secrets, account, executionId);
  const limit = input.limit ?? CLOUDFLARE_POSTURE_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > CLOUDFLARE_POSTURE_MAX_ENTRIES) {
    throw new Fault(502, "CLOUDFLARE_INTEGRATION_FAILED", "The Cloudflare Integration could not complete.");
  }
  const path = `/accounts/${accountId}${CLOUDFLARE_INSIGHTS_SUFFIX}`;
  const issues: CloudflareInsightIssue[] = [];
  let totalAvailable: number | null = null;
  let apiCalls = 0;
  let page = 1;
  const started = Date.now();
  for (let fetched = 0; fetched < CLOUDFLARE_POSTURE_MAX_PAGES && issues.length < limit; fetched += 1) {
    const params: Record<string, string | number> = {
      per_page: Math.min(limit - issues.length, CLOUDFLARE_POSTURE_PAGE_SIZE),
      page,
    };
    // Dismissed findings are noise by default; the Saga surfaces them only
    // when the operator opts in.
    if (input.includeDismissed !== true) params.dismissed = "false";
    const payload = await getJson(connection.endpoint, token, path, params, deadline, registered, started);
    apiCalls += 1;
    const raw = Array.isArray(payload.result) ? payload.result : [];
    let shaped = 0;
    for (const entry of raw) {
      const issue = shapeInsight(entry);
      if (issue === null) continue;
      issues.push(issue);
      shaped += 1;
      if (issues.length >= limit) break;
    }
    if (totalAvailable === null) totalAvailable = totalCountOf(payload);
    const info = object(payload.result_info) ? (payload.result_info as Record<string, unknown>) : {};
    const totalPages = info.total_pages;
    if (shaped === 0 || (typeof totalPages === "number" && page >= totalPages)) break;
    page += 1;
  }
  const capped = issues.slice(0, limit);
  const severityCounts: Record<string, number> = {};
  const unresolvedCriticalIds: string[] = [];
  for (const issue of capped) {
    severityCounts[issue.severity] = (severityCounts[issue.severity] ?? 0) + 1;
    if (issue.severity === "critical" && !issue.dismissed) unresolvedCriticalIds.push(issue.id);
  }
  return {
    status: "completed",
    readOnly: true,
    integration: "Cloudflare",
    account: { id: accountId, name: accountName },
    issueCount: capped.length,
    totalAvailable,
    truncated: totalAvailable !== null && capped.length < totalAvailable,
    apiCalls,
    severityCounts: sortedCounts(severityCounts),
    unresolvedCriticalIds: Object.freeze(unresolvedCriticalIds),
    verdict: "advisory",
    baselineRecordedAt: null,
    issues: Object.freeze(capped),
  };
}

export interface CloudflareZoneSettingRead {
  readonly setting: string;
  readonly zoneId: string;
  readonly ok: boolean;
  readonly valueJson: string | null;
  readonly valueText: string | null;
  readonly errorCode: string | null;
}
export interface CloudflareZoneSettingsResult {
  readonly status: "completed";
  readonly readOnly: true;
  readonly integration: "Cloudflare";
  readonly account: CloudflareAccountRef;
  readonly zoneIds: readonly string[];
  readonly settings: readonly CloudflareZoneSettingRead[];
  readonly apiCalls: number;
}

function shapeSettingValue(value: unknown): { readonly valueJson: string | null; readonly valueText: string | null } {
  if (value === null || value === undefined) return { valueJson: null, valueText: null };
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = String(value);
    return {
      valueJson: JSON.stringify(value),
      valueText: text.length > 300 ? text.slice(0, 300) : text,
    };
  }
  let json: string;
  try {
    json = JSON.stringify(value) ?? "null";
  } catch {
    return { valueJson: null, valueText: null };
  }
  return { valueJson: json.length > 1024 ? json.slice(0, 1024) : json, valueText: null };
}

/** Read-only Action: bounded zone-settings reads for the benchmark. Zone IDs
 * and setting names validate locally (allowlist rejects before any vendor
 * call). A per-setting vendor rejection (e.g. a plan-gated setting) is
 * recorded as evidence with its error code: the benchmark fails that
 * setting check on the unreadable zone (missing evidence never passes) and
 * reports "unknown" only when nothing was readable; transport/timeout
 * faults still fail loud. Never persists secrets. */
export async function readZoneSettings(
  connection: CloudflareConnection,
  secrets: CloudflareSecrets,
  account: { readonly id: unknown; readonly name: unknown },
  input: { readonly zoneIds: readonly string[]; readonly settings: readonly string[] },
  executionId?: string,
  timeoutMs?: number,
): Promise<CloudflareZoneSettingsResult> {
  const deadline = timeoutMs ?? CLOUDFLARE_TIMEOUT_MS;
  const { token, accountId, accountName, registered } = requirePostureSetup(connection, secrets, account, executionId);
  if (!Array.isArray(input.zoneIds) || input.zoneIds.length === 0 || input.zoneIds.length > 25) {
    throw new Fault(502, "CLOUDFLARE_INTEGRATION_FAILED", "The Cloudflare Integration could not complete.");
  }
  const zoneIds: string[] = [];
  for (const zoneId of input.zoneIds) {
    if (typeof zoneId !== "string" || !CLOUDFLARE_ACCOUNT_ID_PATTERN.test(zoneId)) {
      throw new Fault(502, "CLOUDFLARE_INTEGRATION_FAILED", "The Cloudflare Integration could not complete.");
    }
    if (!zoneIds.includes(zoneId)) zoneIds.push(zoneId);
  }
  if (!Array.isArray(input.settings) || input.settings.length === 0) {
    throw new Fault(502, "CLOUDFLARE_INTEGRATION_FAILED", "The Cloudflare Integration could not complete.");
  }
  const settings: string[] = [];
  for (const setting of input.settings) {
    if (typeof setting !== "string" || !(CLOUDFLARE_ZONE_SETTING_ALLOWLIST as readonly string[]).includes(setting)) {
      throw new Fault(502, "CLOUDFLARE_INTEGRATION_FAILED", "The Cloudflare Integration could not complete.");
    }
    if (!settings.includes(setting)) settings.push(setting);
  }
  const reads: CloudflareZoneSettingRead[] = [];
  let apiCalls = 0;
  const started = Date.now();
  for (const zoneId of zoneIds) {
    for (const setting of settings) {
      const path = `/zones/${zoneId}${CLOUDFLARE_ZONE_SETTINGS_SUFFIX}/${setting}`;
      apiCalls += 1;
      let payload: Record<string, unknown>;
      try {
        payload = await getJson(connection.endpoint, token, path, undefined, deadline, registered, started);
      } catch (error) {
        // Plan-gated or unknown-to-the-account settings degrade to evidence;
        // anything else (timeout, transport, auth) fails the run.
        if (
          error instanceof Fault &&
          (error.code === "CLOUDFLARE_REQUEST_FAILED" || error.code === "CLOUDFLARE_BAD_RESPONSE")
        ) {
          reads.push({ setting, zoneId, ok: false, valueJson: null, valueText: null, errorCode: error.code });
          continue;
        }
        throw error;
      }
      const result = object(payload.result) ? (payload.result as Record<string, unknown>) : {};
      const shaped = shapeSettingValue(result.value);
      reads.push({
        setting,
        zoneId,
        ok: true,
        valueJson: shaped.valueJson,
        valueText: shaped.valueText,
        errorCode: null,
      });
    }
  }
  return {
    status: "completed",
    readOnly: true,
    integration: "Cloudflare",
    account: { id: accountId, name: accountName },
    zoneIds: Object.freeze(zoneIds),
    settings: Object.freeze(reads),
    apiCalls,
  };
}
