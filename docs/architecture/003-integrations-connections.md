# ADR 003: Integrations and Connections

Status: **Core contract implemented** (per issue #75), **management boundary implemented** (CON-01, issue #146). OAuth/token lifecycle surfaces below remain illustrative.

## Context

Upstream Bifrost separates an Integration definition from organization-specific mappings. A workflow resolves the Integration in its current organization context; configuration is composed from service defaults and organization overrides, while OAuth/token state belongs to the environment rather than portable workflow source.

Wrangnarök needs the same product boundary without inheriting Bifrost's implementation.

## Decision

### Integration

A **Integration** is code: a reusable, typed TypeScript integration/provider definition.

An Integration owns:

- a stable machine identifier;
- human discovery metadata;
- typed configuration schema;
- identification of which configuration fields are secret;
- optional authentication/OAuth contract;
- typed Actions that Sagas may call;
- vendor-specific request/response normalization;
- vendor-specific pagination/rate-limit/error behavior where useful.

An Integration does **not** own tenant credentials or mutable OAuth tokens.

Example shape (illustrative, not yet API-stable):

```ts
export const echo = defineIntegration({
  id: "00000000-0000-0000-0000-000000000101",
  name: "echo",
  config: EchoConfig,
  actions: {
    echo: async (ctx, input: EchoInput) => {
      const response = await ctx.fetch(`${ctx.config.baseUrl}/echo`, {
        method: "POST",
        body: JSON.stringify(input),
      });
      return response.json<EchoResult>();
    },
  },
});
```

### Connection

A **Connection** is environment state: a configured instance of an Integration for an Organization.

A Connection owns:

- stable Connection ID;
- Integration ID;
- Organization ID;
- optional external entity/tenant ID and display name;
- non-secret configuration;
- references to secret material;
- authentication state/metadata;
- created/updated timestamps.

A Connection must never serialize decrypted credentials through the ordinary public API, ExecutionHistory, Execution result, or browser-facing state.

### Resolution

A Saga normally asks for an Integration in the current Execution's Organization context. The runtime resolves the corresponding Connection.

The MVP resolution rule is deliberately strict:

1. Resolve the requested Integration by stable ID/name.
2. Resolve a Connection for exactly the current Organization.
3. If none exists and the Saga declared the Integration required, fail with structured `INTEGRATION_REQUIREMENT_UNSATISFIED` (424 semantics inside ExecutionHistory). Optional undeclared lookup returns `None` without throwing. ADR 010 and the implementation mapping below supersede the former uniform `CONNECTION_NOT_CONFIGURED` rule.

There is **no implicit global credential fallback in the MVP**. Upstream supports org/global cascades, but explicit Organization isolation is safer and simpler for the experiment. Shared/default Connections may be introduced later only with explicit lookup and write-boundary semantics.

Explicit cross-Organization Connection lookup is an administrative capability, not something arbitrary Saga code receives by passing another Organization ID.

### Actions

An **Action** is a typed callable exposed by an Integration. Keep this boring term.

Sagas should ideally read like ordinary TypeScript:

```ts
const echo = await ctx.integrations.echo.echo({ message: "hello" });
```

Do not require Saga authors to manipulate Connection records, tokens, D1 rows, or Cloudflare bindings directly.

### Secret boundary

Cloudflare Worker secrets and Secrets Store are suitable for deployment/account-level secrets, but they are not by themselves a scalable per-Organization Connection store: Worker secrets are deployment bindings, while Secrets Store is account-level and currently limited in count.

D1 encryption at rest does not make plaintext credential columns acceptable. **ADR 005 v0 is accepted:** explicitly declared provider-global deployment credentials plus Organization-scoped non-secret Connection mappings. NinjaOne currently uses transient client-credentials tokens without persistence; echo has no credentials. Missing required org mappings still fail closed rather than invoking a generic global fallback.

Per-Organization envelope encryption, token persistence, key lifecycle and rotation remain behind ADR 005's first genuinely per-tenant-secret/compliance tripwire. They are not requirements to replace the accepted v0 prematurely. Execution-scoped secret registration and universal substring scrubbing remain production-readiness gates under #110; selected sentinel tests and shaped results do not establish that mechanism. The audit also distinguishes actual Worker secret strings from the ADR's intended Secrets Store binding choice, which needs explicit reconciliation.

### OAuth

OAuth is deferred, but the Connection contract must leave room for:

- authorization-code tokens;
- client-credentials flows;
- access/refresh token expiry;
- refresh coordination;
- alternate requested scopes/resources;
- token replacement without replacing Connection identity.

Token refresh must not be implemented independently in every Saga.

## Consequences

- Integration code remains portable and Git-versioned.
- Connection state remains Organization/environment-specific.
- A Saga cannot accidentally carry credentials in source.
- MVP tenant resolution is stricter than upstream Bifrost's global fallback behavior.
- Secret storage becomes an explicit security design task rather than an accidental D1 schema detail.
- The MVP slice can implement the Integration abstraction without blocking on OAuth/secret storage.

## Upstream behavior intentionally not copied yet

- global/default Integration credential fallback;
- provider-organization mapping enumeration;
- cross-org mapping administration from ordinary workflow APIs;
- full Solution install requirement resolution beyond the implemented Saga `requiredIntegrations` boundary;
- OAuth scope override behavior.

These remain specification fodder for later phases.

## Implementation mapping

Per issue #75 (lanes A: PRs #80, #83, #85, #88), extended by CON-01 (issue #146):

- Integration registry: `src/integrations/index.ts` (`defineIntegration` validates stable UUID id, slug name, 1–280 char description, explicit `secretFields` list; definitions frozen via `Object.freeze`; `INTEGRATION_DEFINITIONS` canonical order; `integrationById`/`integrationByName` lookup).
- Non-secret config schema (CON-01): each definition declares `configSchema` (typed non-secret fields with required/defaults/bounds, always including `endpoint`), `requiredSecrets` (provider-global credential names, each mapped to a deployment env var in `secretEnvVars`), and `health` (test hint + remediation copy). `validateConnectionConfig` applies defaults and rejects unknown keys, missing required fields, overlong values, and credential-shaped input with per-field 400 details. Credential-shaped names can never enter the non-secret schema.
- Endpoint safe-URL policy (issue #236): every `endpoint` value — explicit or defaulted — must parse with `new URL` and satisfy the per-Integration policy before it can persist (create/update) or be used (vendor Action, management probe). Echo is loopback-only over plain http (the local fixture); ninjaone requires https under `.ninjarmm.com` or the never-routable `.invalid` test seam. Malformed, credential-bearing, non-web-scheme, and internal-address targets fail closed with per-field 400 details at write time; rows that predate the policy fail closed as `INVALID_CONNECTION` at use time without any outbound fetch.
- Connection entity: typed `Connection` in `src/integrations/index.ts` (stable IDs, non-secret endpoint, optional display label, enabled flag, managed_by marker; secret material referenced transiently at execution time, never stored there), returned by `resolveConnection` in `src/executions.ts`.
- Resolution: `resolveConnection` in `src/executions.ts` looks up exactly one row for the current Organization (`WHERE org_id=? AND integration_id=?`, never a global cascade, never cross-org); declared-but-missing — including a disabled mapping — fails loud with structured `424 INTEGRATION_REQUIREMENT_UNSATISFIED`; undeclared (optional) access resolves to `None` with no throw. Pre-0007/0004 rows are read tolerantly with backfill-equivalent defaults.
- Management boundary (CON-01): `src/connections.ts` is the one authorized path for non-secret mappings — list/create/read/update/delete plus a read-only connectivity test, all scoped to the caller's Organization. Managed rows reject live mutation with `MANAGED_RESOURCE` (installer-only writes); loose rows stay writable. The Worker serves `GET /api/integrations`, `GET/POST /api/connections`, `GET/PUT/DELETE /api/connections/:integrationId`, and `POST /api/connections/:integrationId/test`; every response is scrubbed with the deployment secrets and views carry required-secret names only, never values. The `/connections` admin screen plus typed client calls use the same routes.
- Declared requirements: mandatory `requiredIntegrations` field on `SagaDefinition` plus `CatalogEntry` in `src/saga.ts` (validated at startup, frozen; operational-policy keys rejected from source).
- Secret-field declarations: `secretFields` on each `IntegrationDefinition` (`echo`: none; `ninjaone`: `clientSecret`), with selected output-shaping/sentinel tests. Universal output scrubbing remains the separate ADR 005/#110 mechanism gate.
- Upstream 424 adaptation: upstream Bifrost serves declared-missing requirements as HTTP 424 at the API boundary (`SolutionConnectionSchema` resolution, org → defaults fallback). Wrangnarök keeps the stricter MVP posture — no global/default fallback — and the 424 surfaces in two places: as the structured step error inside ExecutionHistory on the submit path (existing ADR 010 contract), and as the HTTP status of `POST /api/connections/:integrationId/test` when the mapping is missing (CON-01 management parity for the same code).

What stays deferred (not implemented by this closeout): OAuth authorization-code/refresh coordination/audience overrides/token replacement lifecycle, per-Organization envelope encryption behind ADR 005's tripwire, generic global/default credential fallback, provider-organization mapping enumeration beyond the caller's own Organization, and cross-org mapping administration. Provider-global v0 credentials are accepted, not a claim that these broader features or production gates are complete.
