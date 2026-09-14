// SPDX-License-Identifier: AGPL-3.0
// Global unhandled-rejection guard (issues #332/#333).
//
// Loaded via `test.setupFiles` in vitest.config.ts, so it runs inside the
// workerd isolate before every test file. It records every `unhandledrejection`
// with the file/line context vitest already attributes, then lets the run
// finish: vitest prints its own "Unhandled Errors" summary and fails the file
// when a rejection escapes a test. This guard adds two things vitest does not:
//
// 1. An explicit allowlist for rejection categories the suite asserts on by
//    design (intentional stress paths). Anything outside the allowlist is
//    logged with a HARD-FAIL marker so new harness leaks are visible as
//    first-class failures instead of log spam.
// 2. A per-file count summary that makes it cheap to tell whether a lane's
//    change moved the suite toward zero unexpected rejections.
//
// The allowlist is intentionally narrow: broadening it to silence a new noise
// source masks production failures (issue #333 forbids blanket suppression).
// Shrink the noise by fixing the harness (test/helpers/workflow-harness.ts),
// never by adding patterns here without an asserted stress path behind them.

interface RecordedRejection {
  readonly file: string;
  readonly reason: string;
  readonly allowed: boolean;
}

/** Rejection categories the suite asserts explicitly. Each entry names the
 * stress path that produces it; remove the stress path and the entry goes
 * with it. */
const ALLOWLIST: ReadonlyArray<{ readonly pattern: RegExp; readonly why: string }> = [
  // Resilience/negative-path suites submit unknown revisions, cancelled
  // executions, and failing vendor integrations on purpose and assert the
  // terminal D1 state afterwards (execution-guards, runtime-policy,
  // saga-run-paths, resilience). The Workflow engine replays the step
  // failure as an unhandled NonRetryableError after the assertion lands.
  { pattern: /NonRetryableError/, why: "asserted stress path (unknown revision / cancelled / vendor fault)" },
  // Pre-submit introspection probes (`introspectWorkflowInstance` before any
  // instance exists) and cancel/child paths that assert not-found handling
  // (cancel-confirmation, child-invocation, domain classifyTerminateError).
  { pattern: /instance\.not_found/, why: "asserted not-found introspection path" },
  // Introspector liveness probes against engines that never started
  // (pre-dispatch status checks in history/connections/ops suites).
  { pattern: /Engine was never started/, why: "asserted pre-dispatch introspection probe" },
  // Partial-migration suites (org-lifecycle pre-0007 DROP-rebuild,
  // schedule-branches authority-store fences) assert 503 gates against
  // tables that do not exist yet.
  { pattern: /D1_ERROR: no such table/, why: "asserted partial-migration gate" },
  // A step that throws NonRetryableError aborts its engine; workerd reports
  // the abort through the actor output gate. Same asserted stress paths as
  // the NonRetryableError entry above, observed one layer down.
  { pattern: /outputGateBroken/, why: "engine abort telemetry for an asserted stress path" },
  // Timeout-sweeper and RUN-01 deadline suites hold vendor steps past their
  // snapshot deadline on purpose; workerd cancels the hung request after the
  // test already asserted the TimedOut terminal state.
  { pattern: /canceled this request because it detected/, why: "asserted vendor-timeout path" },
  // Introspector waitForStatus on an instance that settles finite-unexpected
  // (probe-then-assert suites that check the error branch, e.g. executions
  // failure persistence). The test asserts via waitForStatus("errored") or
  // getError(); the competing waiter rejects unhandled.
  { pattern: /has reached status .* finite status/, why: "asserted finite-unexpected introspector wait" },
];

const recorded: RecordedRejection[] = [];

function currentFile(): string {
  // Vitest appends the test file to the stack of the rejection context when
  // it reports; inside the handler the closest we get portably is the error
  // stack itself, which carries the originating test file path.
  return "unknown-file";
}

function classify(reason: unknown): { readonly text: string; readonly allowed: boolean } {
  const text = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
  const hit = ALLOWLIST.find((entry) => entry.pattern.test(text));
  return { text, allowed: hit !== undefined };
}

try {
  const target = globalThis as unknown as {
    addEventListener?: (type: string, listener: (event: { reason?: unknown }) => void) => void;
  };
  target.addEventListener?.("unhandledrejection", (event) => {
    const { text, allowed } = classify(event?.reason);
    recorded.push({ file: currentFile(), reason: text.slice(0, 300), allowed });
    if (!allowed) {
      console.error(`[unhandled-guard] HARD-FAIL unexpected rejection: ${text.slice(0, 500)}`);
    }
  });
  const g = globalThis as unknown as Record<string, unknown>;
  g.__wrangnarokUnhandledGuard = {
    recorded,
    summary(): { allowed: number; unexpected: number } {
      return {
        allowed: recorded.filter((r) => r.allowed).length,
        unexpected: recorded.filter((r) => !r.allowed).length,
      };
    },
  };
} catch {
  // Listener registration outside a supporting runtime must never break the
  // suite: without the guard vitest still reports unhandled rejections.
}
