# ADR 005: Per-Organization Secret Storage

- **Status:** Accepted — v0, owner-approved 2026-09-10 per issue #78; firing amendment Accepted (owner-stamped 2026-09-17 per issue #411 — P1 authorized)
- **Date:** 2026-09-09 (v0 redraft 2026-09-10)
- **Extends:** ADR 003 (Integrations and Connections; now Implemented per #75), `docs/upstream-spec.md` Secret management row

## Context

An Integration is portable code; a Connection is Organization-scoped environment state
(see ADR 003). Portable Saga/Integration source must never embed Organization credentials.

Upstream Bifrost binds Integrations to per-organization OAuth/config state.
Wrangnarök must provide the same product boundary Cloudflare-natively,
starting from Worker + Workflows + D1 only (AGENTS.md constraint 7).

Operator experience since the Rung-1 NinjaOne integration reshapes the
problem: MSP-platform credentials are effectively global with vendor-side
multitenancy — one M2M app credential sees every tenant organization
through the vendor API. Per-Organization secrets have no demonstrated need
(AGENTS.md constraint 7), so v0 does not build per-Organization secret
storage. The envelope scheme is retained as a tripwire-gated upgrade, not v1.

## Decision v0 (accepted 2026-09-10 per issue #78)

Deployment-level secrets plus org-scoped non-secret Connection mapping:

- Integration credential sets live at the **deployment level** in **Secrets
  Store** (one entry per credential, per environment; local-only values for
  `dev`). This matches the current NinjaOne posture (`NINJA_CLIENT_ID` /
  `NINJA_CLIENT_SECRET` from env) and formalizes it: the credential belongs
  to the deployment's vendor relationship, not to any Organization.
- Connection rows stay **org-scoped and non-secret**: `(org_id,
  integration_id)` → endpoint plus non-secret config
  (`UNIQUE(org_id, integration_id)` already in migration 0001). No secret
  or token columns, plaintext or otherwise.
- Each `IntegrationDefinition` declares `secretFields` (already in
  `src/integrations/index.ts`: `echo` none, `ninjaone` `clientSecret`).
  Declarations drive the scrub/redaction discipline below; secret material
  is resolved transiently at the Integration Action call boundary and never
  serialized through discovery, history, or Execution results.
- No OAuth token persistence yet: client-credentials tokens are fetched per
  execution and dropped (the degenerate inline refresh that works today).
  Cached tokens are secret storage and wait for the tripwire.

### Provider-global scope must be declared per Integration

Deployment-global credentials are legitimate only where the Integration's
contract explicitly declares provider-global as its normal model — this is
not a generic implicit fallback. If an Organization-scoped Connection is
missing, resolution fails closed (`424 INTEGRATION_REQUIREMENT_UNSATISFIED`)
unless that Integration declares provider-global credentials as normal.

v0 declarations:

| Integration | Credential scope | Rationale |
| --- | --- | --- |
| `ninjaone` | provider-global (declared) | MSP-platform M2M app: one credential sees all tenant orgs vendor-side |
| `halo` | provider-global (declared) | Lab HaloPSA proof credential: one deployment credential for the pinned lab origin (TOOL-01 proof) |
| `cloudflare` | provider-global (declared) | One account API token as a deployment secret; per-Connection account mapping selects the inventoried account. No per-tenant secret demonstrated (issue #411; PR #406) |
| `echo` | n/a (fixture, no secrets) | Local loopback fixture; `secretFields: []` |

A future Integration whose vendor model is Organization-scoped must use
per-Organization Connections (tripwire path) and must fail closed until
they exist — never silently inherit the deployment credential.

## Scrub and redaction discipline (retained in full)

Unchanged from the prior draft and non-negotiable in v0:

- Decrypted material exists only transiently, server-side, inside
  Worker/Workflow execution at the Action call boundary.
- No secrets in D1 rows, ExecutionHistory, Execution inputs/outputs,
  Workflow step payloads, Worker logs, error messages, or smoke-test output.
- No API — admin debug included — echoes decrypted Connection secrets.
- Workerd tests audit every persisted surface with secret sentinels
  (precedent: `test/ninjaone.test.ts`, `test/ninja-echo-digest.test.ts`).

### Execution-scoped registry and universal output scrubbing (gating deliverable)

Before real credentials or OAuth are production-ready, the redaction
contract must be enforced by mechanism, not call-site discipline alone
(per issue #110 analyst reply, accepted):

- An execution-scoped secret registry: secret values materialized during an
  Execution are registered for that Execution; every egress/persistence path
  scrubs registered values by substring, not exact-match only. This is the
  transferable upstream lesson (dynamic registry + deep scrub); Fernet
  itself is not adopted.
- Scrubbed egress paths, all of them: console/logs, structured errors,
  Workflow outputs, D1 Trail/history rows, usage/telemetry payloads, HTTP
  responses, and thrown exception strings.
- Tests use secrets embedded as substrings (URLs, headers, vendor error
  bodies), never exact-value matches alone.

## Tripwire: envelope encryption as a gated upgrade

The application-level envelope scheme (Web Crypto AES-GCM-256, per-Connection
DEK wrapped by a per-environment KEK in Secrets Store, `ciphertext` /
`nonce` / `wrapped_dek` / `key_version` / `algorithm` beside non-secret
config, decrypt-only-transient) is fully specified in the prior draft and
preserved as the upgrade design — it is not built until the tripwire fires.

The tripwire fires on the **first Integration with genuinely per-tenant
secrets**: a vendor auth model with no global-with-multitenancy option, or
a compliance demand for per-tenant credential isolation. Pre-authorized now:
firing the tripwire may introduce a **separate dependency** (crypto helper,
KMS-adjacent library) if that is what the envelope takes — no second
justification round for the dependency itself, only for the firing.

Firing the tripwire means: an ADR amendment recording which Integration
fired it and why no global credential exists; the envelope implemented per
the retained spec (encrypt-with-latest, decrypt-with-version, staged
re-wrap rotation, dev-smoke-then-destroy drill); and D1 backups understood
to carry ciphertext thereafter (unrecoverable without the matching KEK).

### Tripwire evaluation: Cloudflare Zone Inventory (issue #411, decided 2026-09-17)

Question: does provisioning `CLOUDFLARE_API_TOKEN` for the migrated
Zone Inventory Sagas (PR #406) fire the tripwire and authorize building
per-Organization envelope encryption plus secret-writing operator paths?

Decision: **no — the tripwire stays shut.** The Cloudflare credential as
deployed is provider-global: one account API token lives as a deployment
secret, Connections carry endpoint plus account mapping only, and D1 holds
no secret values — the same posture as the NinjaOne M2M credential. No
Integration with genuinely per-tenant secrets was demonstrated, and no
compliance demand for per-tenant credential isolation was made. A future
multi-account Cloudflare posture (one token per customer Organization)
would be the firing condition, and firing it still requires the ADR
amendment above — this note does not pre-authorize it.

Accepted operator path (unchanged v0 discipline): provision the value
outside Wrangnarok surfaces via `wrangler secret put CLOUDFLARE_API_TOKEN
--env <env>` (stdin, so the value never lands in shell history; a
Keeper-sidecar pipeline feeds the same stdin), reference it by declared
name only (`secretEnvVars`, `{ ref }`-style references — never values in
D1, logs, or portable source). No Wrangnarok UI, CLI, or API accepts a
secret value; both non-goals from the issue hold (no unencrypted values,
no D1 discipline change). Rotation stays Secrets Store rotation per the v0
section below.

Follow-through shipped with this decision: `CLOUDFLARE_API_TOKEN` added to
the Worker-isolate `deploymentSecretsFromEnv` scrub list in
`src/secrets.ts` (the Workflow isolate already registered it) with
sentinel tests in `test/secret-scrub.test.ts`, and the provider-global
declarations table above now covers `cloudflare` (plus the missing `halo`
row).

Steward checkpoint (one-diagram test): still one authoritative secrets
path — deployment secrets plus the execution-scoped registry plus
universal substring scrubbing, tripwire shut. No second path was added.

> Superseded later the same day: the tripwire **FIRED** per owner
> velocity direction (issue #411 reopened). The shut decision above is
> kept as history; the firing amendment below is authoritative once
> owner-stamped.

## Firing amendment (issue #411, Accepted — owner-stamped 2026-09-17)

### What fires it and why no global credential suffices

The firing requirement is general operator velocity, explicitly
owner-authorized as broader than one vendor: every provider credential
must be provisionable through Wrangnarok surfaces (CLI, API, UI) instead
of per-credential `wrangler secret put` sidecars. Deployment-global
secrets cannot serve this: one store per account capped at 100 secrets,
statically declared bindings, and a redeploy per new credential make
per-Organization onboarding require a deploy. Provider-global v0 is
**retained, not migrated** — existing deployment credentials keep working
and no forced migration ships with this amendment.

### Crypto contract (boring composition only)

- Algorithm: AES-GCM-256 via Web Crypto, no custom construction, no new
  primitive (the pre-authorized crypto dependency needs no second
  justification round; Web Crypto needs none at all).
- Envelope: random DEK per (Connection, secret field); DEK wrapped by the
  per-environment KEK. KEK lives in Secrets Store (env secret, stdin-provisioned),
  never in D1, never in logs, never in portable source.
- Stored columns beside non-secret config: `ciphertext` / `nonce` /
  `wrapped_dek` / `key_version` / `algorithm`. Ciphertext only — D1 never
  holds plaintext values, same discipline as v0.
- Associated data binds `org_id` + Connection id: ciphertext decrypted
  under the wrong org or Connection fails closed (no cross-tenant move by
  row copy).
- Decrypt transiently at the Integration Action call boundary only;
  register the plaintext with the execution-scoped registry for
  write-time scrubbing, then drop it. Encrypt-with-latest,
  decrypt-with-version.

### Schema (migration 0029; 0017 stays RESERVED and is never used)

New `connection_secrets` table, separate from Connection identity/config
metadata: `(org_id, connection_id, field)` → envelope columns plus
timestamps. `UNIQUE(connection_id, field)`; FK to the Connection row so
deleting a Connection deletes its secrets. Nonce uniqueness is by
`crypto.getRandomValues` per encryption (never reused, never derived).

### Key lifecycle

- Generation: KEK per environment via stdin-provisioned secret
  (`wrangler secret put` piped, or Keeper-sidecar pipeline); dev and prod
  KEKs are distinct and never shared. Local dev KEK lives in `.dev.vars`
  (0600, never printed, never committed).
- Rotation: staged re-wrap — mint new `key_version`, re-wrap DEKs,
  verify decrypt-with-version on both generations, destroy the old KEK
  only after verification. Rotation is a runbooked drill:
  dev-smoke-then-destroy before touching prod.
- Loss/restore: D1 backups carry ciphertext thereafter and are
  unrecoverable without the matching KEK. Losing a KEK means
  re-onboarding N Organizations (the v0 single-vendor blast radius no
  longer applies — stated here, not discovered later).

### Operator contracts (CLI + UI)

- CLI `secret put` accepts values on **stdin only** (plus the existing
  `@FILE` form, which likewise keeps values out of argv/history); values
  never appear in args, logs, or errors. Missing/empty stdin fails loud;
  TTY without piped input refuses rather than blocks.
- API/UI writes accept values in the request body only; every readback is
  masked (`[SECRET]`, consistent with `configs` list masking) and never
  serializes values. Omitting a field on update preserves its ciphertext;
  undeclared fields are rejected; managed rows reject writes.
- No Wrangnarok surface echoes a value it accepted — the Bifrost masked
  config surface invariant, adapted.

### What stays shut under this firing

- OAuth token persistence: cached tokens and scheduled refresh stay
  fetch-and-discard (this firing covers Connection credentials, not
  token caching).
- D1 plaintext discipline and the scrub/redaction contract in full,
  extended to the new table and routes with sentinel tests.
- Tripwire-shut code claims that P1 breaks (`src/connections.ts`
  boundary header, `src/secrets.ts` envelope note, masked-view shaping)
  are amended in the same lane; untouched claims (OAuth, provider-global
  resolution) stay as-is.

### Acceptance (P4 test matrix, local workerd, fixture secrets only)

Wrong-org/wrong-key decryption failure, tamper rejection, nonce
uniqueness, versioned decrypt across rotation, rotation/recovery drill,
ciphertext-only persistence (sentinel audit of every D1 row), masked
views and `[SECRET]` lists carrying no values, stdin EOF/TTY behavior,
UI no-value-leak, and dev/prod KEK separation. No production
credentials at any stage.

Steward checkpoint (one-diagram test): after stamping, the secrets path
is deployment secrets (v0 retained) plus per-Organization envelope
ciphertext (fired) under one registry/scrub discipline — two stores, one
discipline, one diagram. If a third storage story appears, consolidate
before new parity lanes.

### OAuth token persistence slice 1 (issue #149, post-#148 amendment)

SEC-02 closed (issue #148; PR #427 merged), so the "OAuth token
persistence stays fetch-and-discard" line above is now superseded for
per-Connection OAuth tokens only. This slice persists encrypted
per-Organization, per-Connection OAuth tokens plus non-secret health in a
new `oauth_tokens` table (migration 0031, `src/oauth-tokens.ts`) — and
explicitly adds no second secret store:

- Same envelope, same KEK: AES-GCM-256 rows via `src/envelope.ts`
  (`ciphertext` / `nonce` / `wrapped_dek` / `key_version` / `algorithm`
  per token value), per-environment KEK from Secrets Store, associated
  data binding org_id + Connection id + field (`oauth_access` /
  `oauth_refresh` bindings so the two values never decrypt under each
  other). Encrypt-with-latest, decrypt-with-version, staged re-wrap
  rotation, and dev/prod KEK separation are unchanged from the firing
  amendment above.
- Same discipline: D1 holds ciphertext only (sentinel-audited); decrypted
  tokens exist transiently at the Integration Action call boundary,
  register with the execution-scoped registry for write-time substring
  scrubbing, then drop. No token material in D1 rows, ExecutionHistory,
  Workflow state, logs, errors, or HTTP responses.
- Same fence: every rotation funnels through the existing centralized
  `refreshRotatingToken` primitive plus the `OAuthRefreshFence` object
  with the persisted generation as the fence generation. Replacement
  writes are conditional on the expected persisted generation
  (`UPDATE ... WHERE generation=?`): a superseded writer observes
  OAUTH_TOKEN_GENERATION_STALE instead of overwriting the newer token.
  No D1 transaction is held across vendor HTTP — D1 read, vendor call,
  and D1 conditional write are separate phases.
- Health persists honestly per Connection (`healthy` / `failed` /
  `revoked` with consecutive-failure counting via the pure lifecycle in
  `src/oauth.ts`): vendor Faults mark failed, successful rotation
  recovers to healthy, explicit revocation marks revoked without moving
  Connection identity. Raw transport errors propagate without a health
  write (reachability unknown). Deleting a Connection deletes its token
  row (explicit delete beside the FK cascade; pre-0031 chains skip it).
- No new operator surface: no callback route, no consent UI, no secret
  value echoed on any path. No scheduled refresh (still needs its own
  demonstrated need and ADR). No Integration-list health aggregate (the
  PR #762 effective-Connection semantics stay deferred until cached
  tokens plus consent rows exist to aggregate over).

Steward checkpoint (one-diagram test, 2026-09-17): still one secrets
path — deployment secrets plus per-Organization envelope ciphertext
(Connection credentials and now OAuth tokens, same mechanism, same KEK
lifecycle, same registry/scrub discipline). No third storage story;
Free-tier posture unchanged (one D1 table, no new primitive, no new
binding).

## Why Secrets Store alone is insufficient for per-org secrets (tripwire rationale)

This is why the envelope — not more deployment secrets — is the upgrade
when the tripwire fires. Secrets Store is real and correct for v0's
platform-level keys, but structurally wrong for per-Organization
credentials: one store per account capped at 100 secrets, per-secret
statically declared bindings, and every new credential needing a config
entry plus a redeploy by a Secrets Store Deployer. Onboarding one
Organization must never require a redeploy, and Organization isolation
would still have to be built on top — at which point the envelope has been
rebuilt with extra steps and a ceiling. D1 encryption at rest, likewise,
does not make plaintext credential columns acceptable application design.

## v0 rotation, backup, restore

- Rotation is Secrets Store rotation (version, verify, destroy) with a
  Worker restart/redeploy; no re-wrap migration, because D1 holds no secrets.
- D1 backups are secret-free by construction. KEK-style loss semantics do
  not apply in v0; losing a deployment secret means re-onboarding one
  vendor relationship, not N Organizations.

## v0 acceptance (accepted 2026-09-10 per issue #78; unlocks 3.0 implementation)

Owner stamp per issue #78. Entry basis: #75 closed (ADR 003 Implemented),
KEK provisioning dropped under v0, scrub/redaction discipline retained with
`secretFields` coverage tests. Envelope stays Proposed/tripwire-gated; cached
tokens and refresh stay 3.1-gated with no D1 schema for secrets until the
tripwire fires. Milestone 3.0 exit (scrub/redaction matrix green,
deployment-secret rotation runbook exercised on dev) is tracked by the
milestone, not by this stamp. The superseded items below are kept as the
acceptance record:

1. Threat model: deployment-secret compromise blast radius, admin vs
   ordinary caller on Connection mapping writes, backup/log attacker.
2. Scrub/redaction tests green in workerd for every Integration with a
   non-empty `secretFields` list (allowed/denied callers, history/result/log
   audit with sentinels).
3. `secretFields` coverage: every Integration declares; every declared
   field is excluded from discovery/history/result serialization by test.
4. Acceptance stamp (this note, v0 Accepted) + updated
   `docs/upstream-spec.md` secret-management row.
5. Execution-scoped secret registry + universal output scrubbing implemented
   with substring-embedded sentinel tests green on every egress path above
   (gating: real credentials/OAuth stay non-production until this lands).

## Alternatives considered (ecosystem survey, Sep 2026; verdicts stand)

| Pattern | Verdict |
| --- | --- |
| Few static secrets (Worker secrets / Secrets Store) | **Adopted for v0 platform-level keys** (including any future KEK). Fails per-Organization credentials on cardinality (100/account), static per-secret bindings, and redeploy-per-tenant onboarding — which is why it is v0, not the tripwire answer. |
| Application-level envelope encryption | **Tripwire-gated upgrade** (see above), not v1. |
| Per-Organization D1 databases (Cloudflare's own SaaS guidance: DB/KV/R2 per customer) | **Documented upgrade path, not v0.** Matches Cloudflare's "complete isolation" story and stays on the earned D1 primitive. |
| Tenant-scoped Durable Objects as vaults (one DO per org, secrets in DO SQLite storage) | Strongest isolation story, but a new primitive (must be earned), paid-metered, and still needs app-level routing correctness. Requires its own ADR if ever demanded. |
| Workers for Platforms per-tenant bindings | Rejected twice over: paid-only dispatch namespaces (breaks the Free-tier constraint) and equally static bindings. |
| External KMS (call out to AWS/GCP/Vault) | Rejected: vendor dependency, latency, and cost against the Cloudflare-native experiment constraint. |

## Storage topology: single D1 now, per-Organization D1 later

v1 is a **single D1** with `org_id` columns and (under v0) zero secret
columns: unbounded Organizations on Free, static bindings, one migration
stream (ADR 004), isolation by deny-by-absence `WHERE` clauses proven with
allowed/denied caller tests. Per-Organization D1 databases are the Phase 3+
upgrade, gated on all of:

1. A Paid plan (Free caps at **10 databases per account** — per-org D1 as v1
   would cap the product at 10 Organizations and violate the Free-tier
   constraint outright).
2. An Organization count or compliance demand where per-DB blast radius,
   backup/restore, and per-DB usage metering justify migration fan-out.
3. A runtime routing design that does not smuggle an API token into the edge
   (static bindings cap at ~5,000/script and still need deploys; the
   Cloudflare API from inside the Worker is a super-credential, worse than
   the problem it solves).

Until all three hold, per-org D1 is studied, not built.
