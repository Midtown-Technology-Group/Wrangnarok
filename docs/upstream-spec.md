# Upstream Bifrost capability map

Wrangnarök is AGPL-3.0 and treats `gobifrost/bifrost` as its reference product. This document extracts behavioral contracts and product invariants rather than assuming upstream infrastructure should be reproduced.

Status vocabulary: **Adopt** preserves the product capability; **Adapt** preserves intent with a Cloudflare-native model; **Defer** is useful but not required yet; **Reject** is intentionally outside this experiment; **Investigate** needs more evidence.

## Current audit baseline (2026-09-11)

The current reference is legitimate upstream `gobifrost/bifrost` commit `3543c7ebee0e1bd9a2cab6dfba080a30621b1c5f`, not the similarly named AI gateway or a workspace/userland repository. See [the full parity map](upstream-parity.md) for capability-level implementation status, source/test evidence, issue ownership and explicit adaptations. **Adopt/Adapt are intent, not completion claims.**

This audit corrects several earlier summaries below. Findings 16–18 retain historical `0598020e` observations except where explicitly corrected; their old paths/line numbers must not be treated as current evidence. The parity map supplies current paths, including `api/shared/form_runtime.py`, `api/bifrost/decorators.py`, and `api/src/services/mcp_server/`. Selected source/tests were inspected, not an upstream production instance or a passing upstream test run.

| Upstream capability | Status | Wrangnarök direction | Candidate Cloudflare primitive |
| --- | --- | --- | --- |
| Code-first workflows | **Adopt** | TypeScript **Sagas** | Workflows |
| Workflow executions | **Adapt** | **Executions** with durable Operations | Workflow instances + D1 ExecutionHistory |
| Stable workflow identity | **Adopt** | Source edits must not silently mint a new Saga identity | D1 catalog + source metadata |
| Workflow discovery metadata | **Adopt** | Name, description, category/tags or equivalent | D1/catalog |
| Reusable integrations | **Adopt** | Typed **Integrations** | Worker TypeScript modules |
| Multi-tenancy / organizations | **Adopt** | **Organizations** | D1 initially |
| Explicit access boundary | **Adopt** | A caller must be authorized through the complete dependency chain | Worker auth + D1 policies/application checks |
| Connection/config management | **Adopt** | **Connections** scoped/resolved through Organizations | D1 + secret mechanism |
| OAuth management / refresh | **Defer** | Integration-specific auth contract with common lifecycle helpers | Worker + D1/secrets |
| Secret management | **Adapt** | v0 Accepted (ADR 005, owner-approved 2026-09-10 per issue #78): deployment-level Secrets Store credentials plus org-scoped non-secret Connection mapping with scrub discipline retained; per-Organization envelope encryption is tripwire-gated, not v1 | Secrets Store + D1 |
| Dynamic forms | **Defer** | Form field names bind to Saga inputs | Worker + static UI + D1 |
| Tables / application storage | **Adapt** | JSON/document-like author storage over D1, if justified | D1 |
| Row-level authorization/policies | **Defer / Investigate** | Preserve deny-by-absence and tenant-safe query semantics if Tables ship | Application policy layer over D1 |
| Triggers/events | **Adopt** | **Triggers** include HTTP/webhook, schedule, and potentially topic events | Worker / Cron / Workflows |
| Topic emission/subscription | **Defer** | Preserve event decoupling only if needed | Queues / Workflows |
| Async execution queue | **Adapt** | Workflows first; Queue only for real broker/backpressure semantics | Queues if earned |
| Cache/session layer | **Reject as required architecture** | Add caching only for demonstrated need | KV / Cache API / DO if earned |
| Object/file storage | **Defer** | **Artifacts** with explicit ownership/access boundaries | R2 |
| Scheduler service | **Adapt** | No persistent scheduler process | Cron Triggers / Workflows |
| Persistent worker processes | **Reject** | Execution lives in Cloudflare primitives | Workers / Workflows |
| Local source execution | **Adopt** | Fast local execution without registration/deploy should remain possible | Wrangler/local runtime |
| Hot reload | **Adapt** | Standard local Worker development | Wrangler |
| Portable bundles / Solutions | **Defer but important** | One source definition installable into multiple Organizations; separate source from environment state | Git + manifests + D1 install state |
| Deploy-owned vs loose entities | **Investigate** | Upstream distinction is valuable but may be too heavy for early Wrangnarök | Catalog/manifests |
| Git-based management | **Adopt** | Sagas and Integrations are ordinary version-controlled TypeScript | GitHub |
| AI-assisted development | **Adopt as philosophy** | Types, docs, tests, and boring APIs should be agent-friendly | TypeScript |
| Monitoring / execution history | **Adopt** | **ExecutionHistory** | D1 + Workers observability |
| Agents / tool workflows | **Defer** | A Saga may eventually opt into tool exposure; normal Sagas remain distinct | Workers AI / external model APIs later |
| Self-host anywhere | **Reject** | This experiment is intentionally Cloudflare-native | Cloudflare |
| PostgreSQL / Redis / RabbitMQ | **Reject as dependencies** | Port behavior, not products | Native primitives as earned |
| Docker Compose deployment | **Reject** | Deployment target is Cloudflare | Wrangler |

## Behavioral findings from upstream

### 1. Code-first automation is a core invariant

Upstream workflows are ordinary async Python functions whose typed function signature defines inputs and whose result must be serializable. The decorated workflow should remain thin: validate input, orchestrate reusable module behavior, and shape output. Reusable integration/domain logic belongs outside the workflow body.

**Wrangnarök implication:** Sagas should be ordinary TypeScript, not serialized workflow definitions. Type inference/schema generation should derive as much as practical from code. Integration logic should remain independently testable.

### 2. Source identity and persisted execution identity are separate

Upstream registers a callable as a stable, scoped, permissioned workflow record. Editing its implementation preserves registration. Moving/renaming has explicit replacement/remap behavior because blindly re-registering creates a new UUID and breaks dependents.

**Wrangnarök implication:** do not equate `export function foo` with durable identity. A Saga needs stable identity independent of source edits, and references from Triggers/forms/etc. should survive implementation changes. Exact registration UX is TBD.

### 3. Runtime policy is environment state, not source decorator trivia

Upstream source-level workflow metadata is intentionally limited to identity/discovery. Timeouts, schedules, endpoints, access, retries, cache behavior, and similar operational configuration live on persisted entities rather than being baked into decorators.

**Wrangnarök implication:** keep the TypeScript Saga authoring contract small. Avoid stuffing Cloudflare deployment/runtime knobs into `saga()` just because they are available.

### 4. Local execution without registration is valuable

Upstream explicitly supports executing local workflow source without registration and separately executing registered workflows. Solution preview runs local code while using real environment resources and authorization.

**Wrangnarök implication:** `wrangler dev` should eventually support a fast local Saga loop. Do not make every edit require a deploy or D1 registration round trip.

### 5. Tenant scope is a dependency-chain property

Upstream organizations are tenant boundaries. Apps/forms/workflows/resources each carry scope/access, and successful admin execution does not prove an ordinary caller can traverse the dependency chain.

**Wrangnarök implication:** Organization context should be explicit and propagated through Executions, Integration Connection resolution, Tables, and Triggers. Tests need representative allowed and denied non-admin/non-owner callers once auth exists.

### 6. Integrations separate service definition from tenant mapping

Upstream Integration entities define a service/config schema; organization mappings bind them to tenant-specific OAuth/config state. Packages declare requirements but do not carry environment credentials.

**Wrangnarök implication:** distinguish **Integration** (code/service definition) from **Connection** (environment/Organization-specific configuration and credentials). Portable Saga code must never embed Connection state. Working dependencies do not guarantee connectivity: each Integration must document allowed outbound hosts, redirect/timeout/byte-bound policy, and non-HTTP / private-registry / IP-allowlist limits, with per-Operation timeout/retry/concurrency caps stated explicitly rather than inherited from host behavior.

### 7. Events are source + subscription, not merely cron annotations

Upstream event sources include schedule, webhook, and topic. A subscription targets one workflow or agent, and topic events carry metadata/payload into execution context.

**Wrangnarök implication:** Trigger should remain a first-class domain concept rather than becoming `cron` metadata on a Saga. MVP only needs HTTP initiation, but the model should not preclude schedules/webhooks/topics.

### 8. Tables are JSON-document storage with policy semantics

Upstream Tables store JSON documents, support filtering/querying, and attach row-level policies. Schema/declaration is source/deploy state while rows are environment data. Fresh resources are effectively deny-by-absence for ordinary users until policy is defined.

**Wrangnarök implication:** if user-facing Tables are implemented, they are not merely direct D1 access. They need a stable author API, explicit schema/declaration vs row-data separation, and authorization semantics. This is post-MVP. Phase 4 acceptance must additionally cover: atomic authorization of batch writes, explicitly managed indexes for arbitrary JSON queries (no PostgreSQL JSONB assumptions), counts/pagination over filtered history, per-subscriber visibility transitions and revocation handling, and a retention/partitioning policy for the D1 10 GB per-database limit with cross-database no-transaction semantics stated.

### 9. Portable product definition is distinct from an installation

An upstream Solution is a portable source definition containing apps, workflows, forms, agents, table/config declarations, claims, and declared file locations. One definition can be installed in many organizations. Each install has independent identity, scope, environment configuration, and runtime data. Shareable exports exclude secrets/table rows/runtime file bytes.

**Wrangnarök implication:** this distinction is worth preserving eventually. A portable bundle should not contain Organization-specific Connection credentials or mutable environment data. Do not prematurely make Git repository == tenant installation. Activation of a new bundle version must be atomic (persist inputs/outputs outside execution, then flip version with rollback path), and published assets need explicit authorization, version activation/rollback, and cache invalidation — interrupted work restarts from the beginning, never from a half-activated state.

### 10. Managed ownership has consequences

Upstream Solution-owned entities are deploy-managed; live mutation is blocked. Loose entities can be manipulated directly. Deploy is full replacement/reconciliation of managed definitions, while environment data follows separate preservation rules.

**Wrangnarök implication:** there is a useful invariant here—declaratively managed resources should not drift through ad-hoc mutation—but reproducing the full loose-vs-managed system may be excessive. Investigate after the MVP slice.

### 11. Shared-resource fallback is explicit and bounded

Upstream can allow a Solution to fall back to eligible shared workflows/tables/files/modules, but this does not grant arbitrary cross-tenant access. Shared table fallback is read-only, normal policy remains active, and configs/integrations have separate resolution rules.

**Wrangnarök implication:** do not build magical global fallback early. If shared Integrations/resources arrive later, define lookup order and write boundaries explicitly.

### 12. Agents are consumers of explicitly exposed tools

Upstream distinguishes normal workflows from tool workflows exposed to agents. Tool naming/description must be sufficiently distinctive for deferred discovery, and server-side permissions remain authoritative even when an agent can discover a tool.

**Wrangnarök implication:** future AI/tool exposure should be opt-in metadata on suitable Sagas/Actions, not the default execution model.

### 13. First real vendor: NinjaOne (Rung 1, verified live 2026-09-09)

Auth is OAuth2 client-credentials M2M app, sysadmin-created via the API Services platform. Token host is regional `us2.ninjarmm.com/oauth/token`; central `app.ninjarmm.com` does not know us2 clients (returns API-envelope `Client-app-not-exist`). The `scope` parameter is mandatory; `monitoring` is granted while `management` is rejected for a read-only app. Token shape is `{access_token (87 chars observed), expires_in 3600, token_type Bearer}`; tokens are re-requested per execution with no caching yet.

API base is `https://us2.ninjarmm.com/api` with `/v2/organizations`; both `/api/v2` and `/v2` paths route on us2 (verified via error-envelope discrimination, no creds).

The response is a bare JSON array of organizations (297 observed, ~24KB); entries are `{id number, name string}`; results are shaped to count plus max 25 persisted (4KB D1 result bound) with a 256KB transport cap for this call.

Error mapping used: 401 `NINJA_UNAUTHORIZED`, 429 `NINJA_RATE_LIMITED`, 5xx `NINJA_VENDOR_FAILED`, non-array `NINJA_BAD_RESPONSE`, 3xx rejected (workerd has no `redirect:error`), slow vendor/abort `NINJA_VENDOR_TIMEOUT` (explicit 5s deadline per call; Sagas route it to the `timeout-mark-v1` checkpoint, never inferred).

Runtime facts: workerd `fetch` rejects `redirect:error` (use `manual` plus explicit 3xx handling); cross-realm `Request` construction from Workflow-isolate init fails (read headers directly); D1 `exec()` rejects leading SQL comments.

**Wrangnarök implication:** derive the token host from the Connection endpoint (region-portable, no per-region code). Pin OAuth scope as the least-privilege precedent for future OAuth work. Shape and count-cap vendor list responses before persisting; never assume small.

### 14. Execution state, retry, timeout and cancellation (corrected 2026-09-11)

At `3543c7e`, the status vocabulary includes `Scheduled`, `Pending`, `Running`, `Success`, `Failed`, `Timeout`, `Stuck`, `CompletedWithErrors`, `Cancelling`, and `Cancelled` (`api/src/models/enums.py`). A returned `{success: false}` can produce `CompletedWithErrors` (`api/src/services/execution/engine.py:408-439`). Wrangnarök's narrower taxonomy remains an explicit adaptation.

**Pending is not universally unswept upstream.** `api/src/jobs/schedulers/execution_cleanup.py:31-44,73-83,119-177` identifies database Pending rows older than ten minutes by `started_at` and writes Timeout. This observation does not imply every Redis-only receipt is swept. Wrangnarök's no-Pending-sweeper rule remains a deliberate local safety choice.

The previous `ExecutionRetryPolicy`/maximum-two/engine-loss-only attribution was not corroborated in current upstream. `api/src/models/contracts/workflows.py:91-95` calls `retry_policy` future use, and the workflow router emits `retry_policy=None`. Broker publication retries (`api/src/jobs/rabbitmq.py:612-695`), drain requeue, processing failures with `requeue=False` (`:255-281`), durable checkpoint retries and vendor retries are distinct concerns. The local ceiling of two for eligible idempotent checkpoints is local policy, not a proven upstream contract.

The deferred promoter commits Scheduled-to-Pending **before** publishing and best-effort reverts on publication failure (`api/src/jobs/schedulers/deferred_execution_promoter.py:9-17,48-105`). The inspected completion update (`api/src/repositories/executions.py:180-194,267-272`) does not establish a universal matching-attempt-token predicate. Do not attribute the earlier advisory-lock/attempt-token/broker-confirm protocol to current upstream without additional evidence.

Cancellation has owner/admin authorization and distinct scheduled/pending/running paths (`api/src/routers/executions.py:588-642`, `api/src/routers/workflows.py:1108-1190`). Current local code attempts native termination and fences D1 writes, but a swallowed termination failure is not proof of physical stop. The parity map tracks that local follow-up separately from status-name compatibility.

**Wrangnarök implication:** preserve existing idempotency, conservative vendor retries, explicit `Cancelling`, conditional terminal writes and refusal of fabricated success. Correct their provenance rather than weakening working safety rules to imitate upstream. Runtime policy, synchronous invocation, scheduling, partial-success and recovery gaps have explicit parity issues.

### 15. Integration SDK and OAuth contracts (upstream sweep, Sep 2026)

The SDK is workflow-facing, not vendor-facing: `@workflow`/`@tool` decorators, typed errors, and `integrations.get(name, scope, oauth_scope)` with decrypted secrets auto-registered for log scrubbing. There are deliberately **no** request/response normalization or pagination helpers — vendor calls are raw workflow HTTP plus OAuth URL templating and config merge. Vendor-call discipline comes from elsewhere: a concurrency admission slot (fail-closed, never retries the vendor op), GET-only 5xx retry, 10s timeouts with backoff, and 4xx-no-retry.

OAuth storage splits portable from per-organization state: global providers/tokens (null org) carry defaults; per-org rows carry overrides; client secrets and tokens are Fernet-encrypted while names, URLs, scopes, and expiry stay plaintext. Refresh runs in one shared primitive used by the scheduler (15-minute cadence, refresh within 20 minutes of expiry), the on-demand endpoint, and inline client-credentials auto-refresh; failures mark the token failed and emit events. **Correction at `3543c7e`:** a blanket configured-scope subset restriction is not supported by the inspected SDK path. `api/src/routers/cli.py:148-182,863-939` uses `oauth_scope` to request a fresh token for a different resource audience; `api/tests/unit/routers/test_cli_auto_refresh.py:284-336` explicitly exercises Graph-to-Exchange scope replacement. OAuth resource scopes are not Organization authorization scope.

Portable definitions declare needs (`SolutionConnectionSchema`); resolution falls back org row → defaults, org overrides winning, token mapping → org token → most-recent global token. Requirement failures are loud when declared (HTTP 424) and silent (`None`/404) when undeclared; 403s propagate.

**Wrangnarök implication (feeds Phase 3):** preserve the declared-required versus optional-missing split rather than a uniform `CONNECTION_NOT_CONFIGURED`; local required failures currently surface inside ExecutionHistory, not as submit-time HTTP 424. Put refresh in one shared primitive with per-Connection status. Specify audience/scope overrides and an auditable lookup order explicitly; a local subset restriction would be a deliberate divergence, not an upstream invariant. ADR 005's accepted provider-global v0 and per-Organization-secret tripwire remain in force.

### 16. Files/artifacts: policy-checked URLs, finalize-after-PUT, versioned deletes (upstream sweep, Sep 2026)

All pins at vendor/upstream commit `0598020e` (2026-09-04).

Uploads and downloads go through server-minted presigned S3 URLs, never through the API process as a pipe: `PUT`/`GET` URLs are generated only after per-action policy checks (`signed_get`, `signed_put`, `delete`) scoped by location, org scope, and path, with declared-solution-location requirements on writes (`api/src/routers/files.py:922-1029`). URL expiry is bounded 1 second to 7 days, default 600 (`files.py:165-184`); batch issuance caps at 100 with per-path allow/deny results (`files.py:187-205,1737-1747`).

Reads tier across scopes with an existence-first match — the shared read-only fallback pattern, again (`files.py:942-986`). Writes require a declared location plus policy. A browser `PUT` is not trusted until the client finalizes it with asserted metadata (path, content-type, size, sha256: `SignedUploadCompleteRequest`, `files.py:208`).

Deletes are policy-checked, mutation-locked, and optimistic-versioned: missing file or stale version answers `409` (`file_missing`, `version_conflict`) rather than silently succeeding (`files.py:1306-1365`). Retention is opt-in scheduled cleanup, default 90 days, range 1–3650 (`api/src/models/contracts/artifact_retention.py:6-21`; `api/src/routers/maintenance.py:60-122`). Size caps are per-surface, not global: logos 5 MB (`routers/branding.py:28`), avatars 2 MB (`routers/profile.py:27`), form file fields enforce per-field `max_size_mb` (`routers/forms.py:1937-1942`), chat caps attachments per message. Large objects stream via multipart without full-memory retention (`api/src/services/file_storage/s3_client.py:215-280`). File policies are CRUD-managed with pubsub invalidation (`files.py:881-919`); structural listing is admin-only (`files.py:218-228`); a policy access-test endpoint exists (`files.py:249-264`).

**Wrangnarök implication (feeds Phase 4):** Artifacts stay Deferred, but the required shape is now pinned — R2 presigned URLs plus D1 metadata plus per-Operation authorization, with finalize-after-PUT, versioned deletes, and a retention policy as mandatory pieces. No Container or Worker-local filesystem persistence assumptions; per-surface byte caps stated explicitly rather than inherited.

### 17. App SDK and forms: async invoke, owner-scoped reads, declared fields (upstream sweep, Sep 2026)

All pins at vendor/upstream commit `0598020e` (2026-09-04).

**Invocation correction at `3543c7e`: upstream is not async-only.** `api/src/models/contracts/executions.py:134-179` includes `sync`; `api/src/routers/workflows.py:976-1083` supports synchronous/data-provider results as well as asynchronous receipts, and `api/tests/e2e/api/test_executions.py:87-116` asserts inline results. Configured HTTP endpoints also dispatch by persisted sync/async mode (`api/src/routers/endpoints.py:212-232`). The browser SDK's async invoke/stream/poll path is one client workflow, not the whole server contract. Wrangnarök maps this in ADR 023 (RUN-03, issue #150): async receipts stay the default, and eligible read-only Sagas run bounded inline through `POST /api/executions/provider` with the durable receipt. Preserve method-shaped retries and explicit install/org context when adapting the current V2 SDK; do not invent forms/config hook exports absent from its export surface.

Execution reads are owner-scoped for non-admins, with redaction of variables/context/memory/CPU and hidden `DEBUG`/`TRACEBACK` logs (`api/src/routers/executions.py:155-190,337-366,462-522`). The UI polls detail every 2 s while `Pending`/`Running` and tolerates brief 404s; cancel invalidates list plus detail (`hooks/useExecutions.ts:66-126,180-200`).

Forms bind by name: each field name is a workflow parameter name, max 50 fields with unique names, from a closed type enum (`api/src/models/contracts/forms.py:68-70,134-146`; `api/src/models/enums.py:33-48`). The server validates submissions against the persisted field declarations — unknown names rejected, display-only types excluded — with per-type coercion and checks (email, ISO dates, option membership, pattern/min/max) and hard caps (200 keys, 256 KB) (`api/src/services/shared/form_runtime.py:32-157`; `contracts/forms.py:231-278`). Launch merges validated input over defaults, exposes inputs top-level plus `context.form_inputs`, and a deferred submit inserts a `SCHEDULED` row instead of running inline (`api/src/routers/forms.py:1354-1395`). Dynamic option providers and auto-fill targets are declared and capped (50 keys/64 KB option fetch); launch requires a random session-bound startup handle with a 30-minute TTL, and submitting without one is `422` (`form_runtime.py:178-231`). Public/embed forms need a fresh capability fingerprint and exact-match origins, no wildcards (`form_runtime.py:358-441`). Authz tiers run authenticated-minus-externals, everyone, role-based, private(owner), with unset-means-authenticated and unknown-means-deny; direct execution is allowlisted (admin, form/app grantee, integration-tied provider); form submit uses the form gate as authoritative, bypassing workflow RBAC anchored to the form org (`api/src/routers/forms.py:1322-1337`).

**Wrangnarök implication (feeds Phase 4):** Dynamic forms stay Deferred, verdict confirmed — the surface (providers, startup handles, fingerprints, embed fencing) is orthogonal to the MVP. When forms arrive: field-names-bind-to-Saga-inputs, server-validates-against-persisted-declaration, submit-gate-as-authoritative, and embed fingerprinting are the invariants to keep. The method-shaped SDK retry discipline (`GET` retries, `POST` never) is worth copying into our client now. AI-assisted-development (Adopt as philosophy) and Git-based management (Adopt) verdicts stand confirmed with no new runtime contract.

### 18. Agents and MCP: opt-in tools, gateway-vs-native, deny-by-default (upstream sweep, Sep 2026)

All pins at vendor/upstream commit `0598020e` (2026-09-04).

Tool identity mirrors our own saga contract: `@tool` is `@workflow(is_tool=True)` with identity-only decorator parameters (name, description, category, tags); parameters are inferred from the function signature while runtime config lives in the database (`api/src/sdk/decorators.py:15-27,128-142,165-213`). The registry lists only active `type='tool'` workflows, prefers `tool_description` over `description`, and normalizes names with a category prefix (or `wf_`) so workflow tools cannot shadow system tools (`api/src/services/tool_registry.py:23-53,91-117`).

Resolution is explicit and deterministic: an agent carries its own tool list (opt-in, never ambient); system tools win conflicts; workflow tools resolve sorted by ID; name conflicts hide the loser with a warning (`api/src/services/execution/agent_helpers.py:107-189`). The caller's identity controls whether per-user-OAuth MCP tools enter the visible set.

The MCP surface is FastMCP over Streamable HTTP only — no SSE, no stdio (`api/src/routers/mcp.py:5`; `api/src/mcp_server/server.py:1-16`) — with a dual endpoint over one registry: `/mcp` serves 7 stable gateway tools while `/mcp/{agent_id}` serves the native per-agent surface (`routers/mcp.py:10-11`; `mcp_server/middleware.py:1-43`). Workflow-backed tools enumerate the same ToolRegistry with stale-entry removal (`mcp_server/server.py:764-906`).

Credentials split four ways: global templates without secrets, per-org connections carrying `encrypted_client_secret` plus an `oauth_token_id` reference, a tool catalog with verbatim input schemas, and per-user credentials with consent and granted scopes (`api/src/models/orm/external_mcp.py`). Token resolution funnels through one five-path table (user, service-chat, needs-reauth, service-autonomous, misconfigured) with a 5-minute freshness margin and single refresh-plus-persist (`api/src/mcp_client/auth_resolution.py:1-28,53-128,229-328`); dispatch retries once on 401/403 markers and caps envelopes at 250 KB (`dispatch.py:17-22,157-303`).

Authorization fails closed throughout: list filters return nothing unauthenticated and only gateway names unscoped; call filters deny hidden and out-of-agent tools; org scoping lives in the database with deny-by-default agent grants; the per-workflow gate reuses the rule that listable equals executable (`mcp_server/middleware.py:45-233`; `tool_access.py:62-110,183-210,353-472`). External tool names are namespaced (`mcp__<connectionUUID>__<tool>`, UUID-validated on parse) with `_workflow` suffixing on native collisions (`api/src/services/execution/agent_helpers.py:31-43`; `mcp_server/server.py:807-843`).

**Wrangnarök implication (feeds Phase 6):** Agents/tool workflows stay Deferred, verdict confirmed. When they arrive, the invariants to keep are: opt-in tool metadata on suitable Sagas with normal Sagas remaining distinct; a gateway-vs-native split; normalized namespaced tool names with description priority; caller-scoped resolution; server-side permissions authoritative even when an agent can discover a tool; hidden-tool denial. No MCP server, agent runtime, or tool-execution path until Phase 6 earns them.

### 19. Configuration: typed key/value rows, cascade scope, masked secrets (CON-02 baseline, Sep 2026)

All pins at vendor/upstream commit `3543c7e` (the parity-audit baseline).

Config is general key/value state with five types (`string`, `int`, `bool`, `json`, `secret`; `api/src/models/enums.py`) and three scopes: global rows (null org), org rows, and Integration-managed rows. Keys match `^[a-zA-Z0-9_]+$`; secret values are encrypted at rest (`api/src/models/contracts/config.py`; `api/src/repositories/config.py`).

Operator surface (`api/src/routers/config.py`): superuser-only list (with scope filter: all, global-only, one org), set/upsert by natural key (org, key), update by ID (rename and org-move allowed; omitted secret values preserve the existing ciphertext), delete by ID. Listing masks secrets as `[SECRET]`; cache invalidation (including the global-version bump on cross-boundary moves) rides every write.

Author surface (`api/bifrost/config.py`): `config.get(key, default, scope)` resolves through the execution context org with automatic global fallback (cascade); a missing key returns 200-with-null and the caller's default — never an error — while permission/server errors surface. `config.set`/`config.delete` write directly. Resolved secret values auto-register for log scrubbing.

**Wrangnarök implication (CON-02, ADR 031):** Adopt the type vocabulary, key shape, `[SECRET]` list masking, partial-update preservation, and declared-versus-undeclared lookup outcomes. Adapt the scope model: org-only resolution with no global tier in v1 (ADR 003's no-implicit-fallback rule extended from credentials to config rows); org/global precedence arrives only with its own ADR. Secret values never reach D1 at all — secret rows store references to declared provider-global deployment secrets (ADR 005 v0), resolved transiently and registered with the execution-scoped scrub registry. Managed-row ownership follows the ADR 011 owned/loose contract.

### 20. Operator console: History, ExecutionDetail, Dashboard summary (CONSOLE-01, issue #222, Sep 2026)

All pins at the parity-audit baseline commit `3543c7e`.

ExecutionHistory (`client/src/pages/ExecutionHistory.tsx`, ~40KB): server-side status (single or multi), scope/workflow, and ISO date filters with keyset cursor traversal; free-text search is client-side over each loaded slice only (the executions list exposes no search param; only the admin-only logs surface has `message_search`). First-page counts are never platform totals. ExecutionDetail (`client/src/pages/ExecutionDetails.tsx`, ~30KB): input/result/safe error, Operation outputs/errors/timestamps, live poll every 2 s on Pending/Running stopping at terminal/unmount.

Dashboard (`client/src/pages/Dashboard.tsx`, ~4KB): headline stat cards plus an executions-over-time chart fed by dashboard-metrics and execution time-series backends, plus inventory counts (workflows, forms, agents, applications) and 24h ROI. Requires role-gated auth context (platform admin vs org user redirect) and lucide/react-query component stack.

**Wrangnarök implication (CONSOLE-01):** History and ExecutionDetail adapt to our History cursor API, detail routes, and owner-only cancel semantics; polling stops at terminal/unmount with stale responses discarded. Dashboard adapts the product shape only — a summary over the real org-scoped list APIs this Worker serves (sagas, history page one, connections/integrations, artifacts page one, file locations) with honestly-scoped sample counts — because the metrics/timeseries/agents/ROI backends do not exist here. No new /api/* routes and no invented metrics endpoint to feed the console; the console owner records that boundary so feature lanes stop shipping one-off screens.

### 21. SDK generation: OpenAPI spec to typed Integration module (INT-01, issue #229, Sep 2026)

All pins at vendor/upstream commit `0598020e` (2026-09-04); the `3543c7e` baseline was not available in the local vendor checkout, so these observations carry the historical pin like findings 16–18.

Upstream generates Python SDK modules from OpenAPI specs with integration-aware authentication (`api/src/services/sdk_generator.py`, 595 lines). Four auth types — bearer, api_key, basic, oauth — with credentials fetched from the Bifrost integration at runtime, never embedded in generated code. Specs load from URL (with host validation in `_allowed_hosts`/`_validate_spec_url`) or inline content, pass through `sanitize_spec`, and render through a Jinja2 template with `autoescape=False` flagged intentional (generated Python source, not HTML: `sdk_generator.py:597-646`).

The template (`api/src/services/templates/sdk.py.j2`, 236 lines) pins three behaviors worth naming: a `DotDict` dict subclass for dot-notation access to response keys (`sdk.py.j2:23-44`), retry with exponential backoff for `{429, 500, 502, 503, 504}` honoring `Retry-After` (base 1.0s, cap 60.0s: `sdk.py.j2:99-150`), and credential binding through `await integrations.get(name)` with per-auth-type header injection (`sdk.py.j2:218-249`). The generation endpoint is platform-admin-only (`POST /{integration_id}/generate-sdk`, `api/src/routers/integrations.py:2055-2100`); output lands in the workspace `modules/` folder and imports as `from modules import example_api`.

**Wrangnarök implication (INT-01, first slice PR #318):** Adapt, not import — the local emitter is a pure TypeScript function (`src/generate-integration.ts`) producing committed source through the offline `wrangnarok generate-integration` CLI, with Connection credential binding (ADR 003), execution-scoped scrubbing (ADR 005/SEC-01), operator allowlist, closed risk classifications, and deterministic output. Deliberate gaps in the first slice, recorded here so they are not mistaken for parity: no retry/backoff policy in the generated client yet, no dot-notation response access, and no `modules/` runtime-import equivalent (committed source instead). Regeneration is idempotent with explicit `--force`; spec drift produces a diff, not silent overwrite.

**DefinedNet generator-sanity proof (INT-01, 2026-09-16):** the emitter was proven against the real Defined Networking spec (`https://docs.defined.net/openapi.yaml`, openapi 3.1.0, 27 paths, bearer `ApiToken` scheme, 10+ deprecated ops; fixture at `test/fixtures/definednet-openapi.json` with a pinned SHA-256 drift assertion). Four defects fixed, each with a regression test: (1) auth-kind detection reads `securitySchemes` and emits bearer ApiToken output for `http`/`bearer` and `apiKey` (OAuth client-credentials only for `oauth2` flows, fail closed on unknown schemes); (2) deterministic UUIDv5 Integration ID derived from the pinned spec digest; (3) `deprecated: true` operations excluded from the classification map by default with an opt-in flag; (4) 96 KiB embedded-spec budget with a documented strip policy (examples, descriptions over 280 chars, vendor extensions). The DefinedNet output carries the bearer shape, registers via `defineIntegration`, and stays well under budget. The Halo OAuth proof stays green alongside it.

### 22. Webhook and custom HTTP execution endpoints (TRG-02, issue #138, Sep 2026)

Pins at vendor/upstream commit `3543c7e` (the parity-audit baseline) unless noted. No local vendor checkout exists in this repo (`vendor/upstream/` is empty), so the pins below rest on the upstream paths and commit references recorded in the issue ledger; the recorded behaviors — not re-inspected source lines — are what TRG-02 adapts.

Custom endpoints (`api/src/routers/endpoints.py`, `api/src/routers/workflow_keys.py`): `POST /api/endpoints/{workflow_id}` carries a per-workflow `X-Bifrost-Key` API key (raw value shown once at creation, SHA-256 stored, expiry plus last-used bookkeeping, admin revoke; no global keys). Whether the call returns an inline result (sync) or an immediate queued receipt (async) is a persisted workflow setting (`execution_mode`), never caller choice. Upstream tests: `api/tests/e2e/api/test_endpoint_execution.py`.

Public webhook receivers (`api/src/routers/hooks.py`): `/api/hooks/{source_id}` is keyed by an unguessable UUID path, with no Bearer [REDACTED] — path secrecy plus adapter validation is the posture. Per-source rate limiting runs before any database write; accepted payloads are delivered as queued events with 202 Accepted, never inline results. Upstream tests: `api/tests/e2e/api/test_webhook_rate_limit.py`.

Webhook adapters (`api/src/services/webhooks/adapters/generic.py`, `api/src/services/webhooks/protocol.py`, `api/bifrost/webhooks.py`): optional HMAC-SHA256 body signatures against a configurable header/prefix; rejected signatures answer 401 with constant-time comparison; vendor challenge handshakes answer via ValidationResponse without executing anything. Drift at `070235e0` (PR #727, 2026-09-14): verification accepts canonical hex or standard padded base64 of the raw digest, tolerating surrounding whitespace plus whitespace immediately after a configured prefix (notably HaloPSA's `sha256= <base64>` form), while still rejecting base64url, unpadded base64, base64-of-hex, and whitespace inside the digest. Upstream tests include `test_base64_signature_with_whitespace_after_prefix`, `test_whitespace_within_base64_signature_is_rejected`, and `test_webhook_with_spaced_base64_hmac_accepted`.

Ordering and correlation (issue-ledger drift): at `08a8f58b` upstream commits event/delivery records before enqueueing execution, so a dispatched run can never race the rows it needs to resolve. At `21bc39a` (PR #740, 2026-09-13) the processor returns the persisted event ID and the router queues that exact ID after commit — concurrent webhooks must queue the event created by each request rather than re-querying the newest event for the source. Upstream tests: `test_hooks_delivery_queueing.py`, `test_processor_delivery.py`.

**Wrangnarök implication (TRG-02, ADR 018):** Adopt the product shape — scoped endpoints bound to a stable Saga, per-endpoint revocable credentials, HMAC verification with the evidenced encodings/whitespace rules, echo-param challenges answered in plaintext with no Execution, per-endpoint rate limiting before any Execution write, vendor event IDs with deterministic `wep-` delivery keys (same event replays, mismatched duplicates conflict), Organization/run-as identity from the endpoint row only, and synchronous HTTP responses kept distinct from asynchronous Execution receipts (async-first; bounded sync stays with RUN-03). Adapt the mechanism: Worker fetch plus D1 plus the standard submit protocol (Execution row written before Workflow dispatch; no Queue or Durable Object), deployment-scoped webhook secrets per ADR 005 v0, and fail-closed admission (rate-window read faults and endpoint-lookup faults propagate as sanitized 5xx, never as 404 or an invented zero count). No automatic retry of business mutations: submit failures propagate and the vendor redelivers the same event ID.

### 23. External MCP servers: templates, connections, catalog, consent, refresh (TOOL-02, issue #171, Sep 2026)

All pins at `3543c7e` (the parity-audit baseline). Surveyed:
`api/src/routers/mcp_servers.py` (425 lines),
`api/src/routers/mcp_connections.py` (899 lines),
`api/src/routers/mcp_oauth_callback.py` (437 lines),
`api/src/services/execution/agent_helpers.py` (341 lines),
`api/tests/e2e/api/test_mcp_servers.py` (234 lines),
`api/tests/e2e/api/test_mcp_connections.py` (404 lines),
`api/tests/e2e/api/test_mcp_oauth_callback.py` (50 lines).
Supporting behavior confirmed at the same commit in
`api/src/services/mcp_client/{auth_resolution,catalog_sync,client,dispatch,discovery,errors,oauth_state}.py`
(note: these modules moved from `api/src/mcp_client/` since the `0598020e`
pins in §18; behavior matches), `api/src/models/orm/external_mcp.py`, and
`api/src/models/contracts/external_mcp.py`.

**Templates are secretless and admin-managed** (`mcp_servers.py`). A template
carries name (globally unique), `server_url`, an optional OAuth-provider
link, `redirect_url`, `discovery_metadata`, an optional org scope, and
`is_active` — no secrets, manifest-friendly. Platform admins see all
templates (filterable: all / platform-level / one org); org users see
platform-level (`organization_id` NULL) plus their own org's; cross-org
detail answers 404, not 403. Create/update/delete and discovery are
platform-admin-only (403 otherwise). Delete defaults to soft
(`is_active=False`, excludable via `active_only`) so existing agent tool
bindings don't silently break; `?hard=true` cascade-deletes connections,
catalog rows, and per-user credentials. Provider linking is exclusive-or:
`oauth_provider_id` (link) or inline `oauth_provider` (create) — both is
422; `authorization_code` without `authorization_url` is 422. The
provider's `client_id`/secret are `"__mcp_per_connection__"` placeholders
that MUST NOT be used for token requests — the authoritative per-org pair
lives on the Connection. Discovery (`POST /discover`) fetches
`/.well-known/oauth-authorization-server` and
`/.well-known/oauth-protected-resource` from the server's host (5s timeout,
no retries) and returns merged metadata or `{metadata: null}` when neither
is usable; the form falls back to manual entry.

**Connections are per-org OAuth instances** (`mcp_connections.py`). One
Connection per (server, org); each carries the org's own `client_id` plus
encrypted `client_secret` (registered as that org's OAuth app with the
vendor), an optional `server_url_override` (wins over the template URL),
`available_in_chat` / `available_to_autonomous` flags (default false), and
`service_oauth_token_id` once connected. CRUD requires platform admin or
membership in the Connection's org (v1 permissive; tighter roles deferred);
cross-org reads 404; the encrypted secret never appears in responses
(asserted in tests). Create accepts a plaintext secret and encrypts at
rest; unknown server is 404; org users may only target platform-level or
own-org templates. Update re-encrypts a rotated secret and flips flags.
Delete is a hard cascade (catalog rows + per-user credentials).
Per-tool overrides (`PATCH .../tools/{tool_id}`) toggle `enabled`: disabling
records `"Manually disabled by admin"` so catalog sync won't auto-re-enable;
re-enabling clears auto-disable markers. Refresh (`POST .../refresh-tools`)
runs `tools/list` over the service token and returns
`{total, enabled, disabled}`; no service token (or provider, or failed
refresh) is a loud 400, not an empty catalog. Admin connect
(`POST .../connect`) branches on the provider flow: `authorization_code`
returns `{authorization_url, state}` for a PKCE-S256 popup (signed state
JWT: connection_id, `flow_type=service`, verifier, redirect URI, nonce);
`client_credentials` exchanges synchronously server-to-server and persists
or in-place-updates the service token row (preserving the FK). No provider
is 400. Per-user connect (`GET /api/me/mcp-connections/{id}/connect`)
needs only same-org visibility and is `authorization_code`-only
(`client_credentials` is 400 — no per-user mode exists); its state carries
`flow_type=user` plus user_id. Per-user listing returns credentials with
token expiry but never the Bearer; disconnect (`DELETE`) is idempotent 204
and deletes both the credential row and its token row. The callback URL is
deterministic per deployment (`{public_url}/api/mcp/oauth/callback`) so
exactly one redirect URI is registered with each vendor.

**The callback completes consent, never JSON** (`mcp_oauth_callback.py`).
`GET /api/mcp/oauth/callback?code&state` short-circuits vendor errors to an
error popup with no state work, then decodes the signed state, consumes the
single-use nonce (replay → "state already used or expired"), resolves
Connection + provider, runs the PKCE code exchange with the Connection's
per-org secret, and always inserts a NEW token row ("rotate on consent";
the old row is orphaned). Service flow sets `service_oauth_token_id`; user
flow upserts the (user, Connection) credential with `consent_granted_at`
and granted scopes (vendor-returned scope, else provider scopes). Missing
vendor expiry defaults to one hour. Every outcome renders an HTML popup
page (`window.opener.postMessage` + `window.close`), 200 on success and 400
on error — asserted in e2e.

**The catalog is per-Connection and drift-tolerant** (`catalog_sync.py`,
`external_mcp.py`). Sync always uses the service token, never a per-user
token (catalog is per-Connection, not per-user; sync is operator-initiated).
Schemas persist verbatim (`inputSchema`) for planner re-emit. New tools
arrive enabled; vanished tools are flagged `enabled=False` with a
timestamped `"Removed from server catalog at ..."` reason — never deleted,
so schemas and agent bindings survive. Vendor-restored tools auto-re-enable
only when the previous reason was auto-removal; admin manual disables
survive sync. Consent rows are unique per (user, Connection), pointing at a
user-owned token with granted scopes and an optional consent expiry.

**Refresh and resolution are centralized in one five-path table**
(`auth_resolution.py`, `errors.py`, `dispatch.py`). Freshness uses a 5-minute
expiry margin matching the scheduler's refresh buffer; `expires_at NULL`
counts as fresh (unknown expiry — let the vendor reject first use). At most
one refresh attempt through the shared scheduler primitives, persisted on
success; failure falls through to the next path. Health checks are
deliberately uncached so revocation fails closed on the next call, and the
firing path is returned for per-call audit (user vs service identity). The
paths: (1) chat caller + healthy per-user credential → user token;
(2) chat caller without one + `available_in_chat` + healthy service token
→ service fallback; (3) chat caller with no fallback → `NeedsReauthError`
carrying a server-built reauth URL (`authorization_code`), or
`MisconfigError` (`client_credentials` — only an admin enabling the flag
can fix it); (4) autonomous caller (`None`) + `available_to_autonomous` +
healthy service token → service; (5) autonomous otherwise → `MisconfigError`
(a planner bug made visible, never a silent fallback). `client_credentials`
has no per-user mode at all. Dispatch pre-checks catalog presence and
`enabled` (disabled reason included in the denial), then on post-resolution
401/403 (conservative marker match) resolves once more and retries exactly
once; a user token that still 401s becomes `NeedsReauthError` — never a
quiet upgrade to service. Result envelopes are normalized and capped at
~250 KB serialized JSON with a structured truncation nudge.

**Agent binding is opt-in, caller-scoped, and namespaced**
(`agent_helpers.py`). Only Connections explicitly granted via
`agent_mcp_connections` surface tools to an agent — no grant means zero MCP
tools regardless of flags; platform-level agents get none. Planner gates:
autonomous runs need `available_to_autonomous` plus a service token not
hard-expired (more than 5 minutes past expiry; in-window expiry is left for
dispatch to refresh); chat runs on `client_credentials` Connections need
`available_in_chat` plus a usable service token, while
`authorization_code` Connections are includable because per-user OAuth can
happen at dispatch. Precedence is system tools (always win) > workflow tools
(sorted by ID, loser hidden with a warning) > delegation > MCP. LLM-visible
names are `mcp__<connectionUUID>__<tool>` with UUID-validated parsing
(malformed names route elsewhere, never error); collisions are defensively
skipped with a warning. Descriptions prefer the schema text, else a
generated fallback; parameters accept `inputSchema` or `input_schema`, else
an empty object.

**Transport is Streamable HTTP only** (`client.py`). Exactly one transport —
`mcp.client.streamable_http.streamablehttp_client`; no SSE, no stdio, by
deliberate omission (future transports arrive as separate modules). The
layer is auth-agnostic bytes-over-wire: Bearer header from the resolved
token, per-call sessions, torn down after use.

**Test-shape note.** The e2e files pin the HTTP surface and negative paths
listed above; in-process happy paths (discovery parse, refresh-tools
success, state encoding, callback exchange, client-credentials exchange)
live in unit tests because the cross-process runner cannot mock into the
API container (`tests/unit/services/test_mcp_client_discovery.py`,
`tests/unit/services/test_mcp_oauth_state.py`,
`tests/unit/routers/test_mcp_oauth_callback.py`,
`tests/unit/routers/test_mcp_connections*.py`).

**Wrangnarök implication (TOOL-02, P0 decisions in
`docs/tool-02-p0-decisions.md`):** Adopt the four-way secret split
(secretless templates, per-org pairs, verbatim catalog, per-user consent),
the five-path resolution table with the no-privilege-fallback rule
(user-auth failure → needs-reauth, never service), the drift-tolerant
catalog rules, the `mcp__<connection>__<tool>` namespace policy, and the
Streamable-HTTP-only transport as parity. Adapt the substrate: no agent
entity exists yet, so P2/P3 resolve Connection-first with an explicit
service principal for autonomous callers (consistent with ADR 018 machine
principals) and AI-02 grants attach later; secrets land in the settled
OAUTH-01 token envelopes + SEC-02 envelope path with inline/on-demand
refresh only (scheduled refresh stays deferred with OAUTH-01). Private
endpoints, non-HTTP transports, and SSE/stdio are explicit v0 non-support
with P4 compatibility statements.

## Candidate product invariants

These are stronger than implementation preferences and should guide design reviews:

1. **Code is source of behavior; environment state is not embedded in code.**
2. **Saga identity survives ordinary source edits.**
3. **Organizations are hard tenant boundaries.**
4. **Integration definitions and Organization-specific Connections are separate.**
5. **Secrets never cross into browser/client code or ordinary execution output.**
6. **Portable definitions exclude tenant credentials and mutable runtime data.**
7. **Every externally invokable dependency must validate caller/context authority, including explicit scoped delegation from an authorized form/app.** A form grant is not arbitrary workflow access, but upstream form submission need not require a separate direct-workflow grant.
8. **Local development should not require production deployment.**
9. **Managed/declarative resources must have a clear source of truth.**
10. **Cloudflare primitives remain visible rather than hidden behind mythological aliases.**
11. **Free-tier viability is measured, not assumed.**

## Next upstream sweeps

Priority order is intentional. Inspect first:

- execution state machine, cancellation, timeout and retry behavior — required to settle ADR 001 Execution/Operation semantics, Phase 1 state model, and Phase 2 retries/cancellation before any Tables/Forms/AI work;

Then, in roughly this order:

- current integration SDK and OAuth implementation contracts (swept, §15);
- files/artifacts (swept, §16);
- app/web SDK and forms (swept, §17);
- agent/MCP surface (swept, §18);
- Solution manifests and packaging/version semantics;
- claims/policies and authentication model;
- API surface and execution observability;
- current upstream tests for invariants that documentation may omit.

## Cutover lessons from Cloudflare lift-and-shift report (2026-09)

Upstream's hardest→easiest cutover ranking assumes preserving Python, FastAPI, and PostgreSQL via Containers. Wrangnarök rejects that path (TypeScript Sagas, Workers-native API, D1 day one) but keeps the failure-mode inventory:

1. **D1 capacity/retention:** 10 GB per-database limit, explicit retention/partitioning policy, no cross-database transactions. Pointer: ADR 001 Open questions, Phase 4 Tables bullet.
2. **Tables/policy acceptance:** atomic batch-write authz, managed indexes for JSON queries, counts/pagination, visibility transitions, revocation. Pointer: §8 implication above.
3. **Job-contract hygiene:** no process/cgroup/filesystem assumptions; explicit progress/lost-run story plus concurrency, cancellation, timeout, and resource limits. Pointer: ADR 001 Open questions.
4. **Atomic activation:** persist inputs/outputs outside execution; version flip with rollback and cache invalidation; interrupted activation restarts. Pointer: §9 implication, Phase 5 roadmap.
5. **Networking/egress:** private APIs/registries, non-HTTP, IP allowlists validated per Integration. Pointer: §6 implication, Phase 2 roadmap.
6. **Storage/search verification:** R2 uploads, signed access, multipart, metadata, cleanup, authz verified per operation; search keeps org scope/permissions/filtering with explicit reindex and async-index consistency. Pointer: Phase 4 roadmap.

## Free-tier rule (measurable)
Every proposed capability should answer:

> Can a small but useful deployment exercise this capability indefinitely within Cloudflare Free allowances?

If not, document the exact limit or missing primitive. Paid-tier escape hatches are useful findings, but they are not MVP defaults.

Measurement is mandatory, not assumed (see ADR 004 `system.smoke`):

1. Every `system.smoke` run MUST log a `usage` block with, at minimum:
   - D1: rows written/read, read/write/query counts for the run;
   - Workflow: instances started, steps executed, per-Execution duration;
   - Worker: requests handled, CPU-ms per request where the runtime exposes it.
2. The repo MUST maintain a Free-allowance vs actuals table (in docs, updated per smoke run or release), e.g.:

   | Primitive | Free allowance | Smoke actual (per run) | Notes/source |
   | --- | --- | --- | --- |
   | D1 stored data / rows | 5 GB total; no per-table row-count cap | 3 application Operation rows observed; database storage not measured by the local test | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), checked 2026-09-10. The 3 rows are application observations, not Cloudflare metered storage. |
   | D1 rows read / written | 5,000,000 rows read/day; 100,000 rows written/day | 4 application-observed reads; 8 application-observed writes | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), checked 2026-09-10. These smoke counters are statements/operation counts and are not D1 `meta.rows_read`/`meta.rows_written` billing telemetry. |
   | Workflow steps | 3,000 steps/day (billing allowance) | 4 steps | [Workers pricing, Workflows table](https://developers.cloudflare.com/workers/platform/pricing/#workflows), checked 2026-09-10. |
   | Workflow instances / executions | 100,000 executions/day (Free limit) | 1 instance | [Workflow limits](https://developers.cloudflare.com/workflows/reference/limits/), checked 2026-09-10. |
   | Workflow duration / retention | Wall-clock duration per step is unlimited; completed state retained 3 days | Per-execution `durationMs` is emitted by `system.smoke`, but is not archived by the local/CI test; the full smoke test completed in 137 ms of test time | [Workflow pricing](https://developers.cloudflare.com/workflows/reference/pricing/) and [Workflow limits](https://developers.cloudflare.com/workflows/reference/limits/), checked 2026-09-10. Test duration is not Workflow billing telemetry. |
   | Worker requests / CPU-ms | 100,000 requests/day; 10 ms CPU per invocation | Worker requests and CPU-ms are `null` in the local Workflow usage block (not exposed by workerd); no deployed request/CPU sample is archived | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), checked 2026-09-10. |

    The smoke actuals above were verified with `npx vitest run test/smoke.test.ts` on 2026-09-10 (`2` tests passed). The usage block's D1 counters are deliberately application-observed and must not be mistaken for Cloudflare's metered row counts. A deployed smoke artifact using D1 `meta` plus Workers request/CPU analytics is still required before claiming production metering accuracy; local and CI runs remain credential-free and do not consume production allowance. Per-run budgets (reads ≤ 10, writes ≤ 20, operation rows ≤ 10, instances = 1, steps ≤ 10) are enforced in CI by `test/smoke.test.ts`, which fails closed on growth — bump them only with the reason recorded.

   Do not hard-code allowance numbers from memory; link the pricing/docs page checked and the date checked. Use `[verify vs current Cloudflare pricing]` where uncertain.
3. Track at least: D1 (stored data, rows, reads, writes), Workflows (steps, instances, duration/retention), Workers (requests/day, CPU-ms). Add R2/KV/ Queue/DO rows only when an ADR earns that primitive.
4. If a capability cannot stay within Free allowances for a small useful deployment, its spec entry MUST name the binding limit and propose a deferred/paid alternative — it MUST NOT silently become an MVP default.
