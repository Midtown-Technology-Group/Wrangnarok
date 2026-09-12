// SPDX-License-Identifier: AGPL-3.0
// Project CLI: thin conveniences over the Worker HTTP API only. No Saga
// logic lives here — every command is fetch calls plus polling plus output
// formatting. Destructive actions take exact IDs only, never prefixes or
// search matches.
//
// Auth: --token, else $WRANGNAROK_TOKEN, else LAB_TOKEN from .dev.vars
// (local fixture only; the token value is never printed). Behind Cloudflare
// Access (e.g. dev), also pass --access-client-id/--access-client-secret
// (or $CF_ACCESS_CLIENT_ID/$CF_ACCESS_CLIENT_SECRET); without an SSO
// session or service token the edge challenges machine callers.
// Organization always comes from the auth context plus X-Organization-Id
// scope selection (ADR 015); passing --org fails loudly (legacy guard).
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const TERMINAL = ["Succeeded", "Failed", "TimedOut", "Cancelled"];
const EXECUTION_ID = /^[a-f0-9]{64}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/;
const SAGA_SLUG = /^[a-z0-9][a-z0-9.-]*$/i;
const STABLE_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** Human-rendering bound for input/result payloads (mirrors the D1 4096-byte bound). */
const CLI_JSON_BOUND = 4096;
const HISTORY_STATUSES = ["Pending", "Running", "Succeeded", "Failed", "TimedOut", "Cancelling", "Cancelled"];

// Stable machine-readable error envelope (DEV-01, issue #140): with --json,
// failures print one JSON object { error: { code, message } } on stderr and
// keep the same exit convention (2 for usage, 1 otherwise). Human-readable
// output keeps the legacy WRANGNAROK_CLI line. Codes match SDK_ERROR_CODES
// in src/sdk.ts; messages are never the contract.
function fail(code, message) {
  if (process.argv.includes("--json")) {
    console.error(JSON.stringify({ error: { code, message: String(message) } }));
  } else {
    console.error(`WRANGNAROK_CLI ${code}: ${message}`);
  }
  process.exit(code === "USAGE" ? 2 : 1);
}

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function readDevVars() {
  try {
    if (!existsSync(".dev.vars")) return {};
    const vars = {};
    for (const line of readFileSync(".dev.vars", "utf-8").split("\n")) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (match) vars[match[1]] = match[2];
    }
    return vars;
  } catch {
    return {};
  }
}

function authToken() {
  const token = arg("token") ?? process.env.WRANGNAROK_TOKEN ?? readDevVars().LAB_TOKEN ?? "";
  if (!token) {
    fail("USAGE", "no bearer token: pass --token, set $WRANGNAROK_TOKEN, or run `npm run setup:local`.");
  }
  return token;
}

function baseUrl() {
  const base = arg("base", process.env.WRANGNAROK_BASE ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) fail("USAGE", `--base must be an http(s) URL, got ${JSON.stringify(base)}.`);
  return base;
}

function accessHeaders() {
  const id = arg("access-client-id") ?? process.env.CF_ACCESS_CLIENT_ID ?? "";
  const secret = arg("access-client-secret") ?? process.env.CF_ACCESS_CLIENT_SECRET ?? "";
  if (id || secret) {
    if (!id || !secret) fail("USAGE", "Access service token needs both id and secret.");
    return { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret };
  }
  return {};
}

async function readJson(response, what) {
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    fail("SERVER_MISMATCH", `${what} returned HTTP ${response.status} with a non-JSON body: ${text.slice(0, 160)}`);
  }
  if (!response.ok) {
    const code = data?.error?.code ?? "UNKNOWN";
    const message = data?.error?.message ?? text.slice(0, 160);
    fail("SERVER_REJECTED", `${what} failed: HTTP ${response.status} ${code}: ${message}`);
  }
  return data;
}

function asJson() {
  return flag("json");
}

function emit(value) {
  if (asJson()) console.log(JSON.stringify(value));
  return asJson();
}

async function fetchSagas(ctx) {
  const data = await readJson(await ctx.fetchImpl(`${ctx.base}/api/sagas`, { headers: ctx.headers }), "saga catalog");
  if (!Array.isArray(data.sagas)) fail("SERVER_MISMATCH", "saga catalog has no sagas array.");
  return data.sagas;
}

async function resolveSagaId(ctx, ref) {
  if (/^[0-9a-fA-F-]{36}$/.test(ref)) return ref;
  const sagas = await fetchSagas(ctx);
  const matches = sagas.filter((entry) => entry.name === ref);
  if (matches.length === 0) fail("SERVER_MISMATCH", `no Saga named ${JSON.stringify(ref)} in the catalog.`);
  if (matches.length > 1) fail("SERVER_MISMATCH", `multiple Sagas named ${JSON.stringify(ref)}; pass a stable UUID.`);
  return matches[0].id;
}

const NOTIFICATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkNotificationId(id) {
  if (!NOTIFICATION_ID.test(id ?? "")) {
    fail("USAGE", "notification and dismiss-notification need the exact notification UUID.");
  }
  return id;
}

function checkExecutionId(id) {
  if (!EXECUTION_ID.test(id ?? "")) {
    fail("USAGE", "cancel and detail need the exact 64-hex Execution ID (no prefixes, no search).");
  }
  return id;
}

const ORG_ID = /^[0-9a-fA-F-]{36}$/;

function checkOrgId(id) {
  if (!ORG_ID.test(id ?? "")) {
    fail("USAGE", "org commands need the exact Organization UUID (no prefixes, no search).");
  }
  return id;
}

function checkConfigId(id) {
  if (!STABLE_UUID.test(id ?? "")) {
    fail("USAGE", "config-update and config-delete need the exact config UUID (no prefixes, no search).");
  }
  return id;
}

/** Config --value parsing: secret types take { ref } JSON (or @FILE);
 * non-secret types take raw text (or @FILE text). Never logs or stores. */
function readConfigValue(ctx) {
  const raw = ctx.configValue;
  if (typeof raw !== "string") fail("USAGE", "config --value must be text (or @path to a file).");
  const text = raw.startsWith("@") ? readFileSync(raw.slice(1), "utf-8") : raw;
  if (ctx.configType === "secret") {
    try {
      return JSON.parse(text);
    } catch {
      return fail("USAGE", 'secret configs need --value \'{"ref":"<declared name>"}\' (or @path to that JSON).');
    }
  }
  return text;
}

function readInput() {
  const raw = arg("input", "{}");
  const text = raw.startsWith("@") ? readFileSync(raw.slice(1), "utf-8") : raw;
  try {
    return JSON.parse(text);
  } catch {
    return fail("USAGE", "--input must be JSON (or @path to a JSON file).");
  }
}

async function pollDetail(ctx, executionId, { wait, timeoutMs, pollMs, sleep }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const detail = await readJson(
      await ctx.fetchImpl(`${ctx.base}/api/executions/${executionId}`, { headers: ctx.headers }),
      "execution detail",
    );
    if (typeof detail.status !== "string") fail("SERVER_MISMATCH", "execution detail has no status.");
    if (TERMINAL.includes(detail.status) || !wait) return detail;
    if (Date.now() >= deadline) fail("TIMEOUT", `execution ${executionId} did not settle in time.`);
    await sleep(pollMs);
  }
}

function printSagas(sagas) {
  if (emit({ sagas })) return;
  for (const saga of sagas) console.log(`${saga.name}\t${saga.id}\t${saga.revision}`);
}

function printInspect(saga) {
  if (emit({ saga })) return;
  console.log(`${saga.name}\t${saga.id}\t${saga.revision}`);
  console.log(saga.description);
  if (Array.isArray(saga.requiredIntegrations) && saga.requiredIntegrations.length > 0) {
    console.log(`requiredIntegrations: ${saga.requiredIntegrations.join(", ")}`);
  } else {
    console.log("requiredIntegrations: (none)");
  }
  if (saga.inputSchema !== undefined) console.log(`inputSchema: ${JSON.stringify(saga.inputSchema)}`);
  if (saga.outputSchema !== undefined) console.log(`outputSchema: ${JSON.stringify(saga.outputSchema)}`);
}

const DIAGNOSE_HINTS = {
  INTEGRATION_REQUIREMENT_UNSATISFIED:
    "This Saga requires an Integration Connection that is not configured for this Organization.",
  ECHO_VENDOR_TIMEOUT: "The vendor exceeded its deadline; the timeout-mark checkpoint wrote TimedOut.",
  NINJA_VENDOR_TIMEOUT: "The vendor exceeded its deadline; the timeout-mark checkpoint wrote TimedOut.",
  NINJA_UNAUTHORIZED: "NinjaOne credentials are missing or rejected; check the server environment.",
  NINJA_NOT_CONFIGURED: "NinjaOne credentials are not configured; check the server environment.",
  EXECUTION_CANCELLED: "The Execution was cancelled; submit a fresh Idempotency-Key to run again.",
  DISPATCH_UNCONFIRMED: "Work may have started. Retry the same request and Idempotency-Key.",
};

function printDiagnosis(detail) {
  const errorCode = detail?.error?.code;
  const diagnosis = {
    executionId: detail.executionId,
    status: detail.status,
    sagaName: detail.sagaName,
    operations: detail.operations,
    result: detail.result,
    error: detail.error,
    hint: DIAGNOSE_HINTS[errorCode] ?? null,
  };
  if (emit({ diagnosis })) return;
  console.log(`${diagnosis.executionId} ${diagnosis.status}`);
  for (const op of diagnosis.operations ?? []) console.log(`  ${op.name}\t${op.status}`);
  if (diagnosis.error !== null && diagnosis.error !== undefined) {
    console.log(`error: ${JSON.stringify(diagnosis.error)}`);
  }
  if (diagnosis.hint) console.log(`hint: ${diagnosis.hint}`);
}

function boundedCliJson(value) {
  if (value === null || value === undefined) return "—";
  const text = JSON.stringify(value, null, 2) ?? "—";
  if (text.length <= CLI_JSON_BOUND) return text;
  return `${text.slice(0, CLI_JSON_BOUND)}\n… (truncated at ${CLI_JSON_BOUND} chars; rerun with --json for the full payload)`;
}

function printHistory(executions, hasMore, { pages }) {
  if (emit({ executions, hasMore })) return;
  for (const row of executions) {
    console.log(
      `${String(row.executionId).slice(0, 12)}\t${row.sagaName}\t${row.status}\t${row.startedAt ?? row.createdAt ?? "-"}`,
    );
  }
  // Loaded-slice counts are never presented as totals: hasMore means the
  // server holds rows this output does not show.
  if (hasMore) console.log(`# ${executions.length} loaded across ${pages} page(s); more available server-side.`);
  else console.log(`# ${executions.length} loaded (complete under these filters).`);
}

function printAudit(events, hasMore, { pages }) {
  if (emit({ events, hasMore })) return;
  for (const row of events) {
    console.log(
      `${String(row.id).slice(0, 12)}\t${row.action}\t${row.outcome}\t${row.targetId ?? "-"}\t${row.createdAt ?? "-"}`,
    );
  }
  // Loaded-slice counts are never presented as totals: hasMore means the
  // server holds rows this output does not show.
  if (hasMore) console.log(`# ${events.length} loaded across ${pages} page(s); more available server-side.`);
  else console.log(`# ${events.length} loaded (complete under these filters).`);
}

function printNotifications(notifications) {
  if (emit({ notifications })) return;
  for (const row of notifications) {
    console.log(`${String(row.id).slice(0, 12)}\t${row.scope}\t${row.status}\t${row.title}`);
  }
  if (notifications.length === 0) console.log("# no notifications.");
}

function printNotification(notification) {
  if (emit({ notification })) return;
  console.log(`${notification.id} ${notification.status}`);
  console.log(`${notification.scope} · ${notification.category}: ${notification.title}`);
  if (notification.body) console.log(notification.body);
  const detail = notification.detail;
  if (detail !== null && detail !== undefined) console.log(`detail: ${JSON.stringify(detail)}`);
  console.log(`created: ${notification.createdAt ?? "-"} updated: ${notification.updatedAt ?? "-"}`);
}

function printDetail(detail) {
  if (emit(detail)) return;
  console.log(`${detail.executionId} ${detail.status}`);
  console.log(`saga: ${detail.sagaName} (${detail.sagaRevision})`);
  console.log(`runtime: ${detail.runtimeStatus ?? "unavailable (native history expired or not yet dispatched)"}`);
  console.log(`dispatch: ${detail.dispatchConfirmed ? "confirmed" : "unconfirmed (Pending receipt only)"}`);
  console.log(
    `created: ${detail.createdAt ?? "-"} started: ${detail.startedAt ?? "-"} completed: ${detail.completedAt ?? "-"}`,
  );
  console.log(`input: ${boundedCliJson(detail.input)}`);
  if (detail.status === "Succeeded") console.log(`result: ${boundedCliJson(detail.result)}`);
  else if (detail.status === "Failed" || detail.status === "TimedOut" || detail.status === "Cancelled") {
    const error = detail.error;
    console.log(`error: ${error?.code ?? "UNKNOWN"}: ${error?.message ?? "no message"}`);
  } else console.log("output: still active (no terminal result yet)");
  for (const op of detail.operations ?? []) {
    console.log(`op ${op.name} ${op.status} started=${op.startedAt} completed=${op.completedAt ?? "-"}`);
    if (op.result !== null && op.result !== undefined) console.log(`  result: ${boundedCliJson(op.result)}`);
    if (op.error !== null && op.error !== undefined) {
      console.log(`  error: ${op.error?.code ?? "UNKNOWN"}: ${op.error?.message ?? boundedCliJson(op.error)}`);
    }
  }
}

function printCancel(outcome) {
  if (emit(outcome)) return;
  if (outcome.cancelled)
    console.log(`${outcome.executionId} Cancelled (confirmed; it will not run again under this key)`);
  else console.log(`${outcome.executionId} ${outcome.status} (already in progress; another request won the race)`);
}

function printArtifacts(artifacts, hasMore) {
  if (emit({ artifacts, hasMore })) return;
  for (const entry of artifacts ?? []) {
    console.log(`${String(entry.id).slice(0, 8)}\t${entry.name}\tv${entry.version}\t${entry.status}`);
  }
  if (hasMore) console.log(`# ${artifacts?.length ?? 0} loaded; more available server-side.`);
  else console.log(`# ${artifacts?.length ?? 0} loaded (complete under these filters).`);
}

function printArtifact(artifact) {
  if (emit({ artifact })) return;
  console.log(`${artifact.id} ${artifact.name} v${artifact.version} ${artifact.status}`);
  for (const entry of artifact.versions ?? [])
    console.log(`  v${entry.version} ${entry.mime} ${entry.sizeBytes} bytes`);
  for (const entry of artifact.bindings ?? []) console.log(`  bound ${entry.scope}:${entry.refId}`);
}

function printDownload(result) {
  if (emit(result)) return;
  console.log(result.out ? `downloaded ${result.bytes} bytes to ${result.out}` : `downloaded ${result.bytes} bytes`);
}

function printBinding(binding) {
  if (emit({ binding })) return;
  console.log(`bound ${binding.artifactId} ${binding.scope}:${binding.refId}`);
}

function printUnbound() {
  if (emit({ deleted: true })) return;
  console.log("unbound");
}

function printBindings(bindings) {
  if (emit({ bindings })) return;
  for (const entry of bindings ?? []) console.log(`${entry.artifactId} ${entry.scope}:${entry.refId}`);
  if ((bindings ?? []).length === 0) console.log("(no bindings)");
}

function printRetention(retention) {
  if (emit({ retention })) return;
  console.log(`retention: ${retention.maxAgeDays} days`);
}

function printCleanup(cleanup) {
  if (emit({ cleanup })) return;
  for (const id of cleanup.deleted ?? []) console.log(`deleted ${id}`);
  for (const entry of cleanup.failed ?? []) console.log(`failed ${entry.id} ${entry.code}`);
  console.log(`remaining: ${cleanup.remaining ?? 0}`);
}

const HELP = `wrangnarok: thin CLI over the Worker HTTP API (no Saga logic here).

Usage: node scripts/wrangnarok.mjs [global flags] <command> [args]

Global flags:
  --base URL            Worker origin (default http://127.0.0.1:8787, or $WRANGNAROK_BASE)
  --token TOKEN         Bearer token (default $WRANGNAROK_TOKEN, else .dev.vars LAB_TOKEN)
  --access-client-id / --access-client-secret (or $CF_ACCESS_CLIENT_ID/_SECRET)
                        Cloudflare Access service token headers for dev URLs
  --org ID              LEGACY GUARD: fails loudly; organization comes from auth context + scope selection
  --json                Machine-readable JSON output (default is human-readable)
  --help                This text

Commands:
  sagas                                   List the Saga catalog
  inspect --saga NAME|UUID                Show one Saga (schemas, requirements)
  scaffold --name SLUG --id UUID [--description TEXT] [--revision REV]
                                          Emit a new defineSaga module (offline)
  submit --saga NAME|UUID [--input JSON|@FILE] [--key KEY] [--no-wait]
                                          Submit an Execution (202 + poll to terminal)
  preview --saga NAME|UUID [--input JSON|@FILE] [--check-env]
                                          No-registration local preview (read-only:
                                          no D1 writes, no dispatch)
  detail --id HEX                         Fetch one Execution (add --wait to poll)
  diagnose --id HEX                       Fetch one Execution with failure hints
  history [--status S[,S2]] [--saga NAME|UUID] [--from YYYY-MM-DD]
          [--to YYYY-MM-DD] [--limit N] [--all]
                                          Query Execution summaries (server filters,
                                          cursor traversal; loaded counts are not totals)
  cancel --id HEX                         Cancel one Execution (exact ID only)
  audit [--action PREFIX] [--outcome success|failure] [--search TEXT]
        [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--limit N] [--all]
                                          Query audit events (server filters,
                                          cursor traversal; loaded counts are not totals)
  notifications [--limit N]               List the notifications inbox
  notification --id UUID                  Fetch one notification
  dismiss-notification --id UUID          Dismiss one notification (exact ID only)
  artifacts [--limit N]                   List Artifact summaries (no bytes)
  artifact --id UUID                      Fetch one Artifact (versions + bindings)
  upload --name NAME [--mime TYPE] [--file PATH]
                                          Upload bytes (same name versions the row)
  download --id UUID [--out PATH]         Fetch current-version bytes
  rename --id UUID --name NAME            Rename the canonical record
  bind --id UUID --scope S --ref REF      Bind to an execution/workspace/conversation
  unbind --id UUID --scope S --ref REF    Remove one attachment binding
  bindings --scope S --ref REF            List attachment triples (no bytes)
  retention [--days N]                    Read (or, with --days, set*) the policy
  cleanup [--run]                         Preview (or, with --run, execute*) cleanup
                                          * admin only (instance/org admin membership)
  orgs                                    List visible Organizations
  org-create --name NAME                  Create an Organization (instance admin)
  org-disable/--enable --id UUID          Disable/enable an Organization (instance admin)
  org-delete-preview --id UUID            Preview cascading delete (retained history)
  org-delete --id UUID                    Delete an Organization (instance admin)
  members --id UUID                       List Organization members (org admin)
  invite --id UUID --user ID [--role R] [--kind K]
                                          Invite a user (role member|admin, kind ordinary|external)
  member-update --id UUID --user ID [--role R] [--status S] [--kind K]
                                          Change role/status/kind (org admin)
  user-disable/--enable --user ID         Disable/enable a user globally (instance admin)
  org-executions --id UUID [--status S] [--limit N]
                                          Org-scoped ExecutionHistory (org admin, incl. in-flight)
  configs                                 List typed config rows (secrets masked)
  config-set --key NAME --type T [--value V|@FILE] [--description TEXT]
                                          Set a non-secret value or provision a
                                          secret reference (upsert by key)
  config-update --id UUID [--key NAME] [--type T] [--value V|@FILE]
                [--description TEXT]      Update one config row (omitted secret
                                          values preserve the reference)
  config-delete --id UUID                 Delete one config row (exact ID only)
  contract                                Show the versioned SDK contract (GET /api/sdk)
  selftest                                Offline selftest (stub fetch, no network)

  Bulk user operations are intentionally omitted in this slice: repeat the
  single-row invite/member-update calls above (see ADR 015). Loop helpers must
  report per-item status and stop on the first server rejection.

Auth notes: local .dev.vars tokens never leave this machine in logs. Dev
URLs behind Access challenge machine callers without a service token.
Cancel takes the exact 64-hex Execution ID; nothing here guesses targets.`;

export function parseContext(argv = process.argv) {
  return {
    command: argv[2],
    base: (arg("base", process.env.WRANGNAROK_BASE ?? "http://127.0.0.1:8787") ?? "").replace(/\/+$/, ""),
    json: argv.includes("--json"),
    org: arg("org"),
  };
}

export async function runCommand(ctx, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const full = {
    ...ctx,
    fetchImpl,
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      "Content-Type": "application/json",
      ...accessHeaders(),
    },
  };
  switch (ctx.command) {
    case "sagas": {
      return { sagas: await fetchSagas(full) };
    }
    case "inspect": {
      if (!ctx.saga) fail("USAGE", "inspect needs --saga NAME|UUID.");
      const sagas = await fetchSagas(full);
      if (STABLE_UUID.test(ctx.saga)) {
        const byId = sagas.find((entry) => String(entry.id).toLowerCase() === ctx.saga.toLowerCase());
        if (!byId) fail("SDK_SAGA_NOT_FOUND", `no Saga with stable id ${JSON.stringify(ctx.saga)}.`);
        return { saga: byId };
      }
      const matches = sagas.filter((entry) => entry.name === ctx.saga);
      if (matches.length === 0) fail("SDK_SAGA_NOT_FOUND", `no Saga named ${JSON.stringify(ctx.saga)}.`);
      if (matches.length > 1) fail("SDK_SAGA_AMBIGUOUS", `multiple Sagas named ${JSON.stringify(ctx.saga)}.`);
      return { saga: matches[0] };
    }
    case "scaffold": {
      // Offline: no fetch, no token use. Mirrors scaffoldSaga() in src/sdk.ts;
      // test/sdk.test.ts pins the same markers in both.
      const name = ctx.scaffoldName;
      const id = ctx.scaffoldId;
      if (!name || !SAGA_SLUG.test(name)) fail("USAGE", "scaffold needs --name SLUG (simple slug).");
      if (!id || !STABLE_UUID.test(id)) fail("USAGE", "scaffold needs --id UUID (stable Saga identity).");
      const description = ctx.scaffoldDescription ?? `Saga ${name}`;
      if (description.length === 0 || description.length > 280) {
        fail("USAGE", "scaffold --description must be 1-280 chars.");
      }
      const revision = ctx.scaffoldRevision ?? `${name}-v1`;
      if (revision.length === 0 || revision.length > 64) fail("USAGE", "scaffold --revision must be 1-64 chars.");
      const path = `src/sagas/${name}.ts`;
      const content = [
        "// SPDX-License-Identifier: AGPL-3.0",
        `// ${name} Saga (scaffolded with the Wrangnarok CLI).`,
        "// Stable identity per ADR 002: changing the id below mints a DIFFERENT Saga.",
        'import { WorkflowEntrypoint } from "cloudflare:workers";',
        'import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";',
        'import { NonRetryableError } from "cloudflare:workflows";',
        'import type { Bindings } from "../bindings";',
        'import { EXECUTION_ID } from "../domain";',
        'import type { ExecutionParams, SafeError } from "../domain";',
        'import { defineSaga } from "../saga";',
        'import { failExecution, prepareExecution } from "../executions";',
        'import { executeSaga } from "./shared";',
        "",
        `export const ${name.replace(/[^a-zA-Z0-9_]/g, "_")}SagaDef = defineSaga<unknown>({`,
        `  id: ${JSON.stringify(id)},`,
        `  name: ${JSON.stringify(name)},`,
        `  revision: ${JSON.stringify(revision)},`,
        `  description: ${JSON.stringify(description)},`,
        "  requiredIntegrations: [],",
        "  inputSchema: Object.freeze({",
        '    type: "object" as const,',
        "    properties: Object.freeze({}),",
        "    additionalProperties: false,",
        "  }),",
        "  parse: (value) => value,",
        "  run: async (ctx, step) => {",
        "    const eid = ctx.executionId;",
        '    if (typeof eid !== "string" || !EXECUTION_ID.test(eid)) {',
        '      throw new NonRetryableError("Invalid local Execution invocation.");',
        "    }",
        "    let expectedFailure;",
        "    try {",
        '      const prepared = await step.do("prepare-input-v1", () =>',
        `        prepareExecution(ctx.db, eid, ${JSON.stringify(id)}, ${JSON.stringify(revision)}, (v) => v),`,
        "      );",
        '      const output = await step.do("work-v1", async () => prepared.input);',
        '      await step.do("persist-success-v1", async () => {',
        "        await ctx.db",
        "          .prepare(",
        "            \"UPDATE executions SET status='Succeeded',completed_at=?,result_json=? WHERE id=? AND status='Running'\",",
        "          )",
        "          .bind(new Date().toISOString(), JSON.stringify(output), eid)",
        "          .run();",
        "      });",
        "      return output;",
        "    } catch {",
        "      const safe = expectedFailure ?? {",
        '        code: "EXECUTION_FAILED",',
        '        message: "The Execution could not complete. Inspect local runtime diagnostics.",',
        "      };",
        '      await step.do("persist-failure-v1", () => failExecution(ctx.db, eid, safe));',
        "      throw new NonRetryableError(safe.code);",
        "    }",
        "  },",
        "});",
        "",
        `export class ${name.replace(/[^a-zA-Z0-9]/g, "")}Workflow extends WorkflowEntrypoint<Bindings, ExecutionParams> {`,
        "  async run(event, step) {",
        `    return executeSaga(this.env, event, step, ${name.replace(/[^a-zA-Z0-9_]/g, "_")}SagaDef);`,
        "  }",
        "}",
        "",
      ].join("\n");
      return {
        scaffold: {
          path,
          content,
          next: [
            "Add the definition to SAGA_DEFINITIONS in src/sagas/index.ts and the Workflow binding in wrangler.jsonc.",
            "Add the stable identity to sagas.manifest.json (the saga-contract test fails loudly otherwise).",
            "Run npm run check:sagas and npm test before opening a PR.",
          ],
        },
      };
    }
    case "diagnose": {
      const detail = await pollDetail(full, checkExecutionId(ctx.id), {
        wait: false,
        timeoutMs: ctx.timeoutMs,
        pollMs: ctx.pollMs,
        sleep,
      });
      const hint = DIAGNOSE_HINTS[detail?.error?.code] ?? null;
      return {
        diagnosis: {
          executionId: detail.executionId,
          status: detail.status,
          sagaName: detail.sagaName,
          operations: detail.operations,
          result: detail.result,
          error: detail.error,
          hint,
        },
      };
    }
    case "contract": {
      return readJson(await fetchImpl(`${ctx.base}/api/sdk`, { headers: full.headers }), "sdk contract");
    }
    case "preview": {
      // DEV-02 (issue #141): no-registration local preview. Read-only by
      // construction server-side (no D1 writes, no dispatch); --check-env
      // opts into the read-only Connection-presence check for this
      // Organization only. Same caller policy as every other command.
      if (!ctx.saga) fail("USAGE", "preview needs --saga NAME|UUID.");
      const sagaId = await resolveSagaId(full, ctx.saga);
      return readJson(
        await fetchImpl(`${ctx.base}/api/dev/preview`, {
          method: "POST",
          headers: full.headers,
          body: JSON.stringify({
            sagaId,
            input: ctx.input ?? {},
            ...(ctx.checkEnv ? { checkEnvironment: true } : {}),
          }),
        }),
        "saga preview",
      );
    }
    case "submit": {
      if (!ctx.saga) fail("USAGE", "submit needs --saga NAME|UUID.");
      const key = ctx.key ?? `cli-${randomUUID()}`;
      if (!IDEMPOTENCY_KEY.test(key)) fail("USAGE", "--key must be 16-128 chars [A-Za-z0-9._:-].");
      const sagaId = await resolveSagaId(full, ctx.saga);
      const accepted = await readJson(
        await fetchImpl(`${ctx.base}/api/executions`, {
          method: "POST",
          headers: { ...full.headers, "Idempotency-Key": key },
          body: JSON.stringify({ sagaId, input: ctx.input }),
        }),
        "execution submit",
      );
      if (typeof accepted.executionId !== "string") fail("SERVER_MISMATCH", "submit returned no executionId.");
      if (!ctx.wait) return accepted;
      return pollDetail(full, accepted.executionId, {
        wait: true,
        timeoutMs: ctx.timeoutMs,
        pollMs: ctx.pollMs,
        sleep,
      });
    }
    case "detail": {
      return pollDetail(full, checkExecutionId(ctx.id), {
        wait: ctx.wait,
        timeoutMs: ctx.timeoutMs,
        pollMs: ctx.pollMs,
        sleep,
      });
    }
    case "history": {
      // Cursor traversal: --all follows nextCursor while preserving the
      // active filters; otherwise one page. Statuses stay comma-separated
      // (mirrors the server + upstream multi-status filter).
      const statuses = ctx.statusFilter
        ? String(ctx.statusFilter)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      for (const status of statuses) {
        if (!HISTORY_STATUSES.includes(status))
          fail("USAGE", `--status must be ${HISTORY_STATUSES.join("|")} (comma-separated ok).`);
      }
      const sagaId = ctx.sagaFilter ? await resolveSagaId(full, ctx.sagaFilter) : undefined;
      const collected = [];
      let cursor;
      let pages = 0;
      let hasMore;
      for (;;) {
        const params = new URLSearchParams();
        if (statuses.length > 0) params.set("status", statuses.join(","));
        if (sagaId) params.set("sagaId", sagaId);
        if (ctx.from) params.set("startDate", ctx.from);
        if (ctx.to) params.set("endDate", ctx.to);
        if (ctx.limit) params.set("limit", String(ctx.limit));
        if (cursor) params.set("cursor", cursor);
        const suffix = params.size > 0 ? `?${params.toString()}` : "";
        const data = await readJson(
          await fetchImpl(`${ctx.base}/api/executions${suffix}`, { headers: full.headers }),
          "history",
        );
        if (!Array.isArray(data.executions)) fail("SERVER_MISMATCH", "history has no executions array.");
        collected.push(...data.executions);
        pages += 1;
        hasMore = data.hasMore === true;
        cursor = typeof data.nextCursor === "string" ? data.nextCursor : undefined;
        if (!ctx.all || !hasMore || !cursor) break;
      }
      return { executions: collected, hasMore, pages };
    }
    case "cancel": {
      const id = checkExecutionId(ctx.id);
      return readJson(
        await fetchImpl(`${ctx.base}/api/executions/${id}/cancel`, { method: "POST", headers: full.headers }),
        "execution cancel",
      );
    }
    case "audit": {
      // Cursor traversal: --all follows nextCursor while preserving the
      // active filters; otherwise one page. Loaded counts are not totals.
      if (ctx.auditOutcome !== undefined && !["success", "failure"].includes(ctx.auditOutcome)) {
        fail("USAGE", "--outcome must be success|failure.");
      }
      const collected = [];
      let cursor;
      let pages = 0;
      let hasMore;
      for (;;) {
        const params = new URLSearchParams();
        if (ctx.auditAction) params.set("action", ctx.auditAction);
        if (ctx.auditOutcome) params.set("outcome", ctx.auditOutcome);
        if (ctx.auditSearch) params.set("search", ctx.auditSearch);
        if (ctx.from) params.set("startDate", ctx.from);
        if (ctx.to) params.set("endDate", ctx.to);
        if (ctx.limit) params.set("limit", String(ctx.limit));
        if (cursor) params.set("cursor", cursor);
        const suffix = params.size > 0 ? `?${params.toString()}` : "";
        const data = await readJson(
          await fetchImpl(`${ctx.base}/api/audit${suffix}`, { headers: full.headers }),
          "audit trail",
        );
        if (!Array.isArray(data.events)) fail("SERVER_MISMATCH", "audit trail has no events array.");
        collected.push(...data.events);
        pages += 1;
        hasMore = data.hasMore === true;
        cursor = typeof data.nextCursor === "string" ? data.nextCursor : undefined;
        if (!ctx.all || !hasMore || !cursor) break;
      }
      return { events: collected, hasMore, pages };
    }
    case "notifications": {
      const params = new URLSearchParams();
      if (ctx.limit) params.set("limit", String(ctx.limit));
      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      return readJson(
        await fetchImpl(`${ctx.base}/api/notifications${suffix}`, { headers: full.headers }),
        "notifications",
      );
    }
    case "notification": {
      checkNotificationId(ctx.id);
      return readJson(
        await fetchImpl(`${ctx.base}/api/notifications/${ctx.id}`, { headers: full.headers }),
        "notification",
      );
    }
    case "dismiss-notification": {
      checkNotificationId(ctx.id);
      return readJson(
        await fetchImpl(`${ctx.base}/api/notifications/${ctx.id}`, { method: "DELETE", headers: full.headers }),
        "notification dismissal",
      );
    }
    case "artifacts": {
      const params = new URLSearchParams();
      if (ctx.limit !== undefined) params.set("limit", String(ctx.limit));
      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      return readJson(await fetchImpl(`${ctx.base}/api/artifacts${suffix}`, { headers: full.headers }), "artifacts");
    }
    case "artifact": {
      if (!ctx.artifactId || !STABLE_UUID.test(ctx.artifactId)) fail("USAGE", "artifact needs --id UUID.");
      return readJson(
        await fetchImpl(`${ctx.base}/api/artifacts/${ctx.artifactId}`, { headers: full.headers }),
        "artifact",
      );
    }
    case "upload": {
      // Bytes ride the raw body; name/mime ride the allowlisted query keys.
      if (!ctx.artifactName) fail("USAGE", "upload needs --name NAME.");
      const params = new URLSearchParams({
        name: ctx.artifactName,
        mime: ctx.artifactMime ?? "application/octet-stream",
      });
      const bytes = ctx.artifactFile ? readFileSync(ctx.artifactFile) : Buffer.from(ctx.artifactText ?? "", "utf-8");
      if (bytes.length === 0) fail("USAGE", "upload needs non-empty bytes (--file PATH or --text TEXT).");
      return readJson(
        await fetchImpl(`${ctx.base}/api/artifacts?${params.toString()}`, {
          method: "PUT",
          headers: { ...full.headers, "Content-Type": "application/octet-stream" },
          body: bytes,
        }),
        "artifact upload",
      );
    }
    case "download": {
      if (!ctx.artifactId || !STABLE_UUID.test(ctx.artifactId)) fail("USAGE", "download needs --id UUID.");
      const response = await fetchImpl(`${ctx.base}/api/artifacts/${ctx.artifactId}/download`, {
        headers: full.headers,
      });
      if (!response.ok) {
        const code = (await response.json().catch(() => ({})))?.error?.code ?? "UNKNOWN";
        fail("SERVER_REJECTED", `artifact download failed: HTTP ${response.status} ${code}.`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (ctx.artifactOut) writeFileSync(ctx.artifactOut, buffer);
      return { bytes: buffer.length, out: ctx.artifactOut ?? null };
    }
    case "rename": {
      if (!ctx.artifactId || !STABLE_UUID.test(ctx.artifactId)) fail("USAGE", "rename needs --id UUID.");
      if (!ctx.artifactName) fail("USAGE", "rename needs --name NAME.");
      return readJson(
        await fetchImpl(`${ctx.base}/api/artifacts/${ctx.artifactId}/rename`, {
          method: "POST",
          headers: full.headers,
          body: JSON.stringify({ name: ctx.artifactName }),
        }),
        "artifact rename",
      );
    }
    case "bind":
    case "unbind": {
      if (!ctx.artifactId || !STABLE_UUID.test(ctx.artifactId)) fail("USAGE", `${ctx.command} needs --id UUID.`);
      if (!ctx.bindingScope || !ctx.bindingRef) fail("USAGE", `${ctx.command} needs --scope S and --ref REF.`);
      const body = JSON.stringify({ scope: ctx.bindingScope, refId: ctx.bindingRef });
      if (ctx.command === "bind") {
        return readJson(
          await fetchImpl(`${ctx.base}/api/artifacts/${ctx.artifactId}/bindings`, {
            method: "POST",
            headers: full.headers,
            body,
          }),
          "artifact bind",
        );
      }
      return readJson(
        await fetchImpl(`${ctx.base}/api/artifacts/${ctx.artifactId}/bindings`, {
          method: "DELETE",
          headers: full.headers,
          body,
        }),
        "artifact unbind",
      );
    }
    case "bindings": {
      if (!ctx.bindingScope || !ctx.bindingRef) fail("USAGE", "bindings needs --scope S and --ref REF.");
      const params = new URLSearchParams({ scope: ctx.bindingScope, refId: ctx.bindingRef });
      return readJson(
        await fetchImpl(`${ctx.base}/api/artifacts/bindings?${params.toString()}`, { headers: full.headers }),
        "artifact bindings",
      );
    }
    case "retention": {
      if (ctx.retentionDays === undefined) {
        return readJson(await fetchImpl(`${ctx.base}/api/artifacts/retention`, { headers: full.headers }), "retention");
      }
      return readJson(
        await fetchImpl(`${ctx.base}/api/artifacts/retention`, {
          method: "PUT",
          headers: { ...full.headers },
          body: JSON.stringify({ maxAgeDays: ctx.retentionDays }),
        }),
        "retention set",
      );
    }
    case "cleanup": {
      if (!ctx.cleanupRun) {
        return readJson(
          await fetchImpl(`${ctx.base}/api/artifacts/cleanup/preview`, { headers: full.headers }),
          "cleanup preview",
        );
      }
      return readJson(
        await fetchImpl(`${ctx.base}/api/artifacts/cleanup/run`, {
          method: "POST",
          headers: { ...full.headers },
        }),
        "cleanup run",
      );
    }
    case "orgs": {
      return readJson(await fetchImpl(`${ctx.base}/api/orgs`, { headers: full.headers }), "org list");
    }
    case "org-create": {
      if (!ctx.name) fail("USAGE", "org-create needs --name NAME.");
      return readJson(
        await fetchImpl(`${ctx.base}/api/orgs`, {
          method: "POST",
          headers: full.headers,
          body: JSON.stringify({ name: ctx.name }),
        }),
        "org create",
      );
    }
    case "org-disable":
    case "org-enable": {
      const id = checkOrgId(ctx.id);
      const action = ctx.command === "org-disable" ? "disable" : "enable";
      return readJson(
        await fetchImpl(`${ctx.base}/api/orgs/${id}/${action}`, { method: "POST", headers: full.headers }),
        `org ${action}`,
      );
    }
    case "org-delete-preview": {
      const id = checkOrgId(ctx.id);
      return readJson(
        await fetchImpl(`${ctx.base}/api/orgs/${id}/delete-preview`, { headers: full.headers }),
        "delete preview",
      );
    }
    case "org-delete": {
      const id = checkOrgId(ctx.id);
      return readJson(
        await fetchImpl(`${ctx.base}/api/orgs/${id}`, { method: "DELETE", headers: full.headers }),
        "org delete",
      );
    }
    case "members": {
      const id = checkOrgId(ctx.id);
      return readJson(await fetchImpl(`${ctx.base}/api/orgs/${id}/members`, { headers: full.headers }), "members");
    }
    case "invite": {
      const id = checkOrgId(ctx.id);
      if (!ctx.user) fail("USAGE", "invite needs --user ID.");
      return readJson(
        await fetchImpl(`${ctx.base}/api/orgs/${id}/members`, {
          method: "POST",
          headers: full.headers,
          body: JSON.stringify({ userId: ctx.user, role: ctx.role ?? "member", kind: ctx.kind ?? "ordinary" }),
        }),
        "invite",
      );
    }
    case "member-update": {
      const id = checkOrgId(ctx.id);
      if (!ctx.user) fail("USAGE", "member-update needs --user ID.");
      const update = {};
      if (ctx.role !== undefined) update.role = ctx.role;
      if (ctx.memberStatus !== undefined) update.status = ctx.memberStatus;
      if (ctx.kind !== undefined) update.kind = ctx.kind;
      if (Object.keys(update).length === 0) fail("USAGE", "member-update needs --role/--status/--kind.");
      return readJson(
        await fetchImpl(`${ctx.base}/api/orgs/${id}/members/${encodeURIComponent(ctx.user)}`, {
          method: "PATCH",
          headers: full.headers,
          body: JSON.stringify(update),
        }),
        "member update",
      );
    }
    case "user-disable":
    case "user-enable": {
      if (!ctx.user) fail("USAGE", "user-disable/enable needs --user ID.");
      const action = ctx.command === "user-disable" ? "disable" : "enable";
      return readJson(
        await fetchImpl(`${ctx.base}/api/users/${encodeURIComponent(ctx.user)}/${action}`, {
          method: "POST",
          headers: full.headers,
        }),
        `user ${action}`,
      );
    }
    case "org-executions": {
      const id = checkOrgId(ctx.id);
      const params = new URLSearchParams();
      if (ctx.statusFilter) params.set("status", ctx.statusFilter);
      if (ctx.limit) params.set("limit", String(ctx.limit));
      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      return readJson(
        await fetchImpl(`${ctx.base}/api/orgs/${id}/executions${suffix}`, { headers: full.headers }),
        "org executions",
      );
    }
    case "configs": {
      const data = await readJson(await fetchImpl(`${ctx.base}/api/config`, { headers: full.headers }), "config list");
      if (!Array.isArray(data.configs)) fail("SERVER_MISMATCH", "config list has no configs array.");
      return data;
    }
    case "config-set": {
      if (!ctx.configKey) fail("USAGE", "config-set needs --key NAME.");
      if (!ctx.configType) fail("USAGE", "config-set needs --type string|int|bool|json|secret.");
      return readJson(
        await fetchImpl(`${ctx.base}/api/config`, {
          method: "POST",
          headers: full.headers,
          body: JSON.stringify({
            key: ctx.configKey,
            type: ctx.configType,
            ...(ctx.configValue === undefined ? {} : { value: readConfigValue(ctx) }),
            ...(ctx.configDescription === undefined ? {} : { description: ctx.configDescription }),
          }),
        }),
        "config set",
      );
    }
    case "config-update": {
      const id = checkConfigId(ctx.id);
      const update = {};
      if (ctx.configKey !== undefined) update.key = ctx.configKey;
      if (ctx.configType !== undefined) update.type = ctx.configType;
      if (ctx.configValue !== undefined) update.value = readConfigValue(ctx);
      if (ctx.configDescription !== undefined) update.description = ctx.configDescription;
      if (Object.keys(update).length === 0) fail("USAGE", "config-update needs --key/--type/--value/--description.");
      return readJson(
        await fetchImpl(`${ctx.base}/api/config/${id}`, {
          method: "PUT",
          headers: full.headers,
          body: JSON.stringify(update),
        }),
        "config update",
      );
    }
    case "config-delete": {
      const id = checkConfigId(ctx.id);
      return readJson(
        await fetchImpl(`${ctx.base}/api/config/${id}`, { method: "DELETE", headers: full.headers }),
        "config delete",
      );
    }
    default:
      fail("USAGE", `unknown command ${JSON.stringify(ctx.command ?? "")}. See --help.`);
      return undefined;
  }
}

async function main() {
  if (flag("help") || process.argv[2] === "help" || !process.argv[2]) {
    console.log(HELP);
    return;
  }
  if (process.argv[2] === "selftest") {
    await selftest();
    return;
  }
  if (arg("org") !== undefined) {
    fail("ORG_RESERVED", "--org is reserved for future multi-tenancy; organization comes from the auth context.");
  }
  const parsed = parseContext();
  if (!/^https?:\/\//.test(parsed.base)) fail("USAGE", "--base must be an http(s) URL.");
  const limit = arg("limit");
  const limitMax = parsed.command === "notifications" ? 100 : 50;
  if (limit !== undefined && (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > limitMax)) {
    fail("USAGE", `--limit must be an integer from 1 to ${limitMax}.`);
  }
  const command = parsed.command;
  const orgCommands = new Set([
    "org-disable",
    "org-enable",
    "org-delete-preview",
    "org-delete",
    "members",
    "invite",
    "member-update",
    "org-executions",
  ]);
  const userCommands = new Set(["user-disable", "user-enable"]);
  const ctx = {
    command,
    token: command === "scaffold" ? "" : authToken(),
    base: baseUrl(),
    json: parsed.json,
    timeoutMs: Number(arg("timeout-ms", "120000")),
    pollMs: Number(arg("poll-ms", "2000")),
    // Per-command arguments; each command reads only its own.
    saga: command === "submit" || command === "inspect" || command === "preview" ? arg("saga") : undefined,
    checkEnv: command === "preview" ? flag("check-env") : false,
    scaffoldName: command === "scaffold" ? arg("name") : undefined,
    scaffoldId: command === "scaffold" ? arg("id") : undefined,
    scaffoldDescription: command === "scaffold" ? arg("description") : undefined,
    scaffoldRevision: command === "scaffold" ? arg("revision") : undefined,
    sagaFilter: command === "history" || command === "org-executions" ? arg("saga") : undefined,
    id:
      command === "detail" ||
      command === "cancel" ||
      command === "diagnose" ||
      command === "notification" ||
      command === "dismiss-notification" ||
      orgCommands.has(command)
        ? arg("id")
        : undefined,
    key: command === "submit" ? arg("key") : undefined,
    input: command === "submit" || command === "preview" ? readInput() : undefined,
    statusFilter: command === "history" || command === "org-executions" ? arg("status") : undefined,
    auditAction: command === "audit" ? arg("action") : undefined,
    auditOutcome: command === "audit" ? arg("outcome") : undefined,
    auditSearch: command === "audit" ? arg("search") : undefined,
    limit: limit === undefined ? undefined : Number(limit),
    from: command === "history" || command === "audit" ? arg("from") : undefined,
    to: command === "history" || command === "audit" ? arg("to") : undefined,
    all: command === "history" || command === "audit" ? flag("all") : false,
    wait: command === "submit" ? !flag("no-wait") : flag("wait"),
    artifactId:
      command === "artifact" ||
      command === "download" ||
      command === "rename" ||
      command === "bind" ||
      command === "unbind"
        ? arg("id")
        : undefined,
    artifactName: command === "upload" || command === "rename" ? arg("name") : undefined,
    artifactMime: command === "upload" ? arg("mime") : undefined,
    artifactFile: command === "upload" ? arg("file") : undefined,
    artifactText: command === "upload" ? arg("text") : undefined,
    artifactOut: command === "download" ? arg("out") : undefined,
    bindingScope: command === "bind" || command === "unbind" || command === "bindings" ? arg("scope") : undefined,
    bindingRef: command === "bind" || command === "unbind" || command === "bindings" ? arg("ref") : undefined,
    retentionDays: command === "retention" && arg("days") !== undefined ? Number(arg("days")) : undefined,
    cleanupRun: command === "cleanup" ? flag("run") : false,
    name: command === "org-create" ? arg("name") : undefined,
    user: command === "invite" || command === "member-update" || userCommands.has(command) ? arg("user") : undefined,
    role: command === "invite" || command === "member-update" ? arg("role") : undefined,
    memberStatus: command === "member-update" ? arg("status") : undefined,
    kind: command === "invite" || command === "member-update" ? arg("kind") : undefined,
  };
  const result = await runCommand(ctx).catch((error) => {
    if (error instanceof Error && error.message.startsWith("WRANGNAROK_CLI")) throw error;
    fail("NETWORK", `request failed: ${error instanceof Error ? error.message : error}`);
  });
  if (command === "sagas") printSagas(result.sagas);
  else if (command === "inspect") printInspect(result.saga);
  else if (command === "diagnose") printDiagnosis(result.diagnosis);
  else if (command === "scaffold") {
    if (parsed.json) console.log(JSON.stringify(result));
    else {
      console.log(`scaffolded ${result.scaffold.path}`);
      for (const step of result.scaffold.next) console.log(`next: ${step}`);
    }
  } else if (command === "history") printHistory(result.executions, result.hasMore, { pages: result.pages ?? 1 });
  else if (command === "audit") printAudit(result.events, result.hasMore, { pages: result.pages ?? 1 });
  else if (command === "notifications") printNotifications(result.notifications ?? []);
  else if (command === "notification") printNotification(result.notification);
  else if (command === "dismiss-notification") {
    if (parsed.json) console.log(JSON.stringify(result));
    else console.log("dismissed");
  } else if (command === "org-executions" && Array.isArray(result.executions))
    printHistory(result.executions, result.hasMore);
  else if (command === "orgs" && Array.isArray(result.orgs)) {
    if (asJson()) console.log(JSON.stringify(result));
    else for (const org of result.orgs) console.log(`${org.name}\t${org.id}\t${org.status}`);
    return;
  } else if (command === "members" && Array.isArray(result.members)) {
    if (asJson()) console.log(JSON.stringify(result));
    else for (const m of result.members) console.log(`${m.userId}\t${m.role}\t${m.status}\t${m.kind}`);
    return;
  } else if (command === "configs" && Array.isArray(result.configs)) {
    if (asJson()) console.log(JSON.stringify(result));
    else
      for (const c of result.configs)
        console.log(`${c.key}\t${c.type}\t${JSON.stringify(c.value)}\t${c.managedBy ?? "loose"}`);
    return;
  } else if ((command === "config-set" || command === "config-update") && result.config) {
    if (asJson()) console.log(JSON.stringify(result));
    else {
      const c = result.config;
      console.log(`${c.key}\t${c.type}\t${JSON.stringify(c.value)}`);
    }
    return;
  } else if (command === "config-delete") {
    if (asJson()) console.log(JSON.stringify(result));
    else console.log("deleted");
    return;
  } else if (command === "detail") printDetail(result);
  else if (command === "cancel") printCancel(result);
  else if (command === "artifacts") printArtifacts(result.artifacts, result.hasMore);
  else if (command === "artifact") printArtifact(result.artifact);
  else if (command === "upload") printArtifact(result.artifact);
  else if (command === "download") printDownload(result);
  else if (command === "rename") printArtifact(result.artifact);
  else if (command === "bind") printBinding(result.binding);
  else if (command === "unbind") printUnbound();
  else if (command === "bindings") printBindings(result.bindings);
  else if (command === "retention") printRetention(result.retention);
  else if (command === "cleanup") printCleanup(result.cleanup);
  else if (parsed.json) console.log(JSON.stringify(result));
  else if (typeof result.status === "string") console.log(`${result.executionId} ${result.status}`);
  else console.log(`${result.executionId} accepted (replayed: ${result.replayed === true})`);
}

function stubFetch(scenarios) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const next = scenarios.shift();
      if (!next) throw new Error(`Unexpected fetch: ${url}`);
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

async function selftest() {
  let passed = 0;
  const check = (name, cond) => {
    if (!cond) throw new Error(`selftest failed: ${name}`);
    passed += 1;
  };
  const base = { command: "", base: "http://local.test", token: "tok", timeoutMs: 1000, pollMs: 0, json: false };
  const noSleep = { sleep: async () => {} };

  // sagas list passes through.
  {
    const stub = stubFetch([jsonResponse({ sagas: [{ id: "u", name: "echo", revision: "echo-v1" }] })]);
    const result = await runCommand({ ...base, command: "sagas" }, { fetchImpl: stub.fetch, ...noSleep });
    check("sagas", result.sagas.length === 1 && stub.calls[0].url === "http://local.test/api/sagas");
  }

  // submit resolves a Saga name, sends a key, and polls to terminal.
  {
    const id = "a".repeat(64);
    const stub = stubFetch([
      jsonResponse({ sagas: [{ id: "saga-uuid", name: "echo", revision: "echo-v1" }] }),
      jsonResponse({ executionId: id, replayed: false }, 202),
      jsonResponse({ executionId: id, status: "Running" }),
      jsonResponse({ executionId: id, status: "Succeeded" }),
    ]);
    const result = await runCommand(
      { ...base, command: "submit", saga: "echo", input: {}, key: "laneC-selftest-001", wait: true },
      { fetchImpl: stub.fetch, ...noSleep },
    );
    check("submit terminal", result.status === "Succeeded");
    check("submit key", stub.calls[1].init.headers["Idempotency-Key"] === "laneC-selftest-001");
  }

  // history forwards allowlisted filters only.
  {
    const stub = stubFetch([jsonResponse({ executions: [], hasMore: false, nextCursor: null })]);
    await runCommand(
      { ...base, command: "history", statusFilter: "Failed", limit: 5 },
      { fetchImpl: stub.fetch, ...noSleep },
    );
    check("history query", stub.calls[0].url === "http://local.test/api/executions?status=Failed&limit=5");
  }

  // history --all follows cursors with filters preserved.
  {
    const stub = stubFetch([
      jsonResponse({ executions: [{ executionId: "a" }], hasMore: true, nextCursor: "cursor-2" }),
      jsonResponse({ executions: [{ executionId: "b" }], hasMore: false, nextCursor: null }),
    ]);
    const result = await runCommand(
      {
        ...base,
        command: "history",
        statusFilter: "Failed,TimedOut",
        from: "2026-09-01",
        to: "2026-09-10",
        limit: 1,
        all: true,
      },
      { fetchImpl: stub.fetch, ...noSleep },
    );
    check("history traversal", result.executions.length === 2 && result.pages === 2 && result.hasMore === false);
    check(
      "history cursor keeps filters",
      stub.calls[1].url.includes("status=Failed%2CTimedOut") &&
        stub.calls[1].url.includes("startDate=2026-09-01") &&
        stub.calls[1].url.includes("cursor=cursor-2"),
    );
  }

  // history rejects unknown statuses before any fetch.
  {
    const stub = stubFetch([]);
    let error = null;
    const exit = process.exit;
    process.exit = (code) => {
      throw new Error(`exit:${code}`);
    };
    try {
      await runCommand({ ...base, command: "history", statusFilter: "Bogus" }, { fetchImpl: stub.fetch, ...noSleep });
    } catch (e) {
      error = e;
    } finally {
      process.exit = exit;
    }
    check("history status gate", /exit:2/.test(String(error)) && stub.calls.length === 0);
  }

  // cancel refuses ambiguous IDs.
  {
    const stub = stubFetch([]);
    let error = null;
    const exit = process.exit;
    process.exit = (code) => {
      throw new Error(`exit:${code}`);
    };
    try {
      await runCommand({ ...base, command: "cancel", id: "abc" }, { fetchImpl: stub.fetch, ...noSleep });
    } catch (e) {
      error = e;
    } finally {
      process.exit = exit;
    }
    check("cancel exact id", /exit:2/.test(String(error)) && stub.calls.length === 0);
  }

  // cancel success passes the terminal marker through.
  {
    const id = "d".repeat(64);
    const stub = stubFetch([jsonResponse({ executionId: id, status: "Cancelled", cancelled: true })]);
    const result = await runCommand({ ...base, command: "cancel", id }, { fetchImpl: stub.fetch, ...noSleep });
    check("cancel success", result.status === "Cancelled");
    check("cancel exact url", stub.calls[0].url === `http://local.test/api/executions/${id}/cancel`);
  }

  // org admin surface hits the exact routes with exact IDs.
  {
    const orgId = "aaaaaaaa-1111-4111-8111-111111111111";
    const stub = stubFetch([
      jsonResponse({ orgs: [{ id: orgId, name: "acme", status: "active" }] }),
      jsonResponse({ id: orgId, name: "acme", status: "disabled" }),
      jsonResponse({ members: [{ userId: "sam@example.com", role: "member", status: "invited", kind: "ordinary" }] }),
      jsonResponse({ userId: "sam@example.com", role: "member", status: "invited", kind: "ordinary" }, 201),
      jsonResponse({ executions: [], hasMore: false }),
    ]);
    const orgs = await runCommand({ ...base, command: "orgs" }, { fetchImpl: stub.fetch, ...noSleep });
    check("orgs list", orgs.orgs.length === 1 && stub.calls[0].url === "http://local.test/api/orgs");
    await runCommand({ ...base, command: "org-disable", id: orgId }, { fetchImpl: stub.fetch, ...noSleep });
    check("org disable", stub.calls[1].url === `http://local.test/api/orgs/${orgId}/disable`);
    await runCommand({ ...base, command: "members", id: orgId }, { fetchImpl: stub.fetch, ...noSleep });
    check("members list", stub.calls[2].url === `http://local.test/api/orgs/${orgId}/members`);
    await runCommand(
      { ...base, command: "invite", id: orgId, user: "sam@example.com", role: "member", kind: "ordinary" },
      { fetchImpl: stub.fetch, ...noSleep },
    );
    check("invite posts", stub.calls[3].url === `http://local.test/api/orgs/${orgId}/members`);
    await runCommand(
      { ...base, command: "org-executions", id: orgId, statusFilter: "Running", limit: 5 },
      { fetchImpl: stub.fetch, ...noSleep },
    );
    check(
      "org executions query",
      stub.calls[4].url === `http://local.test/api/orgs/${orgId}/executions?status=Running&limit=5`,
    );
  }

  // inspect resolves a Saga by exact name and returns its metadata.
  {
    const stub = stubFetch([
      jsonResponse({
        sagas: [
          {
            id: "395e15f0-3627-41f6-8922-008ce37e3b35",
            name: "hello",
            revision: "hello-v1",
            description: "hi",
            requiredIntegrations: [],
          },
        ],
      }),
    ]);
    const result = await runCommand(
      { ...base, command: "inspect", saga: "hello" },
      { fetchImpl: stub.fetch, ...noSleep },
    );
    check("inspect name", result.saga.name === "hello");
  }

  // inspect by stable UUID; unknown names fail with SDK_SAGA_NOT_FOUND.
  {
    const stub = stubFetch([
      jsonResponse({ sagas: [{ id: "395e15f0-3627-41f6-8922-008ce37e3b35", name: "hello", revision: "hello-v1" }] }),
    ]);
    const result = await runCommand(
      { ...base, command: "inspect", saga: "395e15f0-3627-41f6-8922-008ce37e3b35" },
      { fetchImpl: stub.fetch, ...noSleep },
    );
    check("inspect uuid", result.saga.revision === "hello-v1");
    const empty = stubFetch([jsonResponse({ sagas: [] })]);
    let error = null;
    const exit = process.exit;
    const errlines = [];
    const err = console.error;
    console.error = (line) => errlines.push(String(line));
    process.exit = (code) => {
      throw new Error(`exit:${code}`);
    };
    try {
      await runCommand({ ...base, command: "inspect", saga: "missing" }, { fetchImpl: empty.fetch, ...noSleep });
    } catch (e) {
      error = e;
    } finally {
      process.exit = exit;
      console.error = err;
    }
    check(
      "inspect unknown",
      /exit:1/.test(String(error)) && errlines.some((line) => line.includes("SDK_SAGA_NOT_FOUND")),
    );
  }

  // scaffold is offline: no fetch, template carries the determinism markers.
  {
    const stub = stubFetch([]);
    const result = await runCommand(
      {
        ...base,
        command: "scaffold",
        scaffoldName: "fresh",
        scaffoldId: "395e15f0-3627-41f6-8922-008ce37e3b97",
        scaffoldDescription: "Fresh scaffold.",
        scaffoldRevision: "fresh-v1",
      },
      { fetchImpl: stub.fetch, ...noSleep },
    );
    check("scaffold path", result.scaffold.path === "src/sagas/fresh.ts");
    for (const marker of ["defineSaga", "requiredIntegrations", 'step.do("prepare-input-v1"']) {
      check(`scaffold marker ${marker}`, result.scaffold.content.includes(marker));
    }
    check("scaffold offline", stub.calls.length === 0);
  }

  // diagnose returns the detail plus a hint for known failure codes.
  {
    const id = "e".repeat(64);
    const stub = stubFetch([
      jsonResponse({
        executionId: id,
        status: "Failed",
        sagaName: "hello",
        operations: [{ name: "prepare-input-v1", status: "Succeeded" }],
        result: null,
        error: { code: "NINJA_UNAUTHORIZED", message: "rejected" },
      }),
    ]);
    const result = await runCommand({ ...base, command: "diagnose", id }, { fetchImpl: stub.fetch, ...noSleep });
    check("diagnose hint", typeof result.diagnosis.hint === "string" && result.diagnosis.hint.includes("credentials"));
  }

  // contract fetches the versioned SDK descriptor.
  {
    const stub = stubFetch([jsonResponse({ contract: "wrangnarok.sdk", version: "1" })]);
    const result = await runCommand({ ...base, command: "contract" }, { fetchImpl: stub.fetch, ...noSleep });
    check("contract version", result.version === "1");
    check("contract url", stub.calls[0].url === "http://local.test/api/sdk");
  }

  // artifacts list forwards the limit filter only.
  {
    const stub = stubFetch([jsonResponse({ artifacts: [], hasMore: false })]);
    const result = await runCommand({ ...base, command: "artifacts", limit: 5 }, { fetchImpl: stub.fetch, ...noSleep });
    check("artifacts query", stub.calls[0].url === "http://local.test/api/artifacts?limit=5");
    check("artifacts empty", result.artifacts.length === 0 && result.hasMore === false);
  }

  // upload sends octet-stream bytes with name/mime query keys.
  {
    const id = "11111111-1111-4111-8111-111111111111";
    const stub = stubFetch([jsonResponse({ artifact: { id, name: "n.md", version: 1, status: "active" } }, 201)]);
    const result = await runCommand(
      { ...base, command: "upload", artifactName: "n.md", artifactMime: "text/markdown", artifactText: "hi" },
      { fetchImpl: stub.fetch, ...noSleep },
    );
    check("upload url", stub.calls[0].url === "http://local.test/api/artifacts?name=n.md&mime=text%2Fmarkdown");
    check("upload bytes", stub.calls[0].init.headers["Content-Type"] === "application/octet-stream");
    check("upload result", result.artifact.id === id);
  }

  // retention reads by default and sets with --days; cleanup previews and runs.
  {
    const stub = stubFetch([jsonResponse({ retention: { maxAgeDays: 90 } })]);
    const result = await runCommand({ ...base, command: "retention" }, { fetchImpl: stub.fetch, ...noSleep });
    check("retention read", result.retention.maxAgeDays === 90);
    const setStub = stubFetch([jsonResponse({ retention: { maxAgeDays: 7 } })]);
    await runCommand({ ...base, command: "retention", retentionDays: 7 }, { fetchImpl: setStub.fetch, ...noSleep });
    check("retention set url", setStub.calls[0].url === "http://local.test/api/artifacts/retention");
    const previewStub = stubFetch([jsonResponse({ cleanup: { deleted: [], failed: [], remaining: 0 } })]);
    await runCommand({ ...base, command: "cleanup" }, { fetchImpl: previewStub.fetch, ...noSleep });
    check("cleanup preview url", previewStub.calls[0].url === "http://local.test/api/artifacts/cleanup/preview");
    const runStub = stubFetch([jsonResponse({ cleanup: { deleted: [], failed: [], remaining: 0 } })]);
    await runCommand(
      { ...base, command: "cleanup", cleanupRun: true, admin: true },
      { fetchImpl: runStub.fetch, ...noSleep },
    );
    check("cleanup run url", runStub.calls[0].url === "http://local.test/api/artifacts/cleanup/run");
  }

  // preview resolves the Saga name, posts the parsed input, and returns the
  // read-only receipt untouched. --check-env opts into the read-only check.
  {
    const uuid = "395e15f0-3627-41f6-8922-008ce37e3b35";
    const body = {
      preview: {
        saga: { id: uuid, name: "hello", revision: "hello-v1" },
        input: { name: "Ada" },
        environmentChecked: false,
        environment: [],
        persisted: false,
        dispatched: false,
      },
    };
    const stub = stubFetch([
      jsonResponse({ sagas: [{ id: uuid, name: "hello", revision: "hello-v1" }] }),
      jsonResponse(body),
    ]);
    const result = await runCommand(
      { ...base, command: "preview", saga: "hello", input: { name: "Ada" }, checkEnv: false },
      { fetchImpl: stub.fetch, ...noSleep },
    );
    check("preview read-only", result.preview.persisted === false && result.preview.dispatched === false);
    check("preview url", stub.calls[1].url === "http://local.test/api/dev/preview");
    check("preview opt-in off by default", !JSON.parse(stub.calls[1].init.body).checkEnvironment);
    const envStub = stubFetch([
      jsonResponse({ sagas: [{ id: uuid, name: "hello", revision: "hello-v1" }] }),
      jsonResponse(body),
    ]);
    await runCommand(
      { ...base, command: "preview", saga: uuid, input: {}, checkEnv: true },
      { fetchImpl: envStub.fetch, ...noSleep },
    );
    check("preview check-env opts in", JSON.parse(envStub.calls[0].init.body).checkEnvironment === true);
  }

  // server mismatch is loud.
  {
    const stub = stubFetch([new Response("not json", { status: 200 })]);
    let error = null;
    const exit = process.exit;
    const errlines = [];
    const err = console.error;
    console.error = (line) => errlines.push(String(line));
    process.exit = (code) => {
      throw new Error(`exit:${code}`);
    };
    try {
      await runCommand({ ...base, command: "sagas" }, { fetchImpl: stub.fetch, ...noSleep });
    } catch (e) {
      error = e;
    } finally {
      process.exit = exit;
      console.error = err;
    }
    check("mismatch loud", /exit:1/.test(String(error)) && errlines.some((line) => line.includes("SERVER_MISMATCH")));
  }

  // audit forwards allowlisted filters and follows cursors with --all.
  {
    const stub = stubFetch([
      jsonResponse({ events: [{ id: "e1" }], hasMore: true, nextCursor: "cursor-2" }),
      jsonResponse({ events: [{ id: "e2" }], hasMore: false, nextCursor: null }),
    ]);
    const result = await runCommand(
      {
        ...base,
        command: "audit",
        auditAction: "app.",
        auditOutcome: "success",
        auditSearch: "storefront",
        from: "2026-09-01",
        to: "2026-09-10",
        limit: 1,
        all: true,
      },
      { fetchImpl: stub.fetch, ...noSleep },
    );
    check("audit traversal", result.events.length === 2 && result.pages === 2 && result.hasMore === false);
    check(
      "audit cursor keeps filters",
      stub.calls[0].url.includes("action=app.") &&
        stub.calls[1].url.includes("outcome=success") &&
        stub.calls[1].url.includes("search=storefront") &&
        stub.calls[1].url.includes("cursor=cursor-2"),
    );
  }

  // audit rejects bad outcomes before any fetch.
  {
    const stub = stubFetch([]);
    let error = null;
    const exit = process.exit;
    process.exit = (code) => {
      throw new Error(`exit:${code}`);
    };
    try {
      await runCommand({ ...base, command: "audit", auditOutcome: "Bogus" }, { fetchImpl: stub.fetch, ...noSleep });
    } catch (e) {
      error = e;
    } finally {
      process.exit = exit;
    }
    check("audit outcome gate", /exit:2/.test(String(error)) && stub.calls.length === 0);
  }

  // notifications list passes the limit through; fetch and dismiss use exact UUIDs.
  {
    const stub = stubFetch([jsonResponse({ notifications: [] })]);
    await runCommand({ ...base, command: "notifications", limit: 5 }, { fetchImpl: stub.fetch, ...noSleep });
    check("notifications query", stub.calls[0].url === "http://local.test/api/notifications?limit=5");
    const one = stubFetch([jsonResponse({ notification: { id: "11111111-1111-4111-8111-111111111111" } })]);
    await runCommand(
      { ...base, command: "notification", id: "11111111-1111-4111-8111-111111111111" },
      { fetchImpl: one.fetch, ...noSleep },
    );
    check(
      "notification exact url",
      one.calls[0].url === "http://local.test/api/notifications/11111111-1111-4111-8111-111111111111",
    );
    const gone = stubFetch([jsonResponse({ dismissed: true })]);
    await runCommand(
      { ...base, command: "dismiss-notification", id: "11111111-1111-4111-8111-111111111111" },
      { fetchImpl: gone.fetch, ...noSleep },
    );
    check("dismiss exact url", gone.calls[0].init.method === "DELETE");
    const bad = stubFetch([]);
    let error = null;
    const exit = process.exit;
    process.exit = (code) => {
      throw new Error(`exit:${code}`);
    };
    try {
      await runCommand({ ...base, command: "dismiss-notification", id: "abc" }, { fetchImpl: bad.fetch, ...noSleep });
    } catch (e) {
      error = e;
    } finally {
      process.exit = exit;
    }
    check("dismiss exact id", /exit:2/.test(String(error)) && bad.calls.length === 0);
  }

  console.log(`wrangnarok cli selftest: ${passed} passed.`);
}

const invokedAsCli = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
if (invokedAsCli) {
  try {
    await main();
  } catch (error) {
    console.error(`WRANGNAROK_CLI FAILED: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
