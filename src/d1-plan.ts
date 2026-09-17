// SPDX-License-Identifier: AGPL-3.0
// Developer query-plan helper, Slice B (issue #302).
//
// Runs `EXPLAIN QUERY PLAN` for known hot-path queries and classifies the
// result coarsely: indexed SEARCH is healthy, full SCAN on a hot path
// deserves human review. SQLite documents EQP output as debugging-oriented
// and not a stable machine API, so classification is deliberately coarse
// (substring match on SCAN/SEARCH) and CI must treat it as advisory —
// human-readable output, never a hard gate on exact plan text.
export interface PlanStep {
  readonly id: number;
  readonly parent: number;
  readonly detail: string;
}

export type PlanClassification = "search" | "scan" | "mixed" | "unknown";

/** Minimal structural surface needed for EXPLAIN: satisfied by a real
 * D1Database and trivially stubbed in unit tests. */
export interface PlanCapableDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all<T>(): Promise<{ results: T[] }>;
    };
  };
}

function asPlanStep(row: unknown): PlanStep | null {
  if (typeof row !== "object" || row === null) return null;
  const fields = row as Record<string, unknown>;
  if (typeof fields["detail"] !== "string") return null;
  return {
    id: typeof fields["id"] === "number" ? fields["id"] : 0,
    parent: typeof fields["parent"] === "number" ? fields["parent"] : 0,
    detail: fields["detail"],
  };
}

/** Run EXPLAIN QUERY PLAN for one statement. Params bind positionally, so
 * the plan reflects the real query shape without embedding values. */
export async function explainQueryPlan(
  db: PlanCapableDb,
  sql: string,
  params: readonly unknown[] = [],
): Promise<PlanStep[]> {
  const out = await db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...params)
    .all<unknown>();
  const steps: PlanStep[] = [];
  for (const row of out.results ?? []) {
    const step = asPlanStep(row);
    if (step) steps.push(step);
  }
  return steps;
}

/** Coarse classification over EQP detail lines. Anything unexpected
 * (empty plan, unrecognized text) is "unknown", never a false healthy. */
export function classifyPlan(steps: readonly PlanStep[]): PlanClassification {
  if (steps.length === 0) return "unknown";
  let scan = false;
  let search = false;
  for (const step of steps) {
    const detail = step.detail.toUpperCase();
    if (detail.includes("SCAN")) scan = true;
    if (detail.includes("SEARCH")) search = true;
  }
  if (scan && search) return "mixed";
  if (scan) return "scan";
  if (search) return "search";
  return "unknown";
}

/** One hot-path query registered for plan review: stable operation name,
 * the exact SQL the caller runs, representative bind values, and the
 * classification a human last confirmed as healthy. */
export interface HotPathQuery {
  readonly operation: string;
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly expect: Exclude<PlanClassification, "unknown">;
}

export interface PlanReview {
  readonly operation: string;
  readonly classification: PlanClassification;
  readonly expected: HotPathQuery["expect"];
  readonly match: boolean;
  readonly steps: readonly PlanStep[];
}

/** Review registered hot-path queries against live plans. `match: false`
 * means "human, look at this" — never a thrown error, so reviewers can
 * run the whole registry and triage mismatches together. */
export async function reviewHotPaths(db: PlanCapableDb, queries: readonly HotPathQuery[]): Promise<PlanReview[]> {
  const reviews: PlanReview[] = [];
  for (const query of queries) {
    const steps = await explainQueryPlan(db, query.sql, query.params);
    const classification = classifyPlan(steps);
    reviews.push({
      operation: query.operation,
      classification,
      expected: query.expect,
      match: classification === query.expect,
      steps,
    });
  }
  return reviews;
}
