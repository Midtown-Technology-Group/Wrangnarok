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
// vendors; Sagas route it to timeout-mark-v1 like every other lane.
import {
  boundedJson,
  CLOUDFLARE_ACCOUNT_ID_PATTERN,
  CLOUDFLARE_API_BASE,
  CLOUDFLARE_INTEGRATION_ID,
  CLOUDFLARE_MAX_ZONES,
  CLOUDFLARE_PAGE_SIZE,
  CLOUDFLARE_TIMEOUT_MS,
  CLOUDFLARE_VERIFY_PATH,
  CLOUDFLARE_ZONES_PATH,
  Fault,
  object,
} from "../domain";
import type {
  CloudflareInventoryInput,
  CloudflareInventoryResult,
  CloudflareVerifyResult,
  CloudflareZoneSummary,
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
      message: typeof record.message === "string" && record.message.length > 0 ? record.message : "Cloudflare request failed",
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
  const url = new URL(path, base);
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
    throw new Fault(
      502,
      "CLOUDFLARE_BAD_RESPONSE",
      `Cloudflare returned HTTP ${response.status} with invalid JSON.`,
    );
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
    token: {
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
    if (batch.length === 0 || (typeof totalPages === "number" && page >= totalPages) || batch.length < CLOUDFLARE_PAGE_SIZE) {
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
