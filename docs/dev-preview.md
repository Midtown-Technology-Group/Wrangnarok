# Local preview, sync, and deploy validation (DEV-02, issue #141)

Author source stays Git-owned TypeScript (ADR 002). This slice adds the
fast local loop: no-registration preview, explicit sync/conflict handling,
Git target validation, dependency lock/build validation, and deploy checks.
Design: ADR 035 (renumbered from 016 by issue #225). Compatibility inventory: `docs/dev-compatibility.md`.

## No-registration local preview

`POST /api/dev/preview` (authenticated like every other `/api/*` route).
Read-only by construction: no D1 writes, no Workflow dispatch, no vendor
calls. Production resources are never touched and caller/install scope is
never bypassed, because the route has no write or dispatch path.

```json
{ "sagaId": "<stable-uuid>", "input": { "name": "Ada" }, "checkEnvironment": true }
```

`checkEnvironment` is opt-in (omit or `false` for pure local preview).
When `true`, the Worker only `SELECT`s Connection presence for the
caller's own Organization — never foreign rows, never secret values:

```json
{
  "preview": {
    "saga": { "id": "...", "name": "hello", "revision": "hello-v1" },
    "input": { "name": "Ada" },
    "environmentChecked": true,
    "environment": [{ "integrationId": "...", "configured": true, "detail": "..." }],
    "persisted": false,
    "dispatched": false
  }
}
```

The server parse stays authoritative: invalid input fails `INVALID_INPUT`
exactly as submit would. CLI: `preview --saga hello --input '{"name":"Ada"}'
[--check-env]`. SDK: `client.previewSaga({ saga: "hello", input })`.

## Source pull/push/watch conflicts

`planSync(local, remote, base)` in `src/dev.ts` is a three-way plan over
content snapshots (`sagaId`, `revision`, `contentHash` via `contentHash`):

- Remote missing: push the local source.
- Both sides agree: up-to-date.
- Only one side moved since the last sync: push or pull that side.
- Both sides moved, or no common base: **conflict**. Nothing is pushed or
  pulled. Resolve explicitly (keep one side), then sync again.

Identity is compared first: different Saga ids are different Sagas
(`SYNC_CONFLICT`), never an auto-merge. `watch` polls `planSync`; any
non-clean plan halts the loop for an operator (`nextWatchAction` maps
conflict to `halt`). There is no silent merge and no push-over-remote.

## Git authentication and branch selection

`parseGitTarget({ remoteUrl, branch, authEnvVar })`:

- `remoteUrl`: `https://` or `git@` remote (max 512 chars).
- `branch`: explicit valid ref. No default-branch guessing: the caller
  names the branch every time.
- `authEnvVar`: names the environment variable holding the token. The
  token value never appears in source, errors, or logs. Any inline
  credential key (`token`, `password`, `secret`, `auth`, `key`) is
  rejected with `INVALID_GIT_TARGET` without echoing its value.

Git stays the transport. There is no hosted Git service in the Worker.

## Dependency lock and build validation

`validateLockfile({ packageJson, lockPresent, registryUrl })` requires
exact pinned versions (no ranges, `*`, `latest`, or non-registry specs),
a lockfile present, and the default registry. Failures list every problem
so the author can fix them in one pass.

`validateDeploy({ environment, buildVenue, lock, sagaIds })`:

- Environment is `local`, `dev`, or `preview`. `production` fails closed
  (`DEPLOY_BLOCKED`): production is intentionally unconfigured (ADR 004).
- Build venue is `github-actions` (CI `npm ci`) or `local-npm`. A
  Worker-runtime venue is rejected: package installation and builds never
  run as arbitrary shell execution inside a Worker.
- The lock must be reproducible and at least one stable Saga UUID named.

## Stable IDs across edits

Ordinary edits keep the stable UUID (`checkStableIdentity`). Changing the
id mints a different Saga; moving/renaming records an explicit
`remapIdentity(fromId, toId, reason)` with 1-280 chars of operator
justification, or the `STABLE_IDENTITY_REMAP_REQUIRED` Fault fails the
operation loudly.

## Fresh-checkout loop

1. `npm run setup:local` then `npm run dev` (local Worker + D1).
2. `node scripts/wrangnarok.mjs preview --saga hello --input '{"name":"Ada"}'`
   for pure local validation.
3. Add `--check-env` to confirm this Organization's Connections without
   dispatching anything.
4. `submit` only when the preview is clean; `planSync` before pushing
   shared source; `validateDeploy` before any deploy.

No production deployment is involved at any step.
