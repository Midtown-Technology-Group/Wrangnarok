# ADR 013: Phase 2 egress and resource limits per Integration

**Status:** Recorded for issue #76. Descriptive, not prescriptive: it pins
the outbound and per-Operation bounds the code already enforces, so the
next Integration copies explicit caps instead of inheriting host behavior.
No code change in this slice. Upstream pointer: finding 6 implication
(document per-Integration egress) and the lift-and-shift networking lesson
(`docs/upstream-spec.md`).

## Rule

Every Integration documents, in one place: allowed outbound hosts,
redirect/timeout/byte-bound policy, retry/concurrency caps, secret
posture, and what it explicitly does NOT support (non-HTTP, private
registries, IP allowlists). Working dependencies do not guarantee
connectivity — each Integration re-states its limits here.

## echo (fixture HTTP Integration)

| Bound | Value (source) |
| --- | --- |
| Allowed host | Exactly `http://127.0.0.1:8788/echo`; any other endpoint is `INVALID_CONNECTION` (`src/integrations/echo.ts`). Fixture-only, not arbitrary user URLs. |
| Method/shape | `POST` JSON `{ message }`; response must echo the message byte-for-byte, else `ECHO_INTEGRATION_FAILED`. |
| Redirects | `manual`; any 3xx fails the call (workerd has no `redirect:error`). |
| Timeout | `VENDOR_TIMEOUT_MS` (1000ms) via `AbortSignal.timeout`, plus a late-resolve elapsed check — both surface `ECHO_VENDOR_TIMEOUT` (`src/domain.ts`). |
| Byte caps | Input message ≤1024 UTF-8 bytes (`parseInput`); response parsed under the shared 4096-byte `boundedJson`; persisted result under the D1 result CHECK. |
| Retries | 0 — `stepRetryLimit("echo-http-v1")`; redelivery reuses the stable `${executionId}-echo-http-v1` outbound `Idempotency-Key`. |
| Concurrency | Serial steps; MVP fanout cap 8 per ADR 001 (this Saga uses none). |
| Secrets | None. |
| Not supported | Non-HTTP transports, private registries, IP-allowlist validation. |

## ninjaone (NinjaOne client-credentials Integration)

| Bound | Value (source) |
| --- | --- |
| Allowed hosts | Derived from the Connection endpoint origin: token at `/oauth/token`, API at `/v2/organizations` on the same origin (`src/integrations/ninjaone.ts`). Region-portable, no per-region code. Verified live on `us2.ninjarmm.com`; central `app.ninjarmm.com` does not know regional clients (see `docs/upstream-spec.md` finding 13). |
| Auth | OAuth2 client-credentials, scope pinned to `monitoring` (least privilege; `management` is rejected for the read-only app). |
| Redirects | `manual` on both calls; 3xx surfaces `NINJA_AUTH_FAILED` / `NINJA_VENDOR_FAILED`. |
| Timeout | `NINJA_TIMEOUT_MS` (5000ms) on both calls, abort plus late-resolve — both surface `NINJA_VENDOR_TIMEOUT` (`src/domain.ts`). |
| Byte caps | Token response under shared 4096-byte `boundedJson`; orgs transport cap 262144 bytes; persisted shape is count plus max 25 orgs (`NINJA_ORGS_MAX`) under the D1 result CHECK. |
| Error codes | 401 `NINJA_UNAUTHORIZED`, 429 `NINJA_RATE_LIMITED` (both calls), 5xx `NINJA_VENDOR_FAILED`, non-array `NINJA_BAD_RESPONSE`. No automatic retry on any of them. |
| Retries | 0 — `stepRetryLimit("ninja-list-orgs-v1")`. |
| Concurrency | Serial steps; fanout cap 8 per ADR 001 (unused here). |
| Secrets | Client ID/secret from Worker env only, transient inside the Action; presence enforced behind the Action boundary (`NINJA_NOT_CONFIGURED`); tokens fetched per execution, never cached, never persisted (audited in `test/ninjaone.test.ts` and `test/ninja-echo-digest.test.ts`). |
| Not supported | Non-HTTP transports, private registries, IP-allowlist validation; OAuth authorization-code flow and refresh lifecycle (deferred to Phase 3 per ADR 005). |

## system.smoke (platform smoke Saga)

No egress: D1-only Operations plus a pure transform. Any outbound `fetch`
during smoke is a test failure (guarded in `test/smoke.test.ts`). Bounds
are D1 rows/reads/writes plus the persisted usage block (ADR 004).

## AI providers (AI-01 verify/discovery, issue #164)

Verify-with-key (`POST /api/ai/profiles/:id/verify`) and model discovery
(`GET /api/ai/discover/:integrationId`) share one bounded read-only vendor
list (`fetchVendorModelIds` in `src/ai-profiles.ts`). The keyless
`testConnection` reachability probe is unchanged (no key on the wire);
verify/discovery authenticate with the deployment-global key server-side.

| Bound | Value (source) |
| --- | --- |
| Allowed hosts | Exact canonical HTTPS origins for OpenAI, Anthropic, Google, and OpenRouter. OpenAI-compatible requires an exact origin in the deployment-owned comma-separated `OPENAI_COMPATIBLE_ALLOWED_ORIGINS` binding. Endpoints re-parse through `assertSafeEndpoint` and the credential-origin guard before every probe; rows rewritten outside validation fail closed as `INVALID_CONNECTION` before `fetch`. |
| Method/shape | `GET` model list; OpenAI-shaped `{data:[{id}]}` for openai/openai-compatible/openrouter/anthropic, Google-shaped `{models:[{name}]}` for google. Unknown shapes fail closed (`AI_VERIFY_FAILED` / `AI_DISCOVERY_FAILED`); vendor text never flows outward. |
| Redirects | `manual`; any 3xx fails the probe (workerd has no `redirect:error`). |
| Timeout | `AI_VENDOR_TIMEOUT_MS` (5000ms) via `AbortSignal.timeout` (`src/ai-profiles.ts`). |
| Byte caps | Vendor list bodies under the shared `boundedJson` with `AI_VENDOR_BODY_MAX` (65536 bytes); model-id scan capped at `AI_DISCOVERY_MODELS_MAX` (1000). Nothing persists: outcomes carry counts plus per-profile availability booleans only. |
| Retries | 0 — one probe per request; the caller retries explicitly. |
| Concurrency | Serial per request; no fan-out. |
| Secrets | Deployment-global API key per provider (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_COMPATIBLE_API_KEY`), presence-checked before any fetch (`SECRET_NOT_CONFIGURED`), header-carried only (never URLs), transient inside the probe, scrubbed from every outward detail. Model inference is vendor-paid per Connection; Cloudflare Free never includes external model inference. |
| Not supported | Live inference, per-tenant AI keys (SEC-02 tripwire stays shut for AI), embeddings/Vectorize, non-HTTP transports, private registries, IP-allowlist validation. |

Per-provider list targets (`vendorTarget` in `src/ai-profiles.ts`):

| Provider | List path (joined to the Connection endpoint) | Auth |
| --- | --- | --- |
| openai | `/v1/models` | `Authorization: Bearer` |
| openai-compatible | `/v1/models` (an endpoint already carrying `/v1` is not doubled) | `Authorization: Bearer` |
| openrouter | `/api/v1/models` | `Authorization: Bearer` |
| anthropic | `/v1/models` | `x-api-key` plus `anthropic-version: 2023-06-01` |
| google | `/v1beta/models` | `x-goog-api-key` (header form, never query) |

## Per-Operation platform caps (all Sagas)

Resolved by the adapter through the `stepRetryLimit` table
(`src/domain.ts` via `bindSagaStep` in `src/saga.ts`), never by Saga
source: Workflow step timeout `10 seconds`; vendor/Integration steps
`retries: 0`; idempotent D1 checkpoint steps up to the operator ceiling 2
(`STEP_RETRY_CEILING`); unknown step names fail closed to 0. Business and
expected failures throw `NonRetryableError` so the engine never retries a
non-idempotent mutation.

## Adding the next Integration

Copy this shape: allowed-host rule, redirect/timeout/byte policy with
code references, retry/concurrency caps, secret posture, and an explicit
not-supported list. If a requirement breaks a cap (or needs a primitive
beyond Worker plus Workflows plus D1), the lane records why per AGENTS.md
constraint 7 before adopting it — Free-tier viability is measured per the
upstream-spec rule, not assumed.
