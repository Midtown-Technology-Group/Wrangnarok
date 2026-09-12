// SPDX-License-Identifier: AGPL-3.0
// Browser App SDK runtime client (APP-02, issue #160; ADR 019).
//
// Scoped imperative client for authored apps: an installed app (identified by
// its Organization-scoped app UUID) invokes granted Sagas, reads/writes
// granted Tables, and uploads/downloads granted files. Maps the actual
// upstream V2 exports (index.v2.ts: provider, workflow invocation, Tables,
// files, subscriptions) onto Wrangnarok routes; Forms/config hooks stay out
// (their own parity issues: FORM-02, CON-02).
//
// Upstream mapping (baseline 3543c7eb vs Wrangnarok 32dabf88):
// - provider.tsx BifrostProvider -> AppRuntimeProvider (lib/app-provider.tsx):
//   authed fetch, install/org/app context, theme, logout, one-401 refresh.
// - use-workflow run/status/result -> invokeSaga/pollExecution/getResult:
//   POST invoke (Idempotency-Key) plus terminal poll; no WebSocket.
// - use-table/tables.ts -> queryTable/insertRow/patchRow/deleteRow plus
//   subscribeTable: bounded polling against the authoritative tableRevision
//   (no WebSocket, Durable Object, or Queue in this slice).
// - use-files/files.ts -> declareFile/issueToken/uploadFile/downloadFile:
//   single-use scoped tokens with finalize-after-upload verification.
// - wire-surface.ts/sdk-contract.test.ts tripwire -> handshake: the client
//   asserts sdk name + version before its first scoped call (APP_SDK_MISMATCH).
//
// Retry rules (method-shaped, acceptance-pinned):
// - GET: safe to retry. Bounded retries on network failure and 503
//   (Retry-After honored once), then the error surfaces.
// - POST/PATCH/PUT/DELETE: never retried blindly. Invoke carries a caller
//   Idempotency-Key so a caller-driven retry is safe; PATCH has no key and
//   is last-writer-wins, so a failed PATCH surfaces and the caller re-lists.
import { parseApiError } from "./api-error";
import type { AppExecutionLink, AppFileMeta, AppGrant, AppHandshake, AppTableDef, AppTableRow } from "./client-types";

/** Browser App SDK contract version. Must equal the served handshake
 * version (APP_SDK_VERSION in src/app-runtime.ts); drift fails loud. */
export const APP_SDK_VERSION = "1" as const;

export const APP_SDK_NAME = "wrangnarok.app-runtime" as const;

const APP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROW_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{16,128}$/;
const TERMINAL_STATUSES = ["Succeeded", "Failed", "TimedOut", "Cancelled"];

export interface AppRuntimeOptions {
  /** Absolute Worker base URL (no trailing slash). */
  readonly baseUrl: string;
  /** Bearer token for the Organization caller. */
  readonly token: string;
  /** The installed app UUID this context is scoped to. */
  readonly appId: string;
  /** Override fetch (tests / non-browser). Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Called once after a 401 to rotate the token. Bounded: exactly one
   * retry follows, then the 401 surfaces and logout handling runs. */
  readonly onRefreshToken?: () => Promise<string | null>;
  /** Called when auth definitively fails (refresh absent, empty, or replay 401). */
  readonly onAuthFailure?: () => void;
  /** GET retry ceiling for network/503 failures (default 2). Mutations never retry. */
  readonly maxGetRetries?: number;
  /** Base delay between GET retries and subscription polls (default 1000ms). */
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface TablePageQuery {
  readonly filter?: Record<string, string | number | boolean>;
  readonly limit?: number;
  readonly cursor?: string | null;
  readonly sinceRevision?: number | null;
}

export interface TablePage {
  readonly rows: AppTableRow[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly tableRevision: number;
}

export interface ExecutionReceipt {
  readonly executionId: string;
  readonly replayed: boolean;
  readonly statusUrl: string;
}

function checkAppId(appId: string): void {
  if (!APP_ID_RE.test(appId)) throw new Error("Unexpected App ID shape.");
}

function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `app-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTablePage(value: unknown): value is TablePage {
  return (
    isRecord(value) &&
    Array.isArray(value.rows) &&
    typeof value.hasMore === "boolean" &&
    (value.nextCursor === null || typeof value.nextCursor === "string") &&
    typeof value.tableRevision === "number"
  );
}

function isHandshake(value: unknown): value is AppHandshake {
  return (
    isRecord(value) &&
    value.sdk === APP_SDK_NAME &&
    typeof value.version === "string" &&
    isRecord(value.app) &&
    typeof value.app.id === "string"
  );
}

export interface AppRuntimeClient {
  /** Compatibility handshake: assert sdk name + version before scoped calls. */
  handshake(): Promise<AppHandshake>;
  listGrants(): Promise<AppGrant[]>;
  listTables(): Promise<AppTableDef[]>;
  queryTable(name: string, query?: TablePageQuery): Promise<TablePage>;
  insertRow(table: string, data: Record<string, unknown>): Promise<AppTableRow>;
  patchRow(table: string, rowId: string, data: Record<string, unknown>): Promise<AppTableRow>;
  deleteRow(table: string, rowId: string): Promise<{ deleted: true; tableRevision: number }>;
  invokeSaga(sagaId: string, input?: unknown, key?: string): Promise<ExecutionReceipt>;
  fetchResult(executionId: string): Promise<{ status: string; result: unknown; error: unknown }>;
  pollExecution(
    executionId: string,
    options?: { timeoutMs?: number },
  ): Promise<{ status: string; result: unknown; error: unknown }>;
  listExecutions(): Promise<AppExecutionLink[]>;
  listFiles(): Promise<AppFileMeta[]>;
  uploadFile(name: string, bytes: Uint8Array, contentType?: string): Promise<AppFileMeta>;
  downloadFile(name: string): Promise<{ meta: AppFileMeta; bytes: Uint8Array }>;
  deleteFile(name: string, expectedVersion?: number): Promise<{ deleted: true }>;
  /** Bounded polling subscription against the authoritative Table revision.
   * Reconnect: on transport failure the poller backs off, re-lists from the
   * last known revision, and resumes. Returns an unsubscribe that halts all
   * further fetches (repeat mount/unmount safe). */
  subscribeTable(
    name: string,
    query: TablePageQuery | undefined,
    onPage: (page: TablePage) => void,
    onError: (error: Error) => void,
  ): () => void;
  /** File re-list subscription: polls the granted file list and reports
   * change by version. Same reconnect/unsubscribe contract as tables. */
  subscribeFiles(onFiles: (files: AppFileMeta[]) => void, onError: (error: Error) => void): () => void;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Decode(content: string): Uint8Array {
  const binary = atob(content);
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

export function createAppRuntimeClient(options: AppRuntimeOptions): AppRuntimeClient {
  const base = options.baseUrl.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) throw new Error("The App SDK base must be an http(s) URL.");
  if (!options.token) throw new Error("The App SDK needs a bearer token.");
  checkAppId(options.appId);
  const appId = options.appId;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const maxGetRetries = options.maxGetRetries ?? 2;
  const pollMs = options.pollMs ?? 1000;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let token = options.token;
  let handshook = false;

  function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    // The live token wins: a caller-supplied Authorization (e.g. built before
    // a rotation) never overrides the rotated token on retry.
    const { Authorization: _stale, ...rest } = extra;
    void _stale;
    return { Accept: "application/json", Authorization: `Bearer ${token}`, ...rest };
  }

  function retryAfterMs(response: Response): number {
    const raw = response.headers.get("Retry-After");
    const seconds = raw === null ? NaN : Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 60) return seconds * 1000;
    return pollMs;
  }

  /** Single fetch with bounded one-401 refresh. Returns the (possibly
   * retried-once) response; callers check ok themselves. */
  async function authed(input: string, init?: RequestInit): Promise<Response> {
    let response = await fetchImpl(input, { ...init, headers: authHeaders(init?.headers as Record<string, string>) });
    if (response.status !== 401 || !options.onRefreshToken) return response;
    // Bounded one-401 refresh: rotate once, retry once. A replay 401 (or an
    // empty rotation) surfaces and runs auth-failure handling.
    const fresh = await options.onRefreshToken();
    if (!fresh) {
      options.onAuthFailure?.();
      return response;
    }
    token = fresh;
    response = await fetchImpl(input, { ...init, headers: authHeaders(init?.headers as Record<string, string>) });
    if (response.status === 401) options.onAuthFailure?.();
    return response;
  }

  async function readJson(response: Response, what: string): Promise<unknown> {
    if (!response.ok) throw await parseApiError(response);
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new Error(`Unexpected ${what} response shape.`);
    }
  }

  /** GET with bounded retries on network failure and 503 only. Every other
   * status (including 401-after-refresh, 403, 404, 422) surfaces immediately.
   * Mutations never pass through here. */
  async function getJson(path: string, what: string): Promise<unknown> {
    let attempt = 0;
    for (;;) {
      let response: Response;
      try {
        response = await authed(`${base}${path}`, { headers: authHeaders() });
      } catch (error) {
        if (attempt >= maxGetRetries) throw error instanceof Error ? error : new Error(String(error));
        attempt += 1;
        await sleep(pollMs * attempt);
        continue;
      }
      if (response.status === 503 && attempt < maxGetRetries) {
        attempt += 1;
        await sleep(retryAfterMs(response));
        continue;
      }
      return readJson(response, what);
    }
  }

  /** Mutations: exactly one attempt, never retried blindly. A failed POST
   * (non-2xx) surfaces; only the caller retries, with the same
   * Idempotency-Key for invoke. */
  async function mutate(path: string, method: string, body: unknown, what: string): Promise<unknown> {
    const response = await authed(`${base}${path}`, {
      method,
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    return readJson(response, what);
  }

  async function ensureHandshake(): Promise<void> {
    if (handshook) return;
    const data = await getJson(`/api/apps/${appId}/sdk`, "app handshake");
    if (!isHandshake(data)) throw new Error("Unexpected app handshake shape.");
    if (data.version !== APP_SDK_VERSION) {
      throw Object.assign(new Error(`App SDK drift: client v${APP_SDK_VERSION} vs server v${data.version}.`), {
        code: "APP_SDK_MISMATCH",
      });
    }
    handshook = true;
  }

  function tablePath(name: string, suffix: string): string {
    return `/api/apps/${appId}/runtime/tables/${encodeURIComponent(name)}${suffix}`;
  }

  function checkRowId(rowId: string): void {
    if (!ROW_ID_RE.test(rowId)) throw new Error("Unexpected Table row ID shape.");
  }

  return {
    async handshake(): Promise<AppHandshake> {
      const data = await getJson(`/api/apps/${appId}/sdk`, "app handshake");
      if (!isHandshake(data)) throw new Error("Unexpected app handshake shape.");
      if (data.version !== APP_SDK_VERSION) {
        throw Object.assign(new Error(`App SDK drift: client v${APP_SDK_VERSION} vs server v${data.version}.`), {
          code: "APP_SDK_MISMATCH",
        });
      }
      handshook = true;
      return data;
    },

    async listGrants(): Promise<AppGrant[]> {
      const data = await getJson(`/api/apps/${appId}/grants`, "app grants");
      if (!isRecord(data) || !Array.isArray(data.grants)) throw new Error("Unexpected app grants shape.");
      return data.grants as AppGrant[];
    },

    async listTables(): Promise<AppTableDef[]> {
      await ensureHandshake();
      const data = await getJson(`/api/apps/${appId}/runtime/tables`, "app tables");
      if (!isRecord(data) || !Array.isArray(data.tables)) throw new Error("Unexpected app tables shape.");
      return data.tables as AppTableDef[];
    },

    async queryTable(name: string, query: TablePageQuery = {}): Promise<TablePage> {
      await ensureHandshake();
      const params = new URLSearchParams();
      if (query.filter !== undefined) params.set("filter", JSON.stringify(query.filter));
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      if (query.cursor) params.set("cursor", query.cursor);
      if (query.sinceRevision !== undefined && query.sinceRevision !== null) {
        params.set("sinceRevision", String(query.sinceRevision));
      }
      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      const data = await getJson(tablePath(name, `/rows${suffix}`), "table rows");
      if (!isTablePage(data)) throw new Error("Unexpected table rows shape.");
      return data;
    },

    async insertRow(table: string, data: Record<string, unknown>): Promise<AppTableRow> {
      await ensureHandshake();
      const payload = await mutate(tablePath(table, "/rows"), "POST", { data }, "table insert");
      if (!isRecord(payload) || !isRecord(payload.row)) throw new Error("Unexpected table row shape.");
      return payload.row as unknown as AppTableRow;
    },

    async patchRow(table: string, rowId: string, data: Record<string, unknown>): Promise<AppTableRow> {
      checkRowId(rowId);
      await ensureHandshake();
      // No retry: PATCH is last-writer-wins. A failure surfaces; the caller
      // re-lists and reconciles before deciding to write again.
      const payload = await mutate(tablePath(table, `/rows/${rowId}`), "PATCH", { data }, "table patch");
      if (!isRecord(payload) || !isRecord(payload.row)) throw new Error("Unexpected table row shape.");
      return payload.row as unknown as AppTableRow;
    },

    async deleteRow(table: string, rowId: string): Promise<{ deleted: true; tableRevision: number }> {
      checkRowId(rowId);
      await ensureHandshake();
      const response = await authed(`${base}${tablePath(table, `/rows/${rowId}`)}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      const data = await readJson(response, "table delete");
      if (!isRecord(data) || data.deleted !== true || typeof data.tableRevision !== "number") {
        throw new Error("Unexpected table delete shape.");
      }
      return { deleted: true, tableRevision: data.tableRevision };
    },

    async invokeSaga(sagaId: string, input: unknown = {}, key?: string): Promise<ExecutionReceipt> {
      await ensureHandshake();
      const idempotencyKey = key ?? randomKey();
      if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
        throw new Error("Idempotency-Key must be 16-128 chars [A-Za-z0-9._:-].");
      }
      // One attempt: the receipt carries the key, so only the caller retries
      // with the same key (canonical replay: 200 + replayed:true).
      const response = await authed(`${base}/api/apps/${appId}/runtime/invoke`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json", "Idempotency-Key": idempotencyKey }),
        body: JSON.stringify({ sagaId, input }),
      });
      const data = await readJson(response, "app invoke");
      if (!isRecord(data) || typeof data.executionId !== "string") {
        throw new Error("Unexpected app invoke shape.");
      }
      return {
        executionId: data.executionId,
        replayed: data.replayed === true,
        statusUrl: typeof data.statusUrl === "string" ? data.statusUrl : `/api/executions/${data.executionId}`,
      };
    },

    async fetchResult(executionId: string): Promise<{ status: string; result: unknown; error: unknown }> {
      if (!/^[a-f0-9]{64}$/.test(executionId)) throw new Error("Unexpected Execution ID shape.");
      const data = await getJson(`/api/executions/${executionId}`, "execution detail");
      if (!isRecord(data) || typeof data.status !== "string" || !("result" in data) || !("error" in data)) {
        throw new Error("Unexpected execution detail shape.");
      }
      return { status: data.status, result: data.result, error: data.error };
    },

    async pollExecution(
      executionId: string,
      options: { timeoutMs?: number } = {},
    ): Promise<{ status: string; result: unknown; error: unknown }> {
      const deadline = Date.now() + (options.timeoutMs ?? 120000);
      for (;;) {
        const detail = await this.fetchResult(executionId);
        if (TERMINAL_STATUSES.includes(detail.status)) return detail;
        if (Date.now() >= deadline) throw new Error(`Execution ${executionId} did not settle in time.`);
        await sleep(pollMs);
      }
    },

    async listExecutions(): Promise<AppExecutionLink[]> {
      await ensureHandshake();
      const data = await getJson(`/api/apps/${appId}/runtime/executions`, "app executions");
      if (!isRecord(data) || !Array.isArray(data.executions)) {
        throw new Error("Unexpected app executions shape.");
      }
      return data.executions as AppExecutionLink[];
    },

    async listFiles(): Promise<AppFileMeta[]> {
      await ensureHandshake();
      const data = await getJson(`/api/apps/${appId}/runtime/files`, "app files");
      if (!isRecord(data) || !Array.isArray(data.files)) throw new Error("Unexpected app files shape.");
      return data.files as unknown as AppFileMeta[];
    },

    async uploadFile(name: string, bytes: Uint8Array, contentType = "application/octet-stream"): Promise<AppFileMeta> {
      await ensureHandshake();
      // Declare (idempotent) with the write grant, mint a single-use upload
      // token, then redeem with finalize-after-upload verification metadata.
      const declared = await mutate(`/api/apps/${appId}/runtime/files/declare`, "POST", { name, contentType }, "file");
      if (!isRecord(declared) || !isRecord(declared.file)) throw new Error("Unexpected file declare shape.");
      const tokened = await mutate(
        `/api/apps/${appId}/runtime/files/tokens`,
        "POST",
        { name, scope: "upload" },
        "file token",
      );
      if (!isRecord(tokened) || typeof tokened.token !== "string") {
        throw new Error("Unexpected file token shape.");
      }
      const content = base64Encode(bytes);
      const sha256 = await sha256Hex(bytes);
      const response = await authed(`${base}/api/apps/${appId}/runtime/files/upload`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json", "X-File-Token": tokened.token }),
        body: JSON.stringify({ content, contentType, size: bytes.byteLength, sha256 }),
      });
      const redeemed = await readJson(response, "file upload");
      if (!isRecord(redeemed) || !isRecord(redeemed.file)) throw new Error("Unexpected file upload shape.");
      return redeemed.file as unknown as AppFileMeta;
    },

    async downloadFile(name: string): Promise<{ meta: AppFileMeta; bytes: Uint8Array }> {
      await ensureHandshake();
      const tokened = await mutate(
        `/api/apps/${appId}/runtime/files/tokens`,
        "POST",
        { name, scope: "download" },
        "file token",
      );
      if (!isRecord(tokened) || typeof tokened.token !== "string") {
        throw new Error("Unexpected file token shape.");
      }
      // Single-use bearer: the token rides one header on one call, never a
      // query string (no log/token-cache surface), never retried.
      const response = await authed(`${base}/api/apps/${appId}/runtime/files/download`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json", "X-File-Token": tokened.token }),
        body: JSON.stringify({}),
      });
      const data = await readJson(response, "file download");
      if (!isRecord(data) || !isRecord(data.meta) || typeof data.content !== "string") {
        throw new Error("Unexpected file download shape.");
      }
      const bytes = base64Decode(data.content);
      const sha256 = await sha256Hex(bytes);
      const meta = data.meta as unknown as AppFileMeta;
      if (meta.sha256 !== sha256) throw new Error("Downloaded bytes failed sha256 verification.");
      return { meta, bytes };
    },

    async deleteFile(name: string, expectedVersion?: number): Promise<{ deleted: true }> {
      await ensureHandshake();
      const suffix = expectedVersion === undefined ? "" : `?expectedVersion=${expectedVersion}`;
      const response = await authed(`${base}/api/apps/${appId}/runtime/files/${encodeURIComponent(name)}${suffix}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      const data = await readJson(response, "file delete");
      if (!isRecord(data) || data.deleted !== true) throw new Error("Unexpected file delete shape.");
      return { deleted: true };
    },

    subscribeTable(
      name: string,
      query: TablePageQuery | undefined,
      onPage: (page: TablePage) => void,
      onError: (error: Error) => void,
    ): () => void {
      let stopped = false;
      let revision: number | null = query?.sinceRevision ?? null;
      let failures = 0;
      const stop = () => {
        stopped = true;
      };
      void (async () => {
        for (;;) {
          if (stopped) return;
          try {
            const page = await this.queryTable(name, { ...query, sinceRevision: revision });
            if (stopped) return;
            revision = page.tableRevision;
            failures = 0;
            onPage(page);
          } catch (error) {
            if (stopped) return;
            failures += 1;
            if (failures >= maxGetRetries + 1) {
              // Reconnect exhausted for this window: surface, reset the
              // counter, and keep the loop on backoff until unsubscribed.
              // The next successful poll re-lists from the last known
              // revision, so no change is silently skipped.
              onError(error instanceof Error ? error : new Error(String(error)));
              failures = 0;
            }
          }
          if (stopped) return;
          await sleep(pollMs * Math.min(failures + 1, 4));
        }
      })();
      return stop;
    },

    subscribeFiles(onFiles: (files: AppFileMeta[]) => void, onError: (error: Error) => void): () => void {
      let stopped = false;
      let lastKey: string | null = null;
      let failures = 0;
      const stop = () => {
        stopped = true;
      };
      void (async () => {
        for (;;) {
          if (stopped) return;
          try {
            const files = await this.listFiles();
            if (stopped) return;
            // Re-list recovery: after a transport outage the next successful
            // list is authoritative, so reconnect always re-emits the full
            // list (keyed by name@version) rather than a delta.
            const key = files
              .map((file) => `${file.name}@${file.version}:${file.status}`)
              .sort()
              .join("|");
            failures = 0;
            if (key !== lastKey) {
              lastKey = key;
              onFiles(files);
            }
          } catch (error) {
            if (stopped) return;
            failures += 1;
            if (failures >= maxGetRetries + 1) {
              onError(error instanceof Error ? error : new Error(String(error)));
              failures = 0;
            }
          }
          if (stopped) return;
          await sleep(pollMs * Math.min(failures + 1, 4));
        }
      })();
      return stop;
    },
  };
}
