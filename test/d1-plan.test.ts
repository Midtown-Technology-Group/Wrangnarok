// Slice B plus hot-path review coverage for src/d1-plan.ts (issue #302):
// EXPLAIN passthrough, coarse SCAN/SEARCH classification (covering-index
// and case variants included), and the review-everything verdict shape.
// Pure unit: stub database, no Worker runtime. Assertions stay coarse on
// purpose — EQP text is debugging output, not a stable machine API.
import { expect, it } from "vitest";
import type { HotPathQuery, PlanCapableDb, PlanStep } from "../src/d1-plan";
import { classifyPlan, explainQueryPlan, reviewHotPaths } from "../src/d1-plan";

function stubDb(rows: unknown[], seen: { sql?: string; params?: unknown[] }): PlanCapableDb {
  return {
    prepare(sql: string) {
      seen.sql = sql;
      return {
        bind(...values: unknown[]) {
          seen.params = values;
          return {
            all<T>() {
              return Promise.resolve({ results: rows as T[] });
            },
          };
        },
      };
    },
  };
}

const SEARCH: PlanStep[] = [
  { id: 2, parent: 0, detail: "SEARCH saga_policies USING PRIMARY KEY (org_id=? AND saga_id=?)" },
];
const SCAN: PlanStep[] = [{ id: 2, parent: 0, detail: "SCAN executions" }];

it("prefixes EXPLAIN and binds params positionally", async () => {
  const seen: { sql?: string; params?: unknown[] } = {};
  const steps = await explainQueryPlan(
    stubDb([{ id: 1, parent: 0, detail: "SEARCH t USING INDEX i (a=?)" }], seen),
    "SELECT a FROM t WHERE a=?",
    ["org"],
  );
  expect(seen.sql).toBe("EXPLAIN QUERY PLAN SELECT a FROM t WHERE a=?");
  expect(seen.params).toEqual(["org"]);
  expect(steps).toHaveLength(1);
  expect(steps[0]?.detail).toContain("SEARCH");
});

it("classifies search, scan, mixed, and empty plans", () => {
  expect(classifyPlan(SEARCH)).toBe("search");
  expect(classifyPlan(SCAN)).toBe("scan");
  expect(classifyPlan([...SEARCH, ...SCAN])).toBe("mixed");
  expect(classifyPlan([])).toBe("unknown");
  expect(classifyPlan([{ id: 0, parent: 0, detail: "USE TEMP B-TREE FOR ORDER BY" }])).toBe("unknown");
});

it("classifies covering-index and lowercase plan lines coarsely", () => {
  expect(
    classifyPlan([
      { id: 3, parent: 0, detail: "SEARCH executions USING COVERING INDEX executions_history (org_id=?)" },
    ]),
  ).toBe("search");
  expect(classifyPlan([{ id: 3, parent: 0, detail: "scan execution_logs" }])).toBe("scan");
  expect(
    classifyPlan([
      { id: 2, parent: 0, detail: "SEARCH connections USING INDEX sqlite_autoindex_connections_2 (org_id=?)" },
      { id: 5, parent: 0, detail: "USE TEMP B-TREE FOR ORDER BY" },
    ]),
  ).toBe("search");
});

it("drops malformed EXPLAIN rows instead of throwing", async () => {
  const steps = await explainQueryPlan(stubDb(["nope", { id: 1 }], {}), "SELECT 1", []);
  expect(steps).toEqual([]);
});

it("reviews the whole registry and flags mismatches without throwing", async () => {
  const queries: HotPathQuery[] = [
    { operation: "saga-policy.load", sql: "SELECT a FROM t WHERE a=?", params: ["o"], expect: "search" },
    { operation: "executions.list", sql: "SELECT a FROM t", params: [], expect: "search" },
  ];
  const calls: unknown[][] = [
    [{ id: 2, parent: 0, detail: "SEARCH t USING INDEX i (a=?)" }],
    [{ id: 3, parent: 0, detail: "SCAN t" }],
  ];
  const db: PlanCapableDb = {
    prepare() {
      return {
        bind() {
          return {
            all<T>() {
              return Promise.resolve({ results: (calls.shift() ?? []) as T[] });
            },
          };
        },
      };
    },
  };
  const reviews = await reviewHotPaths(db, queries);
  expect(reviews).toHaveLength(2);
  expect(reviews[0]).toMatchObject({ operation: "saga-policy.load", classification: "search", match: true });
  expect(reviews[1]).toMatchObject({ operation: "executions.list", classification: "scan", match: false });
});

it("resolves an empty registry without throwing", async () => {
  const db: PlanCapableDb = {
    prepare() {
      throw new Error("must not query for an empty registry");
    },
  };
  await expect(reviewHotPaths(db, [])).resolves.toEqual([]);
});
