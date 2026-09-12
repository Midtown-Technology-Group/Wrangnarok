// SPDX-License-Identifier: AGPL-3.0
// Browser App SDK provider and hooks (APP-02, issue #160; ADR 019).
//
// Maps the actual upstream V2 exports (client/src/lib/app-sdk/provider.tsx,
// use-table.ts, use-files.ts, use-workflow-hooks.ts at baseline 3543c7eb):
// scoped context/provider, workflow invocation/status/results, Tables, files,
// and subscriptions. Deliberately NOT mapped: Forms/config hooks (their own
// parity issues FORM-02/CON-02), WebSocket transports (polling instead, per
// OBS-02 first slice), and the v1 globalThis inline path (untouched).
//
// Shape contract (acceptance: "table flat-hook versus nested-imperative
// shape"): the imperative client (lib/app-runtime.ts) returns the nested wire
// shape { id, data, tableRevision, ... }; the useAppTable hook returns FLAT
// rows ({ ...data, id, tableRevision, ... }), matching upstream's
// flattenDocument where the snapshot and live updates share one flat shape.
// Query-only filters (nested operators) are rejected server-side with
// APP_TABLE_QUERY_UNSUPPORTED and surface here via error, never silently.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AppRuntimeOptions } from "./app-runtime";
import { createAppRuntimeClient } from "./app-runtime";
import type { AppFileMeta, AppTableRow } from "./client-types";

export type AppTheme = "light" | "dark";

const THEME_KEY = "wrangnarok.app-theme";

export interface AppRuntimeProviderProps extends AppRuntimeOptions {
  readonly children: ReactNode;
  /** Host-controlled theme seed. Omit to read the shared stored theme. */
  readonly theme?: AppTheme;
  readonly onThemeChange?: (theme: AppTheme) => void;
  /** Declares the app responds to theme changes (tokens key off `.dark`). */
  readonly supportsTheme?: boolean;
  /** In-app router basename the host mounted this app under. Passed through
   * so the authored app's router mounts under it. */
  readonly basename?: string;
  /** Called when the app requests logout. */
  readonly onLogout?: () => void;
}

export interface AppRuntimeContextValue {
  readonly baseUrl: string;
  readonly appId: string;
  readonly basename: string;
  readonly theme: AppTheme;
  readonly setTheme: (theme: AppTheme) => void;
  readonly toggleTheme: () => void;
  readonly supportsTheme: boolean;
  readonly logout: () => void;
}

const AppRuntimeContext = createContext<AppRuntimeContextValue | null>(null);

type StorageLike = { getItem(key: string): string | null; setItem(key: string, value: string): void };

function storage(): StorageLike | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // Non-browser render (SSR/tests): no stored theme, defaults apply.
  }
  return null;
}

/** Seed the theme: host prop wins, else the shared stored key, else light. */
export function readStoredTheme(initial?: AppTheme): AppTheme {
  if (initial === "light" || initial === "dark") return initial;
  const value = storage()?.getItem(THEME_KEY);
  if (value === "light" || value === "dark") return value;
  return "light";
}

/** Reflect the theme as the `dark` class on the document root. No-op off-DOM. */
export function applyThemeClass(theme: AppTheme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (theme === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
}

export function AppRuntimeProvider({
  baseUrl,
  token,
  appId,
  fetchImpl,
  onRefreshToken,
  onAuthFailure,
  maxGetRetries,
  pollMs,
  sleep,
  theme: themeProp,
  onThemeChange,
  supportsTheme = false,
  basename = "/",
  onLogout,
  children,
}: AppRuntimeProviderProps) {
  // One imperative client per provider mount (per-client state, no
  // module-global transport: repeat mount/unmount is naturally isolated).
  const client = useMemo(
    () =>
      createAppRuntimeClient({
        baseUrl,
        token,
        appId,
        fetchImpl,
        onRefreshToken,
        onAuthFailure,
        maxGetRetries,
        pollMs,
        sleep,
      }),
    // Token rotation flows through onRefreshToken, not through re-created
    // clients: re-creating per render would drop handshake state.
    [baseUrl, appId, fetchImpl],
  );
  void client;

  const [theme, setThemeState] = useState<AppTheme>(() => readStoredTheme(themeProp));
  useEffect(() => {
    applyThemeClass(theme);
  }, [theme]);
  // Follow the host if it drives the theme prop (derive-during-render, the
  // React-sanctioned previous-prop pattern; an effect sync would cascade).
  const [prevThemeProp, setPrevThemeProp] = useState(themeProp);
  if (themeProp !== prevThemeProp) {
    setPrevThemeProp(themeProp);
    if (themeProp && themeProp !== theme) setThemeState(themeProp);
  }

  const setTheme = useCallback(
    (next: AppTheme) => {
      setThemeState(next);
      try {
        storage()?.setItem(THEME_KEY, next);
      } catch {
        // Storage unavailable: in-memory theme still applies this session.
      }
      applyThemeClass(next);
      onThemeChange?.(next);
    },
    [onThemeChange],
  );
  const toggleTheme = useCallback(() => setTheme(theme === "dark" ? "light" : "dark"), [theme, setTheme]);
  const logout = useCallback(() => onLogout?.(), [onLogout]);

  const value = useMemo<AppRuntimeContextValue>(
    () => ({
      baseUrl: baseUrl.replace(/\/+$/, ""),
      appId,
      basename,
      theme,
      setTheme,
      toggleTheme,
      supportsTheme,
      logout,
    }),
    [baseUrl, appId, basename, theme, setTheme, toggleTheme, supportsTheme, logout],
  );
  return <AppRuntimeContext.Provider value={value}>{children}</AppRuntimeContext.Provider>;
}

/** Read the App SDK context. Throws outside a provider (authored apps must
 * wrap their root; the control-plane UI never calls this). */
export function useAppRuntimeContext(): AppRuntimeContextValue {
  const ctx = useContext(AppRuntimeContext);
  if (ctx === null) {
    throw new Error("useAppRuntimeContext must be used within an <AppRuntimeProvider>.");
  }
  return ctx;
}

/** Flat row as seen by useAppTable consumers: JSONB fields spread to the top
 * level alongside row metadata. The row id wins over a colliding data field. */
export type AppFlatRow = Record<string, unknown> & {
  readonly id: string;
  readonly tableRevision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export function flattenAppRow(row: AppTableRow): AppFlatRow {
  return {
    ...row.data,
    id: row.id,
    tableRevision: row.tableRevision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface UseAppTableQuery {
  readonly filter?: Record<string, string | number | boolean>;
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface UseAppTableResult {
  readonly rows: AppFlatRow[];
  readonly tableRevision: number | null;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly loading: boolean;
  readonly error: Error | null;
}

/** Live-updating Table hook with flat rows. Loads a snapshot, then polls
 * against the authoritative tableRevision; only changed windows re-render.
 * Query-only operators (nested filters) fail server-side with
 * APP_TABLE_QUERY_UNSUPPORTED and surface via error. */
export function useAppTable(
  clientOptions: AppRuntimeOptions,
  name: string,
  query: UseAppTableQuery = {},
): UseAppTableResult {
  const [rows, setRows] = useState<AppFlatRow[]>([]);
  const [tableRevision, setTableRevision] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const optionsRef = useRef(clientOptions);
  optionsRef.current = clientOptions;

  const filterKey = JSON.stringify(query.filter ?? null);
  const { filter, limit, cursor } = query;

  useEffect(() => {
    const client = createAppRuntimeClient(optionsRef.current);
    let cancelled = false;
    const stop = client.subscribeTable(
      name,
      { filter, limit, cursor, sinceRevision: null },
      (page) => {
        if (cancelled) return;
        setRows(page.rows.map(flattenAppRow));
        setTableRevision(page.tableRevision);
        setHasMore(page.hasMore);
        setNextCursor(page.nextCursor);
        setError(null);
        setLoading(false);
      },
      (cause) => {
        if (cancelled) return;
        setError(cause);
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
      stop();
    };
    // filterKey gives value-based change detection for inline literals.
  }, [name, filterKey, limit, cursor]);

  return { rows, tableRevision, hasMore, nextCursor, loading, error };
}

export interface UseAppFilesResult {
  readonly files: AppFileMeta[];
  readonly loading: boolean;
  readonly error: Error | null;
}

/** File list hook with reconnect re-list: after a transport outage the next
 * successful list is authoritative and re-emits the full list. */
export function useAppFiles(clientOptions: AppRuntimeOptions): UseAppFilesResult {
  const [files, setFiles] = useState<AppFileMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const optionsRef = useRef(clientOptions);
  optionsRef.current = clientOptions;

  useEffect(() => {
    const client = createAppRuntimeClient(optionsRef.current);
    let cancelled = false;
    const stop = client.subscribeFiles(
      (next) => {
        if (cancelled) return;
        setFiles(next);
        setError(null);
        setLoading(false);
      },
      (cause) => {
        if (cancelled) return;
        setError(cause);
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  return { files, loading, error };
}

export interface UseAppInvokeResult {
  readonly executionId: string | null;
  readonly status: string | null;
  readonly result: unknown;
  readonly error: unknown;
  readonly running: boolean;
  readonly invokeError: Error | null;
  readonly invoke: (sagaId: string, input?: unknown, key?: string) => Promise<void>;
  readonly reset: () => void;
}

/** Workflow invocation hook: invoke (caller Idempotency-Key) then poll to a
 * terminal status. POST side effects are never retried blindly; a failed
 * invoke surfaces and the caller re-invokes explicitly. */
export function useAppInvoke(clientOptions: AppRuntimeOptions): UseAppInvokeResult {
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const [running, setRunning] = useState(false);
  const [invokeError, setInvokeError] = useState<Error | null>(null);
  const optionsRef = useRef(clientOptions);
  optionsRef.current = clientOptions;
  const cancelledRef = useRef(false);
  useEffect(
    () => () => {
      cancelledRef.current = true;
    },
    [],
  );

  const invoke = useCallback(async (sagaId: string, input: unknown = {}, key?: string) => {
    const client = createAppRuntimeClient(optionsRef.current);
    setRunning(true);
    setInvokeError(null);
    setError(null);
    setResult(null);
    try {
      const receipt = await client.invokeSaga(sagaId, input, key);
      if (cancelledRef.current) return;
      setExecutionId(receipt.executionId);
      const settled = await client.pollExecution(receipt.executionId);
      if (cancelledRef.current) return;
      setStatus(settled.status);
      setResult(settled.result);
      setError(settled.error);
    } catch (cause) {
      if (cancelledRef.current) return;
      setInvokeError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      if (!cancelledRef.current) setRunning(false);
    }
  }, []);

  const reset = useCallback(() => {
    setExecutionId(null);
    setStatus(null);
    setResult(null);
    setError(null);
    setInvokeError(null);
  }, []);

  return { executionId, status, result, error, running, invokeError, invoke, reset };
}
