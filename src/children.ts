// SPDX-License-Identifier: AGPL-3.0
// RUN-02 (issue #136, ADR 018): nested Saga invocation with explicit
// context, completion, and failure semantics.
//
// Upstream pin (gobifrost/bifrost@3543c7e, inspected not executed): the
// engine runs inline `func` with the caller's ContextVar context, while
// `workflows.execute()` POSTs a registered invocation with sync:false and
// returns a fire-and-forget execution ID. Wrangnarok adopts the
// remote-registered shape only: a parent reserves a child Execution row with
// lineage, dispatches it through the ADR 001 dual-write protocol under the
// same Idempotency-Key, gets back a queued receipt, and polls the child D1
// row to terminal for the typed JSON result. No inline function-import path
// exists (nothing passes callables between Workflow instances), and no
// process-pool infrastructure is copied.
//
// Context: the child inherits org_id/user_id from the parent D1 row. invoke
// takes no org parameter, so a foreign-org child is unconstructable; unknown
// child refs and non-serializable inputs fail before any write. Every catalog
// Saga is invokable from its own Organization until AUTH-02 gates
// visibility; that is documented in ADR 018, not hidden.
//
// Identity: the child Execution ID is deterministic over
// (caller, parent, step, child, key), so step retries and duplicate
// dispatches converge on one child row. The step segment is the owning
// step.do Operation name (bound ambiently by bindSagaStep; options.callerStep
// overrides for explicit fan-out within one step). Lineage persists as
// parent_execution_id/parent_step; detail serves parentExecutionId plus a
// children list.
//
// Completion: child Succeeded yields its JSON output (a corrupt row yields
// CHILD_RESULT_CORRUPT, never invented success). Child Failed/TimedOut/
// Cancelled yields CHILD_FAILED carrying { childExecutionId, status, code };
// the parent persists its own Failed checkpoint. Await expiry yields
// CHILD_AWAIT_TIMEOUT while the child keeps running. Dispatch ambiguity
// yields CHILD_DISPATCH_UNCONFIRMED. The dispatch step converges (checkpoint
// retry ceiling); poll reads are limit 0.
import { Fault, hash } from "./domain";
import type { ExecutionStatus, Principal, SagaDef } from "./domain";
import { EXECUTION_ID } from "./domain";
import type { OrgCtx } from "./saga";
import { assertJsonSerializable, currentOperationName } from "./saga";
import { cancelExecution, visibleExecution, workflowForSaga } from "./executions";
import { requireActiveInstall } from "./solutions";
import type { ExecutionRow } from "./executions";
import type { Bindings } from "./bindings";
import { scrubExecutionValue } from "./secrets";

/** Queued receipt returned by a child dispatch: the child Execution exists
 * as a D1 row and (when confirmed) a native Workflow instance. Distinct from
 * the synchronous result, which only awaitChildResult produces. */
export interface ChildReceipt {
  readonly executionId: string;
  readonly sagaId: string;
  readonly replayed: boolean;
  readonly statusUrl: string;
}

/** Resolution of one child ref: stable UUID or exact catalog name. Names are
 * unique (buildCatalog throws on duplicates), so misses are a loud
 * CHILD_SAGA_NOT_FOUND rather than a guess. */
export interface ChildCatalog {
  readonly sagas: readonly SagaDef[];
}

export function resolveChildSaga(catalog: ChildCatalog, ref: string): SagaDef {
  const byId = catalog.sagas.find((entry) => entry.id.toLowerCase() === ref.toLowerCase());
  if (byId) return byId;
  const matches = catalog.sagas.filter((entry) => entry.name === ref);
  if (matches.length === 1 && matches[0] !== undefined) return matches[0];
  throw new Fault(404, "CHILD_SAGA_NOT_FOUND", "No Saga matches that child reference.");
}

/** Deterministic child Execution key: one stable Idempotency-Key per
 * (parent, step, child, key) tuple, so retries converge. */
export function childDispatchKey(
  parentExecutionId: string,
  stepName: string,
  childSagaId: string,
  key: string,
): string {
  return `child.${parentExecutionId}.${stepName}.${childSagaId}.${key}`;
}

/** Deterministic child Execution ID over (caller, parent, step, child,
 * key): retries compute the same ID before touching D1. Pure and
 * unit-testable without bindings. */
export async function childExecutionId(
  caller: Principal,
  parentExecutionId: string,
  stepName: string,
  childSagaId: string,
  key: string,
): Promise<string> {
  return hash(
    JSON.stringify(["wrangnarok.child.v1", caller.orgId, caller.userId, parentExecutionId, stepName, childSagaId, key]),
  );
}

/** Author-facing child options: the caller key disambiguates sibling
 * invocations of one child within a step; callerStep overrides the ambient
 * owning Operation (resolved from the enclosing step.do callback) when a
 * single step must dispatch under distinct identity segments; awaitTimeoutMs
 * bounds the poll loop inside awaitChildResult (the child keeps running on
 * expiry). */
export interface InvokeChildOptions {
  readonly key?: string;
  readonly callerStep?: string;
  readonly awaitTimeoutMs?: number;
}

/** Durable child handle surfaced on SagaEventContext. Dispatch (invoke)
 * returns a queued receipt; awaitResult polls that receipt to terminal and
 * returns the typed JSON output. Both must run inside step.do(...): invoke
 * performs the D1 + Workflow dual write, awaitResult performs D1 reads and
 * step.sleep waits. */
export interface SagaChildren {
  invoke(childRef: string, input: unknown, options?: InvokeChildOptions): Promise<ChildReceipt>;
  awaitResult<T>(receipt: ChildReceipt, options?: InvokeChildOptions): Promise<T>;
}

export interface ChildEnv {
  readonly env: Bindings;
  readonly catalog: ChildCatalog;
  readonly parentOrg: OrgCtx;
  readonly parentExecutionId: string;
  readonly parentSagaId: string;
  readonly awaitTimeoutDefaultMs?: number;
}

/** Poll cadence for child awaits: one native sleep per interval keeps the
 * wait durable without busy-spinning D1. */
export const CHILD_POLL_INTERVAL = "1 second";

/** Ampersand-free step names for child dispatch Operations, so position
 * ordering stays greppable in ExecutionHistory. Idempotent: callers may pass
 * either the owning Operation name ("child-dispatch-invoke-v1") or its
 * already-prefixed form; an already-prefixed name passes through unchanged
 * so ambient resolution (which sees the full step.do name) never
 * double-prefixes. */
const CHILD_DISPATCH_PREFIX = "child-dispatch-";

export function childDispatchStep(stepName: string): string {
  return stepName.startsWith(CHILD_DISPATCH_PREFIX) ? stepName : `child-dispatch-${stepName}`;
}

export function childPollStep(stepName: string): string {
  return `child-poll-${stepName}`;
}

/** Terminal child statuses mapped to completion: only Succeeded yields a
 * result. Failed/TimedOut/Cancelled surface as CHILD_FAILED with the child
 * status and safe code; anything else keeps polling. */
const CHILD_TERMINAL: readonly ExecutionStatus[] = ["Succeeded", "Failed", "TimedOut", "Cancelled"];

export function childTerminalOf(status: string): ExecutionStatus | null {
  return (CHILD_TERMINAL as readonly string[]).includes(status) ? (status as ExecutionStatus) : null;
}

/** Bind the durable child handle for one parent Saga run: the caller comes
 * from the parent OrgCtx (org/user identity built from the immutable parent
 * D1 row), the child from the static catalog. The adapter
 * (src/sagas/shared.ts) installs this on every SagaEventContext; Sagas never
 * construct it directly. */
export function bindSagaChildren(
  childEnv: ChildEnv,
  step: { sleep(name: string, duration: string): Promise<void> },
): SagaChildren {
  return {
    // Dispatch identity is (parent, step, child, key): the step segment
    // resolves from the owning step.do Operation (ambient, bound by
    // bindSagaStep) with options.callerStep as an explicit override. Two
    // distinct step.do callbacks invoking the same child under the same key
    // therefore produce two child rows with correct parent_step. Invoke
    // outside a step.do callback (no ambient Operation, no override) fails
    // loud with CHILD_STEP_MISSING instead of converging on a shared
    // default row.
    invoke: async (childRef, input, options) => {
      const owner = options?.callerStep ?? currentOperationName();
      if (owner === undefined) {
        throw new Fault(
          400,
          "CHILD_STEP_MISSING",
          "Child invoke must run inside a step.do() callback (or pass callerStep): the owning Operation is part of child identity.",
        );
      }
      return invokeChild(childEnv, childDispatchStep(owner), childRef, input, options);
    },
    awaitResult: <T>(receipt: ChildReceipt, options?: InvokeChildOptions): Promise<T> =>
      awaitChildResult<T>(childEnv, step, receipt, options),
  };
}

/** Dispatch one child Execution under the ADR 001 dual-write protocol with
 * lineage: deterministic child ID, reserve the row (lineage
 * parent_execution_id/parent_step) or converge on the existing reservation,
 * then createBatch retained-ID dispatch and the dispatched marker. Submit
 * faults map to child codes: 409 EXECUTION_CANCELLED/RECOVERY_EXPIRED and
 * 409 lineage/input conflicts become CHILD_FAILED; 503
 * DISPATCH_UNCONFIRMED becomes CHILD_DISPATCH_UNCONFIRMED. */
export async function invokeChild(
  childEnv: ChildEnv,
  stepName: string,
  childRef: string,
  input: unknown,
  options: InvokeChildOptions = {},
): Promise<ChildReceipt> {
  if (!EXECUTION_ID.test(childEnv.parentExecutionId)) {
    throw new Fault(400, "CHILD_PARENT_INVALID", "The parent Execution ID is not a 64-hex Execution.");
  }
  const child = resolveChildSaga(childEnv.catalog, childRef);
  if (child.id === childEnv.parentSagaId) {
    throw new Fault(400, "CHILD_SELF_INVOKE", "A Saga cannot invoke itself as a child.");
  }
  // Parse child input through the Saga's own parser BEFORE reservation and
  // dispatch: invalid input fails here with the parser's Fault(400) instead
  // of reserving and dispatching a row the child later rejects. Only
  // serialization failures map to CHILD_INPUT_NOT_SERIALIZABLE.
  const parsedInput = child.parse(input);
  try {
    assertJsonSerializable(parsedInput, "child input");
  } catch {
    throw new Fault(400, "CHILD_INPUT_NOT_SERIALIZABLE", "The child input must be plain JSON.");
  }
  const key = options.key ?? "default";
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) {
    throw new Fault(400, "CHILD_KEY_INVALID", "The child key must be 1 to 128 safe characters.");
  }
  // The stepName parameter already carries the (parent, step, child, key)
  // identity segment: bindSagaChildren resolves it from the owning step.do
  // Operation (options.callerStep overrides). Validate the shape here so a
  // malformed caller step fails closed before any write.
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(stepName)) {
    throw new Fault(400, "CHILD_KEY_INVALID", "The caller step must be 1 to 128 safe characters.");
  }
  const caller: Principal = { orgId: childEnv.parentOrg.orgId, userId: childEnv.parentOrg.userId };
  // Active-install parity with top-level submit (SOL-01 gate): a child Saga
  // absent from the org's active bundle (or pinned to another revision) is
  // rejected here exactly as a top-level submit would reject it, so the same
  // Saga cannot run or be denied depending only on the invocation path.
  await requireActiveInstall(childEnv.env.DB, child.id, child.revision, caller.orgId);
  const inputJson = JSON.stringify(parsedInput);
  const dispatchKey = childDispatchKey(childEnv.parentExecutionId, stepName, child.id, key);
  const id = await childExecutionId(caller, childEnv.parentExecutionId, stepName, child.id, key);
  await childEnv.env.DB.prepare(
    "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,parent_execution_id,parent_step,created_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
  )
    .bind(
      id,
      child.id,
      child.name,
      child.revision,
      caller.orgId,
      caller.userId,
      inputJson,
      childEnv.parentExecutionId,
      stepName,
      new Date().toISOString(),
    )
    .run();
  const reserved = await visibleExecution(childEnv.env.DB, id, caller);
  if (
    reserved.saga_id !== child.id ||
    reserved.input_json !== inputJson ||
    reserved.parent_execution_id !== childEnv.parentExecutionId ||
    reserved.parent_step !== stepName
  ) {
    throw new Fault(409, "CHILD_DISPATCH_CONFLICT", "This child key already identifies different input or lineage.");
  }
  if (reserved.status === "Cancelling" || reserved.status === "Cancelled") {
    throw new Fault(409, "CHILD_FAILED", "The child Execution was cancelled and will not dispatch.");
  }
  if (!reserved.dispatched) {
    const acknowledged = await dispatchChildInstance(childEnv.env, child.id, id, dispatchKey);
    if (!acknowledged) {
      throw new Fault(503, "CHILD_DISPATCH_UNCONFIRMED", "Work may have started. Retry the parent under the same key.");
    }
  }
  return { executionId: id, sagaId: child.id, replayed: reserved.dispatched === 1, statusUrl: `/api/executions/${id}` };
}

/** createBatch retained-ID dispatch plus the durable dispatched marker for
 * one reserved child row. Returns false (no throw) when the native control
 * fails, so the caller maps it to CHILD_DISPATCH_UNCONFIRMED with the
 * retry-safe posture of the parent submit path. */
async function dispatchChildInstance(
  env: Bindings,
  childSagaId: string,
  id: string,
  dispatchKey: string,
): Promise<boolean> {
  void dispatchKey;
  const workflow = workflowForSaga(env, childSagaId);
  try {
    await workflow.createBatch([{ id, params: { executionId: id } }]);
    await env.DB.prepare("UPDATE executions SET dispatched = 1 WHERE id = ?").bind(id).run();
    return true;
  } catch {
    return false;
  }
}

/** Await one child receipt to terminal and return its typed JSON output.
 * Polls the child D1 row (never native introspection) through step.sleep
 * waits; the deadline only stops the parent wait (CHILD_AWAIT_TIMEOUT) while
 * the child keeps running and stays inspectable. A Succeeded child yields
 * its result (corrupt JSON is CHILD_RESULT_CORRUPT, never invented
 * success); Failed/TimedOut/Cancelled yields CHILD_FAILED with the child
 * status and safe code. */
export async function awaitChildResult<T>(
  childEnv: ChildEnv,
  step: { sleep(name: string, duration: string): Promise<void> },
  receipt: ChildReceipt,
  options: InvokeChildOptions = {},
): Promise<T> {
  if (!EXECUTION_ID.test(receipt.executionId)) {
    throw new Fault(400, "CHILD_RECEIPT_INVALID", "The child receipt carries no 64-hex Execution ID.");
  }
  const caller: Principal = { orgId: childEnv.parentOrg.orgId, userId: childEnv.parentOrg.userId };
  // Deadline agreement with the enclosing step.do (10s platform timeout in
  // the saga adapter): awaitChildResult runs inside step.do, so any deadline
  // beyond ~9s would die under the outer step timeout instead of producing
  // the documented CHILD_AWAIT_TIMEOUT. The bound stays under the step
  // ceiling; longer waits belong across multiple step.do calls (poll steps),
  // not one long sleep loop.
  const timeoutMs = options.awaitTimeoutMs ?? childEnv.awaitTimeoutDefaultMs ?? 8000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 9000) {
    throw new Fault(400, "CHILD_AWAIT_INVALID", "awaitTimeoutMs must be 1 to 9000 ms (inside the 10 s step timeout).");
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // Child reads stay org-scoped: a receipt smuggled from a foreign org
    // answers 404 (EXECUTION_NOT_FOUND) and the await fails closed.
    const row = await visibleExecution(childEnv.env.DB, receipt.executionId, caller);
    // Lineage check: the row must belong to this parent (parent_execution_id)
    // and match the receipt's Saga. A stale or constructed receipt naming an
    // unrelated same-org Execution (top-level, sibling, or another parent's
    // child) is rejected instead of returning foreign output as our own.
    if (row.parent_execution_id !== childEnv.parentExecutionId || row.saga_id !== receipt.sagaId) {
      throw new Fault(400, "CHILD_RECEIPT_INVALID", "The child receipt does not belong to this parent Execution.");
    }
    const terminal = childTerminalOf(row.status);
    if (terminal === "Succeeded") {
      try {
        const output = row.result_json === null ? null : JSON.parse(row.result_json);
        assertJsonSerializable(output, "child output");
        return scrubExecutionValue(output, childEnv.parentExecutionId) as T;
      } catch {
        throw new Fault(502, "CHILD_RESULT_CORRUPT", "The child result is not JSON-serializable.");
      }
    }
    if (terminal !== null) {
      throw new Fault(502, "CHILD_FAILED", `Child ${receipt.executionId} ended ${terminal} (${safeCode(row)}).`);
    }
    if (Date.now() >= deadline) {
      throw new Fault(
        504,
        "CHILD_AWAIT_TIMEOUT",
        `Child ${receipt.executionId} did not settle in time; it keeps running.`,
      );
    }
    await step.sleep(childPollStep(receipt.executionId.slice(0, 8)), CHILD_POLL_INTERVAL);
  }
}

function safeCode(row: ExecutionRow): string {
  if (!row.error_json) return row.status;
  try {
    const parsed: unknown = JSON.parse(row.error_json);
    if (parsed !== null && typeof parsed === "object" && "code" in parsed && typeof parsed.code === "string") {
      return parsed.code;
    }
  } catch {
    // Fall through to the status marker below.
  }
  return row.status;
}

/** True when D1 reports a missing lineage column: a store that predates
 * migration 0015 has no parent_execution_id/parent_step to read. Read paths
 * (detail, cancel fan-out) degrade; the child-dispatch write path stays
 * fail-loud so lineage is never silently dropped. */
export function isMissingLineageColumn(error: unknown): boolean {
  return error instanceof Error && /no such column/i.test(error.message);
}

/** Best-effort child fan-out for parent cancellation: mark still-active
 * direct children Cancelling, attempt each native terminate, classify, and
 * confirm only observed stops. Ambiguous children stay active and
 * inspectable; parent confirmation never depends on child outcomes (ADR
 * 018). Returns the child IDs that reached a confirmed stop. */
export async function cancelDirectChildren(
  env: Bindings,
  caller: Principal,
  parentExecutionId: string,
): Promise<readonly string[]> {
  let kids: { id: string; saga_id: string; status: string; dispatched: number }[];
  try {
    kids = (
      await env.DB.prepare(
        "SELECT id,saga_id,status,dispatched FROM executions WHERE parent_execution_id=? AND org_id=? AND user_id=?",
      )
        .bind(parentExecutionId, caller.orgId, caller.userId)
        .all<{ id: string; saga_id: string; status: string; dispatched: number }>()
    ).results;
  } catch (error) {
    // Pre-lineage stores (before migration 0015) have no children to fan out
    // to: the parent cancel proceeds without them. Genuine failures still throw.
    if (isMissingLineageColumn(error)) return [];
    throw error;
  }
  const confirmed: string[] = [];
  for (const kid of kids) {
    if (kid.status !== "Pending" && kid.status !== "Running") continue;
    const marked = await env.DB.prepare(
      "UPDATE executions SET status='Cancelling' WHERE id=? AND status IN ('Pending','Running')",
    )
      .bind(kid.id)
      .run();
    if (marked.meta.changes === 0) continue;
    let stopped = false;
    try {
      const binding = workflowForSaga(env, kid.saga_id);
      await (await binding.get(kid.id)).terminate();
      stopped = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
      if (message.includes("instance.cannot_terminate")) stopped = true;
      else if (message.includes("instance.not_found") && kid.status === "Pending" && kid.dispatched === 0)
        stopped = true;
    }
    if (stopped) {
      await cancelExecution(env.DB, kid.id);
      confirmed.push(kid.id);
    } else {
      // Ambiguous: roll back to the prior active status so the child stays
      // inspectable and its true terminal can still land (same compensating
      // posture as the parent cancel route, ADR 001).
      await env.DB.prepare("UPDATE executions SET status=? WHERE id=? AND status='Cancelling'")
        .bind(kid.status, kid.id)
        .run();
    }
  }
  return confirmed;
}
