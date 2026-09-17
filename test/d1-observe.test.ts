// Slice A coverage for src/d1-observe.ts (issue #302): meta extraction,
// stable operation naming, and the untouched-result contract. Pure unit:
// no Worker runtime, no database — D1-shaped stubs only.
import { afterEach, expect, it, vi } from "vitest";
import { extractD1Observation, observeD1 } from "../src/d1-observe";

afterEach(() => {
  vi.restoreAllMocks();
});

it("extracts rows read/written, returned rows, and serving metadata", () => {
  const result = {
    results: [{ id: 1 }, { id: 2 }],
    meta: {
      rows_read: 14,
      rows_written: 2,
      served_by_region: "enam",
      served_by_primary: true,
    },
  };
  expect(extractD1Observation("usage.persist", "run", result, 9)).toMatchObject({
    version: "wrangnarok.d1.v1",
    operation: "usage.persist",
    kind: "run",
    rowsRead: 14,
    rowsWritten: 2,
    rowsReturned: 2,
    durationMs: 9,
    servedByRegion: "enam",
    servedByPrimary: true,
  });
});

it("degrades unknown result shapes to zeros instead of throwing", () => {
  expect(extractD1Observation("x.list", "all", null, 3)).toMatchObject({
    rowsRead: 0,
    rowsWritten: 0,
    rowsReturned: 0,
  });
  expect(extractD1Observation("x.list", "all", { results: "nope", meta: "nope" }, 3)).toMatchObject({
    rowsRead: 0,
    rowsWritten: 0,
    rowsReturned: 0,
  });
});

it("returns the query result untouched and logs counts, never SQL", async () => {
  const seen: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    seen.push(String(line));
  });
  const stub = { ok: true, meta: { rows_read: 5, rows_written: 1 } };
  const sql = "SELECT secret_payload FROM t WHERE id=?";
  const out = await observeD1("usage.persist", "run", () => Promise.resolve(stub));
  expect(out).toBe(stub);
  expect(seen).toHaveLength(1);
  expect(seen[0]?.startsWith("WRANGNAROK_D1 ")).toBe(true);
  expect(seen[0]).toContain('"operation":"usage.persist"');
  expect(seen[0]).toContain('"rowsRead":5');
  expect(seen[0]).not.toContain(sql);
  expect(seen[0]).not.toContain("secret_payload");
});
