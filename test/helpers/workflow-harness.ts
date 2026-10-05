// SPDX-License-Identifier: AGPL-3.0
// Shared Workflow-runtime test harness (issues #332/#333).
//
// Workflow-backed suites previously applied ad-hoc migration subsets in
// beforeEach, so a Workflow step touching a table outside the subset failed
// with `D1_ERROR: no such table` as an unhandled workerd exception instead
// of a readable test failure. This helper applies the FULL migration set in
// filename order before each test, tracks every Workflow introspector the
// test creates, and drains each tracked instance to a terminal status before
// disposing it so no in-flight engine promise outlives the test file's
// `reset()` boundary.
//
// Files with intentional partial-migration coverage (pre-migration 503
// gates, DROP-rebuild sequences) keep their hand-built setup and must NOT
// adopt this helper: applying the full set would mask the gate under test.
import { introspectWorkflowInstance, reset } from "cloudflare:test";
import type { WorkflowInstanceIntrospector } from "cloudflare:test";
import { afterEach, beforeEach, vi } from "vitest";
import migration0001 from "../../migrations/0001_initial.sql?raw";
import migration0002 from "../../migrations/0002_cancelling.sql?raw";
import migration0003 from "../../migrations/0003_usage_blocks.sql?raw";
import migration0004 from "../../migrations/0004_solutions_install.sql?raw";
import migration0005 from "../../migrations/0005_forms.sql?raw";
import migration0006 from "../../migrations/0006_apps.sql?raw";
import migration0007 from "../../migrations/0007_org_membership.sql?raw";
import migration0008 from "../../migrations/0008_executions_org_fk.sql?raw";
import migration0009 from "../../migrations/0009_tables.sql?raw";
import migration0010 from "../../migrations/0010_solutions_activation.sql?raw";
import migration0011 from "../../migrations/0011_connection_admin.sql?raw";
import migration0012 from "../../migrations/0012_saga_policies.sql?raw";
import migration0013 from "../../migrations/0013_resource_roles.sql?raw";
import migration0014 from "../../migrations/0014_execution_logs.sql?raw";
import migration0015 from "../../migrations/0015_child_lineage.sql?raw";
import migration0016 from "../../migrations/0016_schedules.sql?raw";
import migration0018 from "../../migrations/0018_ops.sql?raw";
import migration0019 from "../../migrations/0019_files.sql?raw";
import migration0020 from "../../migrations/0020_artifacts.sql?raw";
import migration0021 from "../../migrations/0021_endpoints.sql?raw";
import migration0022 from "../../migrations/0022_app_runtime.sql?raw";
import migration0023 from "../../migrations/0023_config.sql?raw";
import migration0024 from "../../migrations/0024_tool_enrollments.sql?raw";
// 0025-0027 are stuck-database convergence repairs, not fresh-chain schema:
// applying them here rebuilds `executions` without later columns (e.g.
// parent_execution_id from 0015) and breaks harness suites, so the harness
// chain skips them. Stuck-database recovery stays owned by
// docs/migration-ledger.md.
import migration0029 from "../../migrations/0029_connection_secrets.sql?raw";
import migration0030 from "../../migrations/0030_events.sql?raw";
import migration0031 from "../../migrations/0031_oauth_tokens.sql?raw";
import migration0033 from "../../migrations/0033_event_subscriptions.sql?raw";
import migration0038 from "../../migrations/0038_capability_resolution.sql?raw";
import migration0041 from "../../migrations/0041_mcp_external.sql?raw";
import seed from "../../scripts/seed-local.sql?raw";

/** Every migration in filename order. 0017 is reserved (see
 * docs/migration-ledger.md) and intentionally absent. Keep this list in sync
 * with migrations/*.sql: a new migration must be appended here in the same
 * commit that lands it, or harness users silently test a partial schema. */
const FULL_MIGRATIONS = [
  migration0001,
  migration0002,
  migration0003,
  migration0004,
  migration0005,
  migration0006,
  migration0007,
  migration0008,
  migration0009,
  migration0010,
  migration0011,
  migration0012,
  migration0013,
  migration0014,
  migration0015,
  migration0016,
  migration0018,
  migration0019,
  migration0020,
  migration0021,
  migration0022,
  migration0023,
  migration0024,
  migration0029,
  migration0030,
  migration0031,
  migration0033,
  migration0038,
  migration0041,
] as const;

export type WorkflowHarnessDb = Pick<D1Database, "exec" | "prepare" | "batch">;

export interface WorkflowHarnessOptions {
  /** When true (default), inserts the local fixture org + echo connection
   * seed after migrating. Disable for tests that build their own org rows. */
  readonly seed?: boolean;
  /** Extra per-test setup after migrate+seed (fetch mocks, org rows). Runs
   * inside beforeEach so failures fail the test, not the harness. */
  readonly setup?: () => Promise<void> | void;
  /** Extra teardown after drain+reset (secret-registry clears, temp state).
   * Runs inside afterEach so it executes even when the test fails. */
  readonly teardown?: () => Promise<void> | void;
  /** Terminal statuses considered healthy at drain time. Defaults to the
   * three settled engine states; override per test when an instance is
   * expected to still be running (e.g. cancel-race windows). */
  readonly drainStatuses?: ReadonlyArray<DrainStatus>;
}

/** Terminal status accepted by the harness drain, derived from the
 * cloudflare:test introspector contract so engine status renames break the
 * build here instead of silently widening. */
export type DrainStatus = Parameters<WorkflowInstanceIntrospector["waitForStatus"]>[0];

export interface TrackedWorkflowInstance {
  /** The underlying cloudflare:test introspector. */
  readonly inner: WorkflowInstanceIntrospector;
  /** Wait for the instance to settle, then dispose it. Awaited by the
   * harness afterEach: no fire-and-forget waits cross the reset boundary. */
  readonly drain: (status?: DrainStatus) => Promise<void>;
  /** Dispose immediately without waiting (escape hatch for tests that assert
   * on mid-flight states). Prefer drain: undisposed in-flight instances are
   * the source of cross-test `instance.not_found` unhandled rejections. */
  readonly dispose: () => Promise<void>;
  /** Last terminal status the test itself awaited via this handle (null when
   * the test never waited). The harness drain tries it first. */
  readonly lastAwaited: () => DrainStatus | null;
}

interface HarnessState {
  instances: TrackedWorkflowInstance[];
  options: WorkflowHarnessOptions;
}

const state: HarnessState = { instances: [], options: {} };

/** Apply the full migration set plus optional seed to `db`. Exported for
 * files that need migrate-without-hooks (nested describes with their own
 * lifecycle); prefer `useWorkflowHarness` for the standard shape. */
export async function applyFullMigrations(db: WorkflowHarnessDb, withSeed = true): Promise<void> {
  for (const migration of FULL_MIGRATIONS) {
    await db.exec(migration);
  }
  if (withSeed) {
    await db.exec(seed);
  }
}

/** Track an introspector created via `introspectWorkflowInstance` so the
 * harness afterEach drains and disposes it. Replaces bare
 * `await using instance = ...` (whose implicit dispose at scope end races
 * the engine's terminal write) with an explicitly awaited drain. */
export async function trackWorkflowInstance(workflow: Workflow, instanceId: string): Promise<TrackedWorkflowInstance> {
  const raw = await introspectWorkflowInstance(workflow, instanceId);
  // Remember the last status the test itself awaited: the drain tries it
  // first, so the common case (test already settled the instance) resolves
  // immediately instead of probing a wrong terminal state and tripping
  // engine-side finite-status telemetry.
  let lastAwaited: DrainStatus | null = null;
  const inner = new Proxy(raw, {
    get(target, prop, receiver) {
      if (prop === "waitForStatus") {
        return async (status: DrainStatus) => {
          await (target.waitForStatus as (s: DrainStatus) => Promise<void>)(status);
          lastAwaited = status;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as WorkflowInstanceIntrospector;
  const tracked: TrackedWorkflowInstance = {
    inner,
    drain: async (status = "complete") => {
      await inner.waitForStatus(status);
      await inner.dispose();
    },
    dispose: () => inner.dispose(),
    lastAwaited: () => lastAwaited,
  };
  state.instances.push(tracked);
  return tracked;
}

/** Wait for `promise` up to `ms`, resolving to "timeout" instead of hanging
 * the afterEach hook (vitest hooks time out at 10s; a wedged drain must
 * never get there). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout>;
  const gate = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  return Promise.race([
    promise
      .then((value) => ({ value }))
      .then(
        ({ value }) => {
          clearTimeout(timer);
          return value as T | "timeout";
        },
        (error: unknown) => {
          clearTimeout(timer);
          throw error;
        },
      ),
    gate.then((marker) => {
      clearTimeout(timer);
      return marker;
    }),
  ]);
}

/** Drain every tracked instance, then dispose. Runs in afterEach BEFORE
 * `reset()`: dispose-then-reset lets the engine's terminal write land on a
 * live binding; reset-then-dispose orphans it into an unhandled rejection.
 *
 * Waits are bounded (2s per instance): instances that never dispatch (400
 * submit paths, fault-injected controls) or wedge mid-flight must not hang
 * the hook — and a hung afterEach would skip `reset()`, cascading
 * already-exists DDL failures into every later test in the file. The test's
 * own assertions already covered the outcome; the drain exists only to keep
 * engine promises inside the test lifetime. Dispose is always attempted so
 * introspector resources never leak across the reset boundary. */
async function drainAll(): Promise<void> {
  const pending = state.instances.splice(0, state.instances.length);
  const allowed: ReadonlyArray<DrainStatus> = state.options.drainStatuses ?? ["complete", "errored", "terminated"];
  await Promise.all(
    pending.map(async (tracked) => {
      const hint = tracked.lastAwaited();
      const ordered = hint === null ? allowed : [hint, ...allowed.filter((status) => status !== hint)];
      for (const status of ordered) {
        try {
          const settled = await withTimeout(tracked.inner.waitForStatus(status), 2000);
          if (settled !== "timeout") break;
          // Still mid-flight after 2s: stop waiting, dispose below.
          break;
        } catch {
          // Finite-but-unexpected terminal: try the next allowed one, which
          // resolves immediately when the instance already sits in it.
        }
      }
      try {
        await tracked.dispose();
      } catch {
        // Already disposed (explicit early dispose in the test): harmless.
      }
    }),
  );
}

/** Standard harness lifecycle for one Workflow-backed test file:
 * full-migration apply (+seed) in beforeEach, optional extra setup, then
 * drain-then-reset plus fetch-mock restore in afterEach with every wait
 * explicitly awaited. Call once at module scope; call `trackWorkflowInstance`
 * instead of raw `introspectWorkflowInstance` for each instance. */
export function useWorkflowHarness(db: WorkflowHarnessDb, options: WorkflowHarnessOptions = {}): void {
  state.options = options;
  beforeEach(async () => {
    await applyFullMigrations(db, options.seed ?? true);
    await options.setup?.();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await drainAll();
    await reset();
    await options.teardown?.();
  });
}
