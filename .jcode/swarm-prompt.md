# Swarm lane rules for Wrangnarok

Lane workers: you inherit the project prompt overlay. These rules are lane specific and ride along on every spawn.

## Lane discipline (one lane per worktree)

- Work only in your assigned worktree under the scratch root (`$env:TEMP\opencode`, one subdirectory per branch, slashes sanitized). Never work two lanes in one checkout. Never create worktrees inside the main checkout.
- Branch from `origin/main`. Small PRs. `automerge` label AND `@mergifyio queue` comment together at PR creation. Remove the worktree (`git worktree remove`) when its PR merges.
- Never merge a red PR. Never force-push a shared lane branch. Merge method is merge commits unless an ADR says otherwise.
- Mergify queue runs speculative checks (up to 3 parallel, batch 3). Branch protection requires Validate but NOT up-to-date: rebase ONLY on reported conflict, never for currency.

## Own your PR to green

Opening the PR is not done. Keep watching your PR's checks until merged:

- Red CI: fix forward on your branch (never force-push), re-run the FULL gate locally, push.
- CONFLICTING: merge origin/main, resolve keeping your slice's code, re-run the FULL gate, push.
- A finished local todos list with a red or conflicting PR means the job is still open. Do NOT go idle.

## Scope and migrations

- Stay in scope: touch ONLY files in your lane's `scopes/<lane>.scope`. Run `node scripts/lane-scope.mjs scopes/<lane>.scope` before every commit and PR; it must print clean.
- Migrations: never invent a number. Take your reserved number from `docs/migration-ledger.md`, name the file exactly, update test imports in the same commit.

## Messaging

- `label` every spawn (e.g. `label: "phase2 triggers"`).
- Complete assigned tasks directly and report back. Do not spawn sub-generations.
- DM the coordinator for 1:1 questions. Broadcast sparingly.
- File-conflict notices are automatic. Check the diff before ignoring.
- Keep drive messages short plain paragraphs. Long dense prose over HTTP intermittently 500s. Retry or chunk on failure.

## Verification before reporting ready (FULL gate, every step)

1. `npm ci`
2. `npm run test:coverage` (ALL FOUR metrics >= 95: lines, functions, branches, statements; plain `npm test` is NOT enough)
3. `npm run typecheck`
4. `npm run lint`
5. `npm run format:check`
6. `npm run build:ui` then `npm run check:bundle`
7. `node scripts/lane-scope.mjs scopes/<lane>.scope` clean

## On completion (structured: signal vs payload)

- DONE or BLOCKED plus: branch, PR URL, gate status per step (coverage four metrics, typecheck, lint, format, ui, bundle, scope), exact blocker if any. No bare "done" without the payload.
- Rate confidence at completion. Spikes mean go back and verify.
- Terminal states only (DONE with evidence, BLOCKED with exact blocker). Progress chatter stays in the worktree.

## Model routing

- Implementation tasks: `effort: "low"`.
- Design, investigation, debugging, review, verification: default effort.
- Context fetching and bulk reading: `effort: "none"`.
