# ADR 032: AI Provider Connections, Model Profiles, and Capability Assignments

- **Status:** Accepted (design slice; build slices follow)
- **Date:** 2026-09-16
- **Extends:** ADR 003 (Integrations and Connections), ADR 005 (secret storage v0), ADR 022 (OpenAPI Code Mode / MCP)
- **Implements:** AI-01 (issue #164), upstream `ai_models.py` / `llm_config.py` / `ai_model_service.py` adaptation

## Context

Upstream Bifrost configures AI providers in three layers behind
platform-admin routers (surveyed at `3543c7eb` on issue #164):
**Provider Connection** (named credential + endpoint for one of
`openai | anthropic | google | openrouter | openai_compatible`),
**Model Profile** (reusable connection + model id + capabilities JSON +
chat flags, with `openai_transport`), and **Assignment** (six fixed global
default-routing keys), plus a separate **embedding singleton** and a
**behavior row** (default system prompt). Credentials are Fernet-encrypted
at rest; API responses carry only `api_key_set: bool` plus profile counts.
Verify/test/discovery decrypt server-side only, test-before-save
everywhere. The browser sees profile identities, never provider model ids
or key material.

Wrangnarok already owns the reusable substrate (surveyed on #164):
org-scoped Connection CRUD with secret-free views (`src/connections.ts`),
the `testConnection` presence-check-then-probe ladder, the
`defineIntegration` registry with credential-shaped names structurally
excluded (`src/integrations/index.ts`), admin-gated management routes, and
the execution-scoped scrub discipline (`src/secrets.ts`).

## Decision

### Provider kinds are Integration definitions

The five upstream provider kinds land as `IntegrationDefinition` entries
under CON-01, one per kind (`openai`, `anthropic`, `google`, `openrouter`,
`openai-compatible`). `openai_compatible` requires an explicit endpoint
(its vendor model has no default); the other four carry per-provider
default endpoints. This reuses `validateConnectionConfig`,
`assertSafeEndpoint`, and the Connection management routes unchanged.

### Credentials stay deployment-global in v0 (no tripwire)

Upstream AI Connections carry a per-connection encrypted API key. That is
per-tenant secret storage, which fires the ADR 005 tripwire. This slice
does **not** fire it: AI provider credentials are declared
provider-global per Integration (the `requiredSecrets` + `secretEnvVars`
names-only mapping, NinjaOne posture), resolved from the deployment
environment, presence-checked inside execution, never persisted to D1,
never returned through discovery, and scrubbed from every outward Fault.
One vendor identity per deployment is the accepted v0 limitation.

Per-tenant AI keys (per-org/per-connection ciphertext, envelope scheme,
staged rotation) wait for an explicit tripwire firing with its own ADR
amendment recording which Integration fired it and why no global
credential exists. D1 plaintext key columns are never an interim step.

### Profiles, assignments, embedding, and behavior are separate entities

- **Model Profile** rows (migration 0028): stable UUID id, org scope,
  CI-unique name per org, FK `RESTRICT` to the provider Connection row,
  model id, capabilities JSON, `openai_transport`, `enabled_for_chat`.
  Discovery views carry profile identities and capability summaries only;
  provider model ids and key material never reach the browser.
- **Assignments** are org-scoped rows over the six upstream keys
  (`primary, summarization, tuning, image_generation, video_generation,
  chat_default`). Divergence from upstream: no platform-global tier in v1
  (same hazard ADR 003 rejected for credentials). Missing mappings fail
  closed; `primary`/`chat_default` cannot be cleared.
- **Embedding configuration** (connection + model + dimensions) and the
  **behavior row** (default system prompt) are fully independent entities
  with their own tables, never columns on generation profiles.
- **Lifecycle guards** port directly: first profile auto-enabled for chat
  and auto-assigned; disabling chat while holding `chat_default` is
  rejected; deletes blocked while referenced; merge reassigns assignments
  to the target and ORs chat flags.

### Capability state resets on transport change

Provider capability negotiation (e.g. Anthropic prompt-cache support,
`openai_transport`) lives on the Connection as explicit
unknown/supported/unsupported state, reset when endpoint/transport
identity changes, with fallback narrowly tied to a provable pre-generation
rejection. Capability state never rides the nominal provider kind alone.

### Verification is bounded and mocked

Verify/test/discovery follow the `testConnection` ladder:
presence-check declared secrets, re-parse the persisted endpoint, 5s
vendor probe, read-only by construction, every outward detail scrubbed.
Tests use mocked vendor HTTP only (no live inference; Cloudflare Free
never includes external model inference). Provider cost is documented per
Connection; inference is classified paid-adaptation under LIMITS-01.

## Consequences

- AI-01 build slices: migration 0028 DDL, profile/assignment entities
  with lifecycle guards, admin-gated management routes, bounded
  verify/test/discovery probes, browser profile-identity surface.
- The SEC-02 tripwire stays shut; per-tenant keys need their own firing.
- No new runtime primitives; bundle budget respected.
