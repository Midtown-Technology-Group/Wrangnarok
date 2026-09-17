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

it("emits counts-only telemetry for the hot-path history operations", async () => {
  const seen: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    seen.push(String(line));
  });
  const allowed = new Set([
    "version",
    "operation",
    "kind",
    "rowsRead",
    "rowsWritten",
    "rowsReturned",
    "durationMs",
    "servedByRegion",
    "servedByPrimary",
  ]);
  const secretValue = "hotpath-secret-value-sentinel";
  for (const operation of ["executions.history", "executions.history-filtered", "execution-logs.tail"] as const) {
    seen.length = 0;
    const stub = { results: [{ id: 1 }], meta: { rows_read: 7, rows_written: 0 } };
    const out = await observeD1(operation, "all", () => Promise.resolve(stub));
    expect(out).toBe(stub);
    expect(seen).toHaveLength(1);
    const line = seen[0] ?? "";
    expect(line.startsWith("WRANGNAROK_D1 ")).toBe(true);
    const payload = JSON.parse(line.slice("WRANGNAROK_D1 ".length)) as Record<string, unknown>;
    for (const key of Object.keys(payload)) expect(allowed.has(key)).toBe(true);
    expect(payload.operation).toBe(operation);
    expect(payload.kind).toBe("all");
    expect(payload.rowsRead).toBe(7);
    expect(payload.rowsReturned).toBe(1);
    expect(line).not.toContain(secretValue);
    expect(line).not.toContain("SELECT");
    expect(line).not.toContain("secret_payload");
  }
});

it("never emits the SQL or bound values captured by the executed closure", async () => {
  const seen: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    seen.push(String(line));
  });
  const sql = "SELECT id FROM executions WHERE org_id=? AND user_id=? AND status IN (?,?)";
  const boundOrg = "org-bound-sentinel-0001";
  const boundStatus = "Running";
  const stub = { results: [], meta: { rows_read: 3, rows_written: 0 } };
  await observeD1("executions.history-filtered", "all", () => {
    // The closure captures the statement shape and binds; telemetry must not
    // repeat any of it — only the D1 meta counts flow out.
    void sql;
    void boundOrg;
    void boundStatus;
    return Promise.resolve(stub);
  });
  expect(seen).toHaveLength(1);
  const line = seen[0] ?? "";
  expect(line).toContain('"operation":"executions.history-filtered"');
  expect(line).toContain('"rowsRead":3');
  expect(line).not.toContain(sql);
  expect(line).not.toContain(boundOrg);
  expect(line).not.toContain(boundStatus);
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
