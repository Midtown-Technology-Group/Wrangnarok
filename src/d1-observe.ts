// SPDX-License-Identifier: AGPL-3.0
// Per-query D1 cost telemetry, Slice A (issue #302).
//
// D1 bills by rows read, rows written, and storage, so query shape is a
// cost question, not just a latency question. This module is the single
// choke point for recording the D1 `meta` fields that matter: callers pass
// a stable operation name (never SQL, never bound values) and the promise
// of an already-built statement, and get one `WRANGNAROK_D1` log line per
// call carrying counts/durations only.
//
// Migration is opt-in, one call site at a time; the other ~400 raw
// `db.prepare()` sites keep working untouched until their turn comes.
import { scrubValueWithSecrets } from "./secrets";

export const D1_OBSERVE_VERSION = "wrangnarok.d1.v1";

/** Terminal D1 call shapes whose results carry a `meta` block. */
export type D1ObservedKind = "all" | "run" | "batch";

/** Structured per-query observation. Counts/durations/IDs only by
 * construction: no SQL text, no bound values, no payload bodies. */
export interface D1Observation {
  readonly version: typeof D1_OBSERVE_VERSION;
  /** Stable caller-chosen name such as "usage.persist". */
  readonly operation: string;
  readonly kind: D1ObservedKind;
  readonly rowsRead: number;
  readonly rowsWritten: number;
  /** Rows actually returned (results array length when exposed, else 0). */
  readonly rowsReturned: number;
  readonly durationMs: number;
  readonly servedByRegion?: string;
  readonly servedByPrimary?: boolean;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Extract an observation from a D1-shaped result without depending on the
 * generated worker types: anything with an object `meta` qualifies, and
 * unknown shapes degrade to zeros rather than throwing. */
export function extractD1Observation(
  operation: string,
  kind: D1ObservedKind,
  result: unknown,
  durationMs: number,
): D1Observation {
  const meta =
    typeof result === "object" && result !== null && "meta" in result ? (result as { meta?: unknown }).meta : undefined;
  const fields = typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>) : {};
  const results =
    typeof result === "object" && result !== null && "results" in result
      ? (result as { results?: unknown }).results
      : undefined;
  const observation: D1Observation = {
    version: D1_OBSERVE_VERSION,
    operation,
    kind,
    rowsRead: asNumber(fields["rows_read"]),
    rowsWritten: asNumber(fields["rows_written"]),
    rowsReturned: Array.isArray(results) ? results.length : 0,
    durationMs,
  };
  const region = fields["served_by_region"];
  const primary = fields["served_by_primary"];
  return {
    ...observation,
    ...(typeof region === "string" ? { servedByRegion: region } : {}),
    ...(typeof primary === "boolean" ? { servedByPrimary: primary } : {}),
  };
}

/** Console emission: JSON on one line behind a stable prefix for log
 * scraping. The observation carries counts/durations only by construction;
 * the scrub is a backstop so a secret-bearing value can never ride out. */
export function logD1Observation(observation: D1Observation, secrets: readonly unknown[] = []): void {
  console.log(`WRANGNAROK_D1 ${JSON.stringify(scrubValueWithSecrets(observation, secrets))}`);
}

/** Time `execute`, extract the D1 observation from its result, log it, and
 * return the result untouched. Observation must never break the query path:
 * logging failures are swallowed after a best-effort warn. */
export async function observeD1<T>(operation: string, kind: D1ObservedKind, execute: () => Promise<T>): Promise<T> {
  const start = Date.now();
  const result = await execute();
  try {
    logD1Observation(extractD1Observation(operation, kind, result, Date.now() - start));
  } catch {
    console.warn(`WRANGNAROK_D1_SKIPPED ${operation}`);
  }
  return result;
}
