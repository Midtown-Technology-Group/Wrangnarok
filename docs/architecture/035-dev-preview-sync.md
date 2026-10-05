# ADR 035: Local-first preview, sync, and deploy validation (DEV-02)

- **Status:** Accepted
- **Date:** 2026-09-11
- **Renumber note (2026-09-18, issue #225):** formerly ADR 016. The number
  collided with ADR 016 (Solution source capture, export, and import, SOL-03);
  per the steward-delegated later-landed-moves rule the later-landed file
  moves, and 035 is the next free number above the highest assigned (033).
- **Issue:** #141 (DEV-02)

## Context

Upstream Bifrost supports executing local workflow source without
registration and separately previewing Solution source against real
environment resources with authorization, plus CLI `sync`/`push`/`pull`/`watch`
flows, Git-backed source management, and package/dependency handling
(`api/bifrost/solution_dev/function_host.py`, `proxy.py`,
`git_commands.py`, routers `github.py`, `packages.py`, `sdk_modules.py`,
`dependencies.py`; e2e `test_github.py`, `test_cli.py`). Wrangnarok has
Git-owned TypeScript plus `wrangler dev`, which is not the same product
capability: no authenticated environment preview, no defined sync/conflict
behavior, no Git target validation, no lock/build gate, and no explicit
compatibility statement for upstream Python dependencies.

Constraints: Cloudflare-native (AGENTS.md 13), Free-tier MVP (constraint 2),
boring typed APIs (constraint 8), source/credential separation
(constraint 9), stable Saga identity (ADR 002, constraints 11), no
portability abstraction (constraint 13). Builds evaluation (ADR 009) keeps
CI on GitHub Actions; deploy automation stays manual until earned
(ADR 004).

## Decision

1. **No-registration local preview is read-only by construction.**
   `POST /api/dev/preview` runs the authoritative server parse against the
   static Git-owned Catalog. No D1 writes, no Workflow dispatch, no vendor
   calls. The environment section is off by default; opting in (`checkEnvironment:
   true`) performs only `SELECT` Connection-presence checks for the caller's
   own Organization — never foreign rows, never secret values. Preview never
   mutates production resources and never bypasses caller/install scope,
   because it has no write or dispatch path at all.
2. **Sync is an explicit three-way plan, never an auto-merge.**
   `planSync(local, remote, base)` returns up-to-date, push, pull, or
   conflict. Diverged edits (or no common base) are a conflict that halts
   the `watch` loop for an operator decision. Identity is compared first:
   different Saga ids are different Sagas, never a merge.
3. **Stable identity survives ordinary edits.** Changing the UUID mints a
   different Saga (ADR 002); the move path is an explicit `remapIdentity`
   record with operator justification, enforced by the
   `STABLE_IDENTITY_REMAP_REQUIRED` Fault.
4. **Git targets are validated, never executed by the Worker.** `parseGitTarget`
   requires an explicit branch (no default guessing), an https/git remote,
   and an env-var token reference. Inline credential material is rejected
   without echoing values. Git stays the transport; there is no hosted Git
   service in the Worker.
5. **Dependency lock/build validation gates deployment, and the build venue
   is CI or local npm — never a Worker runtime.** `validateLockfile`
   requires exact pinned versions, a lockfile, and the default registry;
   `validateDeploy` rejects `production` (ADR 004: intentionally
   unconfigured), rejects Worker-runtime venues, and rejects unresolved
   locks. Package installation is `npm ci` in CI or local npm, justified
   here as the build venue — not arbitrary runtime shell execution.
6. **The Python-dependency compatibility inventory is explicit.**
   `DEV_COMPATIBILITY` classifies python-only, native-extension, process,
   filesystem, private-registry, and bounded-HTTP rows as supported TS
   replacement, bounded HTTP alternative, or explicit blocker. Arbitrary
   upstream Python execution is a blocker, not a TODO: it is outside the
   accepted architecture (documented in `docs/dev-compatibility.md`).

## Consequences

- Authors get a fast read-only preview loop from a fresh checkout with no
  registration round trip and no production risk.
- Sync conflicts, Git targets, locks, and deploys fail loud with stable
  codes (`SYNC_CONFLICT`, `INVALID_GIT_TARGET`, `DEPLOY_BLOCKED`,
  `STABLE_IDENTITY_REMAP_REQUIRED`) instead of silent merges or deploys.
- No new Cloudflare primitive is introduced: Worker + D1 reads + static
  Catalog only. Hosted Git/package management stays out of scope.
- Upstream `packages.py`/`dependencies.py` install-at-runtime behavior is
  an explicit non-goal: installs happen in CI/local npm before deploy.

## Revisit when

- A concrete requirement needs hosted Git/package management inside the
  product (new ADR, cost/security gate).
- FILE-01 (R2) lands and the filesystem row can graduate from bounded
  inline payloads to managed file locations.
- Deploy automation is earned under ADR 004 (this validation becomes the
  pre-deploy gate).
