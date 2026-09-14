// SPDX-License-Identifier: AGPL-3.0
// Global unhandled-rejection guard (issues #332/#333).
//
// Loaded via `test.setupFiles` in vitest.config.ts, so it runs inside the
// workerd isolate before every test file. It records every `unhandledrejection`
// with the originating test file, then lets the run finish: vitest prints its
// own "Unhandled Errors" summary and fails the file when a rejection escapes
// a test. This guard adds two things vitest does not:
//
// 1. An explicit allowlist for rejection categories the suite asserts on by
//    design (intentional stress paths). Every entry matches BOTH the rejection
//    text AND the originating test file: an unrelated regression that happens
//    to contain a generic string is never allowlisted as expected. Anything
//    outside the allowlist is logged with a HARD-FAIL marker so new harness
//    leaks are visible as first-class failures instead of log spam.
// 2. A per-file count summary that makes it cheap to tell whether a lane's
//    change moved the suite toward zero unexpected rejections.
//
// Scoping model: engine-broadcast telemetry (step-failure replays, abort and
// cancel reports, introspector lifecycle) cannot be pinned to exact suites
// without brittle per-file lists that rot on every new test, so entries use
// capability scopes instead of enumerated suites:
// - "runtime": any suite driving the Worker (worker.fetch / cloudflare:*).
//   Pure-unit suites (UNIT_FILES below, mirrored from scripts/test-group.mjs)
//   never touch the runtime, so ANY unhandled rejection from a unit file is a
//   HARD-FAIL. Keep UNIT_FILES in sync with the unit definition when a file
//   gains or loses its Worker surface.
// - "workflow": suites driving local Workflow instances (the 21 files using
//   test/helpers/workflow-harness.ts). Narrower than runtime for
//   introspector-lifecycle categories.
//
// The allowlist is intentionally narrow: broadening it to silence a new noise
// source masks production failures (issue #333 forbids blanket suppression).
// Shrink the noise by fixing the harness (test/helpers/workflow-harness.ts),
// never by adding patterns here without an asserted stress path behind them.
import { expect } from "vitest";

interface RecordedRejection {
  readonly file: string;
  readonly reason: string;
  readonly allowed: boolean;
}

type Scope = "runtime" | "workflow";

/** Pure-unit suites: no cloudflare:* imports, no worker fetch. Mirrors the
 * unit definition in scripts/test-group.mjs — keep the two in sync. Any
 * unhandled rejection from these files HARD-FAILs regardless of pattern. */
const UNIT_FILES = [
  "app-sdk-client.test.tsx",
  "apps-ui.test.tsx",
  "artifact-branches.test.ts",
  "artifacts-ui.test.tsx",
  "config-unit.test.ts",
  "connections-ui.test.tsx",
  "domain.test.ts",
  "files-ui.test.tsx",
  "form-binding.test.ts",
  "generate-integration.test.ts",
  "history-view.test.tsx",
  "integration-faults.test.ts",
  "integrations.test.ts",
  "mailbox.test.ts",
  "migration-bridge.test.ts",
  "oauth.test.ts",
  "observability-config.test.ts",
  "ops-ui.test.tsx",
  "saga-contract.test.ts",
  "sagas-catalog.test.tsx",
  "scanner-edge.test.ts",
  "schedule-branches.test.ts",
  "secret-scrub.test.ts",
  "tables-unit.test.ts",
  "tool-01-openapi.test.ts",
] as const;

/** Suites driving local Workflow instances via test/helpers/workflow-harness.ts. */
const WORKFLOW_FILES = [
  "app-runtime.test.ts",
  "cancel-confirmation.test.ts",
  "child-invocation.test.ts",
  "echo-secretfields.test.ts",
  "endpoints.test.ts",
  "executions.test.ts",
  "form-lifecycle.test.ts",
  "forms.test.ts",
  "hello.test.ts",
  "logs.test.ts",
  "machine-credentials.test.ts",
  "ninja-echo-digest.test.ts",
  "ninjaone.test.ts",
  "redaction.test.ts",
  "resilience.test.ts",
  "runtime-policy.test.ts",
  "schedule-lifecycle.test.ts",
  "sdk.test.ts",
  "secret-scrub-live.test.ts",
  "smoke.test.ts",
  "solutions-activation.test.ts",
] as const;

/** Rejection categories the suite asserts explicitly. Each entry names the
 * stress path that produces it; remove the stress path and the entry goes
 * with it. */
const ALLOWLIST: ReadonlyArray<{ readonly pattern: RegExp; readonly scope: Scope; readonly why: string }> = [
  // Resilience/negative-path suites submit unknown revisions, cancelled
  // executions, and failing vendor integrations on purpose and assert the
  // terminal D1 state afterwards. The Workflow engine replays the step
  // failure as an unhandled NonRetryableError after the assertion lands.
  {
    pattern: /NonRetryableError/,
    scope: "runtime",
    why: "asserted stress path (unknown revision / cancelled / vendor fault)",
  },
  // Pre-submit introspection probes and cancel/child paths that assert
  // not-found handling (cancel-confirmation, child-invocation, domain
  // classifyTerminateError, mocked-binding cancel races).
  { pattern: /instance\.not_found/, scope: "runtime", why: "asserted not-found introspection path" },
  // Introspector liveness probes against engines that never started
  // (pre-dispatch status checks in history/connections/ops suites).
  { pattern: /Engine was never started/, scope: "runtime", why: "asserted pre-dispatch introspection probe" },
  // Partial-migration suites (org-lifecycle pre-0007 DROP-rebuild,
  // schedule-branches authority-store fences) assert 503 gates against
  // tables that do not exist yet; engine leftovers broadcast the same shape.
  { pattern: /D1_ERROR: no such table/, scope: "runtime", why: "asserted partial-migration gate" },
  // A step that throws NonRetryableError aborts its engine; workerd reports
  // the abort through the actor output gate. Same asserted stress paths as
  // the NonRetryableError entry above, observed one layer down.
  { pattern: /outputGateBroken/, scope: "runtime", why: "engine abort telemetry for an asserted stress path" },
  // Native terminate controls (cancel-confirmation, resilience, cancel-race)
  // abort the engine mid-step; workerd reports the abort as a user terminate.
  { pattern: /User called terminate/, scope: "runtime", why: "asserted native terminate path" },
  // Timeout-sweeper and RUN-01 deadline suites hold vendor steps past their
  // snapshot deadline on purpose; workerd cancels the hung request after the
  // test already asserted the TimedOut terminal state.
  {
    pattern: /canceled this request because it detected/,
    scope: "runtime",
    why: "asserted vendor-timeout path",
  },
  // Introspector waitForStatus on an instance that settles finite-unexpected
  // (probe-then-assert suites that check the error branch). The test asserts
  // via waitForStatus("errored") or getError(); the competing waiter rejects
  // unhandled.
  {
    pattern: /has reached status .* finite status/,
    scope: "workflow",
    why: "asserted finite-unexpected introspector wait",
  },
  // Disposing an introspector whose engine already tore down (cancel-race
  // windows where terminate wins before dispose runs).
  { pattern: /Instance dispose/, scope: "workflow", why: "asserted terminate-wins dispose race" },
];

const recorded: RecordedRejection[] = [];

function basenameOf(path: string): string {
  const match = /test\/([^/]+\.test\.tsx?)$/.exec(path);
  return match?.[1] ?? "";
}

function inScope(file: string, scope: Scope): boolean {
  if (file === "unknown-file") return true;
  const base = basenameOf(file) || file;
  if ((UNIT_FILES as readonly string[]).includes(base)) return false;
  if (scope === "workflow") return (WORKFLOW_FILES as readonly string[]).includes(base);
  return true;
}

/** Best-effort origin of a rejection: the vitest testPath when available,
 * else the first test-file frame in the reason's stack, else unknown-file.
 * Non-Error reasons carry no stack and stay unknown unless a test is running. */
function currentFile(reason: unknown): string {
  try {
    const state = (expect as unknown as { getState?: () => { testPath?: string } }).getState?.();
    if (typeof state?.testPath === "string" && state.testPath.includes("test/")) {
      return state.testPath;
    }
  } catch {
    // No test context (or vitest internals unavailable in this isolate):
    // fall through to stack parsing.
  }
  if (reason instanceof Error && typeof reason.stack === "string") {
    const match = /(?:\/|\\)test[\\/]([^\\/]+\.test\.tsx?):\d+/.exec(reason.stack);
    if (match) return `test/${match[1]}`;
  }
  return "unknown-file";
}

function classify(reason: unknown, file: string): { readonly text: string; readonly allowed: boolean } {
  const text = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
  const hit = ALLOWLIST.find((entry) => entry.pattern.test(text) && inScope(file, entry.scope));
  return { text, allowed: hit !== undefined };
}

try {
  const target = globalThis as unknown as {
    addEventListener?: (type: string, listener: (event: { reason?: unknown }) => void) => void;
  };
  target.addEventListener?.("unhandledrejection", (event) => {
    const file = currentFile(event?.reason);
    const { text, allowed } = classify(event?.reason, file);
    recorded.push({ file, reason: text.slice(0, 300), allowed });
    if (!allowed) {
      console.error(`[unhandled-guard] HARD-FAIL unexpected rejection (${file}): ${text.slice(0, 500)}`);
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
