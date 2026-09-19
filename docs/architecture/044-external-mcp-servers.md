# ADR 044: External MCP servers — templates, Connections, catalog, consent, dispatch

- **Status:** Accepted
- **Date:** 2026-09-18
- **Decides:** Issue #171 (parity TOOL-02, slices S1–S4)
- **Related:** ADR 003 (exact-org resolution, no global fallback), ADR 005
  (secret storage + firing amendment), ADR 013 (egress limits), ADR 022
  (inbound MCP gateway + Code Mode host path), P0 decisions
  (`docs/tool-02-p0-decisions.md`), upstream pins
  (`docs/upstream-spec.md` §23)

## Context

Upstream Bifrost connects external MCP servers through four distinct
records — secretless server templates, per-Organization Connections
carrying the org's OAuth pair, a verbatim per-Connection tool catalog,
and per-user consent credentials — resolved through one five-path
credential table and dispatched over Streamable HTTP
(`docs/upstream-spec.md` §23). Wrangnarök had none of the outbound half:
no templates, no org bindings, no catalog, no consent store, no resolver,
no dispatch. The OAUTH-01 substrate (envelopes, generation-fenced token
writes, single-flight refresh, `OAuthRefreshFence` DO) and the TOOL-01
inbound gateway existed and are reused, never forked.

## Decision

1. **Four records, four tables** (migration 0041): `mcp_server_templates`
   (secretless: globally-unique name, server URL, provider flow,
   optional org scope, soft-delete flag), `mcp_connections` (one row per
   server × org: URL override, token path, public client id, chat and
   autonomous availability flags, enablement), `mcp_tool_catalog`
   (verbatim schemas, enabled flag, auto-disable reason), and
   `mcp_user_consents` (one row per Connection × user: granted scopes
   plus the user token envelope) beside `mcp_service_tokens` (one
   envelope row per Connection). Portable templates carry no secrets by
   schema; per-user consent rows are envelope ciphertext excluded from
   portable source (the OPS-03 encrypted-backup boundary: re-onboard on
   restore).
2. **Secret homes reuse the settled paths.** Service and consent tokens
   persist as ADR 005 envelopes with the OAUTH-01 generation-fenced
   conditional writes (`UPDATE ... WHERE generation=?`); the per-org
   client pair persists as an envelope in the MCP-owned
   `mcp_connection_secrets` table — the SEC-02 envelope *path*
   (AES-GCM-256, per-environment KEK, org+Connection+field AAD) in a
   sibling table because `connection_secrets.connection_id` FK-binds the
   vendor `connections` table and local D1 enforces the FK. No D1
   plaintext, no deployment-secret fallback for per-user material.
3. **One five-path resolver** (`src/mcp-auth.ts`, pure): user consent →
   explicit `available_in_chat` service fallback → needs-reauth
   (`authorization_code`, carrying a server-built reauth URL) or
   misconfigured (`client_credentials`); autonomous callers present an
   explicit Connection-owned service principal and resolve service only
   through `available_to_autonomous`, else misconfigured. A user-identity
   auth failure resolves to needs-reauth, never to service. Freshness
   reuses the shared 5-minute skew; NULL expiry counts as fresh; health
   is reread per call so revocation fails closed.
4. **Dispatch is Streamable HTTP only** (`src/mcp-dispatch.ts`): catalog
   gate, then resolution, then one bounded vendor call. Exactly one
   resolve-plus-retry on 401/403 with at most one inline refresh per
   dispatch (single-flight shared, persisted through the fenced write,
   falling through on failure). Redirects never carry the Bearer
   (manual mode, loud failure); responses cap at ~250 KB; timeouts are
   per-call. SSE, stdio, private endpoints, and non-HTTP transports are
   explicit v0 non-support.
5. **Namespace policy adopted verbatim** (P0 D4): qualified names
   `mcp__<connectionId>__<tool>` with UUID-validated parse (malformed
   names route elsewhere, never error); one catalog row per
   (Connection, tool); drift auto-disables with a timestamped reason,
   manual disables survive every sync, vendor returns restore only
   auto-removals.
6. **Consent reuses OAUTH-01 primitives** (`src/mcp-consent.ts`): PKCE,
   state, authorization-URL building, callback validation, and the code
   exchange run through `src/oauth.ts`; only the persistence target
   differs. Rotate-on-consent replaces at generation + 1 (the OAUTH-01
   adaptation of the upstream orphan-row insert — identity survives).
   Disconnect (user or service) is idempotent deletion. `none`-flow
   templates bind but deny dispatch until a flow is configured.
7. **AUTH-02 composes without schema changes.** No new resource kind or
   role table: dispatch denies viewers through the existing
   read-only-ceiling probe (`isViewer`), and AI-02 agent grants attach
   later as a deny-by-default filter on the same path (P0 D1.3).
   Autonomous runs carry the explicit service principal (P0 D1.2), never
   ambient authority.
8. **No new Cloudflare primitive.** Worker + D1 + `fetch`, reusing the
   OAUTH-01 `OAuthRefreshFence` binding for cross-instance refresh
   serialization (module-local single-flight without it). Catalog/CRUD
   rows fit Free D1 limits; external model inference stays vendor-paid
   per the feasibility envelope.

## Adaptations (upstream behavior intentionally reshaped)

- Orphan-row rotation → generation-fenced replace (OAUTH-01 identity
  contract: Connection identity survives revoke/replace).
- Vendor-returned scope → requested scope persisted (the shared exchange
  primitive returns no scope; recorded here, not silently claimed).
- ~250 KB truncation nudge → `MCP_RESPONSE_TOO_LARGE` fail-loud (the
  Code Mode precedent; keeps every envelope bounded).
- Catalog sync on `authorization_code` Connections without a service
  credential answers loud 400 (upstream rule: sync always uses the
  service token, never per-user).
- Vendor-side token revocation calls are a named follow-up (no
  revocation path is stored; disconnect deletes locally).

## Explicit non-goals for v0

SSE/stdio/private transports; scheduled refresh (inline/on-demand only,
with OAUTH-01); confidential-client refresh variants beyond the shared
rotating primitive; vendor revocation calls; AI-02 agent-grant filter;
portable backup of consent ciphertext.

## Steward checkpoint

One authoritative path each: authentication/authorization rides the
membership gate plus the AUTH-02 ceiling probe (no second auth path —
the resolver composes inside it); execution is the single dispatch
function; persistence is D1 migration 0041; secrets ride the envelope
path with the one sibling table justified above; deployment is the
existing Worker; recovery is generation-fenced re-connect. No second
Connection path: vendor `connections` and `mcp_connections` are
distinct entities with distinct tables, and the client-secret table
split exists only to satisfy FK integrity, not to offer a choice.
