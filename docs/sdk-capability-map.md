# SDK capability map: upstream Python SDK to Wrangnarok TypeScript

DEV-01 (issue #140). Baseline: upstream `gobifrost/bifrost@3543c7ebee0e1bd9a2cab6dfba080a30621b1c5f`
vs Wrangnarok `32dabf88e4d362798845c96dae1c14aac279ca49`. Upstream sources were
inspected, not executed; no upstream production instance was used.

Parity means equivalent supported user/operator capabilities with explicit
TypeScript/Cloudflare adaptations. **Python import or wire compatibility is not
promised.** Status vocabulary follows `docs/upstream-parity.md`: **Supported**
(shipped locally), **Partial** (materially narrower), **Tracked** (owned by a
different parity issue, not this SDK), **Missing** (absent).

## 1. SDK module surface (`api/bifrost/__init__.py` vs `src/sdk.ts`)

Upstream exports lazy/eager SDK modules plus models, decorators, execution
context, and typed errors. Wrangnarok maps them as follows:

| Upstream (`api/bifrost/*`) | Wrangnarok TypeScript | Status | Notes |
| --- | --- | --- | --- |
| `workflows` (list, metadata) | `listSagas` / `inspectSaga` in `src/sdk.ts` over `GET /api/sagas` | Supported | Git-owned static Catalog (ADR 002), not a runtime registry. |
| `workflows` runtime policy (timeouts, retries, pause/admission) | `getSagaPolicy` / `updateSagaPolicy` in `src/sdk.ts` over `GET/PUT /api/sagas/:id/policy`; CLI `saga-policy` / `saga-policy-set` | Supported | Persisted per-Saga runtime policy (RUN-01, issue #135, ADR 018): operator inspect/change independent of source, applied snapshots on Execution detail. Writes are Organization-admin (or instance admin); ordinary members read only. |
| `executions` (list) | `listHistory` / `getExecution` over `GET /api/executions[/:id]` | Supported | Summaries only on list; input/result only on detail. Cursor pagination. |
| `workflows.execute` + WebSocket tail | `submitExecution` over `POST /api/executions` + terminal poll; author logs via `tailLogs`/`searchLogs` over `GET /api/executions/:id/logs` and `GET /api/logs` | Partial | Submit returns 202 + `statusUrl`; the client polls to terminal. Author logs are durable D1 rows with cursor-poll reconnect (no WebSocket/log stream; live-push needs an earned ADR). |
| `workflows` cancel | `cancelExecution` over `POST /api/executions/:id/cancel` | Supported | Owner-only, exact 64-hex ID; same caller policy as the UI. |
| `@workflow` decorator + `context` / `ExecutionContext` | `defineSaga` + `SagaStep` (`step.do`/`step.sleep`) in `src/saga.ts` | Supported | Determinism rules enforced by `test/saga-contract.test.ts`. |
| `data_provider` decorator | None | Tracked | Bounded sync/provider execution belongs to RUN-03. |
| `tool` decorator (opt-in agent tools) | None | Tracked | Opt-in tool exposure belongs to TOOL-01. |
| Input validation, defaults, output metadata | `validateAgainstSchema` + `IoSchema` + per-Saga `parse` | Partial | Hand-derived object schemas (no codegen dependency); server `parse` stays authoritative. Defaults beyond schema `required` are not modeled. |
| `config` (get/set/list) | `listConfigs` / `setConfig` / `updateConfig` / `deleteConfig` in `src/sdk.ts` over `GET/POST /api/config`, `PUT/DELETE /api/config/:id` | Supported | Scoped config (CON-02, ADR 020): typed string/int/bool/json plus secret references, org-only resolution, `[SECRET]` masking, managed-row ownership. No global tier by design. |
| `integrations` (+ OAuth tokens) | `IntegrationDefinition` in `src/integrations/index.ts`; no management API | Tracked | Connection management belongs to CON-01; OAuth lifecycle to OAUTH-01. |
| `organizations`, `roles`, `users` | None | Tracked | Organization/user/role lifecycle belongs to AUTH-01/AUTH-02. |
| `tables` | None | Tracked | Author Tables belong to TABLE-01 (#117) and TABLE-02. |
| `forms` | `listForms` / `getForm` / `createForm` / `updateForm` / `deleteForm` / `startForm` / `getFormProviders` / `submitForm` in `src/sdk.ts` over `GET/POST /api/forms`, `GET/PUT/DELETE /api/forms/:name`, `POST /api/forms/:name/startup`, `GET /api/forms/:name/providers`, `POST /api/forms/:name/submit` | Supported | Dynamic forms (FORM-02, issue #155): designer CRUD, startup handles (peeked for validation, consumed only after validation passes), providers, submit/schedule. Embed/publication stays Tracked under EMBED-01. |
| `files`, `artifacts` | `listArtifacts` / `fetchArtifactDetail` / `deleteArtifact` / CLI `artifacts artifact upload download rename bind unbind bindings retention cleanup` over `/api/artifacts/*` | Partial | Generated/uploaded Artifacts ship (FILE-02, ADR 019); managed file locations with signed URLs belong to FILE-01. |
| `files`, `artifacts` | Managed file locations over `GET/POST/PUT/DELETE /api/files*` + `/api/file-locations*` + `/api/file-policies*` | Partial | FILE-01 ships locations, policies, proxy upload/download, finalize verification, versioned mutation (ADR 019); retention/artifacts stay Tracked under FILE-02. |
| `knowledge` | None | Tracked | Knowledge/memory belongs to AI-05/AI-06. |
| `agents`, `ai` (complete/stream) | None | Tracked | Agents/AI belong to AI-01/AI-02/AI-03. |
| `events` (sources/subscriptions) | None | Tracked | Events belong to TRG-03. |
| Typed errors (`UserError`, `WorkflowError`, `ValidationError`, ...) | `SdkError` + `SDK_ERROR_CODES` in `src/sdk.ts` | Supported | Same envelope `{ error: { code, message } }`; callers switch on `code`. |
| Enums (`ExecutionStatus`, `ConfigType`, `FormFieldType`) | `SDK_TERMINAL_STATUSES`, `SDK_ERROR_CODES`, `ExecutionStatus` in `src/domain.ts` plus `FORM_FIELD_TYPES` in `src/forms.ts` | Supported | Statuses, error codes, and the closed 17-type form field set are modeled; config types stay with CON-02. |
| SDK models (single source of truth) | Wire guards (`parseSagaCatalog`, `parseExecutionDetail`, `parseHistoryPage`, `parseFormList`, `parseFormDetail`, `parseFormStartup`, `parseFormProviders`, `parseFormSubmit`) | Supported | Guards fail loud with `SDK_CLIENT_MISMATCH` instead of trusting the wire. |

## 2. CLI surface (`api/bifrost/cli.py` vs `scripts/wrangnarok.mjs`)

Upstream `bifrost` commands: `sync`, `run`, `git`, `push`, `pull`, `solution`,
`app`, `deploy`, `watch`, `api`, `migrate-imports`, `skill`, `login`,
`update`, `logout`, `auth`, `help`, plus entity mutation groups (`orgs`,
`roles`, `workflows`, `forms`, `agents`, `apps`, `claims`, `integrations`,
`configs`, `tables`, `files`, `events`, `policy-rule`, `requirements`).
Wrangnarok is a thin Worker-API CLI (no Saga logic, same caller policies as
the UI: Bearer token, Organization from auth context, exact IDs only):

| CLI capability | Wrangnarok command | Status |
| --- | --- | --- |
| `workflows list` (`GET /api/workflows`) | `sagas` (`GET /api/sagas`) | Supported |
| `workflows get <ref>` (list-and-filter; no per-record GET upstream) | `inspect --saga NAME\|UUID` (`GET /api/sagas` + local resolve) | Supported |
| `workflows execute <ref>` + log tail | `submit --saga NAME\|UUID [--input JSON\|@FILE] [--key KEY] [--no-wait]` (202 + poll to terminal); `logs --id HEX [--level L] [--follow]`, `log-search [--level L] [--saga NAME\|UUID] [--from DATE] [--to DATE]` (cursor-poll over durable rows) | Partial (poll, no log stream) |
| `workflows update/delete/grant-role/revoke-role` | None (Git-owned registration; no runtime mutation) | Tracked (AUTH-02 for grants) |
| `workflows register` (workspace `.py` file) | `scaffold --name SLUG --id UUID` (offline `defineSaga` template; registration stays Git-owned) | Partial (adapted: no runtime registration by design) |
| `run` (direct local workflow file, silent JSON) | `preview --saga NAME\|UUID [--input JSON\|@FILE] [--check-env]` (read-only `POST /api/dev/preview`: authoritative parse, no D1 writes, no dispatch) | Supported (adapted: `wrangler dev` is the edit loop; preview is the validation loop) |
| Execution detail/history/cancel | `detail --id HEX [--wait]`, `history [--status S] [--saga NAME\|UUID] [--limit N]`, `cancel --id HEX` | Supported |
| Failure diagnosis | `diagnose --id HEX` (detail + operations + hint for known codes) | Supported |
| `solution/app/deploy/push/pull/sync/watch/git` | `preview` over `POST /api/dev/preview` plus offline sync/Git/lock/deploy checks in `src/dev.ts` (`planSync`, `parseGitTarget`, `validateLockfile`, `validateDeploy`); full Solution/app lifecycle stays with SOL-01/APP-01 | Partial (DEV-02 slice: local preview + validation; hosted Git/package/deploy lifecycle not in scope) |
| `login/logout/auth` (device-code, password-grant, keychain) | `--token` / `$WRANGNAROK_TOKEN` / `.dev.vars` LAB_TOKEN plus Access service-token headers | Partial (adapted: Access is the identity source per ADR 014; no local password DB per AUTH-03) |
| `api` (generic authenticated request) | None (every command is a fixed typed call) | Missing (deliberate: boring typed APIs over a generic escape hatch) |
| Entity groups (`orgs/roles/forms/agents/apps/claims/integrations/configs/tables/files/events/policy-rule/requirements`) | None | Tracked (owning parity issues; never declared complete here) |

Noninteractive use: every command runs without a TTY; `--json` emits
machine-readable output; failures print `WRANGNAROK_CLI <CODE>: <message>`
with exit 2 for usage errors and exit 1 otherwise. `test/cli.test.ts`
pins the offline selftest shapes; `test/sdk.test.ts` pins the served
contract.

## 3. Routers (`api/src/routers/cli.py`, `docs.py`, `decorator_properties.py`)

| Upstream router | Wrangnarok mapping | Status |
| --- | --- | --- |
| `cli.py` (CLI-facing API surface) | `scripts/wrangnarok.mjs` over the same `/api/*` routes as the UI | Supported for Sagas/Executions; Tracked for entity modules |
| `audit.py` (admin audit log) | `GET /api/audit` + `audit` CLI command (`src/ops.ts`, ADR 020) | Supported (adapted: org-scoped reads until AUTH-02 roles; no superuser gate yet) |
| `notifications.py` (notification inbox) | `GET/DELETE /api/notifications[/:id]` + `notifications`/`notification`/`dismiss-notification` CLI commands | Supported (adapted: durable D1 rows instead of Redis TTLs; poll instead of WebSocket; no upload-lock endpoints) |
| `docs.py` (`GET /api/llms.txt`: full platform docs as one document) | `GET /api/sdk` (versioned contract descriptor) + `docs/sdk.md` + `AGENTS.md` | Partial (adapted: a versioned contract plus author docs instead of one concatenated document) |
| `decorator_properties.py` (workflow decorator metadata) | `CatalogEntry` + `IoSchema` + `validateSagaDefinition` | Supported (identity/discovery only; operational policy stays out of source per upstream finding 3) |

## 4. Upstream test (`api/tests/unit/test_cli_solution_run.py`)

Upstream proves `bifrost run` resolves solution-local imports from a
subdirectory with no network. The Wrangnarok analogue is the offline author
loop: `scaffold` emits a self-contained `defineSaga` module, `inspect` and
`validateAgainstSchema` run with no network, and `test/sdk.test.ts` proves
the scaffold markers, schema validation, and error shapes against the real
local Catalog and Worker. No network, no deployment, same guarantee: the
author loop works from a fresh checkout.
