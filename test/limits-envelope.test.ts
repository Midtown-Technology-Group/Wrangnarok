// SPDX-License-Identifier: AGPL-3.0
// LIMITS-01 feasibility-envelope contract (issue #177): the dated
// capability-versus-limit matrix must cover every required capability row,
// label the evidence class of each number, classify the OAuth Durable Object
// explicitly, model representative multi-org workloads, and carry a
// truthful machine-readable LIMITS-META block — all without credentials or
// deployment. The soft budget is advisory per owner decision, so this suite
// pins the META block shape (parseable JSON, sane fields) rather than exact
// agreement with the budget script. Pure string assertions over ?raw
// imports (workerd-safe); the bundle build itself stays in check:bundle.
import { describe, expect, it } from "vitest";
import envelope from "../docs/feasibility-envelope.md?raw";
import budgetScript from "../scripts/check-bundle-budget.mjs?raw";

function required(pattern: RegExp, label: string): void {
  expect(envelope, `feasibility matrix missing ${label}`).toMatch(pattern);
}

function parseMeta(): Record<string, number | string> {
  const match = envelope.match(/<!-- LIMITS-META (\{.*?\}) -->/);
  expect(match, "LIMITS-META block missing from docs/feasibility-envelope.md").not.toBeNull();
  return JSON.parse(match?.[1] ?? "{}");
}

describe("feasibility envelope (LIMITS-01)", () => {
  it("is dated with a valid non-future check date", () => {
    const match = envelope.match(/^Dated: (\d{4}-\d{2}-\d{2})\./m);
    expect(match, "Dated: YYYY-MM-DD header missing").not.toBeNull();
    const checked = new Date(`${match?.[1]}T00:00:00Z`).getTime();
    expect(Number.isNaN(checked)).toBe(false);
    expect(checked).toBeLessThanOrEqual(Date.now());
  });

  it("carries a truthful LIMITS-META block (advisory reference levels)", () => {
    const meta = parseMeta();
    // Shape guards: the block must parse and carry sane reference fields.
    // Exact agreement with BUDGET_BYTES / MIN_HEADROOM_BYTES is advisory
    // per owner decision (issue #177) and is reported — not gated — by
    // scripts/check-bundle-budget.mjs, so stale bookkeeping never fails CI.
    expect(typeof meta.budgetKiB).toBe("number");
    expect(meta.budgetKiB).toBeGreaterThan(0);
    expect(typeof meta.minHeadroomBytes).toBe("number");
    expect(meta.minHeadroomBytes).toBeGreaterThanOrEqual(0);
    expect(typeof meta.measuredBytes).toBe("number");
    expect(meta.measuredBytes).toBeGreaterThan(0);
    expect(typeof meta.measuredDate).toBe("string");
    expect(meta.measuredDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Reference levels stay declared so prose cannot silently trail code.
    expect(budgetScript).toMatch(/const BUDGET_BYTES = \d+ \* 1024;/);
    expect(budgetScript).toMatch(/const MIN_HEADROOM_BYTES = \d+ \* 1024;/);
  });

  it("covers every required capability row", () => {
    required(/worker(s)?\s+(cpu|bundle|request|egress)/i, "Worker CPU/bundle/egress");
    required(/workflows?\s+(instances|steps)/i, "Workflows instances/steps");
    required(/retention/i, "Workflows history retention");
    required(/rows?\s+read/i, "D1 rows read");
    required(/written/i, "D1 rows written");
    required(/per-database|database size/i, "D1 per-database limit");
    required(/transaction|batch discipline/i, "D1 transaction discipline");
    required(/\bR2\b/, "R2");
    required(/access/i, "Access users");
    required(/vector/i, "model/vector costs");
    required(/build/i, "build costs");
    required(/durable objects?/i, "Durable Objects row");
  });

  it("separates evidence classes instead of mixing meters and estimates", () => {
    required(/provider-published/i, "provider-published evidence class");
    required(/locally measured/i, "locally measured evidence class");
    required(/estimate/i, "estimate evidence class");
    required(/deployment authority/i, "requires-deployment-authority class");
  });

  it("classifies deferred capabilities with an explicit path", () => {
    required(/paid-adaptation/i, "paid-adaptation classification");
    required(/redesign/i, "redesign classification");
    required(/unresolved/i, "unresolved classification");
    required(/multi-org/i, "representative multi-org workloads");
  });

  it("never lets unrelated green tests count as parity", () => {
    required(/green unrelated tests never count as parity/i, "parity-counting rule");
  });
});
