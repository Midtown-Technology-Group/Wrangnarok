# AGENTS.md

Wrangnarök is an experimental Cloudflare-native reimagining of `gobifrost/bifrost`, licensed AGPL-3.0.

Before changing architecture or domain contracts, read:

- `README.md`
- `docs/lexicon.md`
- `docs/upstream-spec.md`
- `docs/roadmap.md`
- relevant files under `docs/architecture/`

## Non-negotiable project constraints

1. Preserve useful Bifrost product semantics, not its infrastructure by default.
2. The first useful MVP must remain viable on Cloudflare Free.
3. TypeScript is the implementation and Saga-authoring language. Node `scripts/*.mjs` local helpers (setup, seed, fixtures, CLIs) are the narrow exception: no prod runtime, no Saga logic.
4. Sagas are code-first. Do not invent a YAML/JSON workflow DSL without a demonstrated requirement.
5. Cloudflare primitives retain their native names: Worker, Workflow, step, Queue, Durable Object, D1, R2, KV, binding, etc.
6. The canonical domain vocabulary is `docs/lexicon.md`; do not casually add mythological aliases. In case of conflict, `docs/lexicon.md` prevails over README, roadmap, or ADR summaries.
7. Start with Worker + Workflows + D1. Add another Cloudflare primitive only when a concrete requirement needs it and document why.
8. Prefer boring, typed TypeScript APIs over clever wrappers.
9. Integration definitions and Organization-specific Connections are separate concepts. Never embed environment credentials in portable Saga/Integration source.
10. Organization context and authorization boundaries must remain explicit.
11. Saga identity must survive ordinary source edits.
12. Local development and tests must not require a Cloudflare production deployment.
13. Do not hide Cloudflare behind a portability abstraction. Cloudflare-native is the experiment.
14. Wrangnarök is AGPL-3.0. Preserve attribution/notices when adapting upstream implementation material.

## Development/testing direction

Use Cloudflare's current local tooling rather than hand-written mocks where practical:

- `wrangler dev` / Miniflare / workerd for local Worker execution and bindings;
- local D1 bindings and migrations;
- local Workflows emulation;
- `@cloudflare/vitest-plugin` + Vitest for Worker-runtime tests;
- mock only external vendor HTTP APIs at the Integration boundary.

Keep domain logic independently testable where possible, but include integration tests that exercise the real local Cloudflare runtime/bindings.

## Architecture changes

If a change introduces a new platform primitive, changes Saga/Execution/Operation semantics, changes tenancy/security boundaries, or creates a public compatibility contract, write/update an ADR or architecture spec and link the relevant issue.

## Simplicity checkpoint (recurring steward review)

Every ADR-level change, new Cloudflare primitive, auth/security boundary change, persistence-model change, or completion of a major parity slice — with a periodic fallback every 10th merge to `main` — the steward must answer: can we still explain the platform in one diagram with one authoritative path each for authentication/authorization, execution, persistence, secrets, deployment, and recovery? If the answer becomes "multiple paths depending on which feature landed when," pause new parity lanes and consolidate first. Stop conditions for opening Phase 4-6 lanes: a second authoritative path appears; the coverage gate stays red for more than one queue cycle; a lane touches files outside its scope twice; LIMITS-01 flags a Free violation without an approved exception. Checklist lives at `docs/architecture/000-steward-checklist.md`.

## Upstream archaeology

When studying Bifrost, record observable behavior and invariants in `docs/upstream-spec.md`. Do not assume a PostgreSQL/Redis/RabbitMQ/process architecture is itself a requirement. Prefer current upstream docs/tests/source over old plans when they disagree. Hew to upstream product philosophy by default; every divergence must be explicit with Cloudflare-driven rationale recorded in the ADR.

## Collaboration

One lane per worktree. Parallel agents (human or AI) must work on separate branches checked out in separate `git worktree` directories — never two lanes in one checkout. One writer per checkout: the main checkout is shared ground, so never do lane file edits in it — work only in your assigned lane worktree. Two agents editing files in the same checkout is the same violation as two lanes in one checkout. Name worktrees after the branch. Remove the worktree (`git worktree remove`) when its PR merges. Git defines no default worktree location, so this project fixes one: create ephemeral lane worktrees under the harness's pre-approved scratch root (`$env:TEMP\opencode`, currently `C:\Users\ThomasBray\AppData\Local\Temp\opencode`), one subdirectory per branch named after the branch (slashes sanitized) — never inside the main checkout. Windows lane note: the MSYS spawn layer rewrites `git` `<rev>:.dotpath` arguments (e.g. `origin/main:.opencode/...` arrives as `origin\main;...`), while `cmd` passes them cleanly — read dotfiles from a checkout, or run such commands via `cmd /c`, never via Git Bash.

## Lane ownership

A lane owner is responsible for their issue end to end: from branch to MERGED. Opening a PR is not done — a finished local task list with an open PR means the job is still open. Do not go idle on a PR you own.

- Red CI: fix forward on your branch (never force-push a shared lane branch), re-run the gate locally, push.
- Conflicts: merge `origin/main`, resolve keeping your slice's code, re-run the gate, push.
- Open review threads block merging. Address every thread: fix the code where the reviewer is right (bot reviewers included), reply where they are wrong, then resolve. Never resolve a thread without a code fix or a written rebuttal.
- Once checks are green and threads are resolved, queue the PR via **Merge when ready** / merge-queue control and watch it until it shows MERGED. Enabling Merge-when-ready on your own green, thread-free PR is standing authorization for the lane owner — it needs no separate explicit ask.
- Heartbeat: make a first visible move (commit, PR comment, or status report) within minutes of starting, and report status at least every 30 minutes while the PR is open — checks state, open thread count, next action. If blocked on another lane, say so immediately; do not wait silently.

## Merging

Native GitHub merge queue owns merging into `main` for `Midtown-Technology-Group/Wrangnarok`. When a PR is intended to land, ensure its required `Validate` check is green, all review threads are resolved, then use GitHub's **Merge when ready** / merge-queue control. Do not use Mergify comments or labels. The queue validates the PR against predicted `main` using the `merge_group` CI event, so lanes should rebase/update only on an actual reported conflict, not merely because the branch is behind. Never merge a red PR, never force-push a shared lane branch, and keep the merge method as merge commits unless an ADR says otherwise.
