# Self-hosting Wrangnarok on celld

Wrangnarok deploys to Cloudflare with Wrangler (see the ADR 004 runbook
in `docs/architecture/004-ci-cd.md`) and can also run self-hosted on
[celld](https://celld.dev), the Deno team's distributed Workers runtime.
Same Worker bundle, same bindings, no code fork (ADR 047). This page is
the celld operator runbook.

celld status at writing: **v0.6.2 beta**. Pin a release and re-run the
smoke below before upgrading a fleet.

## How the pieces map

| Wrangnarok / Cloudflare | celld |
| --- | --- |
| `wrangler.jsonc` (`--env dev`) | `wrangler.celld.jsonc` (generated, committed) |
| `wrangler deploy` | `celld deploy` via `npm run deploy:celld` |
| `wrangler secret put` | No equivalent: vars merged from `.celld.vars` at deploy time |
| `wrangler d1 migrations apply` | `celld d1 migrations apply wrangnarok-local` |
| D1 / R2 / Workflows / Durable Objects | Same bindings, run as cells over your bucket |
| Workers Logs / traces | celld telemetry (no `observability` block) |
| Cloudflare Access in front | Your ingress proxy; LAB Bearer auth works unchanged |

## Prerequisites

- A Linux or macOS host per fleet node (celld ships no Windows binary;
  use WSL2 or Docker on Windows). Nodes need a private, encrypted
  network between them: celld peer traffic is plaintext HTTP.
- `celld` and `esbuild` on `PATH`:

  ```sh
  CELLD_VERSION=v0.6.2 curl -fsSL https://celld.dev/install.sh | sh
  # Verify the download where possible:
  # gh attestation verify <downloaded-asset> --repo denoland/celld
  # or use the pinned image: docker pull ghcr.io/denoland/celld:v0.6.2
  ```

- An S3-compatible, GCS, or Azure Blob bucket the fleet owns. The
  bucket credentials control the fleet -- protect them like secrets.

  ```sh
  export CELLD_BUCKET=s3://YOUR-BUCKET
  # S3-compatible stores only (for Cloudflare R2 set AWS_REGION=auto and
  # S3_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com):
  export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_REGION=... S3_ENDPOINT=...
  ```

- An ingress proxy (nginx, Caddy, a load balancer, ...) terminating TLS
  in front of the nodes. celld serves plain HTTP.

## 1. Configure operator vars and secrets

Committed config carries non-secret vars only. Create the gitignored
`.celld.vars` beside `wrangler.celld.jsonc` with the values this
deployment needs (same `NAME=value` shape as `.dev.vars`):

```dotenv
ENVIRONMENT=selfhost
LAB_ENABLED=true
LAB_TOKEN=<64-hex-local-token>
LAB_ORG_ID=00000000-0000-4000-8000-000000000001
LAB_USER_ID=00000000-0000-4000-8000-000000000002
SECRETS_KEK=<per-deployment-kek>
```

Only set what the deployment uses (`NINJA_*`, `HALO_*`, provider
`*_API_KEY`, `CLOUDFLARE_API_TOKEN`, `ENDPOINT_WEBHOOK_SECRETS` as
needed). celld persists deployed vars in the fleet bucket, so bucket
read access is secret read access. `ENVIRONMENT` matters: unset means
the app treats the deployment as local/fixture in Connection
validation, so a real fleet should set it (for example `selfhost`).

Generate the local LAB token the same way as Cloudflare local dev:
`npm run setup:local` writes `.dev.vars`; copy the values you need into
`.celld.vars`.

## 2. Start a node

```sh
celld --bucket "$CELLD_BUCKET" --endpoint "$S3_ENDPOINT" --region "$AWS_REGION" \
  --listen 0.0.0.0:8080 --internal-listen 10.0.0.12:8081 --advertise node-a.internal:8081
```

Add nodes by starting the same command with each node's own
`--advertise` address against the same bucket. Put the ingress proxy in
front of the public listener (`--listen`); never expose
`--internal-listen`.

For a single-machine trial, `celld dev wrangler.celld.jsonc` runs one
local node with a local object store on http://127.0.0.1:9876 and reads
`.dev.vars` -- no cloud bucket needed. Two limits: `celld d1` cannot
reach the dev local store, so database-backed routes need the fleet
flow below (or a throwaway fleet bucket) before they work; and on
Windows use the Docker image under WSL2 rather than a native binary.
Verified 2026-10-16 on celld v0.6.2: single-node Docker fleet over an
S3-compatible bucket, all 42 migrations applied, `system.smoke` green
with same-key replay (see ADR 047).

## 3. Deploy

First install on a fresh fleet is two steps, because a fleet has no D1
cell until the first deployment exists:

```sh
npm run deploy:celld                      # build UI, deploy (creates the cells)
# wait until a node logs that it adopted the deployment, then:
npm run deploy:celld -- --migrate-only    # apply migrations/ to the new D1 cell
```

Every later release uses the ADR 004 order, migrations before deploy:

```sh
npm run deploy:celld -- --migrate
```

`deploy:celld` builds the UI, merges `.celld.vars` into the gitignored
`wrangler.celld.deploy.jsonc`, optionally applies the D1 migrations in
`migrations/` through `celld d1 migrations apply`, then runs
`celld deploy`. Running nodes adopt the deployment in place (within
`CELLD_DEPLOY_POLL_S`, default 30s). Preview the whole plan first with
`node scripts/deploy-celld.mjs --dry-run`. Between the first deploy and
the migration step, database-backed routes answer 500 -- smoke only
after migrating. If migrations succeed but the deploy step fails, the
schema is ahead of the serving code: ADR 004 forward-compatible
migrations make that safe, and a plain `npm run deploy:celld` (no
`--migrate`) retries only the deploy. The merged secret-bearing deploy
config is deleted after a successful run and kept (with a printed
warning) after a failed one for diagnosis.

Keep the config honest after any `wrangler.jsonc` edit:

```sh
npm run config:celld   # regenerate wrangler.celld.jsonc
npm run check:celld    # the same check CI enforces
```

## 4. Smoke

Reuse the hosted smoke probe against your ingress URL:

```sh
node scripts/smoke-preview.mjs --base-url https://wrangnarok.example.com --token "$LAB_TOKEN"
```

Expect the `system.smoke` lifecycle from ADR 004: submit returns 202,
the Execution reaches `Succeeded` with `prepare-input-v1`,
`smoke-write-v1`, and `smoke-verify-v1` all `Succeeded`, and a same-key
resubmit replays the same Execution. Also submit once, restart a node,
and resubmit the same key: the retained Workflow instance ID must
replay, not duplicate -- that is the `createBatch` retained-ID behavior
the Execution idempotency contract relies on.

## Operational notes

- **Auth.** ADR 014 is unchanged: fixture LAB auth is local/CI only and
  explicitly non-production, and ADR 047 does not amend that. On celld,
  LAB Bearer is therefore for local development and trial fleets on a
  trusted network only -- it authenticates one shared fixture identity
  and is never a production human sign-in. A production fleet must
  terminate at an ingress that injects a verifiable
  `Cf-Access-Jwt-Assertion` for `src/access.ts` to check (the
  Access-verified Principal and membership gate then apply unchanged),
  or wait for a future ADR that gives self-hosting a real identity
  path. Do not expose a LAB-only fleet beyond a trusted network.
- **Schedules.** Cron Triggers are supported, but the config ships
  `crons: []` (ADR 012 pause) on both targets; re-enabling the tick is
  the same reviewed config edit in `wrangler.jsonc`, then
  `npm run config:celld`.
- **Upgrades.** A running node does not restart for a new deployment;
  adjacent versions must accept each other's Durable Object calls
  during the roll (celld forces the move after `CELLD_DEPLOY_MAX_AGE_S`,
  default 60s).
- **Backups.** Fleet state is the bucket (D1 SQLite files, R2 objects,
  Workflow cells). Back up the bucket; there is no D1 Time Travel.
