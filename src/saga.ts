// SPDX-License-Identifier: AGPL-3.0
// Saga authoring contract (ADR 002, Accepted per issue #57).
//
// A Saga is a static, Git-owned TypeScript definition built with defineSaga.
// Its run(ctx, step) body mirrors the native WorkflowEntrypoint run(event, step)
// shape: ctx is the validated event context (execution identity plus
// Integration/D1/secret handles), step is the durable Operation API.
//
// Determinism rules (enforced by test/saga-contract.test.ts, not by types):
// - ALL I/O and nondeterminism MUST live inside step.do() callbacks.
// - ctx.integrations / ctx.db / ctx.secrets / ctx.config MUST ONLY be touched inside step.do().
// - run bodies MUST NOT call fetch, Date.now/new Date, Math.random,
//   randomUUID, AbortSignal, or crypto at the top level.
// - input/output MUST be JSON-serializable (assertJsonSerializable).
//
// Retry limits and step timeouts are NOT Saga source policy: the thin adapter
// (bindSagaStep, below) resolves every step.do through the stepRetryLimit table
// in src/domain.ts with a fixed platform timeout. Saga source carries identity
// and discovery metadata only — never timeouts, retries, or schedules.
import type { WorkflowSleepDuration, WorkflowStep } from "cloudflare:workers";
import { checkpointRetryLimit, stepRetryLimit, UUID, vendorRetryLimit } from "./domain";
import type { EchoInput, NinjaOrgsResult, SagaRuntimePolicy } from "./domain";
import type { EchoConnection } from "./integrations/echo";
import type { NinjaConnection, NinjaSecrets } from "./integrations/ninjaone";

/** Durable Operation API surfaced to Saga authors. Deliberately smaller than
 * the native WorkflowStep: do() for retry-unit work, sleep() for explicit
 * waits. Retry limits and timeouts are resolved by the adapter, never by Saga
 * source. sleepUntil/waitForEvent are not part of this contract. */
export interface SagaStep {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: string): Promise<void>;
}

/** Typed Integration handles. Implementations are bound by the adapter to the
 * real Integration Actions in src/integrations/*. Calling them outside
 * step.do() is a determinism violation and fails the contract test. */
export interface EchoIntegrationHandle {
  echo(connection: EchoConnection, input: EchoInput, operationId: string, timeoutMs?: number): Promise<EchoInput>;
}
export interface NinjaOneIntegrationHandle {
  listOrganizations(
    connection: NinjaConnection,
    secrets: NinjaSecrets,
    executionId?: string,
    timeoutMs?: number,
  ): Promise<NinjaOrgsResult>;
}
export interface SagaIntegrations {
  readonly echo: EchoIntegrationHandle;
  readonly ninjaone: NinjaOneIntegrationHandle;
}

/** Organization-scoped secret handles for the current Execution. Read from the
 * Worker environment by the adapter (never from D1, never from client input)
 * and usable ONLY inside step.do() callbacks. */
export interface SagaSecrets {
  readonly clientId?: string;
  readonly clientSecret?: string;
}

/** Organization context for one Execution (ADR 010 section 1, Phase 1b).
 * Built inside prepare-input-v1 from the immutable D1 Execution row — never
 * from client-supplied context, and never from Workflow params (which carry
 * only { executionId }). attemptToken is the dispatch epoch
 * `${executionId}:${dispatched}`; with one dispatch per deterministic ID
 * there is exactly one epoch, so the status-fenced conditional writes in
 * failExecution/cancelExecution are the stale-token rejection mechanism
 * (late, post-terminal, and post-cancel callbacks match no row and no-op).
 * A fresh per-dispatch nonce column is deferred until a demonstrated
 * ambiguous-dispatch case needs it. */
export interface OrgCtx {
  readonly orgId: string;
  readonly userId: string;
  readonly executionId: string;
  readonly sagaId: string;
  readonly sagaRevision: string;
  readonly operationId?: string;
  readonly attemptToken: string;
}

/** Minimal D1 Execution row shape needed to build an OrgCtx. */
export interface OrgCtxRow {
  readonly id: string;
  readonly org_id: string;
  readonly user_id: string;
  readonly saga_id: string;
  readonly saga_revision: string;
  readonly dispatched: number;
}

export function buildOrgCtx(row: OrgCtxRow, operationId?: string): OrgCtx {
  return Object.freeze({
    orgId: row.org_id,
    userId: row.user_id,
    executionId: row.id,
    sagaId: row.saga_id,
    sagaRevision: row.saga_revision,
    ...(operationId === undefined ? {} : { operationId }),
    attemptToken: `${row.id}:${row.dispatched}`,
  });
}

/** Narrow an OrgCtx to one durable step. Vendor steps resolve Connections
 * and derive stable outbound operation IDs through their own step ctx, so
 * the operationId always names the step doing the work — never the prepare
 * step that built the base ctx. Pure copy; the epoch and identity survive. */
export function withOperation(org: OrgCtx, operationId: string): OrgCtx {
  return Object.freeze({ ...org, operationId });
}

/** Organization-scoped config reads for the current Execution. Resolves
 * typed rows for this Execution's Organization only (ADR 020) and is usable
 * ONLY inside step.do() callbacks, like ctx.integrations/ctx.db/ctx.secrets. */
export interface SagaConfig {
  /** Read one key: declared-but-missing without a default fails loud with
   * CONFIG_REQUIREMENT_UNSATISFIED; undeclared access resolves to the
   * default (null when none is given) and never throws. */
  get(key: string, defaultValue?: unknown): Promise<unknown>;
  /** Read one declared key, failing loud when it is missing or unprovisioned. */
  require(key: string): Promise<unknown>;
}

/** Validated event context for one Saga execution. executionId is the
 * deterministic D1/Workflow identity, checked against the native instance ID
 * by the adapter. Organization context is NOT carried here: each Saga builds
 * its OrgCtx from the immutable D1 Execution row inside prepare-input-v1
 * (Phase 1b, ADR 010) and threads it through Connection resolution and
 * terminal checkpoints — never from caller-supplied org. */
export interface SagaEventContext {
  readonly executionId: string;
  readonly integrations: SagaIntegrations;
  readonly db: D1Database;
  readonly secrets: SagaSecrets;
  readonly config: SagaConfig;
}

/** Minimal object-schema descriptor, hand-derived from the TypeScript
 * input/output types (no codegen dependency: zod/valibot would add Worker
 * bundle weight for metadata alone). Revisit if schema drift ever bites. */
export interface IoSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, { readonly type: string }>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

export type SagaRun<TOutput> = (ctx: SagaEventContext, step: SagaStep) => Promise<TOutput>;

/** Static Saga definition. Identity/discovery metadata only: id, name,
 * revision, description, optional category/tags and IO schemas, the declared
 * Integration requirement list, plus parse and run. Any operational-policy
 * key (timeouts, retries, schedules, endpoints, access rules) is rejected by
 * validateSagaDefinition. */
export interface SagaDefinition<TOutput = unknown> {
  readonly id: string;
  readonly name: string;
  readonly revision: string;
  readonly description: string;
  readonly category?: string;
  readonly tags?: readonly string[];
  /** Stable Integration IDs this Saga requires in its Organization context
   * (ADR 010 section 3, Phase 1b). A declared-but-missing Connection fails
   * loud with 424 INTEGRATION_REQUIREMENT_UNSATISFIED; undeclared (optional)
   * access resolves to None and never throws. The declaration is mandatory —
   * every Saga states it explicitly, even when empty. Source declaration
   * only — never endpoints, credentials, or policy. */
  readonly requiredIntegrations: readonly string[];
  readonly inputSchema?: IoSchema;
  readonly outputSchema?: IoSchema;
  readonly parse: (value: unknown) => unknown;
  readonly run: SagaRun<TOutput>;
}

/** Discovery metadata served by GET /api/sagas and mirrored into D1
 * Execution rows. Metadata only: D1 never drives Saga behavior. The declared
 * Integration requirement list is discovery (which Connections a Saga needs
 * in its Organization), not policy: no endpoints, credentials, or counts. */
export interface CatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly revision: string;
  readonly description: string;
  readonly category?: string;
  readonly tags?: readonly string[];
  readonly requiredIntegrations: readonly string[];
  readonly inputSchema?: IoSchema;
  readonly outputSchema?: IoSchema;
}

const SAGA_NAME = /^[a-z0-9][a-z0-9.-]*$/i;

/** Operational policy keys that must never appear in Saga source (upstream
 * finding 3: runtime policy is environment state, not source trivia).
 * buildCatalog rejects them at startup; persisted policy only. */
const OPERATIONAL_POLICY_KEYS = [
  "timeout",
  "timeouts",
  "retry",
  "retries",
  "schedule",
  "schedules",
  "cron",
  "endpoint",
  "endpoints",
  "access",
  "rateLimit",
  "cache",
  "ttl",
  "concurrency",
  "backoff",
] as const;

export function validateSagaDefinition(def: SagaDefinition): void {
  if (!UUID.test(def.id)) {
    throw new Error(
      `Invalid Saga definition "${def.name}": id "${def.id}" must be a stable UUID (ADR 002); changing it mints a different Saga.`,
    );
  }
  if (!SAGA_NAME.test(def.name)) {
    throw new Error(`Invalid Saga definition id ${def.id}: name "${def.name}" must be a simple slug.`);
  }
  if (typeof def.revision !== "string" || def.revision.length === 0 || def.revision.length > 64) {
    throw new Error(`Invalid Saga definition "${def.name}": revision must be a non-empty diagnostic marker.`);
  }
  if (typeof def.description !== "string" || def.description.length === 0 || def.description.length > 280) {
    throw new Error(`Invalid Saga definition "${def.name}": description must be 1-280 chars of discovery text.`);
  }
  if (def.tags !== undefined) {
    if (
      !Array.isArray(def.tags) ||
      def.tags.some((tag) => typeof tag !== "string" || tag.length === 0 || tag.length > 32)
    ) {
      throw new Error(`Invalid Saga definition "${def.name}": tags must be short strings.`);
    }
  }
  if (typeof def.parse !== "function" || typeof def.run !== "function") {
    throw new Error(`Invalid Saga definition "${def.name}": parse and run are required.`);
  }
  if (def.requiredIntegrations === undefined) {
    throw new Error(
      `Invalid Saga definition "${def.name}": requiredIntegrations must be declared explicitly (empty when none).`,
    );
  }
  if (
    !Array.isArray(def.requiredIntegrations) ||
    def.requiredIntegrations.some((id) => typeof id !== "string" || !UUID.test(id))
  ) {
    throw new Error(
      `Invalid Saga definition "${def.name}": requiredIntegrations must be an explicit list of stable Integration UUIDs (empty when none).`,
    );
  }
  const record = def as unknown as Record<string, unknown>;
  for (const key of OPERATIONAL_POLICY_KEYS) {
    if (key in record) {
      throw new Error(
        `Invalid Saga definition "${def.name}": operational policy "${key}" must not live in Saga source (ADR 002); persisted policy only.`,
      );
    }
  }
}

/** Type-and-freeze helper for Saga authors. Format validation happens here;
 * cross-Saga duplicate detection happens in buildCatalog. */
export function defineSaga<TOutput>(def: SagaDefinition<TOutput>): SagaDefinition<TOutput> {
  validateSagaDefinition(def);
  return Object.freeze({
    ...def,
    tags: def.tags === undefined ? undefined : Object.freeze([...def.tags]),
    requiredIntegrations: Object.freeze([...def.requiredIntegrations]),
  });
}

/** Static Git-owned registration (ADR 002): collect Saga definitions into the
 * Catalog at Worker startup. Duplicate stable IDs or names are fatal boot
 * errors — the module import throws and the Worker never serves. D1 may mirror
 * this metadata for foreign keys/discovery but is never authoritative for
 * behavior. */
export function buildCatalog(defs: readonly SagaDefinition[]): readonly CatalogEntry[] {
  if (defs.length === 0) throw new Error("Fatal Saga catalog error: no Sagas are registered.");
  const ids = new Set<string>();
  const names = new Set<string>();
  const entries: CatalogEntry[] = [];
  for (const def of defs) {
    validateSagaDefinition(def);
    if (ids.has(def.id)) {
      throw new Error(
        `Fatal Saga catalog error: duplicate stable Saga ID ${def.id} ("${def.name}"). Stable IDs must be unique; fix the definitions before boot.`,
      );
    }
    if (names.has(def.name)) {
      throw new Error(
        `Fatal Saga catalog error: duplicate Saga name "${def.name}". Names must be unique; fix the definitions before boot.`,
      );
    }
    ids.add(def.id);
    names.add(def.name);
    entries.push(
      Object.freeze({
        id: def.id,
        name: def.name,
        revision: def.revision,
        description: def.description,
        ...(def.category === undefined ? {} : { category: def.category }),
        ...(def.tags === undefined ? {} : { tags: def.tags }),
        requiredIntegrations: def.requiredIntegrations,
        ...(def.inputSchema === undefined ? {} : { inputSchema: def.inputSchema }),
        ...(def.outputSchema === undefined ? {} : { outputSchema: def.outputSchema }),
      }),
    );
  }
  return Object.freeze(entries);
}

/** Thin platform adapter: translate the Saga step contract onto the native
 * WorkflowStep. Every retry limit resolves through stepRetryLimit (vendor
 * steps 0, idempotent D1 checkpoints up to the operator ceiling 2); the
 * 10-second step timeout is fixed platform mapping, not per-Saga policy. */
export function bindSagaStep(native: WorkflowStep, policy?: SagaRuntimePolicy): SagaStep {
  return {
    do<T>(name: string, fn: () => Promise<T>): Promise<T> {
      return native.do(
        name,
        { retries: { limit: retryLimitForStep(name, policy), delay: "1 second" }, timeout: "10 seconds" },
        () => fn() as unknown as Promise<never>,
      ) as unknown as Promise<T>;
    },
    sleep(name: string, duration: string): Promise<void> {
      return native.sleep(name, duration as WorkflowSleepDuration);
    },
  };
}
/** Effective retry limit for one step under an applied policy snapshot:
 * vendor/Integration steps resolve through the operator vendor ceiling
 * (default 0); idempotent D1 checkpoints resolve through the operator
 * checkpoint ceiling (default 2); unknown names fail closed to 0. Business
 * and expected failures still throw NonRetryableError, so the engine never
 * retries a non-idempotent mutation. Without a snapshot (old rows, unit
 * doubles) this collapses to the code table. */
export function retryLimitForStep(stepName: string, policy?: SagaRuntimePolicy): number {
  if (policy === undefined) return stepRetryLimit(stepName);
  const base = stepRetryLimit(stepName);
  if (base === 0) return vendorRetryLimit(policy);
  return Math.min(base, checkpointRetryLimit(policy));
}

/** Fail unless value is plain JSON (plain objects, arrays, strings, finite
 * numbers, booleans, null). Rejects functions, undefined, symbols, bigints,
 * class instances, Maps/Sets, NaN/Infinity, and circular references — none of
 * which survive Workflow replay or D1 persistence intact. */
export function assertJsonSerializable(value: unknown, label = "value"): void {
  const seen = new WeakSet<object>();
  const visit = (node: unknown, path: string): void => {
    if (node === null) return;
    const kind = typeof node;
    if (kind === "string" || kind === "boolean") return;
    if (kind === "number") {
      if (!Number.isFinite(node)) throw new Error(`${label}${path} is not JSON-serializable: non-finite number.`);
      return;
    }
    if (kind === "undefined" || kind === "function" || kind === "symbol" || kind === "bigint") {
      throw new Error(`${label}${path} is not JSON-serializable: ${kind}.`);
    }
    const record = node as Record<string, unknown>;
    if (seen.has(record)) throw new Error(`${label}${path} is not JSON-serializable: circular reference.`);
    seen.add(record);
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    const proto: unknown = Object.getPrototypeOf(node);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(`${label}${path} is not JSON-serializable: only plain objects and arrays.`);
    }
    for (const [key, entry] of Object.entries(record)) visit(entry, `${path}.${key}`);
  };
  visit(value, "");
}

// --- Determinism static check ------------------------------------------------
// The check reads the run function's own source, blanks out every step.do(...)
// call body (the only place I/O and nondeterminism may live), and fails on any
// remaining forbidden token. Scanner is string/comment/template aware so step
// names and messages never confuse it.

function skipQuoted(source: string, open: number): number {
  const quote = source[open] as string;
  let index = open + 1;
  while (index < source.length) {
    const char = source[index] as string;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    index += 1;
  }
  return source.length;
}

function skipBalanced(source: string, open: number, openChar: string, closeChar: string): number {
  let depth = 0;
  let index = open;
  while (index < source.length) {
    const two = source.slice(index, index + 2);
    if (two === "//") {
      const newline = source.indexOf("\n", index + 2);
      index = newline === -1 ? source.length : newline + 1;
      continue;
    }
    if (two === "/*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    const char = source[index] as string;
    if (char === "'" || char === '"') {
      index = skipQuoted(source, index);
      continue;
    }
    if (char === "`") {
      index = skipTemplate(source, index);
      continue;
    }
    if (char === "/" && two !== "//" && two !== "/*" && isRegexStart(source, index)) {
      index = skipRegex(source, index);
      continue;
    }
    if (char === openChar) depth += 1;
    else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return source.length;
}

function skipTemplate(source: string, open: number): number {
  let index = open + 1;
  while (index < source.length) {
    const char = source[index] as string;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "`") return index + 1;
    if (char === "$" && source[index + 1] === "{") {
      index = skipBalanced(source, index + 1, "{", "}");
      continue;
    }
    index += 1;
  }
  return source.length;
}

/** Keywords after which a `/` starts a regex literal rather than division. */
const REGEX_PREFIX_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "yield",
  "await",
  "throw",
  "case",
  "do",
  "else",
]);

/** Heuristic: is the `/` at index a regex literal start? Division follows a
 * value (identifier, number, string, `)`, `]`); anything else — including
 * expression-prefix keywords — starts a regex. Mismatches only risk
 * over/under-stripping inside step bodies, which the contract test pins. */
function isRegexStart(source: string, index: number): boolean {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(source[cursor] as string)) cursor -= 1;
  if (cursor < 0) return true;
  const prev = source[cursor] as string;
  if (/[$\w)]/.test(prev) || prev === "]" || prev === "'" || prev === '"' || prev === "`") {
    if (!/[$\w]/.test(prev)) return false;
    let start = cursor;
    while (start >= 0 && /[$\w]/.test(source[start] as string)) start -= 1;
    const word = source.slice(start + 1, cursor + 1);
    return REGEX_PREFIX_KEYWORDS.has(word);
  }
  return true;
}

function skipRegex(source: string, open: number): number {
  let index = open + 1;
  let inClass = false;
  while (index < source.length) {
    const char = source[index] as string;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "[") {
      inClass = true;
      index += 1;
      continue;
    }
    if (char === "]") {
      inClass = false;
      index += 1;
      continue;
    }
    if (char === "/" && !inClass) {
      index += 1;
      while (index < source.length && /[a-z]/i.test(source[index] as string)) index += 1;
      return index;
    }
    if (char === "\n") return index;
    index += 1;
  }
  return source.length;
}

/** Blank every step.do(...) call body (name and callback alike), leaving the
 * top-level run orchestration visible for the forbidden-token scan. Exported
 * for unit testing of the scanner itself. */
export function stripStepDoBodies(source: string): string {
  let output = "";
  let cursor = 0;
  for (;;) {
    const call = source.indexOf(".do(", cursor);
    if (call === -1) {
      output += source.slice(cursor);
      return output;
    }
    output += `${source.slice(cursor, call)}.do()`;
    cursor = skipBalanced(source, call + 3, "(", ")");
  }
}

const FORBIDDEN_OUTSIDE_STEPS: ReadonlyArray<{ pattern: RegExp; hint: string }> = [
  { pattern: /\bfetch\s*\(/, hint: "fetch" },
  { pattern: /Date\s*\.\s*now/, hint: "Date.now" },
  { pattern: /new\s+Date\s*\(/, hint: "new Date" },
  { pattern: /Math\s*\.\s*random/, hint: "Math.random" },
  { pattern: /randomUUID/, hint: "randomUUID" },
  { pattern: /AbortSignal/, hint: "AbortSignal" },
  { pattern: /ctx\s*\.\s*integrations/, hint: "ctx.integrations" },
  { pattern: /ctx\s*\.\s*db\b/, hint: "ctx.db" },
  { pattern: /ctx\s*\.\s*secrets/, hint: "ctx.secrets" },
  { pattern: /ctx\s*\.\s*config/, hint: "ctx.config" },
  { pattern: /this\s*\.\s*env/, hint: "this.env" },
  { pattern: /crypto\s*\./, hint: "crypto." },
  { pattern: /process\s*\.\s*env/, hint: "process.env" },
  { pattern: /step\s*\.\s*(sleepUntil|waitForEvent)/, hint: "step.sleepUntil/waitForEvent" },
];

/** Static determinism gate for one Saga run body: every durable effect must
 * flow through step.do(...), and ctx handles must never escape it. Throws a
 * descriptive Error naming the offending token. */
export function assertDeterministicRun(name: string, run: SagaRun<unknown>): void {
  const source = Function.prototype.toString.call(run);
  if (!/\bstep\s*\.\s*do\s*\(/.test(source)) {
    throw new Error(`Saga "${name}" run body never calls step.do(...): durable work must live in Operations.`);
  }
  const outside = stripStepDoBodies(source);
  const violations = FORBIDDEN_OUTSIDE_STEPS.filter((entry) => entry.pattern.test(outside));
  if (violations.length > 0) {
    throw new Error(
      `Saga "${name}" run body uses ${violations.map((entry) => entry.hint).join(", ")} outside step.do(...): move all I/O and nondeterminism inside an Operation.`,
    );
  }
}
