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
`GET /api/executions`, `GET /api/executions/:id/logs`, and `GET /api/logs`
accept a query string, and only each route's allowlisted keys.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/sdk` | Versioned contract descriptor (`describeContract`) |
| `GET` | `/api/sagas` | Saga discovery catalog (read-only metadata) |
| `POST` | `/api/executions` | Submit (`Idempotency-Key` required; 202 + `Location`, replay 200 + `replayed:true`) |
| `POST` | `/api/dev/preview` | No-registration local preview (authoritative parse; no D1 writes, no dispatch; opt-in `checkEnvironment` read-only Connection check) |
| `GET` | `/api/executions` | History summaries (`status` single or comma-separated, `sagaId`, `sagaName`, `startDate`, `endDate`, `limit`, `cursor`) |
| `GET` | `/api/executions/:id` | Detail with Operations, input/result, safe error, `runtimeStatus` |
| `GET` | `/api/executions/:id/logs` | OBS-02 scoped log tail (`level`, `limit`, `cursor`; DEBUG hidden unless asked; polling view over durable rows) |
| `GET` | `/api/logs` | OBS-02 operator log search (`level`, `sagaId`, `sagaName`, `startDate`, `endDate`, `limit`, `cursor`) |
| `POST` | `/api/executions/:id/cancel` | Owner-only cancel (exact 64-hex ID) |
| `GET` | `/api/forms` | Org-scoped form summaries (FORM-02 designer list) |
| `POST` | `/api/forms` | Create a form declaration (400 `INVALID_FORM` on bad fields) |
| `GET` | `/api/forms/:name` | Form declaration for this Organization (FORM-02 metadata + fields) |
| `PUT` | `/api/forms/:name` | Replace a form declaration wholesale (FORM-02 designer edit) |
| `DELETE` | `/api/forms/:name` | Delete a form declaration |
| `POST` | `/api/forms/:name/startup` | Mint a session-bound 30-minute handle with snapshot + provider options |
| `GET` | `/api/forms/:name/providers` | Resolved select/multiselect options through the caller Table gate |
| `POST` | `/api/forms/:name/submit` | Consume a startup handle (422 `STALE_FORM_HANDLE`), validate, merge defaults, submit or schedule |
| `GET` | `/api/config` | Typed config rows for this Organization (secrets answer `[SECRET]`) |
| `POST` | `/api/config` | Set a non-secret value or provision a secret reference (upsert by key) |
| `PUT` | `/api/config/:id` | Update one row; omitted secret values preserve the reference |
| `DELETE` | `/api/config/:id` | Delete one row (managed rows refuse with `MANAGED_RESOURCE`) |
| `GET` | `/api/schedules` | Org-scoped schedule summaries (TRG-01 inventory) |
| `POST` | `/api/schedules` | Create a schedule binding cadence/timezone/input/run-as to one Saga (TRG-01; 409 on duplicate name) |
| `GET` | `/api/schedules/:name` | Schedule detail with next due instant and last promoted window (TRG-01) |
| `DELETE` | `/api/schedules/:name` | Delete a schedule; promoted Executions keep history (TRG-01) |
| `POST` | `/api/schedules/:name/enable` | Re-enable a schedule for promotion (TRG-01) |
| `POST` | `/api/schedules/:name/disable` | Disable a schedule; in-flight Executions run to terminal (TRG-01) |
| `GET` | `/api/schedules/:name/deliveries?window=` | Window-to-Execution delivery mapping (TRG-01) |

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

// Author logs (OBS-02): scoped tail plus operator search. Polling views over
// durable D1 rows; reconnect by refetching from nextCursor (replays dedupe
// by seq). DEBUG rows stay hidden unless level asks for them.
await client.tailLogs(done.executionId, { level: "INFO", limit: 50 });
await client.searchLogs({ saga: "hello", level: "ERROR", limit: 20 });

// Scoped config (CON-02, ADR 020): typed rows for this Organization.
// Secret rows answer "[SECRET]"; secret values never cross the wire.
await client.listConfigs();
await client.setConfig({ key: "timeout", type: "int", value: "30" });
await client.setConfig({ key: "apiKey", type: "secret", value: { ref: "clientSecret" } });

// Dynamic forms (FORM-02, issue #155): designer CRUD, startup handles,
// providers, submit or schedule. The handle is peeked for validation and
// consumed only after validation passes; unknown/stale handles answer STALE_FORM_HANDLE.
await client.listForms();
await client.getForm("contact");
await client.startForm("contact", { name: "Ada" }); // opt-in prefill only
await client.getFormProviders("contact");
await client.submitForm({ form: "contact", handle, values: { name: "Ada" } });

// Contract drift check.
await client.getContract(); // throws SDK_CLIENT_MISMATCH on version skew

// Schedules (TRG-01, issue #137): one-off and recurring schedules as
// persisted environment state. Cadence, timezone, enablement, input, and
// run-as live on the schedule row (run-as is the creating caller); the
// minute Cron tick promotes due rows through the submit protocol.
await client.listSchedules();
await client.getSchedule("morning-digest");
await client.createSchedule({ name: "morning-digest", sagaId: hello.id, kind: "recurring", cron: "0 9 * * 1-5" });
await client.setScheduleEnabled("morning-digest", false);
await client.getScheduleDelivery("morning-digest", "2026-09-12T09:00");
await client.deleteSchedule("morning-digest");
```

Offline helpers (no network): `scaffoldSaga` (emit a `defineSaga` module),
`inspectSaga` (resolve one entry from a catalog), `validateAgainstSchema`,
`localCatalog`, `describeContract`. Wire guards (`parseSagaCatalog`,
`parseExecutionDetail`, `parseHistoryPage`, `parseFormList`,
`parseFormDetail`, `parseFormStartup`, `parseFormProviders`,
`parseFormSubmit`, `parseScheduleList`, `parseScheduleDetail`,
`parseScheduleDelivery`) fail loud with
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
node scripts/wrangnarok.mjs logs --id <64-hex> [--level INFO] [--limit 50] [--follow]
node scripts/wrangnarok.mjs log-search [--level ERROR] [--saga hello] [--from 2026-09-01] [--to 2026-09-10] [--all]
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

Tables beyond the shipped query/count/batch slice, agents,
events, roles, and deploy/sync commands belong to their owning parity
issues (`docs/sdk-capability-map.md` section 1, `docs/upstream-parity.md`).
Dynamic forms ship as the supported `dynamic-forms` capability (FORM-02,
issue #155); embed/publication stays tracked under EMBED-01. The contract
descriptor lists deferred items as `tracked`, never as supported.
