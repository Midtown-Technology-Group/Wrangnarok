// SPDX-License-Identifier: AGPL-3.0
// Machine-readable usage block per ADR 004 (cost-logging requirement).
import { observeD1 } from "./d1-observe";
import { scrubValueWithSecrets } from "./secrets";
// Counts are application-observed D1 statements/rows and Workflow steps —
// not Cloudflare metering. Never carries secrets, tokens, or payload bodies:
// counts, IDs, durations, and status codes only.
export const USAGE_VERSION = "wrangnarok.usage.v1";
export interface UsageBlock {
  readonly version: typeof USAGE_VERSION;
  readonly saga: string;
  readonly sagaRevision: string;
  readonly executionId: string;
  readonly orgId: string;
  readonly status: string;
  readonly d1: {
    readonly operationRows: number;
    readonly reads: number;
    readonly writes: number;
  };
  readonly workflows: {
    readonly instancesStarted: 1;
    readonly stepsExecuted: number;
    readonly durationMs: number;
  };
  readonly workers: {
    // Not exposed to the Workflow at runtime; the submit path owns request
    // counting. Null here means "not observable from this surface".
    readonly requestsHandled: null;
    readonly cpuMs: null;
  };
  readonly note: string;
}
export function buildUsage(input: {
  saga: string;
  sagaRevision: string;
  executionId: string;
  orgId: string;
  status: string;
  operationRows: number;
  reads: number;
  writes: number;
  stepsExecuted: number;
  durationMs: number;
}): UsageBlock {
  return {
    version: USAGE_VERSION,
    saga: input.saga,
    sagaRevision: input.sagaRevision,
    executionId: input.executionId,
    orgId: input.orgId,
    status: input.status,
    d1: { operationRows: input.operationRows, reads: input.reads, writes: input.writes },
    workflows: { instancesStarted: 1, stepsExecuted: input.stepsExecuted, durationMs: input.durationMs },
    workers: { requestsHandled: null, cpuMs: null },
    note: "Application-observed statements/rows/steps in local or dev runtime; not Cloudflare metering. Verify allowances vs current Cloudflare pricing before claiming Free-tier headroom.",
  };
}
/** Console emission: JSON on one line behind a stable prefix for log scraping.
 * The block carries counts/IDs/durations only by construction; the scrub is a
 * backstop so a secret-bearing caller value can never ride a log line out. */
export function logUsage(usage: UsageBlock, secrets: readonly unknown[] = []): void {
  console.log(`WRANGNAROK_USAGE ${JSON.stringify(scrubValueWithSecrets(usage, secrets))}`);
}
/** Per-request access log: method, route, status, and duration only — never
 * headers, bodies, query strings, or secrets. Route is the raw /api/*
 * pathname (IDs are non-secret deterministic hashes) or "static". */
export interface RequestLog {
  readonly method: string;
  readonly route: string;
  readonly status: number;
  readonly durationMs: number;
}
export function logRequest(entry: RequestLog): void {
  console.log(`WRANGNAROK_REQUEST ${JSON.stringify(entry)}`);
}
/** Persisted Trail-adjacent record (no secrets). Best-effort: a missing table
 * (old DB before migration 0002) must not fail the Execution itself. */
export async function persistUsage(
  db: D1Database,
  executionId: string,
  usage: UsageBlock,
  secrets: readonly unknown[] = [],
): Promise<void> {
  try {
    await observeD1("usage.persist", "run", () =>
      db
        .prepare(
          "INSERT INTO usage_blocks(execution_id,usage_json,created_at) VALUES (?,?,?) ON CONFLICT(execution_id) DO NOTHING",
        )
        .bind(executionId, JSON.stringify(scrubValueWithSecrets(usage, secrets)), new Date().toISOString())
        .run(),
    );
  } catch {
    console.warn(`WRANGNAROK_USAGE_PERSIST_SKIPPED ${executionId}`);
  }
}
