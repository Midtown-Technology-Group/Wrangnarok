# Browser App SDK runtime (APP-02)

Authored apps run in the browser against scoped Worker routes through the
typed client in `client/src/lib/app-runtime.ts` (imperative) and
`client/src/lib/app-provider.tsx` (provider + hooks). Design authority is
ADR 019; this page is operator and migration notes.

## Wire map (upstream V2 baseline `3543c7eb`)

| Upstream (`client/src/lib/app-sdk/*`) | Wrangnarök | Notes |
| --- | --- | --- |
| `index.v2.ts` package surface | `client/src/lib/app-runtime.ts` + `app-provider.tsx` | Same export shape (provider, workflow hooks, table hook/files hook, subscription); no bundled npm package (ADR 019 exception 2). |
| `wire-surface.ts` + `sdk-contract.test.ts` tripwire | `GET /api/apps/:id/sdk` handshake + `APP_SDK_VERSION` | Version tripwire, not file-hash tripwire. Client asserts before first scoped call; drift is `APP_SDK_MISMATCH`. |
| `provider.tsx` `BifrostProvider` | `AppRuntimeProvider` | Authed fetch, install/org/app context, theme, logout, bounded one-401 refresh. No `globalThis` platform bridge. |
| `use-workflow` run/status/result | `invokeSaga` + `pollExecution` + `useAppInvoke` | POST invoke (caller `Idempotency-Key`) then terminal poll. No WebSocket. |
| `use-table` + `tables.ts` | `queryTable`/`insertRow`/`patchRow`/`deleteRow` + `subscribeTable` + `useAppTable` | Bounded equality reads; revision polling; flat hook rows vs nested imperative shape. |
| `use-files` + `files.ts` | `uploadFile`/`downloadFile`/`deleteFile` + `useAppFiles` | Single-use tokens in `X-File-Token`; finalize-after-upload verification. |
| Forms/config hooks | None | FORM-02 / CON-02 own them; nothing invented here. |

## Migration notes (SDK v1)

- `APP_SDK_VERSION` is `"1"`. Any breaking change to the runtime routes, the
  handshake shape, or these exports bumps it **and** the served handshake
  together; a mismatch fails the next scoped call with `APP_SDK_MISMATCH`.
- Shape contract: the imperative client returns nested wire rows
  (`{ id, data, tableRevision, ... }`); `useAppTable` returns flat rows
  (`{ ...data, id, tableRevision, ... }`, row id wins collisions). Pick one
  per call site; the hook never returns the nested shape.
- Retry contract: GET retries bounded (network/503); mutations never retry.
  Invoke reuses the caller key for safe caller-driven retry. PATCH failures
  mean re-list and reconcile; the client will not replay a blind PATCH.
- Auth contract: one 401 triggers one token rotation and one retry. A second
  401 (or no rotation) surfaces and runs `onAuthFailure`. There is no refresh
  loop by construction.
- Subscription contract: pollers back off on failure, re-list from the last
  known revision on reconnect, and stop fully on unsubscribe. Mounting twice
  creates two independent pollers; unmounting one never disturbs the other
  (per-client state, no module-global transport).
- Query limits: exact-match equality on top-level fields only (8 clauses,
  `limit` 1–100). Nested operators fail with `APP_TABLE_QUERY_UNSUPPORTED`:
  split into a query-only call pattern or wait for TABLE-02. Hidden Tables and
  ungranted refs fail 403/404 even if the client already knows their names.
- Files: 32 KiB cap, `pending` until verified bytes land, single-use tokens
  (one header, one call, never query strings). Stale versions conflict (409):
  re-list and retry with the fresh version.

## Host bootstrap checklist

1. Create the app (author API), declare Tables/files, create grants.
2. Serve the authored bundle with `baseUrl` (Worker origin, no trailing
   slash), the Organization bearer `token`, and the installed `appId`.
3. Wrap the app root in `<AppRuntimeProvider basename={mountPath}>` so the
   authored router mounts under the host path.
4. Theme: pass the host theme in (or let the provider read the shared stored
   key); set `supportsTheme` only if the app keys tokens off `.dark`.
5. Logout: pass `onLogout`; the provider calls it on definitive auth failure.
