# Repository guidance

Wrangnarök is an experimental Cloudflare-native reimagining of Bifrost, licensed AGPL-3.0. Universal constraints and ownership rules are below; load only the task routes that apply. Detailed original rules remain in `AGENT-GUIDE.md`.

## Core constraints

Preserve useful Bifrost product semantics while keeping the first useful MVP viable on Cloudflare Free. TypeScript owns production and Saga logic; local Node `.mjs` helpers are the narrow exception. Sagas are code-first, with stable identity across ordinary edits. Do not invent a YAML/JSON workflow DSL without a demonstrated requirement. Do not hide Cloudflare behind a portability abstraction: Cloudflare-native is the experiment. Start with Worker + Workflows + D1 and prefer boring, typed APIs.

Use native Cloudflare vocabulary and primitives; `docs/lexicon.md` has precedence. Keep Integration definitions separate from Organization-specific Connections, credentials out of portable source, and tenancy/authorization explicit. Add primitives only for demonstrated requirements. Preserve AGPL notices and upstream attribution.

## Local verification

Use Node >=22.16.0, the lockfile, and real local Cloudflare runtime/bindings; mock external vendor HTTP only at Integration boundaries. Local development must not require production deployment. Root scripts include:

```sh
npm run format:check
npm run lint
npm run typecheck
npm run test:coverage
npm run build
```

`npm run build` uses Wrangler dry-run for `dev`; it does not deploy production. Follow the full `Validate` CI job and scoped checks when preparing a PR.

## Lane and merge ownership

One writer and lane per assigned worktree; never edit the shared main checkout. Follow the prescribed scratch-root/worktree naming and Windows dotfile-reading rules in the full guide. Own the issue through MERGED: fix red checks and conflicts, address every review thread, then use the native GitHub merge queue. Never merge red or force-push shared branches; retain merge commits. Report a first visible move within minutes and status at least every 30 minutes while the PR is open; identify blockers immediately. Review threads require a code fix or written rebuttal before resolution. Update for actual conflicts rather than merely being behind main; retain standing authorization to queue an owned green, thread-free PR.

For ADR-level, primitive, security, persistence, or major parity changes (and every tenth merge), check whether authentication, execution, persistence, secrets, deployment, and recovery still each have one authoritative path. Pause new parity lanes if a second path appears, coverage stays red beyond one queue cycle, a lane twice exceeds its file scope, or LIMITS-01 reports an unapproved Free-tier violation.

## Read by task

- Architecture, domain vocabulary, or parity changes: read `docs/lexicon.md` (authoritative), `docs/upstream-spec.md`, relevant roadmap/ADR material, and [architecture and upstream archaeology](AGENT-GUIDE.md#architecture-changes). Record divergences with Cloudflare rationale and update an ADR/spec for public, tenancy/security, primitive, or Saga/Execution/Operation contract changes.
- Local lane setup: read [collaboration](AGENT-GUIDE.md#collaboration) for the prescribed scratch root, branch-based naming, and Windows dotfile-reading rules before creating or editing a worktree.
- Steward checkpoints: read [simplicity checkpoint](AGENT-GUIDE.md#simplicity-checkpoint) and `docs/architecture/000-steward-checklist.md`.
- Review/merge: read [lane ownership](AGENT-GUIDE.md#lane-ownership) and [merging](AGENT-GUIDE.md#merging) before queueing; native GitHub merge queue and merge-group CI remain authoritative.
