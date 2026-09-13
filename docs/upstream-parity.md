# Upstream parity map

Audit baseline: upstream `gobifrost/bifrost@3543c7ebee0e1bd9a2cab6dfba080a30621b1c5f` compared with Wrangnarok `32dabf88e4d362798845c96dae1c14aac279ca49`, 2026-09-11.

Parity means equivalent supported user/operator capabilities with explicit TypeScript/Cloudflare adaptations, not Python import compatibility, identical HTTP endpoints, identical infrastructure, or self-host-anywhere deployment.

Status vocabulary: **Implemented** (shipped locally), **Partial** (materially narrower), **Missing** (absent), **Gated** (blocked on an explicit security/cost decision). **Adopt/Adapt are intent, not completion claims.**

Upstream tests are evidence of intended assertions, not passing-test claims. Upstream sources were inspected, not executed; no upstream production instance was used.

Total: 47 capability rows — 3 Implemented, 1 Complete (pending review), 26 Partial, 16 Missing, 1 Gated.

| ID | Title | Phase | Status | Depends | Existing issue |
| --- | --- | --- | --- | --- | --- |
| RUN-01 | Persist and enforce per-Saga runtime policy without changing source identity | 2 | Partial | AUTH-02 | new |
| RUN-02 | Invoke child Sagas with explicit context, completion and failure semantics | 2 | Missing | AUTH-02, RUN-01 | new |
| TRG-01 | Run one-off and recurring schedules with durable due-time and cancellation semantics | 2 | Implemented | AUTH-02, RUN-01 | #137 |
| TRG-02 | Expose authenticated webhook and custom HTTP execution endpoints | 2 | Partial | AUTH-01 | #138 |
| TRG-03 | Deliver topic and built-in events through scoped subscriptions with replay visibility | 4 | Missing | TRG-01, TRG-02, AUTH-02 | new |
| DEV-01 | Provide a complete typed TypeScript author and automation SDK | 1+4 | Partial | — | new |
| DEV-02 | Preview, sync and deploy author source with explicit dependency compatibility | 5 | Partial | DEV-01, SOL-01 | new |
| AUTH-01 | Replace the single-org allowlist with Organization and user lifecycle management | 3 | Partial | — | new |
| AUTH-02 | Enforce resource roles, claims and explicit delegated authorization end to end | 3 | Missing | AUTH-01 | new |
| AUTH-03 | Manage scoped machine credentials and verify delegated human identity parity | 3 | Partial | AUTH-01, AUTH-02 | #144 |
| SEC-01 | Enforce execution-scoped secret registration and universal output scrubbing | 3 | Partial | — | new |
| CON-01 | Manage Integration definitions and scoped Connection mappings through authorized APIs | 3 | Complete (pending review) | AUTH-02, SEC-01 | #146 |
| CON-02 | Expose scoped configuration and secret-reference APIs to authors and operators | 3 | Implemented | AUTH-02, SEC-01, CON-01 | #147 |
| SEC-02 | Support genuinely per-Organization credentials behind the accepted secret-storage tripwire | 3 | Gated | SEC-01, CON-01 | new |
| OAUTH-01 | Complete OAuth authorization, centralized refresh and credential health lifecycle | 3 | Partial | CON-01, SEC-02, AUTH-03 | new |
| RUN-03 | Define and deliver bounded synchronous and data-provider execution | 2+4 | Missing | AUTH-02, RUN-01 | new |
| RUN-04 | Do not confirm cancellation when native Workflow termination is ambiguous | 2 | Partial | — | new |
| OBS-01 | Complete the execution UI and CLI: results, failures, live status and history traversal | 2 | Partial | RUN-04 | new |
| OBS-02 | Persist and stream authorized author logs and progress with reconnect recovery | 4 | Partial | SEC-01, AUTH-02, OBS-01 | #153 |
| TABLE-01 | Deliver the existing minimal author Tables migration slice | 4 | Partial | AUTH-02 | #117 |
| TABLE-02 | Extend author Tables to policy-safe querying, batch mutations and realtime visibility | 4 | Partial | TABLE-01, AUTH-02, OBS-02 | #154 |
| FORM-01 | Deliver the existing Forms-to-Saga input binding slice | 4 | Partial | — | #118 |
| FORM-02 | Deliver usable dynamic forms with safe startup, providers and submissions | 4 | Partial | FORM-01, RUN-03, TRG-01, AUTH-02, FILE-01 | #155 |
| EMBED-01 | Publish and embed forms/apps with revocable external capabilities | 4 | Missing | FORM-02, APP-01, AUTH-03, AUTH-02 | new |
| FILE-01 | Deliver managed file locations with policy-checked upload, download and mutation | 4 | Implemented | AUTH-02, SEC-01 | #157 |
| FILE-02 | Manage generated artifacts and attachment lifecycles with retention | 4+6 | Partial | FILE-01, AUTH-02 | #158 |
| APP-01 | Deploy authored applications with explicit lifecycle, ownership and recovery | 4+5 | Partial | AUTH-02, DEV-02, SOL-01 | #159 |
| APP-02 | Provide the browser App SDK with scoped workflows, Tables, files and live updates | 4 | Partial | APP-01, TABLE-02, FILE-01, OBS-02 | #160 |
| SOL-01 | Close the existing bundle reconciliation and activation contract gaps | 5 | Partial | — | new |
| SOL-02 | Install and manage complete reusable Solutions across Organizations | 5 | Partial | SOL-01, AUTH-02, CON-02, TABLE-02, FORM-02, APP-01, AI-02, TRG-03 | new |
| SOL-03 | Export, capture and import portable Solution source without tenant state | 5 | Partial | SOL-01, MIG-01, SEC-01 | #163 |
| MIG-01 | Deliver the existing workspace-to-bundle bridge without false compatibility claims | 5 | Missing | — | #116 |
| MIG-02 | Verify and close out the existing TypeScript migration pilot | 1 | Partial | — | #119 |
| AI-01 | Configure AI provider Connections, model profiles and capability assignments | 6 | Missing | SEC-01, CON-01, AUTH-02 | new |
| AI-02 | Run user-managed agents with scoped tools, delegation and bounded autonomy | 6 | Missing | AI-01, TOOL-01, RUN-02, AUTH-02 | new |
| AI-03 | Provide durable chat, safe agent routing and attachment-aware conversations | 6 | Missing | AI-02, FILE-02, OBS-02 | new |
| AI-04 | Review, evaluate and tune agents without replaying real side effects | 6 | Missing | AI-02, AI-03, OPS-01 | new |
| AI-05 | Store and retrieve permission-scoped knowledge with explicit reindex lifecycle | 6 | Missing | AI-01, AUTH-02, FILE-01 | new |
| AI-06 | Provide consent-controlled personal memory and composed required instructions | 6 | Missing | AI-05, AUTH-02 | new |
| TOOL-01 | Expose opt-in Saga tools and an authorized inbound MCP gateway | 6 | Missing | AUTH-03, DEV-01, SEC-01 | new |
| TOOL-02 | Connect external MCP servers with org tools and per-user consent | 6 | Missing | TOOL-01, OAUTH-01, AI-02 | new |
| OPS-01 | Provide administrative audit trails and user-visible operational notifications | 4 | Partial | AUTH-02, SEC-01, OBS-02 | #172 |
| OPS-02 | Expose Cloudflare-native diagnostics, operational jobs and repair workflows | 4 | Partial | OBS-01, OPS-01, TRG-01 | new |
| OPS-03 | Export and restore operational data with explicit encrypted-backup boundaries | 5 | Missing | SOL-03, TABLE-02, FILE-02, CON-02, SEC-01 | new |
| OPS-04 | Report scoped usage, model costs and automation ROI | 4+6 | Missing | AUTH-02, AI-01, OPS-01 | new |
| UX-01 | Provide configurable branding, user profiles and discoverable platform administration | 4 | Partial | AUTH-01, FILE-01 | new |
| LIMITS-01 | Prove the Cloudflare feasibility envelope and keep parity exceptions explicit | Continuous | Partial | — | #177 |

## RUN-01: Persist and enforce per-Saga runtime policy without changing source identity

Phase 2; **Partial**; existing issue: new

Local status: Static identity, catalog schemas and bounded Operations exist. Policy is a fixed retry table/platform timeout, not an operator-managed workflow policy surface.

Depends: AUTH-02

Acceptance:

- Record an ADR and behavioral test matrix for timeout=0/default/custom, engine-loss-only retry ceilings, business-error non-retry, pause/admission policy, CompletedWithErrors and legacy Stuck representation. Preserve existing idempotency/cancellation guarantees.
- An authorized operator can inspect/change runtime policy independently of Saga source/revision. Ordinary callers cannot change it. Execution snapshots make the applied policy inspectable.
- Demonstrate policy enforcement, stale completion fencing, repeated cancellation and crash/recovery behavior with local Workflows/D1. Any intentionally different status or recovery behavior is listed as a parity exception, not silently counted complete.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/workflows.py`
- `api/src/models/enums.py`
- `api/src/services/execution/engine.py`
- Upstream tests:
  - `api/tests/e2e/api/test_workflows.py`
  - `api/tests/e2e/api/test_pause_semantics.py`

Related Wrangnarok issues: #15, #16, #75, #76

## RUN-02: Invoke child Sagas with explicit context, completion and failure semantics

Phase 2; **Missing**; existing issue: new

Local status: SagaStep exposes do/sleep only. There is no public nested invocation SDK or parent-child execution contract.

Depends: AUTH-02, RUN-01

Acceptance:

- Pin upstream inline/local versus remote registered invocation behavior before designing the TypeScript equivalent. Specify caller/Organization/install context, parent-child identity, synchronous result versus queued receipt, timeouts and cancellation propagation.
- Run a parent Saga invoking an authorized child with typed inputs, JSON outputs and inspectable lineage. A child failure is actionable and cannot become fabricated parent success.
- Reject foreign-org/hidden children and nonserializable results. Test duplicate dispatch, parent cancellation and child timeout against real local bindings. Do not copy process-pool infrastructure.

Upstream evidence (paths relative to upstream repo root):

- `api/bifrost/workflows.py`
- `api/bifrost/_execution_context.py`
- `api/src/services/execution/engine.py`
- Upstream tests:
  - `api/tests/e2e/api/test_scope_execution.py`

## TRG-01: Run one-off and recurring schedules with durable due-time and cancellation semantics

Phase 2; **Implemented**; existing issue: #137

Local status: Schedules ship as persisted environment state (migration 0016, `src/schedules.ts`, ADR 012 accepted): one org-scoped row binds a name to a stable Saga UUID plus cadence, timezone, enablement, input, and run-as policy. A minute Cloudflare Cron Trigger (the only Cron trigger; `test/timeout-sweeper.test.ts` tripwire pins it) promotes due rows through the standard submit protocol with deterministic `sch-` schedule-window keys. Operator create/preview/disable/delete ride the AUTH-01 membership gate (writes admin-only); run-as always resolves to the creating caller, never caller-supplied identity. Delivery visibility maps windows to Executions. `Scheduled` stays a non-status by design: promotion writes Pending rows, never a new Execution state.

Depends: AUTH-02, RUN-01

Acceptance:

- Accept the ADR 012 identity/due-time design before implementation. Store cadence, timezone, enablement, input and run-as policy as environment state; validate cron and document DST/missed-tick behavior.
- An authorized operator can create/preview/disable recurring schedules and schedule/cancel one future Execution. Due rows survive restart and promote exactly once under racing ticks.
- Test duplicate-window dedup separately from overlap between different windows, overdue promotion, disabled/deleted schedules, revocation and cancellation before dispatch. Pending queue backup must not be mistaken for failed execution.
- Exercise a local Cron handler with D1/Workflows and bounded scan/admission costs. Adding Cron is justified here; additional brokers require evidence.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/schedules.py`
- `api/src/routers/events.py`
- `api/src/jobs/schedulers/cron_scheduler.py`
- `api/src/jobs/schedulers/deferred_execution_promoter.py`
- Upstream tests:
  - `api/tests/e2e/api/test_workflow_scheduled_execution.py`
  - `api/tests/e2e/api/test_form_scheduled_execution.py`
  - `api/tests/e2e/api/test_cancel_scheduled_execution.py`

Related Wrangnarok issues: #76

## TRG-02: Expose authenticated webhook and custom HTTP execution endpoints

Phase 2; **Partial**; existing issue: #138

Local status: Scoped api-key endpoints (`POST /api/endpoints/:name`) and HMAC webhook endpoints (`POST /hooks/:name`) bind a name to a deployed Saga (ADR 018, migration 0021). Deliveries verify per-endpoint keys (expiry, disable/rotate revocation) or HMAC signatures against deployment-store secrets, answer echo-param vendor challenges in plaintext, rate-limit per endpoint, and submit through the standard protocol with derived `wep-` keys (202 receipt, 200 replay, 409 mismatch). Operator create/list/read/update/rotate/history ride the AUTH-01 membership gate. Upstream sync-mode inline results stay deferred to RUN-03; per-tenant webhook secrets stay deployment-scoped per ADR 005 v0 (SEC-02 tripwire).

Depends: AUTH-01

Acceptance:

- Inventory upstream endpoint method/input/result/auth and webhook adapter/challenge behavior, then define the Cloudflare mapping. Keep synchronous HTTP response behavior distinct from an asynchronous execution receipt.
- Create/disable a scoped endpoint with explicit Saga binding, signature/key verification, bounded body parsing and payload mapping. Do not let callers supply authoritative Organization or run-as identity.
- Test valid/invalid signatures, expired/revoked keys, replay and mismatched duplicate payload, vendor challenge, rate limit, oversized body and authorization revocation. Requests cannot retry unsafe business mutations automatically.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/endpoints.py`
- `api/src/routers/hooks.py`
- `api/src/routers/workflow_keys.py`
- `api/src/services/webhooks/adapters/generic.py`
- Upstream tests:
  - `api/tests/e2e/api/test_endpoint_execution.py`
  - `api/tests/e2e/api/test_webhook_rate_limit.py`

Related Wrangnarok issues: #76

## TRG-03: Deliver topic and built-in events through scoped subscriptions with replay visibility

Phase 4; **Missing**; existing issue: new

Local status: No event-source/subscription model, event log or topic emission API exists.

Depends: TRG-01, TRG-02, AUTH-02

Acceptance:

- Create source/subscription lifecycle and typed topic emit/list APIs with deterministic payload filters and delivery attribution. Cover schedule/webhook/topic sources plus built-in platform events, not only direct Saga calls.
- A durable event can fan out to eligible subscribers without cross-org leakage. Inspect/filter event and delivery history, retry/replay failed deliveries and disable a subscriber without resurrecting revoked authority.
- Test source/subscriber identity, fan-out, filter failures, redelivery, duplicate suppression and restart recovery using local bindings. Document retention and admission limits. Earn any Queue/DO via an ADR, never assume one.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/events.py`
- `api/src/models/contracts/events.py`
- `api/src/services/events/processor.py`
- `docs/events/topics.md`
- Upstream tests:
  - `api/tests/e2e/api/test_events.py`
  - `api/tests/e2e/api/test_builtin_events.py`
  - `api/tests/e2e/platform/test_event_subscription_filters.py`

## DEV-01: Provide a complete typed TypeScript author and automation SDK

Phase 1+4; **Partial**; existing issue: new

Local status: defineSaga, Integration handles and catalog exist; public SDK/CLI resource management and generated API contracts do not match the breadth of Bifrost.

Depends: none

Acceptance:

- Publish an explicit Python SDK to TypeScript capability map including author discovery/registration, validated input/defaults/output metadata, execute/status/cancel, and resource-management commands. Python import or wire compatibility is not promised.
- A fresh author can scaffold, list, inspect, invoke and diagnose a Saga through documented noninteractive commands with stable machine-readable errors and the same caller policies as the UI.
- Version the public contract and add schema/SDK drift tests plus local happy/denied/error examples. Track Tables/forms/files/config/agents SDK commands to their owning parity issues rather than declaring absent modules complete.
- Serve author/API documentation and maintain AI-agent development instructions based on actual exports and examples, not only an Adopt-as-philosophy claim.

Upstream evidence (paths relative to upstream repo root):

- `api/bifrost/__init__.py`
- `api/bifrost/cli.py`
- `api/bifrost/commands/workflows.py`
- `api/src/routers/cli.py`
- `api/src/routers/docs.py`
- `api/src/routers/decorator_properties.py`
- Upstream tests:
  - `api/tests/unit/test_cli_solution_run.py`

Related Wrangnarok issues: #57, #119

## DEV-02: Preview, sync and deploy author source with explicit dependency compatibility

Phase 5; **Partial**; existing issue: new

Local status: No-registration local preview (`POST /api/dev/preview`, ADR 016) plus explicit sync/Git/lock/deploy validation (`src/dev.ts`) and the Python-dependency compatibility inventory (`docs/dev-compatibility.md`). Preview is read-only by construction (no D1 writes, no dispatch; opt-in same-org Connection-presence check only). Hosted Git/package management stays out of scope.

Depends: DEV-01, SOL-01

Acceptance:

- Demonstrate no-registration local Saga execution and a separately authorized opt-in environment-resource preview. Preview must never silently mutate production resources or bypass caller/install scope.
- Define source pull/push/watch conflict handling, Git authentication/branch selection and dependency lock/build validation. Preserve stable IDs across edits and explicit remapping on moves.
- Build a compatibility inventory for Python-only/native/process/filesystem/private-registry dependencies with supported TS replacement, bounded HTTP alternative or explicit blocker. Arbitrary upstream Python execution is outside the accepted architecture.
- Test a fresh checkout through preview, source edit, sync conflict and deployment validation with no production deployment. Package installation/build occurs in a justified build venue, not arbitrary runtime shell execution in a Worker.

Upstream evidence (paths relative to upstream repo root):

- `api/bifrost/solution_dev/function_host.py`
- `api/bifrost/solution_dev/proxy.py`
- `api/bifrost/git_commands.py`
- `api/src/routers/github.py`
- `api/src/routers/packages.py`
- `api/src/routers/sdk_modules.py`
- `api/src/routers/dependencies.py`
- Upstream tests:
  - `api/tests/e2e/api/test_github.py`
  - `api/tests/e2e/api/test_cli.py`

Related Wrangnarok issues: #116, #119

## AUTH-01: Replace the single-org allowlist with Organization and user lifecycle management

Phase 3; **Partial**; existing issue: new

Local status: Verified Access human/service identity and owner-scoped Execution reads exist. ACCESS_ORG_ID/allowlists are not Organization membership, invitations or lifecycle APIs.

Depends: none

Acceptance:

- Define principals, Organization membership/provider scope, ordinary/external users and administrative lifecycle in an ADR. Preserve Access as identity source and immutable caller context.
- An authorized administrator can create/disable Organizations, onboard/invite users, manage membership and revoke access without code redeployment. Scope selection cannot elevate privileges.
- Test multiple organizations and allowed/denied ordinary/admin/external users through public APIs, including deactivation, stale sessions and in-flight jobs. Cascading deletion behavior must preview retained ExecutionHistory and owned resources.
- Provide usable admin UI and noninteractive management APIs. Explicitly record any upstream bulk operation not included in the initial implementation slice.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/organizations.py`
- `api/src/routers/users.py`
- `api/src/core/auth.py`
- Upstream tests:
  - `api/tests/e2e/api/test_organizations.py`
  - `api/tests/e2e/api/test_users.py`
  - `api/tests/e2e/api/test_user_invites.py`
  - `api/tests/e2e/api/test_users_bulk.py`

Related Wrangnarok issues: #78

## AUTH-02: Enforce resource roles, claims and explicit delegated authorization end to end

Phase 3; **Missing**; existing issue: new

Local status: org_id/owner checks are present but there is no Role/Permission/Claim/policy model or resource-sharing control plane.

Depends: AUTH-01

Acceptance:

- Define resource action grants, role assignments/bulk revocation, reusable claims/policy rules, global-versus-org lookup and deny-by-absence semantics in an ADR. No implicit cross-org fallback.
- Prove the full dependency chain for direct Saga calls, forms/apps, tables/files and later agents. Authorized form/app delegation is explicit and scoped, not a requirement that the user separately hold direct-workflow execution grants.
- Exercise ordinary user, owner, org admin/provider admin and external caller matrices, policy changes and revocation during discovery/execution/live subscriptions. Listings cannot grant execution and hidden references cannot bypass grants.
- Expose role/policy administration and consumer/usage inspection so operators can safely remove a grant without guessing its dependents.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/roles.py`
- `api/src/routers/claims.py`
- `api/src/routers/policy_rules.py`
- `api/src/routers/forms.py`
- Upstream tests:
  - `api/tests/e2e/api/test_permissions.py`
  - `api/tests/e2e/api/test_roles_consumers.py`
  - `api/tests/e2e/api/test_org_scoping_scenarios.py`

## AUTH-03: Manage scoped machine credentials and verify delegated human identity parity

Phase 3; **Partial**; existing issue: #144

Local status: Adapted parity slice (ADR 014 Adaptation Mapping, `test/machine-credentials.test.ts`): delegated human/service identity via Access verification (email + service `common_name` allowlists, per-request membership gate with invited-activation), scoped endpoint credentials as the workflow-key analogue (per-endpoint digest, expiry, disable/rotate, derived `wep-` delivery keys, no raw-secret readback), and `GET /api/auth/me` plus SDK `whoAmI()` reporting the verified credential class. LAB fixture auth is flagged non-production. Remaining gaps: no user-minted/self-service keys, no per-key scopes beyond the bound Saga, service tokens still allowlist-gated, no in-app MFA/passkey enrollment (IdP-owned).

Depends: AUTH-01, AUTH-02

Acceptance:

- Map upstream login/SSO, MFA, passkeys, trusted-device/recovery/session functions to Access/IdP responsibilities and document any non-equivalent outcomes. Do not build a local password database or reset live passwords for this work.
- Provide revocable scoped service/developer/workflow credentials with least privilege, expiry/rotation/audit and no raw-secret readback. Keep fixture LAB auth explicitly non-production.
- Test Access human/service verification, disabled users, revoked credentials, foreign-org use, direct-origin bypass and required MFA/SSO policy evidence. Discovery/CLI/MCP clients must preserve the same identity.
- State external-user onboarding and Access seat-limit/cost constraints honestly. Delegated identity is adapted parity only after acceptance evidence, not merely because an ADR says SSO/MFA.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/auth.py`
- `api/src/routers/workflow_keys.py`
- `api/src/routers/oauth_sso.py`
- `api/src/routers/oauth_config.py`
- `api/src/routers/mfa.py`
- `api/src/routers/passkeys.py`
- Upstream tests:
  - `api/tests/e2e/api/test_auth.py`
  - `api/tests/e2e/api/test_security.py`

## SEC-01: Enforce execution-scoped secret registration and universal output scrubbing

Phase 3; **Partial**; existing issue: new

Local status: ADR 005 requires a mechanism. Existing sentinel tests and fixed error shaping must not be confused with a dynamic registry covering newly materialized tokens and all outputs.

Depends: none

Acceptance:

- Implement the accepted #110/ADR 005 gating deliverable: register secrets materialized at Integration/Action boundaries per Execution, including tokens, then scrub nested/substrings on every persisted or outward path.
- Test D1 input/history/result/error, Workflow step/terminal results, console/logs, thrown exceptions, HTTP responses and usage/telemetry with URL/header/vendor-error substrings. Define short-secret, encoding and cycle handling without pretending redaction makes arbitrary untrusted source safe.
- Ensure no cross-Execution registry leakage and no secret-bearing discovery/portable exports. Exercise success, rejection, retries and cancellation with real local Workflows/D1 and mocked external APIs.
- Keep #110 as the existing security decision gate. Close this implementation issue only on mechanism and coverage evidence, not an accepted-document stamp. Preserve provider-global v0 and the per-tenant-secret tripwire.

Upstream evidence (paths relative to upstream repo root):

- `api/src/core/secret_string.py`
- `api/bifrost/_execution_context.py`
- `api/src/services/execution/engine.py`

Related Wrangnarok issues: #110

## CON-01: Manage Integration definitions and scoped Connection mappings through authorized APIs

Phase 3; **Complete (pending review)**; existing issue: #146

Local status: Typed echo/NinjaOne definitions carry non-secret config schema, defaults, required-secret names, and health copy. Exact-org Connection lookup plus the authorized management boundary (list/create/read/update/delete plus read-only test) exist with stable Connection identity, managed-versus-loose ownership, and per-Organization scoping. The `/connections` admin screen and typed client calls use the same Worker routes. No per-tenant secret values: views carry required-secret names only, responses are scrubbed, and the SEC-02 tripwire stays shut. Upstream 424 adaptation: declared-missing requirements keep the existing ExecutionHistory 424 on the submit path; the management test route also serves 424 for a missing mapping (no global/default fallback in either place).

Depends: AUTH-02, SEC-01

Acceptance:

- Create/update/test/disable non-secret Connection mappings through one authorized boundary, preserving separate portable Integration definitions, stable Connection identity and managed-versus-loose ownership.
- Represent declared requirements, non-secret schema/defaults/overrides and health/failure remediation. Missing declared requirements fail loud; optional resolution and denied access remain distinct. Document the API/Execution-boundary adaptation of upstream 424.
- Test multiple org mappings, provider-global credential declarations without fallback on missing required mappings, unauthorized writers, schema validation, managed write rejection and redaction.
- Provide a minimal usable admin screen plus typed management API. Do not add per-tenant secret values before SEC-02 gates are met.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/integrations.py`
- `api/src/routers/oauth_connections.py`
- `api/bifrost/integrations.py`
- `api/src/routers/cli.py`
- Upstream tests:
  - `api/tests/e2e/api/test_integrations.py`
  - `api/tests/e2e/platform/test_solution_connection_runtime.py`

Related Wrangnarok issues: #75, #110

## CON-02: Expose scoped configuration and secret-reference APIs to authors and operators

Phase 3; **Implemented** (issue #147; ADR 020); existing issue: #147

Local status: Typed key/value config (`string`/`int`/`bool`/`json`/`secret`) in D1 `configs` (migration 0023), org-only resolution (no global tier by design), `[SECRET]` list masking, reference-only secret provisioning against declared provider-global deployment secrets, managed-row ownership (`managed_by`), `bundle_config` pin reconciliation, export-declaration exclusion, `ctx.config` Saga handle with declared-versus-undeclared outcomes, plus SDK/CLI/UI parity.

Depends: AUTH-02, SEC-01, CON-01

Acceptance:

- Define portable config declarations versus environment values, typed validation/defaults, organization resolution order and explicit secret references. Preserve declared-versus-undeclared lookup outcomes.
- An authorized operator can view/set/delete permitted non-secret values and provision secret references without exposing secret values. A Saga resolves only its allowed org/install context.
- Test org/global precedence only where explicitly allowed, hidden/missing values, managed ownership, declaration changes, redaction and export exclusion. Provide UI/SDK parity alongside API behavior.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/config.py`
- `api/bifrost/config.py`
- Upstream tests:
  - `api/tests/e2e/api/test_config.py`

## SEC-02: Support genuinely per-Organization credentials behind the accepted secret-storage tripwire

Phase 3; **Gated**; existing issue: new

Local status: Accepted v0 deliberately uses deployment-global credentials for provider-global vendors. Per-org ciphertext/key lifecycle is not implemented and is not authorized merely by a parity audit.

Depends: SEC-01, CON-01

Acceptance:

- First document the real Integration/compliance requirement that fires ADR 005, or obtain explicit approval to change that gate. Until then this issue remains blocked and full per-tenant credential parity remains unfulfilled.
- Complete threat/crypto review and schema/key/rotation/restore decisions before writes. Isolate credentials/tokens from non-secret metadata, bind ciphertext to tenant/Connection identity and decrypt transiently.
- Test wrong-org/key, tamper, nonce uniqueness, versioned decrypt, rotation/recovery and ciphertext-only persistence in local workerd. Restore tests must prove the key/ciphertext dependency and dev/prod separation.
- No production credentials, new secret infrastructure or forced v0 migration as part of planning. Preserve universally scrubbed output from SEC-01.

Upstream evidence (paths relative to upstream repo root):

- `api/src/models/orm/oauth.py`
- `api/src/services/oauth_storage.py`
- Upstream tests:
  - `api/tests/e2e/api/test_oauth.py`

Related Wrangnarok issues: #110

## OAUTH-01: Complete OAuth authorization, centralized refresh and credential health lifecycle

Phase 3; **Partial**; existing issue: new

Local status: NinjaOne client-credentials is fetched per Execution and discarded. Auth-code consent, cached refresh, token replacement and health events are absent.

Depends: CON-01, SEC-02, AUTH-03

Acceptance:

- Define auth-code/PKCE/state/callback and client-credentials flows, URL/entity templating, per-org mapping, audience/scope overrides, token status and replace/revoke semantics without changing Connection identity.
- Centralize refresh for inline/on-demand and any justified scheduled path, with single-refresh concurrency fencing and no database transaction held over vendor HTTP. Test expiry, refresh-token rotation, 401, revocation and failed/recovered status.
- Correct the upstream attribution: oauth_scope can request a different resource audience; blanket subset enforcement was not corroborated. If Wrangnarok restricts scopes, explicitly document and test the adaptation against Graph/Exchange/SharePoint-style audiences.
- Cached tokens remain secret storage. Satisfy SEC-02 or an explicitly accepted alternative before persistence; retain v0 fetch-and-discard until then. Mock only vendor OAuth HTTP in local acceptance tests.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/oauth_connections.py`
- `api/src/jobs/schedulers/oauth_token_refresh.py`
- `api/src/services/oauth_storage.py`
- `api/src/routers/cli.py`
- Upstream tests:
  - `api/tests/e2e/api/test_oauth.py`
  - `api/tests/e2e/api/test_oauth_config.py`

## RUN-03: Define and deliver bounded synchronous and data-provider execution

Phase 2+4; **Missing**; existing issue: new

Local status: Local submission is async-only. Current upstream has sync, transient and data-provider modes, contrary to our older spec.

Depends: AUTH-02, RUN-01

Acceptance:

- Pin the upstream sync/transient/data-provider behaviors and accept an ADR for safe Cloudflare equivalents, including response deadline, persistence, caller context and failure envelope.
- Demonstrate a bounded authorized read-only provider returning an inline result and an async Saga returning a receipt. A client-side poll is not silently represented as server sync parity.
- Test timeout, cancellation, scope denial, output size, unexpected failure and unsafe mutation admission. Arbitrary submitted Python/source execution is not implicitly enabled. Any unsupported mode stays a named exception with a migration path.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/workflows.py`
- `api/src/routers/endpoints.py`
- `api/src/models/contracts/executions.py`
- Upstream tests:
  - `api/tests/e2e/api/test_executions.py`
  - `api/tests/e2e/api/test_data_providers.py`

## RUN-04: Do not confirm cancellation when native Workflow termination is ambiguous

Phase 2; **Partial**; existing issue: new

Local status: The cancel route catches every terminate error then marks D1 Cancelled. A current resilience test logs unobserved termination without asserting it.

Depends: none

Acceptance:

- Classify known native terminal outcomes separately from transient/control-plane termination failures. Preserve an explicit ambiguous/pending outcome or a retry-safe control path instead of falsely acknowledging a confirmed stop.
- Retain owner/org non-disclosure, idempotent racing requests and late-terminal-write fencing. Document what logical cancellation does and does not guarantee for already-issued external side effects.
- Add a test proving a real local Workflow reaches native terminated state, and a fault-injection test proving a failed termination is not reported as confirmed physical cancellation. Update ADR 001 before changing public state/response semantics.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/executions.py`
- Upstream tests:
  - `api/tests/e2e/api/test_executions.py`
  - `api/tests/e2e/api/test_cancel_scheduled_execution.py`

Related Wrangnarok issues: #16, #76

## OBS-01: Complete the execution UI and CLI: results, failures, live status and history traversal

Phase 2; **Partial**; existing issue: new

Local status: History API has a cursor, but UI/CLI cannot traverse it. Detail UI loads once and omits returned input/result/error and cancellation controls.

Depends: RUN-04

Acceptance:

- Render bounded input/result/safe error, Operation output/errors/timestamps and runtime-unavailable state. Poll active Pending/Running/Cancelling detail, stop at terminal/unmount and handle stale responses.
- Allow authorized cancellation with accurate pending/failure feedback. History UI and CLI consume server cursors without losing filters or presenting first-page counts as totals.
- Add server-backed date/search/multi-status filters where current upstream exposes them, or explicitly separate the initial pagination slice from these remaining acceptance items.
- Exercise success, vendor failure, slow execution, cancellation, >one-page history and expired native history through the real local Worker UI/CLI. Test request cleanup, hidden-owner denial and JSON rendering bounds.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/executions.py`
- `client/src/hooks/useExecutions.ts`
- `client/src/pages/ExecutionDetails.tsx`
- `api/bifrost/commands/workflows.py`
- Upstream tests:
  - `api/tests/e2e/api/test_executions_query_params.py`

Related Wrangnarok issues: #17, #77

## OBS-02: Persist and stream authorized author logs and progress with reconnect recovery

Phase 4; **Partial**; existing issue: #153

Local status: Bounded structured author logs/progress ship end to end on Worker + D1: Saga-emitted rows via `appendAuthorLog` inside `step.do()` (the hello pilot emits one PROGRESS plus one INFO row), execution/org/caller attribution from the immutable Execution row, deterministic seq order, SEC-01 scrubbing before persistence and again before streaming, DEBUG rows persisted but hidden unless explicitly requested, 200-row-per-Execution retention, scoped tail (`GET /api/executions/:id/logs`) plus operator search (`GET /api/logs`, date/level/Saga filters, cursor pagination), SDK `tailLogs`/`searchLogs`, browser tail on the Execution detail view (same 2s tick, cursor resume, seq-dedupe merge), and CLI `logs`/`log-search` with `--follow`. Polling only: D1 is the source of truth and reconnects backfill from the cursor; no WebSocket/DO/Queue surface exists (an earned ADR is required before any live-push design). Remaining: live-push subscriptions, cross-organization operator views (AUTH-02), and richer progress schemas.

Depends: SEC-01, AUTH-02, OBS-01

Acceptance:

- Expose bounded structured author logs/progress with execution/org/caller attribution and deterministic ordering. Enforce SEC-01 before persistence or streaming and preserve diagnostic visibility tiers.
- Offer scoped read/tail and operator log search by date/level/Saga, plus browser/CLI updates. Reconnect backfills from durable state and deduplicates events; a stream is never the source of truth.
- Test disconnected clients, gap recovery, permission revocation, hidden DEBUG/diagnostic fields, retention and secret-substring redaction. Polling is acceptable for the first delivery slice; any WebSocket/DO/Queue design needs an earned ADR.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/executions.py`
- `api/src/routers/websocket.py`
- `api/bifrost/_logging.py`
- `client/src/hooks/useExecutionStream.ts`

## TABLE-01: Deliver the existing minimal author Tables migration slice

Phase 4; **Partial**; existing issue: #117

Local status: The minimal slice ships in `src/tables.ts` (migration
`0009_tables.sql`, renumbered from the `0007` collision per the ledger):
org-scoped Table declarations, single-row create/read/replace/delete,
deny-by-absence per-action grants, and explicit-deletion retention, proven in
workerd by `test/tables.test.ts`. The #117 exit proof lands here too: a
code-first Saga fixture (`table-ledger-fixture`, stable UUID identity, every
durable effect inside `step.do`) writes then reads an author row against real
local D1, replaces it on a second pass, and keeps deny-by-absence for
grantless strangers. Retention/partitioning note: retention is org-owned
explicit deletion only (`deleteTable` drops rows and grants; no TTL, no
partitioning); the D1 10 GB per-database cap needs a retention/partitioning
policy before large Tables are production-shaped. TABLE-02 owns the remaining
query/policy/realtime acceptance; this issue tracks the minimal-slice exit
only.

Depends: AUTH-02

Acceptance:

- Complete the original #117 minimal create/read/write, deny-by-absence workerd proof and retention note. A fixture org stub is development-only, not production authorization parity.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/tables.py`
- `api/bifrost/tables.py`
- Upstream tests:
  - `api/tests/e2e/api/test_tables_batch.py`

## TABLE-02: Extend author Tables to policy-safe querying, batch mutations and realtime visibility

Phase 4; **Partial**; existing issue: #154

Local status: The query/count/batch slice landed (`src/tables.ts`, migration
`0009_tables.sql`, `test/tables.test.ts`): org-scoped declarations with
deny-by-absence per-action grants, policy-safe keyset queries (nested-JSON
filters, prefix, order, cursor pagination), scoped counts with skip_count
(total=-1), and all-or-denied batch mutations with per-item operational
results. Realtime table-change subscriptions (visibility transitions,
revocation push, reconnect reconciliation) remain missing per the multi-slice
note; retained until verified. TABLE-01 (#117) is subsumed by this slice.

D1 bounds and blockers (explicit, Free-tier posture): 4 KB per document, 25
items per batch, 1000-row scan caps, limit 1-50, 5 nested filters. Unsupported
query operators fail closed (UNSUPPORTED_QUERY / INVALID_ORDER / INVALID_CURSOR
for offset or custom sorts: no offset pagination, no custom sorts, no
projection, no managed indexes, no version tokens). D1 limits recorded as
blockers: 10 GB per-database cap needs a retention/partitioning policy before
large Tables are production-shaped (explicit deletion only in this slice);
single-database transactions only (batch() is one-database atomic, no
cross-database semantics); JSON filtering is application-side over the bounded
keyset window (no PostgreSQL JSONB assumptions, no managed indexes yet).

Depends: TABLE-01, AUTH-02, OBS-02

Acceptance:

- Implement evidenced upstream filter/sort/count/pagination and conflict/concurrency behavior with explicit D1 query/byte/row bounds; separately investigate projection, index management and version tokens. Preserve true omitted specifics: skip_count returns total=-1, document-ID keyset scan/prefix, invalid offset/custom-sort combinations, and web-versus-Python count/delete method differences.
- Enforce per-action row policies with all-or-denied batch semantics limited to policy/attribution denials (upstream preflights denied rows but returns per-item write errors for operational failures). Cover nested JSON filters, concurrent-write/conflict semantics, count leakage, insert/update/delete and allowed shared read-only resolution. Optimistic row-version tokens were not established upstream and require a separate adaptation decision if added.
- Deliver authorized table-change subscriptions with visibility enter/leave transitions and immediate revocation. Reconnect reconciles authoritative state; never broadcast hidden rows.
- Add large-table bounded-memory regressions, filtered page continuity and retention/partitioning tests. Record D1 database-size/transaction limits and any unsupported query operators as explicit blockers.
- Multi-slice issue: the query/count slice can land without realtime subscriptions; retain unmet subcases until verified.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/tables.py`
- `api/bifrost/tables.py`
- `api/src/repositories/tables.py`
- Upstream tests:
  - `api/tests/e2e/api/test_tables_batch.py`
  - `api/tests/e2e/api-integration/test_tables.py`

## FORM-01: Deliver the existing Forms-to-Saga input binding slice

Phase 4; **Partial**; existing issue: #118

Local status: Implemented the validated binding without renderer (ADR 015).
Persisted Organization-scoped `forms` declarations (D1 `0005_forms.sql`) name
the target Saga plus closed-v1 `text` fields; field names bind to Saga inputs
by name; the server validates against the persisted declaration (unknown names
rejected, 200-key and per-field byte caps) and only validated input reaches
the Saga parse gate (drift surfaces the Saga 400, distinct from field 422s).
Validation failures are 422 `FORM_VALIDATION_FAILED` with structured
per-field `details`. `GET /api/forms/:name` reads the declaration;
`POST /api/forms/:name/submit` submits down the standard Execution path with
the submit gate authoritative; unknown/foreign names 404. Pilot form
`hello-greeting` binds to the `hello` Saga, proven end to end in workerd
(`test/forms.test.ts`) plus pure unit pins (`test/form-binding.test.ts`).
Renderer, providers, startup handles, scheduled submit, publication, and file
fields stay explicitly deferred to FORM-02.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/forms.py`
- `api/shared/form_runtime.py`
- Upstream tests:
  - `api/tests/e2e/api/test_form_fields.py`
  - `api/tests/e2e/api/test_forms.py`

## FORM-02: Deliver usable dynamic forms with safe startup, providers and submissions

Phase 4; **Partial**; existing issue: #155

Local status: Usable dynamic forms over the same D1 `forms` table (no new
DDL): designer CRUD (`GET/POST /api/forms`, `GET/PUT/DELETE
/api/forms/:name`), 17 field types (text, number, boolean, email, date,
time, datetime, select, multiselect, textarea, url, tel, file, hidden plus
display-only heading/paragraph/divider), declared defaults with
submission-wins merge, `visibleWhen` conditionals (hidden values dropped,
smuggled values fail closed), static + Table option providers resolved
through the caller Table gate (denied tables yield empty lists, never
leaks; membership re-checked at submit), session-bound 30-minute startup
handles (`POST /api/forms/:name/startup`, peeked for validation and
consumed only after validation passes, org/user/form bound, `STALE_FORM_HANDLE` on
unknown/expired/foreign/replayed),
delegated form-to-Saga submit (the consumed handle is the grant; no
separate direct-Saga grant required), immediate dispatch down the standard
Execution path or `{ scheduleAt }` deferred receipt (undispatched Pending
row with `__scheduleAt` linkage, TRG-01 owns promotion), FILE-01
file-field re-validation (ready/size/type against live rows), opt-in URL
prefill (`allowPrefill`; unknown/display-only names fail closed), and a
Forms renderer (`/forms`, `/forms/:name`) with per-field errors plus
execution linkage. The renderer evaluates conditional visibility over the
startup snapshot under operator edits (edits win), matching the server
gate — a prefilled trigger reveals its dependent immediately, and clearing
the trigger hides it again. Submit sends snapshot-backed values for
visible fields (cleared fields send explicit null, which the server reads
as a gap for defaults to fill).
Unknown or stale handles dispatch nothing. Proven in
workerd (`test/form-lifecycle.test.ts`: designer, startup, providers,
submit, scheduled, file, drift) plus unit pins
(`test/form-binding.test.ts`), SDK client + guards (`test/sdk.test.ts`),
and renderer tests (`test/form-ui.test.tsx`). `GET
/api/forms/:name/providers` exposes resolved options; the SDK
`dynamic-forms` capability is supported.

Explicitly deferred (retain until verified): public/embed publication
with capability fingerprints and origin fencing (EMBED-01); scheduled
promotion/due-time dispatch (TRG-01); realtime provider refresh (polling
only); rich-text/signature/cascading-provider field kinds beyond the 17
shipped.

Depends: FORM-01, RUN-03, TRG-01, AUTH-02, FILE-01

Acceptance:

- Create/edit/render org-scoped forms covering upstream field types, layout/display-only fields, defaults, conditional/dependent inputs and validation. Server declarations remain authoritative; unknown fields and invalid option membership fail closed.
- Implement bounded startup handles, provider fetch/output projection and auto-fill, with expiry/session binding and delegated form-to-Saga authorization. Do not require unrelated direct-Saga grants where the authorized form is the entry point.
- Submit immediate or scheduled work with input merge semantics, required/optional values, safe file-field integration and inspectable execution linkage. Unknown or stale handles cannot bypass initialization.
- Use browser plus workerd tests for the complete allowed/denied user journey, provider errors, stale handles, oversized payloads, file bounds and form/Saga schema drift.
- Cover URL-prefill opt-in and display-only field rejection. Multi-slice issue: a usable renderer can land before scheduled-submit and file-field integration; retain unmet subcases until verified.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/forms.py`
- `api/shared/form_runtime.py`
- `api/shared/form_provider.py`
- `api/src/models/contracts/forms.py`
- Upstream tests:
  - `api/tests/e2e/api/test_forms.py`
  - `api/tests/e2e/api/test_data_providers.py`
  - `api/tests/e2e/api/test_form_scheduled_execution.py`

## EMBED-01: Publish and embed forms/apps with revocable external capabilities

Phase 4; **Missing**; existing issue: new

Local status: Neither authenticated embeds nor anonymous/public form publication exists. everyone access is not synonymous with anonymous access.

Depends: FORM-02, APP-01, AUTH-03, AUTH-02

Acceptance:

- Separate authenticated external-user access, signed app/form embed secrets, and public-form publication/review. Model org/resource/origin-bound grants and safe embed bootstrapping explicitly.
- Use exact-match allowed origins, fresh capability fingerprints, session/startup binding, anti-abuse/CAPTCHA where upstream public publication requires it, and session-owned file uploads.
- Test secret rotation/revocation, changed form capabilities, unknown origin, replay/stale startup, blocked publication and external caller dependency traversal. Deny a form/app grant being repurposed to invoke an unrelated Saga or read another tenant.
- Provide admin create/list/revoke/review UX with no secret readback after issuance. Stage form and app activation independently if one surface lands first; both remain tracked until proven.
- Anonymous public forms are confirmation-only with no execution/history disclosure; cover honeypot/submission nonce, upload ownership and capability-changing republish review. Signed HMAC embed is a distinct grant, not anonymous publication.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/embed.py`
- `api/src/routers/app_embed_secrets.py`
- `api/src/routers/form_embed_secrets.py`
- `api/src/routers/forms.py`
- Upstream tests:
  - `api/tests/e2e/api/test_embed.py`
  - `api/tests/e2e/api/test_embed_external_scope.py`
  - `api/tests/e2e/api/test_form_publication.py`
  - `api/tests/e2e/api/test_form_embed.py`

## FILE-01: Deliver managed file locations with policy-checked upload, download and mutation

Phase 4; **Implemented**; existing issue: #157

Local status: ADR 018 earns the R2 primitive (FILES binding; D1 holds metadata only). Declared locations with minted read/write/delete policies, policy-checked proxy upload/download in Bearer and revocable-capability shapes, bounded batch issuance (100 entries, 1s to 7d expiry, per-path allow/deny), finalize-after-upload with server-side size/digest/type verification, version-fenced overwrite/delete (FILE_MISSING / VERSION_CONFLICT), policy admin plus access-test, Organization-scoped listing, and a bounded shared read-only fallback. Reads collapse missing/unfinalized/foreign to 404 (non-disclosure); revocation deletes outstanding tokens (no TTL grace). Single-PUT objects only (per-location max_bytes, at most 25 MiB); multipart/range/retention/content-search are explicit non-goals owned by FILE-02. Proven by 10 workerd tests on real local R2/D1 plus the Files UI read slice. R2 keys are org-namespaced; no Worker-local disk persistence.

Depends: AUTH-02, SEC-01

Acceptance:

- Earn R2 with an ADR covering D1 metadata, org/install/location/path ownership, declared write locations, per-action policies, explicit bounded shared read-only fallback and list/search structure access.
- Implement authorized signed GET/PUT and bounded batch issuance, finalize-after-upload verification, metadata/content-type/size claims and bounded object handling. Investigate what the server actually verifies versus trusts from completion metadata; cryptographic byte verification and multipart/abort UX are unproven upstream parity claims and must be justified separately if adopted as hardening.
- Support version/conflict-aware update/delete and policy administration/access-test. Match non-disclosure semantics intentionally, including missing/stale objects. Distinguish refusing new URLs after policy revocation from invalidating already-issued signed storage URLs; state TTL/revocation guarantees explicitly (a proxy/revocable-capability design is a separate accepted adaptation).
- Exercise actual local R2/D1 operations and browser upload/download with unauthorized paths, traversal, mismatched completion metadata, cross-org reads and stale versions. Add multipart fault tests only when that supported surface is evidenced or explicitly adopted. Do not persist files on Worker-local disk.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/files.py`
- `api/bifrost/files.py`
- Upstream tests:
  - `api/tests/e2e/api/test_files_signed_url_roundtrip.py`
  - `api/tests/e2e/api/test_file_uploads.py`
  - `api/tests/e2e/api/test_file_transitions.py`
  - `api/tests/e2e/api/test_files_403_vs_404.py`

## FILE-02: Manage generated artifacts and attachment lifecycles with retention

Phase 4+6; **Partial**; existing issue: #158

Local status: ADR 019 accepts the identity/versioning/access/retention contract. Generated/uploaded Artifacts ship end to end on Worker + D1 + R2: upload with same-filename versioning (same stable UUID, current pointer advances, no optimistic version-conflict API), list/preview/download/rename/delete, execution/workspace/conversation attachment bindings with the canonical-versus-binding access split (creator-or-admin for bytes, triple-only for binding readers), configurable retention (default 90 days, range 1-3650, admin-only changes) with explicit preview/run cleanup (bounded batch, per-row outcomes, R2-first interrupted recovery), upload completion verification with failed-write cleanup, MIME/size limits (5 MiB per surface), deleted metadata surviving while bytes are removed, and metadata-only portable exports. Generated-output formats ride as deferred subcapabilities; no Python rendering on Workers. Remaining: AUTH-02 roles (finer than creator/org-admin), FILE-01 signed-URL parity (direct-to-R2 browser PUTs), AI-03 chat attachment surfacing. Composes with AUTH-01 membership gating and instance/org admin bypass.

Depends: FILE-01, AUTH-02

Acceptance:

- Define generated/uploaded Artifact identity, workspace/conversation/execution ownership, versions and metadata separately from portable files. Expose list/preview/download/rename/delete; separate attachment-binding access from canonical Artifact access (creator OR matching Organization, admin bypass) and test each. Same-filename versioning is not an optimistic version-conflict API; Artifact rename is evidenced at api/src/routers/chat.py:388-432.
- Implement configurable retention and explicit cleanup preview/run with safe defaults, upload completion and failed-write cleanup. Pin upstream expiry by Artifact.created_at and cascading Chat bindings; preserving still-referenced artifacts would be an explicit adaptation, not an upstream invariant.
- Test attachment-binding versus canonical access denial, MIME/size limits, deleted metadata versus object bytes and interrupted cleanup against local R2/D1. Portable exports exclude runtime bytes unless an explicitly encrypted full-backup operation requests them.
- Track generated-output format/provider capabilities (PDF/DOCX/XLSX/CSV/HTML/Markdown/JSON/text, configured image/video generation, async attachment completion) as unchecked subcapabilities or explicit deferred adaptations; do not require Python rendering libraries on Workers.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/chat.py`
- `api/src/routers/maintenance.py`
- `api/src/models/contracts/artifacts.py`
- `api/bifrost/artifacts.py`
- `docs/guides/chat-artifacts.md`
- Upstream tests:
  - `api/tests/e2e/api/test_artifact_retention.py`

## APP-01: Deploy authored applications with explicit lifecycle, ownership and recovery

Phase 4+5; **Partial**; existing issue: #159

Local status: ADR 017 accepts the lifecycle/ownership/recovery/build-security contract. Independent apps ship end to end on Worker + D1: create, edit source declarations, validate (422 + field failures), build through a validate-gated async deploy job, inspect jobs, slug-swap recovery, delete, and authorized active-deployment asset serving (same-Organization, no-store + ETag). Solution-owned rows reject live mutation with MANAGED_RESOURCE; legacy V1 draft/publish is documented, never implemented; no retained-history rollback UI (redeploy or parked-app swap only); failed builds preserve the prior active deployment. Validation and the v1 build are shape-only: no author code is executed and no packages are installed (follow-up ADR with venue/isolation/cost gate required before any execution). The Applications UI (/apps, /apps/:id) drives the same routes. Remaining: Solution-owned app reconciliation through bundle install (SOL-02), the browser App SDK runtime (APP-02), multi-route apps, custom domains, and build logs beyond the safe job error.

Depends: AUTH-02, DEV-02, SOL-01

Acceptance:

- Specify independent versus Solution-owned apps and distinguish legacy V1 draft/publish from current V2 local-source/build/deploy. Independent V2 has no separate draft/preview/publish step. Preserve routes/slugs, dependencies, managed edit rejection and explicit replace/swap semantics.
- A trusted author can edit/validate/build and deploy through the appropriate lifecycle and inspect its asynchronous job. Pin recovery via redeploy or parked-old-app slug swap. Independent V2 deletes superseded compiled artifacts, so do not promise a retained-history rollback UI as existing upstream behavior. Failed deployment must preserve the prior usable app, with explicit activation/cache invalidation semantics.
- Accept an architecture/build-security decision before any untrusted source or package execution. Worker Static Assets for the platform shell is not proof of per-tenant authored-app hosting/build isolation.
- Exercise local build-failure recovery, concurrent publication, owned versus loose mutation, route conflicts and authorized asset serving. Any new primitive or paid build venue needs its own documented requirement/cost gate.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/applications.py`
- `api/src/routers/app_code_files.py`
- `api/src/routers/dependencies.py`
- `api/src/jobs/platform/application_deploy.py`
- Upstream tests:
  - `api/tests/e2e/api/test_applications.py`
  - `api/tests/e2e/api/test_application_publish_async.py`
  - `api/tests/e2e/platform/test_solution_v2_app_e2e.py`

## APP-02: Provide the browser App SDK with scoped workflows, Tables, files and live updates

Phase 4; **Partial**; existing issue: #160

Local status: ADR 019 accepts the scoped runtime contract. Authored apps run invoke/result, filtered Table read/write/live poll, and signed file upload/download against the real local Worker through `client/src/lib/app-runtime.ts` (imperative) and `app-provider.tsx` (provider + hooks). Authorization is deny-by-absence grant rows checked per call: hidden Tables stay 404 on runtime paths, revoked grants fail immediately (including token redeem), and runtime file lists show read-granted files only. Live updates are bounded revision polling (no WebSocket/Durable Object/Queue); the handshake tripwire (`APP_SDK_VERSION` + `GET /api/apps/:id/sdk`) fails drift loud with `APP_SDK_MISMATCH`. Browser-safe APIs carry install/org/app context, loading/error state, method-shaped retry (GET bounded, mutations never blind), bounded one-401 refresh, reconnect re-list, and the flat-hook vs nested-imperative Table shape. Forms/config hooks stay in FORM-02/CON-02; batch/rich query stays in TABLE-02; artifact lifecycles stay in FILE-02; log streaming stays in OBS-02.

Depends: APP-01, TABLE-02, FILE-01, OBS-02

Acceptance:

- Map the actual current V2 exports and wire contract: scoped context/provider, workflow invocation/status/results, Tables, files and subscriptions. Do not invent forms/config hook exports absent from the current V2 SDK.
- Provide stable typed/browser-safe APIs with install/org/app context, loading/error state, method-shaped retry rules and reconnect behavior. POST/PATCH side effects cannot be retried blindly.
- Run an authored app through invoke/result, filtered Table read/write/live update and signed file upload/download against the real local Worker. Prove hidden resources and revoked app grants fail even if discoverable client-side.
- Version the SDK with a compatibility handshake/drift tripwire and migration notes. Retain separate Forms/config API parity in their own issues.
- Cover host bootstrap/basename and repeat mount/unmount, theme/logout, token rotation with bounded one-401 refresh, table flat-hook versus nested-imperative shape, file reconnect re-list and query-only filter limitations.
- Multi-slice issue: workflow-hook delivery can land before Tables realtime; retain unmet subcases until verified.

Upstream evidence (paths relative to upstream repo root):

- `client/src/lib/app-sdk/index.v2.ts`
- `client/src/lib/app-sdk/wire-surface.ts`
- `client/src/lib/app-sdk/provider.tsx`
- `client/src/lib/app-sdk/use-table.ts`
- `client/src/lib/app-sdk/use-files.ts`
- Upstream tests:
  - `client/src/lib/app-sdk/sdk-contract.test.ts`

## SOL-01: Close the existing bundle reconciliation and activation contract gaps

Phase 5; **Partial**; existing issue: new

Local status: Current installBundle reconciles declared endpoints and appends a ledger. There is no absent-managed-row deletion, active-install execution gate or atomic activation pointer; #35 being closed does not prove these guarantees.

Depends: none

Acceptance:

- Correct ADR 011 upstream attribution: Solution transaction plus retryable post-commit source/dist finalization is distinct from independent app active_deployment_id. Preserve the local intended guarantees as local decisions, not invented upstream CAS semantics.
- Define observable atomicity versus restart convergence for D1 multi-row reconcile. Stage or fence activation so interrupted/racing installs cannot advertise a complete active version while exposing mixed configuration.
- Implement scoped managed-absentee reconciliation, meaningful same-version conflict fencing, immutable install evidence and fail-closed execution against applicable active install/revision. Keep an explicit local/loose development exception.
- Test injected interruption after one row, same-version/concurrent installs, lost activation, absent entities, no-op, forced rollback, stable IDs and local exception with real local D1. Do not count endpoint rollback alone as complete activation parity.
- Cover the silent-config omission: src/solutions.ts parses config but only endpoint enters desired install state; version-only endpoint skip leaves an older managed_by marker; Saga-only bundles derive no org installations. Add tests or explicit rejection.

Upstream evidence (paths relative to upstream repo root):

- `api/src/services/solutions/deploy.py`
- `api/src/routers/solutions.py`
- `api/src/jobs/platform/application_deploy.py`

Related Wrangnarok issues: #35

## SOL-02: Install and manage complete reusable Solutions across Organizations

Phase 5; **Partial**; existing issue: new

Local status: The v1 manifest supports Saga pins and endpoint mapping only, not owned apps/forms/agents/Tables/claims/events or full install administration.

Depends: SOL-01, AUTH-02, CON-02, TABLE-02, FORM-02, APP-01, AI-02, TRG-03

Acceptance:

- One portable definition installs independently into multiple orgs with deterministic per-install identity remapping and internal references. Keep runtime rows, credentials and file payloads separate from definitions.
- Extend declared ownership/reconciliation to apps/forms/agents/Tables/claims/policies/events/config and integration requirements. Preserve explicit bounded shared-resource lookup and read-only fallback where upstream supports it.
- Provide install/setup/inspect/upgrade/rollback/uninstall/delete-preview UX/API, including missing requirement remediation, downgrade gates, pending capture conflicts, preserved runtime data and authorization.
- Test multi-org installs, reference remapping, managed/live edit rejection, absent owned entities, failed preflight, rollback and uninstall retention. Each not-yet-available resource type remains an unchecked subcase, not an ignored manifest key.
- Spell out the capture-to-pull-acknowledgement-to-deploy-blocker author journey; separate source capture from adoption; distinguish inactive/uninstall versus hard-delete/reactivate with recovery.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/solutions.py`
- `api/src/services/solutions/deploy.py`
- `api/src/services/solutions/export.py`
- Upstream tests:
  - `api/tests/e2e/platform/test_solution_v2_app_e2e.py`

## SOL-03: Export, capture and import portable Solution source without tenant state

Phase 5; **Partial**; existing issue: #163

Local status: Implemented the portable source-closure/package/export/capture product in `src/solution-export.ts` (ADR 016): read-only capture/preview with fail-closed gaps, versioned JSON shareable packages with dependency-closure checks, export/import round-trip, and staged export jobs with guaranteed cleanup. App source hosting and forms/tables/agents ownership in packages stay explicitly deferred to SOL-02; encrypted operational backup stays under OPS-03.

Depends: SOL-01, MIG-01, SEC-01

Acceptance:

- Implement source capture/preview and shareable export/import of declarations, modules, app source/assets and metadata with dependency-closure checks. Record intentional JSON-versus-upstream packaging differences without introducing a workflow DSL.
- Retain stable source/install identity mapping, versions, requirements and author readme/logo where portable. Capture cannot silently adopt loose resources across org/ownership boundaries.
- Reject embedded credentials, table rows, execution state and runtime artifact bytes from shareable exports. Test round-trip in a fresh org, malicious archive/path input, missing modules and export-job failure/cleanup.
- Keep encrypted operational backup separate under OPS-03. Source export must not be called a complete data backup.
- Spell out the capture-to-pull-acknowledgement-to-deploy-blocker author journey; separate source capture from adoption.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/solutions.py`
- `api/src/services/solutions/export.py`
- `api/src/services/solutions/export_jobs.py`

## MIG-01: Deliver the existing workspace-to-bundle bridge without false compatibility claims

Phase 5; **Missing**; existing issue: #116

Local status: Reuse #116. A field mapping/converter is smaller than native execution of legacy workspace Python or full Solution lifecycle.

Depends: none

Acceptance:

- Validate the existing #116 converter/mapping with explicit source identity, environment exclusion and actionable unsupported-feature results. Distinguish legacy decorator id metadata from current upstream registered/installed identity.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/solutions.py`
- `api/bifrost/decorators.py`

## MIG-02: Verify and close out the existing TypeScript migration pilot

Phase 1; **Partial**; existing issue: #119

Local status: hello Saga and native local test are already present; #119 remains open and broader workspace migration is not proven.

Depends: none

Acceptance:

- Reuse #119 and verify the landed hello pilot against its original acceptance. Preserve explicit registered-ID mapping, local API/history proof and remaining Forms/Tables/Integration gaps; do not manufacture a new pilot issue.

Upstream evidence (paths relative to upstream repo root):

- `api/bifrost/decorators.py`
- `api/bifrost/cli.py`

## AI-01: Configure AI provider Connections, model profiles and capability assignments

Phase 6; **Missing**; existing issue: new

Local status: No model/provider/embedding configuration or verification surface exists.

Depends: SEC-01, CON-01, AUTH-02

Acceptance:

- Provide authorized provider Connection create/test/verify/disable and model discovery, reusable profile create/merge/edit, capability overrides/conformance and default assignments. Browser callers see profile identities, not credential-bearing provider details.
- Centralize disabled/missing profile resolution and behavior settings. Separate embedding configuration/dimension/reindex decisions from generation-model selection.
- Test secret redaction, model availability, invalid/disabled assignments, scoped access and bounded verification calls with mocked vendor HTTP. Document provider cost and never assume Cloudflare Free includes external model inference.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/ai_models.py`
- `api/src/routers/llm_config.py`
- `api/src/services/ai_model_service.py`
- Upstream tests:
  - `api/tests/unit/test_chat_model_profiles.py`

## AI-02: Run user-managed agents with scoped tools, delegation and bounded autonomy

Phase 6; **Missing**; existing issue: new

Local status: There is no agent entity/runtime. A normal Saga and an opt-in tool are not a user-managed autonomous agent.

Depends: AI-01, TOOL-01, RUN-02, AUTH-02

Acceptance:

- Create private/org agents with authorized tools/knowledge, instructions, model profile, promotion and role grants. List/detail/tool/delegation discovery must intersect the caller authority.
- Run/enqueue/rerun/cancel with durable steps, parent-child lineage, filtering/metadata facets and reconnectable status. A rerun is an explicit new side-effect decision, not an automatic retry.
- Bound tokens/spend/time/turns and inherit budgets/identity into delegated children. Autonomous runs may use only eligible service credentials; missing user consent cannot silently fall back to stronger service auth.
- Test unauthorized tool/agent delegation, loops, budget exhaustion, cancellation, provider failure and restart recovery against local bindings with vendor model HTTP mocked. Do not introduce an infrastructure process-pool abstraction.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/agents.py`
- `api/src/routers/agent_runs.py`
- `api/src/services/execution/agent_helpers.py`
- Upstream tests:
  - `api/tests/e2e/api/test_agents.py`
  - `api/tests/e2e/api/test_agent_delegation_lifecycle.py`
  - `api/tests/e2e/api/test_agent_run_children.py`
  - `api/tests/e2e/api/test_agent_run_enqueue.py`

## AI-03: Provide durable chat, safe agent routing and attachment-aware conversations

Phase 6; **Missing**; existing issue: new

Local status: No chat/conversation/message or streaming run surface exists.

Depends: AI-02, FILE-02, OBS-02

Acceptance:

- Create/list/read/delete owned conversations, submit messages once, reconstruct authoritative run state after reconnect and cancel active work. Expose model/profile selection only when eligible.
- Support accessible-agent auto-routing, explicit switching and tool activity without widening access for administrative callers. Conversation context cannot grant a hidden agent/tool.
- Implement bounded attachments and generated artifact library through FILE-02 with MIME validation, preview/download/unbound delete and ownership isolation.
- Test duplicate send, refresh/reconnect, switch denial, cross-conversation access, attachment failure cleanup and cancellation in a browser backed by local Worker bindings.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/chat.py`
- `api/src/services/chat_runs.py`
- Upstream tests:
  - `api/tests/e2e/api/test_chat.py`
  - `api/tests/unit/services/test_agent_router_access.py`
  - `api/tests/unit/test_chat_attachments.py`

## AI-04: Review, evaluate and tune agents without replaying real side effects

Phase 6; **Missing**; existing issue: new

Local status: No agent fleet/review/tuning workbench exists.

Depends: AI-02, AI-03, OPS-01

Acceptance:

- Provide fleet/per-agent stats, run search/filter/facets and review verdict/clear with audit history. Flagged-run conversations, summary regeneration and bounded/cancellable backfill jobs remain attributable.
- Create tuning proposals, dry-run against saved transcripts without invoking real tools, inspect differences and apply authorized/versioned prompt changes with explicit verdict reset behavior.
- Test dry-run side-effect exclusion, hidden run access, stale tuning apply, cancellation/budget limits and summary failure. UI labels must distinguish simulated evaluation from a real autonomous rerun.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/agent_tuning.py`
- `api/src/routers/agent_runs.py`
- `api/src/routers/agents.py`
- Upstream tests:
  - `api/tests/e2e/api/test_agent_runs_verdict.py`
  - `api/tests/e2e/api/test_flag_conversation_endpoints.py`
  - `api/tests/unit/test_consolidated_tuning.py`

## AI-05: Store and retrieve permission-scoped knowledge with explicit reindex lifecycle

Phase 6; **Missing**; existing issue: new

Local status: No knowledge namespaces/documents/chunks/embedding retrieval exists. Generic search deferral leaves this feature unmapped.

Depends: AI-01, AUTH-02, FILE-01

Acceptance:

- Manage namespaces/roles and logical documents with chunked storage, metadata filters, bulk scope change, re-embed and complete chunk deletion. Preserve explicit external-user and org/global permissions.
- Provide bounded lexical/vector or hybrid retrieval with documented ranking/deduplication/evidence envelope and repeat-query behavior. Validate that no denied document contributes counts, snippets or model context.
- Accept a Cloudflare-native storage/index/embedding architecture and measured cost gate before adding a primitive. Model/dimension changes require observable resumable reindex and consistency policy.
- Test retrieval quality on a deterministic corpus, allowed/denied scopes, chunk update/delete, reindex interruption and stale-index revocation. Do not import PostgreSQL merely because upstream uses it.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/knowledge_sources.py`
- `api/src/repositories/knowledge.py`
- `docs/architecture/knowledge-retrieval.md`
- `api/src/routers/llm_config.py`
- Upstream tests:
  - `api/tests/e2e/api/test_knowledge.py`
  - `api/tests/e2e/api/test_mcp_knowledge_scoping.py`
  - `api/tests/unit/repositories/test_knowledge_repository.py`

## AI-06: Provide consent-controlled personal memory and composed required instructions

Phase 6; **Missing**; existing issue: new

Local status: Persistent per-user memory and global/org instruction controls are absent and are distinct from shared knowledge.

Depends: AI-05, AUTH-02

Acceptance:

- Expose platform enablement/user opt-out and own-memory save/list/search/delete. No caller can read or delete another user memory, including through agent tools.
- Manage authorized global and Organization required instructions with deterministic precedence, clearing and composed memory sections. Instructions never replace server permission enforcement.
- Test effective disablement, deletion/retention, cross-user denial, organization switching and exact composition. Persisted memory content is untrusted context, not an authority source.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/memory.py`
- `api/src/routers/required_instructions.py`
- `api/src/services/memory.py`
- Upstream tests:
  - `api/tests/e2e/api/test_memory.py`
  - `api/tests/unit/services/test_required_instructions.py`

## TOOL-01: Expose opt-in Saga tools and an authorized inbound MCP gateway

Phase 6; **Missing**; existing issue: new

Local status: No tool registry or MCP server exists. The static Saga catalog does not imply tool exposure.

Depends: AUTH-03, DEV-01, SEC-01

Acceptance:

- Add explicit tool opt-in with stable identity, derived schemas, distinctive descriptions and collision-safe names. Scope discovery and execution identically, removing disabled/stale entries.
- Implement gateway search/describe/execute/status versus per-agent native tool surfaces over the chosen standards-compliant transport. Include feature enablement and existing supported gateway utilities in the upstream inventory, not an all-Sagas list.
- Map MCP OAuth discovery/authorization/dynamic registration or an explicitly justified Access-compatible authorization flow without bypassing user authority. Distinguish MCP-client auth from vendor OAuth.
- Test a real MCP client against local endpoints for discovery, invoke, result/error, unauthorized/hidden/cross-agent calls, revocation and stale registry updates. R2/Queues/DO are not prerequisites unless earned.

Upstream evidence (paths relative to upstream repo root):

- `api/src/services/tool_registry.py`
- `api/src/routers/tools.py`
- `api/src/routers/mcp.py`
- `api/src/services/mcp_server/auth.py`
- `api/src/services/mcp_server/middleware.py`
- Upstream tests:
  - `api/tests/e2e/api-integration/test_mcp_gateway.py`
  - `api/tests/e2e/api-integration/test_mcp_protocol.py`

## TOOL-02: Connect external MCP servers with org tools and per-user consent

Phase 6; **Missing**; existing issue: new

Local status: No outbound MCP templates/Connections/catalog/credential resolution or dispatch exists.

Depends: TOOL-01, OAUTH-01, AI-02

Acceptance:

- Separate portable server templates, org Connections, discovered/approved tool catalog and per-user consent credentials. Support discover/refresh/enable/disable and explicit schema/name collision handling.
- Centralize credential resolution for user chat, service chat and autonomous runs. Needs-reauth/misconfigured states deny safely, never fall back to a more privileged identity.
- Test OAuth callback/consent/revoke, refresh races, bounded response/retry rules, tool-list drift, hidden tool denial and namespace collisions with an external MCP fixture server.
- Satisfy secret-persistence gates before storing tokens. Make authenticated egress, private endpoints and non-HTTP transport support explicit compatibility decisions.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/mcp_servers.py`
- `api/src/routers/mcp_connections.py`
- `api/src/routers/mcp_oauth_callback.py`
- `api/src/services/execution/agent_helpers.py`
- Upstream tests:
  - `api/tests/e2e/api/test_mcp_servers.py`
  - `api/tests/e2e/api/test_mcp_connections.py`
  - `api/tests/e2e/api/test_mcp_oauth_callback.py`

## OPS-01: Provide administrative audit trails and user-visible operational notifications

Phase 4; **Partial**; existing issue: #172

Local status: Implemented the ADR 020 slice end to end on Worker + D1 (`audit_events`, `notifications` via `0018_ops.sql`; `src/ops.ts`): `GET /api/audit` (actor/org/action/target/outcome, action-prefix/outcome/search/date filters, keyset pagination, deployment-secret scrubbing, org-scoped reads) with best-effort emission (`app.create/source.edit/build.start/build.complete/swap/delete`, `app.managed_deny`, `execution.cancel/cancel_unconfirmed`) that never fails the primary mutation; durable personal/org notifications with dismiss ownership, per-job dedup, stale-progress reconciliation on read, and polling UI (`/audit`, `/notifications`) plus typed SDK/CLI. Proven in workerd (`test/ops.test.ts`: allowed/denied readers, denied mutations, scrubbing, duplicates, dismissal ownership, interrupted jobs, storage-failure policy) plus UI/contract pins. Remaining: role-gated audit reads and admin scoping (AUTH-02), live progress streaming (OBS-02 follow-up), retention automation (OPS-03).

Depends: AUTH-02, SEC-01, OBS-02

Acceptance:

- Record actor/org/action/target/outcome for consequential admin and policy-deny events with search/keyset pagination, redaction and explicit access/retention rules.
- Deliver scoped personal/admin notifications with durable status, progress and dismiss behavior. Reconnect must not lose authoritative jobs or leak cross-user notifications.
- Test allowed/denied readers, denied mutations, sensitive payload scrubbing, duplicates, dismissal ownership and interrupted jobs. Audit storage failure policy must be explicit, not silently fabricated success.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/audit.py`
- `api/src/routers/notifications.py`
- `api/src/services/audit.py`
- `api/src/services/notification_service.py`
- Upstream tests:
  - `api/tests/e2e/api/test_audit_log.py`
  - `api/tests/e2e/api/test_notifications.py`

## OPS-02: Expose Cloudflare-native diagnostics, operational jobs and repair workflows

Phase 4; **Partial**; existing issue: #173

Local status: Cloudflare-native diagnostics ship on Worker + D1 only (issue
#173): GET /api/ops/version (SDK/catalog/migration contract), /health
(Worker/D1 liveness), /metrics (per-status counts, undispatched-Pending
backlog, recent failure codes), /scheduled-tasks (durable endpoint
inventory, cadence honestly null until TRG-01), /jobs (Execution backlog
plus app deploy aggregates with interrupted flags), /preflight (static
mapping/credential presence), /connections (per-Integration health with
registry hints), and POST /api/ops/repairs (inspect-then-act:
retry-execution with original-input replay, cancel-execution, stuck-build
restore, pending-upload and expired-token sweeps; dryRun inspects, explicit
dryRun:false executes behind the admin gate with audit emission). Typed SDK
client, CLI (ops-version/health/metrics/tasks/jobs/preflight/connections/
repair with --execute), and contract descriptor entries ship too.
Native Workers observability and application usage blocks predate this.

Explicit gaps: no recurring-schedule rows (TRG-01 owns them), no live
vendor probes in preflight (the per-Connection test route owns probes), no
documentation/index repair (no search index exists), no distributed upload
locks (single-Writer D1 needs none), no provider metering (unavailable,
never fabricated), and no scheduled production jobs (manual per ADR 004).

Depends: OBS-01, OPS-01, TRG-01

Acceptance:

- Map upstream queue/worker/process diagnostics to meaningful Workflow/D1/Worker health, admission backlog, recent failures, scheduled task status and platform job progress. Do not recreate containers or RabbitMQ names.
- Provide authorized inspect/cancel/retry or repair actions with dry-run/confirmation and auditable failure semantics. Cover stuck work, upload/deploy locks where applicable, orphan cleanup, dependency preflight and documentation/index repair.
- Test durable/cancellable jobs, owner/admin visibility, interrupted cleanup, expired runtime history and degraded bindings locally. Missing provider metrics remain unavailable, never fabricated.
- Keep production actions manual per ADR 004; inspectable diagnosis must work without a production deployment.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/health.py`
- `api/src/routers/version.py`
- `api/src/routers/metrics.py`
- `api/src/routers/jobs.py`
- `api/src/routers/platform_jobs.py`
- `api/src/routers/scheduler_diagnostics.py`
- `api/src/routers/platform/workers.py`
- `api/src/routers/maintenance.py`

## OPS-03: Export and restore operational data with explicit encrypted-backup boundaries

Phase 5; **Missing**; existing issue: new

Local status: Portable bundle installation/export is not operational backup. No data/config/integration/OAuth/knowledge restore workflow exists.

Depends: SOL-03, TABLE-02, FILE-02, CON-02, SEC-01

Acceptance:

- Inventory operational export/import of configs, Integration mappings, OAuth state, table rows, knowledge and runtime files separately from shareable definitions. Define full Solution backup versus whole-instance disaster recovery coverage.
- Protect full backups with an accepted encryption/key/password contract: upstream requires a password for any selected config, secrets, table rows or file runtime payload, not secrets alone. Use POST-body secret submission, authorization and bounded durable export jobs/download expiry. Never put secret passwords in URLs/logs or portable source.
- Restore into an isolated environment with ID/reference mapping, duplicate/conflict strategy, ciphertext/key compatibility and a preview of overwrite/delete effects. Do not overwrite production as a test.
- Demonstrate fresh restore/round-trip, wrong key/password, partial archive, interrupted import and cleanup of temporary objects. Preserve v0 secret tripwire and document which credentials require operator re-onboarding.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/export_import.py`
- `api/src/routers/solutions.py`
- `api/src/services/solutions/export.py`
- `api/src/services/solutions/export_jobs.py`

## OPS-04: Report scoped usage, model costs and automation ROI

Phase 4+6; **Missing**; existing issue: new

Local status: usage_blocks are application-observed step/DB hints, not Cloudflare billing, model token costs or ROI reports.

Depends: AUTH-02, AI-01, OPS-01

Acceptance:

- Collect attributed Saga/agent usage with explicit measured/estimated/unpriced dimensions and per-org/time/Saga/model aggregations. Preserve honest missing CPU/provider billing data.
- Manage authorized model pricing and ROI assumptions, then expose summary/by-Saga/by-org/trend reports with currency/rounding/time-window semantics and safe exports.
- Test unauthorized aggregations/count leakage, missing price entries, changing prices, retries/duplicate metering and cancellation. Budget controls must reference the same accounting definitions.
- Do not claim financial savings or provider charges without evidence; show assumptions alongside ROI estimates.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/usage_reports.py`
- `api/src/routers/ai_pricing.py`
- `api/src/routers/roi_reports.py`
- `api/src/routers/roi_settings.py`
- `api/src/routers/metrics.py`
- Upstream tests:
  - `api/tests/e2e/api/test_roi_reports.py`
  - `api/tests/e2e/api/test_budget_visibility.py`
  - `api/tests/e2e/api-integration/test_ai_usage.py`

## UX-01: Provide configurable branding, user profiles and discoverable platform administration

Phase 4; **Partial**; existing issue: new

Local status: Static Wrangnarok brand/Nav exists. There is no admin brand configuration, own profile/avatar or complete settings navigation.

Depends: AUTH-01, FILE-01

Acceptance:

- Expose authorized application name/colors/logo/reset and own-profile/preferences/avatar operations with safe upload limits. Password/security settings delegate to the accepted IdP model instead of creating a second identity store.
- Connect each implemented platform family to accessible navigation and admin settings. Disabled nav links must point to the actual open parity issue, not closed unrelated scaffolding issues.
- Test ordinary versus admin settings writes, avatar/logo type/size abuse, own-profile scope, keyboard/error/loading states and safe public branding reads. Preserve AGPL/upstream attribution where UI code is adapted.

Upstream evidence (paths relative to upstream repo root):

- `api/src/routers/branding.py`
- `api/src/routers/profile.py`
- `client/src/pages/EntityManagement.tsx`
- Upstream tests:
  - `api/tests/e2e/api/test_profile.py`
  - `api/tests/e2e/api/test_entity_logos.py`

## LIMITS-01: Prove the Cloudflare feasibility envelope and keep parity exceptions explicit

Phase Continuous; **Partial**; existing issue: #177

Local status: The dated capability-versus-limit matrix ships as `docs/feasibility-envelope.md` (2026-09-12): Worker CPU/memory/bundle/egress, Workflows instances/steps/history, D1 reads/writes/storage/transaction limits, R2 size/signing, Access users, and model/vector/build costs each carry a free / paid-adaptation / redesign / unresolved classification with the binding limit named. Measured local usage (smoke budgets, usage blocks, bundle size) stays explicitly separated from provider meters; what still requires an authorized dev measurement is listed, not assumed. Remaining: deployed D1-meta/Workers-analytics metering and multi-org load fixtures before any production accuracy claim.

Depends: none

Acceptance:

- Publish a dated capability-versus-limit matrix covering Worker CPU/memory/bundle/egress, Workflows instances/steps/history, D1 reads/writes/database/transaction limits, R2 size/signing, Access users and model/vector/build costs.
- Use representative multi-org workloads and local/load fixtures where possible. Separate measured local usage from provider meters and identify what requires an explicitly authorized dev measurement.
- For each incompatible workload, document supported TypeScript/native adaptation, optional paid tier, redesigned user journey or unresolved blocker. Full product parity is not Python import/HTTP wire/self-hosting compatibility.
- Add new primitives only after a concrete child issue and ADR. Do not silently move the first MVP to paid-only infrastructure, or interpret full-parity planning as authorization to purchase/deploy/relax security.
- Define reproducible acceptance and ongoing upstream-revision review. Every deferred capability keeps an issue or approved exception; a feature label or green unrelated tests cannot count as parity.

Upstream evidence (paths relative to upstream repo root):

- `README.md`
- `api/src/services/execution/process_pool.py`
- `api/src/routers/packages.py`

Related Wrangnarok issues: #77, #78
