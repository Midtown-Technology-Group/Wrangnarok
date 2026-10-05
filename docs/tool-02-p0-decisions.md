# TOOL-02 P0 decision record: external MCP servers (issue #171)

- **Status:** Proposed (P0 output per ai-tool-ops Brief 3; P1 folds accepted
  decisions into the TOOL-02 ADR after the 023 number repair in #225)
- **Date:** 2026-09-17
- **Scope:** docs-only. No `src/`, `migrations/`, or `test/` changes.
- **Evidence:** `docs/upstream-spec.md` §23 (survey at upstream
  `gobifrost/bifrost@3543c7e`), `docs/upstream-parity.md` TOOL-02 row,
  ADRs 003/005/013/014/018/022/023, `docs/feasibility-envelope.md`.

Upstream behavior below is pinned to exact paths; the proposals say what
Wrangnarök adopts, adapts, or defers, with Cloudflare-driven rationale.

## D1 — Identity substrate: Connection-first resolution; agents attach later

Upstream hangs outbound dispatch off user-managed agents: MCP tools reach the
planner only through explicit per-agent grants (`agent_mcp_connections`,
deny-by-default), and both planning (`resolve_agent_tools`, keyed on
`caller_user_id` present vs `None`) and dispatch (`resolve_token` five-path
table) are caller-aware (`api/src/services/execution/agent_helpers.py`,
`api/src/services/mcp_client/auth_resolution.py`).

Wrangnarök has no agent entity: AI-02 (#165) is Missing, ADR 041
(Cloudflare Agents runtime, renumbered from 023 by issue #225) is Proposed. Blocking TOOL-02 P2 on AI-02
would stall outbound MCP on the heaviest Phase-6 dependency and drag the
Agents-SDK/Durable-Object primitive into the MCP path before AI-02 earns it
(project constraint 7: Worker + Workflows + D1 first).

**Proposal:**

1. P2/P3 build Connection-first resolution: portable templates,
   Organization Connections, per-Connection tool catalog, per-user consent
   credentials, and one centralized resolver keyed on (Connection, caller)
   where caller is a user identity or an explicit service principal.
2. Autonomous runs use an explicit Connection-owned service principal, not
   ambient authority — consistent with the existing machine-principal shape
   (`endpoint:<id>` principals in ADR 037, service allowlist in ADR 014).
3. AI-02 agents attach later as an additional deny-by-default grant filter
   on the same resolver (same shape as upstream `agent_mcp_connections`),
   without changing the resolution table.

This preserves the upstream invariants that matter — no ambient tools,
caller-dependent visibility, planner-vs-dispatch split — while keeping P2
dispatchable without AI-02. Rejected alternative: block P2 on AI-02 agents.

## D2 — Transport: HTTP-only (Streamable HTTP) v0, as parity

Upstream's outbound client is already exactly-one-transport Streamable HTTP:
"`mcp.client.streamable_http.streamablehttp_client`. No SSE, no stdio — both
are deliberately omitted" (`api/src/services/mcp_client/client.py`
docstring). An HTTP-only v0 therefore reproduces upstream; it is not a
divergence.

**Proposal:**

1. v0 speaks Streamable HTTP to external MCP servers only. SSE, stdio,
   private endpoints, and non-HTTP transports are explicit non-support in
   v0, with compatibility statements proven by the P4 fixture server.
2. Authenticated egress rides the ADR 013 per-Connection allowlist with
   explicit redirect/timeout/byte-bound policy (upstream-spec §6
   implication); per-Connection URL override wins over the template URL,
   as upstream.
3. Keep the "exactly one transport per module" shape so a future transport
   arrives as a separate module, not a parallel branch.

## D3 — Secret home: OAUTH-01 envelopes + SEC-02 path; no privilege fallback

Upstream splits secrets four ways: secretless templates, per-org Connections
carrying the encrypted client pair, a verbatim tool catalog, and per-user
consent credentials; tokens resolve through one five-path table with a
5-minute freshness margin and single refresh-plus-persist
(`api/src/services/mcp_client/auth_resolution.py`,
`api/src/models/orm/external_mcp.py`).

The Wrangnarök homes already exist: per-Connection OAuth tokens persist as
OAUTH-01 envelopes (migration 0031, `src/oauth-tokens.ts`, fenced refresh
via the `OAUTH_REFRESH_FENCE` Durable Object), and per-Organization secret
material has the SEC-02 envelope backend (migration 0029,
`connection_secrets`, tripwire fired per #411/#419/#424).

**Proposal:**

1. Service tokens and per-user consent tokens persist as OAUTH-01 token
   envelopes; per-org client pairs use the SEC-02 envelope path. No new
   secret store, no D1 plaintext, no deployment-secret fallback for
   per-user consent material.
2. Adopt the five-path resolution table with the hard no-privilege-fallback
   rule: a user-identity auth failure resolves to needs-reauth, never to
   the service identity (upstream dispatch already does this: a USER_TOKEN
   that still 401s after the single forced refresh raises
   `NeedsReauthError`, not a fallback). The chat service fallback (upstream
   path 2) survives only as an explicit admin decision via the
   `available_in_chat` flag — never a silent upgrade. Autonomous callers
   have no user identity to fall back from (paths 4/5).
3. Needs-reauth and misconfigured states deny safely with a reconnect
   affordance (server-built reauth URL); consent stays one credential per
   (user, Connection) with granted scopes and timestamp, isolated per
   user; disconnect is idempotent and deletes the token row.
4. Refresh stays inline/on-demand in P2/P3 (single attempt, persisted on
   success, uncached health checks so revocation fails closed on next
   call). Scheduled refresh stays deferred with OAUTH-01's scheduled
   refresh — no Cron Trigger is earned by TOOL-02 v0.

## D4 — Namespace and collision policy

Upstream: LLM-visible names are `mcp__<connectionUUID>__<tool>` with
UUID-validated parsing (malformed names route elsewhere, never error);
catalog rows are unique per (Connection, tool name) with verbatim schemas;
precedence is system tools > workflow tools (sorted by ID, loser hidden
with a warning) > delegation > MCP; drift is handled by refresh
(auto-disable with timestamped reason, manual-disable survival,
restore re-enables only auto-removed rows).

**Proposal:** adopt the policy verbatim, in lexicon terms:

1. Qualified tool names `mcp__<connection-id>__<tool>`; the Connection-id
   segment is validated on parse; unknown or disabled tools deny (never
   silently reroute).
2. One catalog row per (Connection, tool name); schema persisted verbatim
   at sync revision; drift handled by refresh with the upstream
   auto-disable / manual-survival / restore rules.
3. Precedence: curated/system tools first, then Saga tools in deterministic
   order (hidden loser logged), then delegation, then MCP; the `mcp__`
   prefix keeps MCP names disjoint from native names by construction.
4. Tool description prefers the vendor schema description, else a
   generated fallback; argument schema accepts `inputSchema` or
   `input_schema`, else an empty object.

## Steward and Free-tier notes (P0)

- P0 is docs-only: no new authoritative path. P1/P2 must run the
  one-diagram check for the new credential-resolution path (it must land
  as the single resolution path, composing with the AUTH-01 membership
  gate and AUTH-02 roles spine, not a second auth path).
- No new Cloudflare primitive: Worker + D1 + `fetch` only, reusing the
  OAUTH-01 fence. External model inference stays vendor-paid
  (feasibility-envelope `paid-adaptation` row); nothing here changes that.
- AGPL-3.0: behavior recorded from upstream; no upstream code copied. P2+
  lanes adapting upstream implementation material must preserve
  attribution/notices (project constraint 14).

## Explicitly not decided here (P1 owns)

D1 schema and migration numbering (steward-owned), route table, SDK/client
surface, consent-UI shape, fixture-server design, and the TOOL-02 ADR number
itself (blocked on the #225 023-collision repair — P0 mints nothing).
