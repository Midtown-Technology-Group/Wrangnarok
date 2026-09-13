# Swarm lane rules for Wrangnarok

Lane workers: you inherit the project prompt overlay. These rules are lane specific and ride along on every spawn.

## Lane discipline (one lane per worktree)

- Work only in your assigned worktree under the scratch root (`$env:TEMP\opencode`, one subdirectory per branch, slashes sanitized). Never work two lanes in one checkout. Never create worktrees inside the main checkout.
- Branch from `origin/main`. Small PRs. Native GitHub merge queue owns merging into `main`: required check is `Validate`, use Merge-when-ready / merge-queue control, no Mergify. Remove the worktree (`git worktree remove`) when its PR merges.
- Never merge a red PR. Never force-push a shared lane branch. Merge method is merge commits unless an ADR says otherwise.
- The native queue tests each PR against predicted main, so rebase ONLY on reported conflict, never for currency.

## Own your issue and shepherd your PR to green

You are responsible for your assigned parity issue AND for shepherding its PR from open to merged. Opening the PR is not done. A finished local todos list with an open PR means the job is still open. Do NOT go idle.

- Red CI: fix forward on your branch (never force-push), re-run the FULL gate locally, push.
- CONFLICTING: merge origin/main, resolve keeping your slice's code, re-run the FULL gate, push.
- Open review threads BLOCK merging (conversation resolution is required on `main`). Address every thread on your PR: fix the code where the reviewer is right (bot reviewers included — coderabbitai and the codex connector have found genuine P1s), reply where they are wrong, then resolve the thread. Never resolve a thread without either a code fix or a written rebuttal.
- Merge queue: once checks are green and threads are resolved, check dependency readiness BEFORE queueing: read your owned parity issue's declared `Depends:` line (docs/upstream-parity.md plus the issue body). If any dependency is still open, report BLOCKED and do not queue or merge unless the steward records an explicit waiver. The merge queue has no dependency awareness, so this check is yours. Then queue the PR (`gh pr merge <number>` with no strategy flag — the queue owns the strategy). Watch it until it shows MERGED. Never enable auto-merge on a PR whose dependencies are unmet.
- Issue currency: before queueing, re-read your assigned issue for new external updates (strategy-watch, steward, or reviewer comments posted after your last read). If the issue gained new requirements or a coordination brake, address them first. Issues evolve while lanes run; a green PR against a stale reading of its issue is still blocked.

## Heartbeat

- Within 10 minutes of spawn, make your first visible move: a commit, a PR comment, a status report to the coordinator, or a BLOCKED report with the exact blocker. Spawns that show no activity after 15 minutes are assumed dead and will be replaced.
- Report status to the coordinator at least every 30 minutes while your PR is open: checks state, open thread count, next action. Two lines max.
- If you are blocked on another lane or on the coordinator, say so immediately — do not wait silently.

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
