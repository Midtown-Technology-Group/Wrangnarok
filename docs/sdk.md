# Author and automation SDK (DEV-01, issue #140)

The versioned TypeScript surface for Saga authors and automation callers.
Contract version: `1` (`SDK_VERSION` in `src/sdk.ts`). Python import or wire
compatibility with upstream Bifrost is not promised; see
`docs/sdk-capability-map.md` for the capability-by-capability map.

## Concepts

- **Saga**: a code-first automation definition (`defineSaga` in `src/saga.ts`).
  Stable UUID identity survives ordinary source edits (ADR 002).
- **Execution**: one run of a Saga (a Workflow instance + D1 row).
- **Operation**: a durable unit of execution (a Workflow step, e.g.
  `prepare-input-v1`, `echo-http-v1`).
- **Integration / Connection**: a reusable provider definition versus its
  Organization-scoped configuration (ADR 003). Portable Saga source never
  embeds credentials.
- **Organization context** always comes from the auth context, never from
  headers or request bodies. `--org` is reserved and fails loudly.

## HTTP API (same caller policy as the browser UI)

Authenticated like every other `/api/*` route: `Authorization: Bearer
<token>` (local fixture token or Access service identity). Only
`GET /api/executions` accepts a query string, and only its allowlisted
keys.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/sdk` | Versioned contract descriptor (`describeContract`) |
| `GET` | `/api/sagas` | Saga discovery catalog (read-only metadata) |
| `POST` | `/api/executions` | Submit (`Idempotency-Key` required; 202 + `Location`, replay 200 + `replayed:true`) |
| `POST` | `/api/dev/preview` | No-registration local preview (authoritative parse; no D1 writes, no dispatch; opt-in `checkEnvironment` read-only Connection check) |
| `GET` | `/api/executions` | History summaries (`status` single or comma-separated, `sagaId`, `sagaName`, `startDate`, `endDate`, `limit`, `cursor`) |
| `GET` | `/api/executions/:id` | Detail with Operations, input/result, safe error, `runtimeStatus` |
| `POST` | `/api/executions/:id/cancel` | Owner-only cancel (exact 64-hex ID) |
| `GET` | `/api/forms/:name` | Form declaration for this Organization (FORM-01) |
| `POST` | `/api/forms/:name/submit` | Validate (422 `FORM_VALIDATION_FAILED`) then submit the bound Saga |
| `GET` | `/api/config` | Typed config rows for this Organization (secrets answer `[SECRET]`) |
| `POST` | `/api/config` | Set a non-secret value or provision a secret reference (upsert by key) |
| `PUT` | `/api/config/:id` | Update one row; omitted secret values preserve the reference |
| `DELETE` | `/api/config/:id` | Delete one row (managed rows refuse with `MANAGED_RESOURCE`) |

Errors share one envelope: `{ error: { code, message } }`. Switch on
`code`; the message is never the contract. The full list is
`SDK_ERROR_CODES` in `src/sdk.ts`.

## Typed client (`src/sdk.ts`)

```ts
import { createSdkClient } from "./src/sdk";

const client = createSdkClient({ base: "http://127.0.0.1:8787", token: process.env.WRANGNAROK_TOKEN });

// Discovery.
const sagas = await client.listSagas();
const hello = await client.inspectSaga("hello");

// Validate before paying for a submit (the server parse stays authoritative).
// validateAgainstSchema({ name: "Ada" }, hello.inputSchema); // { ok: true }

// Invoke and wait for terminal status.
const done = await client.submitExecution({ saga: "hello", input: { name: "Ada" } });

// Status, history, cancel, diagnosis.
await client.getExecution(done.executionId);
await client.listHistory({ status: "Failed,TimedOut", limit: 20 });
await client.cancelExecution(done.executionId);
await client.diagnoseExecution(done.executionId); // detail + hint for known codes

// Scoped config (CON-02, ADR 020): typed rows for this Organization.
// Secret rows answer "[SECRET]"; secret values never cross the wire.
await client.listConfigs();
await client.setConfig({ key: "timeout", type: "int", value: "30" });
await client.setConfig({ key: "apiKey", type: "secret", value: { ref: "clientSecret" } });

// Contract drift check.
await client.getContract(); // throws SDK_CLIENT_MISMATCH on version skew
```

Offline helpers (no network): `scaffoldSaga` (emit a `defineSaga` module),
`inspectSaga` (resolve one entry from a catalog), `validateAgainstSchema`,
`localCatalog`, `describeContract`. Wire guards (`parseSagaCatalog`,
`parseExecutionDetail`, `parseHistoryPage`) fail loud with
`SDK_CLIENT_MISMATCH` instead of trusting the wire.

## CLI (`scripts/wrangnarok.mjs`: thin fetch calls, no Saga logic)

```sh
node scripts/wrangnarok.mjs sagas --json
node scripts/wrangnarok.mjs inspect --saga hello
node scripts/wrangnarok.mjs scaffold --name my-saga --id <stable-uuid> --description "..." --revision my-saga-v1
node scripts/wrangnarok.mjs submit --saga hello --input '{"name":"Ada"}'
node scripts/wrangnarok.mjs detail --id <64-hex> --wait
node scripts/wrangnarok.mjs diagnose --id <64-hex>
node scripts/wrangnarok.mjs history --status Failed,TimedOut --limit 20 --all
node scripts/wrangnarok.mjs cancel --id <64-hex>
node scripts/wrangnarok.mjs audit --action app. --outcome success --all
node scripts/wrangnarok.mjs notifications
node scripts/wrangnarok.mjs notification --id <uuid>
node scripts/wrangnarok.mjs dismiss-notification --id <uuid>
node scripts/wrangnarok.mjs configs --json
node scripts/wrangnarok.mjs config-set --key timeout --type int --value 30
node scripts/wrangnarok.mjs config-update --id <uuid> --value 60
node scripts/wrangnarok.mjs config-delete --id <uuid>
node scripts/wrangnarok.mjs contract
node scripts/wrangnarok.mjs selftest   # offline stub-fetch checks, no network
```

Every command is noninteractive. `--json` emits machine-readable output;
failures print `WRANGNAROK_CLI <CODE>: <message>` (or
`{ error: { code, message } }` with `--json`) and exit 2 for usage errors,
1 otherwise. `scaffold` is offline and takes no token. `detail`/`cancel`/
`diagnose` take exact 64-hex Execution IDs only. Auth: `--token`, else
`$WRANGNAROK_TOKEN`, else `.dev.vars` `LAB_TOKEN`; add Access service-token
headers behind protected dev URLs.

## Writing a Saga

Scaffold, then register (Git-owned registration per ADR 002: no runtime
register endpoint by design):

1. `node scripts/wrangnarok.mjs scaffold --name my-saga --id <uuid>`.
2. Add the definition to `SAGA_DEFINITIONS` in `src/sagas/index.ts` and the
   Workflow binding in `wrangler.jsonc`.
3. Add the stable identity to `sagas.manifest.json` (the saga-contract test
   fails loudly otherwise).
4. Rules: all I/O and nondeterminism inside `step.do()`; touch
   `ctx.integrations` / `ctx.db` / `ctx.secrets` / `ctx.config` only there; keep
   input/output JSON-serializable; declare `requiredIntegrations`
   explicitly (even when empty); never put timeouts, retries, schedules,
   endpoints, or access rules in source.
5. `npm run check:sagas && npm test`.

## What this SDK does not cover

Tables, forms (beyond the FORM-01 binding slice), files, agents,
events, roles, and deploy/sync commands belong to their owning parity
issues (`docs/sdk-capability-map.md` section 1, `docs/upstream-parity.md`).
The contract descriptor lists them as `tracked`, never as supported.
escriptor lists them as `tracked`, never as supported.
