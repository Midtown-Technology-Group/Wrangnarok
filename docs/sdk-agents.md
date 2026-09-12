# AI agent instructions: Saga authoring and automation (DEV-01, issue #140)

This file is generated from actual exports and examples, not philosophy.
If it disagrees with `src/sdk.ts`, `src/saga.ts`, `scripts/wrangnarok.mjs`,
or `docs/sdk.md`, the source wins and this file must be updated in the same
PR (test/sdk.test.ts pins the contract; drift fails CI).

## Author a Saga

1. Scaffold offline (no token, no network):
   `node scripts/wrangnarok.mjs scaffold --name <slug> --id <stable-uuid>`.
2. Register (Git-owned, ADR 002): add the definition to `SAGA_DEFINITIONS`
   in `src/sagas/index.ts`, the Workflow binding in `wrangler.jsonc`, and
   the stable identity in `sagas.manifest.json`.
3. Build with `defineSaga` (`src/saga.ts`): `id` (stable UUID), `name`
   (slug), `revision` (diagnostic marker), `description` (1-280 chars),
   `requiredIntegrations` (explicit, even when empty), `inputSchema` /
   `outputSchema` (`IoSchema`), `parse`, `run`.
4. Determinism (enforced by `test/saga-contract.test.ts`): every durable
   effect inside `step.do(name, fn)`; touch `ctx.integrations`, `ctx.db`,
   `ctx.secrets` only there; no `fetch`, `Date.now`/`new Date`,
   `Math.random`, `randomUUID`, `AbortSignal`, `crypto`, `process.env`, or
   `step.sleepUntil`/`waitForEvent` at the top level; JSON-serializable
   input/output (`assertJsonSerializable`).
5. Never put operational policy in source: no timeouts, retries, schedules,
   endpoints, access rules, rate limits, cache/TTL, concurrency, or backoff
   (`validateSagaDefinition` rejects them). Retry limits resolve through
   `stepRetryLimit`; the step timeout is fixed platform mapping.
6. Validate: `npm run check:sagas && npm test`.

## Automate (typed client or CLI, same caller policies as the UI)

- Client: `createSdkClient({ base, token })` in `src/sdk.ts`: `listSagas`,
  `inspectSaga`, `submitExecution`, `getExecution`, `cancelExecution`,
  `listHistory`, `diagnoseExecution`, `getContract`. Offline:
  `scaffoldSaga`, `inspectSaga(catalog, ref)`, `validateAgainstSchema`,
  `localCatalog`, `describeContract`.
- CLI: `sagas`, `inspect --saga`, `scaffold`, `submit`, `detail`,
  `diagnose`, `history`, `cancel`, `contract`, `selftest`. Noninteractive;
  `--json` for machine output; exit 2 usage, 1 otherwise.
- Auth: Bearer token; Organization from auth context (never a parameter).
  Execution IDs are exact 64-hex; Idempotency-Keys 16-128
  `[A-Za-z0-9._:-]`. Errors: switch on `error.code`
  (`SDK_ERROR_CODES`), never on messages.
- Contract: `SDK_VERSION` (`"1"`); `GET /api/sdk` serves
  `describeContract()`. Bump the version on any breaking export or route
  change and update `docs/sdk.md` + this file together.

## Do not invent

Tables, forms (beyond FORM-01 binding), files, agents, events,
roles, OAuth, deploy/sync, or a generic `api` escape hatch are not in this
SDK. They belong to their owning parity issues
(`docs/sdk-capability-map.md`); never claim them complete and never add a
YAML/JSON workflow DSL. Use Cloudflare native names (Worker, Workflow,
step, D1) and the `docs/lexicon.md` vocabulary.
