# Demo path: fresh checkout to running Saga

Proves the Phase 0 slice on the local runtime only. No Cloudflare account,
no production deploy, no vendor credentials.

## Prerequisites

- Node >= 22.16.0
- A fresh clone of this repo

## Steps

```bash
# 0. Install and verify the static gates.
npm ci
npm run typecheck
npm test

# 1. Create the local-only fixture identity (idempotent; never overwrites).
npm run setup:local

# 2. Apply migrations and seed the local D1 (demo org + loopback echo only).
npm run db:migrate:local
npm run db:seed:local

# 3. Build the browser UI once (wrangler serves it as Static Assets).
npm run build:ui

# 4. Start the local Worker (leave running).
npx wrangler dev --local --port 8903
```

The token in `.dev.vars` is local-only and gitignored. Never commit it.

## Run a Saga and show history

`system.smoke` is loopback-free (no vendor fixture needed). The echo Saga
needs the fixture in a second terminal: `npm run fixture`
(`http://127.0.0.1:8788/echo`).

```powershell
$tok = (Get-Content .dev.vars | Select-String "^LAB_TOKEN=(.*)$").Matches.Groups[1].Value
$H = @{ Authorization = "Bearer $tok" }

# Catalog.
Invoke-RestMethod http://127.0.0.1:8903/api/sagas -Headers $H

# Submit (Idempotency-Key: REQUIRED, 16-128 chars [a-zA-Z0-9._:-]).
$H2 = @{ Authorization = "Bearer $tok"; "Content-Type" = "application/json"
         "Idempotency-Key" = "laneC-demo-probe-01" }
$body = @{ sagaId = "7a1f3c5e-9b2d-4f6a-8c1e-5d3b7a9f1c2e"; input = @{} } | ConvertTo-Json
$r = Invoke-WebRequest http://127.0.0.1:8903/api/executions -Method POST -Headers $H2 -Body $body
# First submit: 202, replayed false. Same key + same input: 200, replayed true.

# Detail (poll until Succeeded) and history.
$id = ($r.Content | ConvertFrom-Json).executionId
Invoke-RestMethod http://127.0.0.1:8903/api/executions/$id -Headers $H
Invoke-RestMethod http://127.0.0.1:8903/api/executions -Headers $H
```

## Project CLI (`scripts/wrangnarok.mjs`)

Thin wrapper over the same HTTP API — no Saga logic. Auth defaults to
`.dev.vars` `LAB_TOKEN`; `--json` switches every command to raw JSON.
The demo Worker above listens on port 8903, so every CLI invocation pins
`--base http://127.0.0.1:8903` (issue #357): without it the CLI default
port 8787 would receive the LAB token, and any local listener there could
collect it.

```bash
node scripts/wrangnarok.mjs sagas --base http://127.0.0.1:8903
node scripts/wrangnarok.mjs submit --saga system.smoke --key my-run-0001 --base http://127.0.0.1:8903
node scripts/wrangnarok.mjs history --status Succeeded --limit 5 --base http://127.0.0.1:8903
node scripts/wrangnarok.mjs cancel --id <64-hex-execution-id> --base http://127.0.0.1:8903
node scripts/wrangnarok.mjs selftest
```

`--org` is reserved and fails loudly (organization comes from auth
context); cancel takes the exact Execution ID only. Behind Access, pass
`--access-client-id` / `--access-client-secret`.

## Remote dev smoke: human runbook (deferred for machine callers)

The deployed dev smoke (`wrangler deploy --env dev` + `system.smoke` per
ADR 004) stays a human-with-account runbook: machine callers are blocked at
the Access edge (everything challenges without an SSO session; service-token
flow unresolved as of 2026-09-10). Lane verification uses the local loopback
path above; `.dev.vars` is never rotated by automation.

## Last verified (2026-09-10, lane-C, local workerd, origin/main `abffdac`)

- `GET /api/sagas` listed `echo, ninjaone-orgs, ninjaone-echo-digest, system.smoke, hello`.
- `POST /api/executions` (system.smoke): `202`, `replayed: false`.
- Detail: `Succeeded`; operations `prepare-input-v1` / `smoke-write-v1` /
  `smoke-verify-v1` all `Succeeded`; result `d1WriteOk: true, d1ReadOk: true`;
  advisory `runtimeStatus: complete`.
- History: local D1 persists across runs; `?status=Succeeded` server filter
  verified live, `nextCursor` present.
- Usage actuals per run: D1 4 reads / 8 writes / 3 operation rows; Workflow
  1 instance / 4 steps / 35 ms; Worker requests/CPU `null` (not exposed by
  workerd — see the Free-tier table in `docs/upstream-spec.md`).
- Replay with same key + input: `200`, `replayed: true`.
- Short keys (14-15 chars) are rejected with `400 INVALID_IDEMPOTENCY_KEY`.
