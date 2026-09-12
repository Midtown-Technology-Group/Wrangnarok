# Shared rules for all parity lanes.

Lane briefs must include these verbatim:

1. Stay in scope: touch ONLY files listed in your lane's scope file (scopes/<lane>.scope). Run `node scripts/lane-scope.mjs scopes/<lane>.scope` before every commit and before opening a PR; it must print clean.
2. Never stage .jcode/skills/, .opencode/skills/, node_modules/, .wrangler/, vendor/ — lane-scope.mjs enforces this even if a scope file is wrong.
3. Never force-push a shared lane branch.
4. PR standard: `automerge` label AND `@mergifyio queue` comment together at creation.
5. Local + CI only. No prod credentials, no prod deploys, no paid-tier moves.
6. Before opening a PR: merge origin/main, then run the FULL gate locally and confirm every step green — npm ci, npm run test:coverage (ALL FOUR metrics >= 95: lines, functions, branches, statements; plain `npm test` is NOT enough), npm run typecheck, npm run lint, npm run format:check, npm run build:ui, npm run check:bundle, plus lane-scope clean. A PR opened red wastes a full queue cycle.
7. Own your PR to green: opening the PR is not done. After opening, keep watching your PR's checks. On red CI: fix forward on your branch (never force-push), re-run the full gate locally, push. On CONFLICTING: merge origin/main, resolve keeping your slice's code, re-run the full gate, push. Do NOT go idle after opening — a finished local todos list with a red or conflicting PR means the job is still open.
8. Rebase ONLY on reported conflict, never for currency. Under strict=false protection plus Mergify speculative checks, an "out of date" PR still queues and merges — Mergify tests it against predicted main. Every currency update burns a full fresh CI cycle and resets queue position.
9. Migrations: never invent a number. Take your reserved number from docs/migration-ledger.md, name your file exactly, and update your test imports in the same commit.
10. Completion report (structured, SandCastle-style separation of signal vs payload): DONE or BLOCKED plus branch, PR URL, gate status per step (coverage four metrics, typecheck, lint, format, ui, bundle, scope), and the exact blocker if any. No bare "done" without the payload.
