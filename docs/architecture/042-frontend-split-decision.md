# ADR 042: Frontend/static-assets split — keep the single deployment

- **Status:** Accepted
- **Date:** 2026-09-18
- **Keeps:** ADR 008 (full-stack app on a single Worker)
- **Decides:** Issue #438 (frontend/static-assets split assessment)
- **Related:** Issue #177 (bundle-budget policy), `docs/architecture/worker-authority-boundaries.md` (authorized split axis, Proposed), ADR 014 (human authentication)

## Context

Issue #438 asked whether the browser frontend / static assets should be split
into a separate Cloudflare Worker/deployment from the execution/backend
Worker. The stated motivation was backend bundle growth plus differing usage
patterns. A read-only scout lane (`lane-438-frontend-split`, HEAD `a2ab3c1`,
2026-09-17) measured the current architecture fresh; this ADR records its
evidence and the resulting decision so no future lane re-litigates the split
on bundle-size grounds without new evidence.

Scout evidence (all measured, not estimated):

1. **Static Assets consume 0 Worker script bytes.** `npm run build:ui` +
   `npm run check:bundle` produced a Worker bundle of **896,928 bytes raw**
   (the authoritative `worker.js` from the `wrangler deploy --dry-run`
   outfile) against the 730 KiB advisory reference — an overrun of 149,408 B
   that is warn-only under the issue #177 budget policy. Client JS measured
   **408,115 bytes raw / 112.38 kB gzip** (`client/dist/assets/*.js`); those
   bytes are uploaded as Static Assets, never bundled into `worker.js`.
2. **Metafile attribution confirms no byte coupling.** The esbuild metafile
   for the same build lists **59 inputs, all under `src/*`; zero reference
   `client/` or `dist`, zero `.css`**. Top contributors are hand-written
   domain code: `src/index.ts` 169,774 B (19%), `src/forms.ts` 56,091 B,
   `src/sdk.ts` 45,097 B, `src/orgs.ts` 34,782 B, `src/ops.ts` 32,643 B.
   Growth since earlier quotes (735,730 B in `docs/feasibility-envelope.md`,
   737,605 B in the shrink audits) is backend feature breadth, not assets
   and not dependency bloat (`package.json` unchanged).
3. **The only frontend code inside the Worker script is a pass-through.**
   `src/index.ts:1048` (`if (env.ASSETS) return withAssetSecurity(await
   env.ASSETS.fetch(request));`) plus the `withAssetSecurity` CSP/header shim
   (`src/index.ts:458-471`) — tens of lines. The binding is
   `wrangler.jsonc:32-37`: `./client/dist/` served as `ASSETS` with
   `run_worker_first: ["/api/*"]`. A client-only marker (`wrangnarok.token`)
   occurs 0 times in `worker.js`. A frontend split would therefore save
   **~0 Worker script bytes**.
4. **The binding constraint is self-imposed.** 896,928 B is **~1.3% of the
   64 MiB uncompressed provider cap** (both plans, per Cloudflare Workers
   platform limits, 2026-09-04 revision; repo-pinned envelope,
   `docs/feasibility-envelope.md`).
   What binds first is our own 730 KiB soft reference, by design. A split
   does not address the actual pressure, which is API/domain surface growth.
5. **Split costs are real.** Today the app is same-origin: the Vite dev
   proxy forwards `/api` to the Worker, `src/auth.ts:22-27` routes a
   non-empty `Cf-Access-Jwt-Assertion` exclusively to Access verification,
   organization scope travels in `X-Organization-Id`, and CSRF is covered by
   the `requireJson` unencoded-JSON guard (`src/index.ts:496-502`). A split
   frontend would force a CORS allowlist plus credentialed cross-origin
   fetch plus a second Cloudflare Access hostname/policy surface as new
   security-critical code — while the frontend holds no bindings today, so
   the least-authority gain is ~zero. The scout's steward checkpoint: a
   bundle-motivated split **fails** the one-diagram test in
   `docs/architecture/000-steward-checklist.md`.

Today's coupling is therefore **deployment/release coupling only** (one
`wrangler deploy` ships UI+API together per ADR 008), not byte coupling.

## Decision

1. **Keep the ADR 008 single deployment. Do not split** the frontend/static
   assets into a separate Worker, Pages project, or any second deployment.
2. Bundle pressure is managed inside the single Worker: soft-budget
   discipline (issue #177 policy), shrink-before-raise, and per-module
   metafile attribution to target real growth — not topology changes.
3. The only pre-authorized split direction remains the authority-boundary
   axis in `docs/architecture/worker-authority-boundaries.md` (Edge/Control
   vs Execution via Service Binding, Proposed): one internet Worker, one
   identity path, UI staying with the API. An HTTPS/CORS frontend split is
   explicitly not that axis.

## Consequences

### Positive

- No second deployment, second Access policy surface, CORS trust boundary,
  preview-pipeline wiring, or UI-vs-API version skew to build or audit.
- The steward one-diagram explanation (single Worker deployment path) is
  preserved.
- Bundle work stays aimed at the real pressure (domain-code breadth) with
  measurement-only attribution, not architecture churn for ~zero bytes.

### Costs and risks

- UI and API still release together; a UI-only change redeploys the Worker
  (accepted: deploys are cheap, version skew is worse).
- If backend growth ever genuinely exhausts the single-Worker envelope, the
  relief must come from shrinking, scoping, or the authorized
  authority-boundary split — all of which need their own evidence and ADR.

### What would reopen this decision

Either of the following, with Cloudflare-driven rationale recorded in a new
or amended ADR per AGENTS.md (upstream-archaeology rule: every divergence
from the single-deployment default must be explicit with Cloudflare-driven
rationale):

1. **Approaching the 64 MiB uncompressed provider cap from domain growth** — i.e. the hard
   cap, not the soft reference, becomes the binding constraint after
   documented shrink-before-raise attempts, with metafile evidence that the
   remaining bytes are load-bearing execution code. (Raising the soft budget
   is an issue #177 policy decision, not a reopen of this ADR.)
2. **A concrete latency, isolation, or compliance requirement** that one
   deployment cannot satisfy — e.g. a demonstrated need to serve assets from
   a separate failure/identity domain — with the design reconciled against
   `worker-authority-boundaries.md` (Proposed), ADR 014, and ADR 004 before
   any design lane starts.

A bundle-motivated frontend split without (1) is pre-rejected: the scout
proved the byte gain is zero.

## References

- Issue #438 — assessment issue; scout verification comments (bundle
  numbers, metafile attribution, binding, topology) are the evidence base.
- Issue #177 — bundle-budget policy (730 KiB reference, warn-only overrun).
- ADR 008 — single-Worker full-stack deployment (kept, not amended).
- `docs/architecture/worker-authority-boundaries.md` — authorized split axis.
- `docs/feasibility-envelope.md` — 64 MiB uncompressed provider cap, budget history.
- `scripts/check-bundle-budget.mjs` — mechanical budget gate and metafile
  attribution method.
