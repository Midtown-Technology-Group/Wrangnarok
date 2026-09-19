// SPDX-License-Identifier: AGPL-3.0
// OPS-04 slice S1 (issue #175): GET /api/usage/summary over usage_blocks.
// Org-scoped attributed summaries with explicit unpriced gaps, duplicate
// safety on execution_id, cancellation awareness, and negative tests
// (unauthorized aggregation, count leakage). S2 pricing/ROI is no-build:
// every response must carry the gap labels and no money figure.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { buildUsage, persistUsage } from "../src/usage";
import { getUsageSummary, parseUsageSummaryQuery } from "../src/usage-reports";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration3 from "../migrations/0003_usage_blocks.sql?raw";
import migrationOrg from "../migrations/0007_org_membership.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const ORG = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG = "00000000-0000-4000-8000-000000000009";
const OTHER_USER = "00000000-0000-4000-8000-000000000003";
const USER = "00000000-0000-4000-8000-000000000002";

function headers(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
}

function call(path: string, orgId = ORG, userId?: string) {
  return worker.fetch(new Request(`https://local.test${path}`, { method: "GET", headers: headers() }), {
    ...bindings,
    LAB_ORG_ID: orgId,
    ...(userId ? { LAB_USER_ID: userId } : {}),
  });
}

async function summary(path = "/api/usage/summary", orgId = ORG, userId?: string) {
  const response = await call(path, orgId, userId);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    usage: {
      orgId: string;
      window: { start: string | null; end: string | null };
      totals: Record<string, number>;
      bySaga: { saga: string; executions: number; d1Reads: number; d1Writes: number }[];
      byStatus: Record<string, number>;
      cancelledExecutions: number;
      matchedExecutions: number;
      truncated: boolean;
      gaps: Record<string, unknown>;
      note: string;
    };
  };
}

let seq = 0;
function execId(): string {
  seq += 1;
  return `${String(seq).padStart(2, "0")}ab`.padEnd(64, "0").slice(0, 64);
}

async function seedExecution(options: {
  saga?: string;
  status?: string;
  orgId?: string;
  createdAt?: string;
  usageCreatedAt?: string;
  reads?: number;
  writes?: number;
}): Promise<string> {
  const id = execId();
  const saga = options.saga ?? "system.smoke";
  const status = options.status ?? "Succeeded";
  const orgId = options.orgId ?? ORG;
  const stamp = options.createdAt ?? "2026-09-01T00:00:00.000Z";
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?) ON CONFLICT(id) DO NOTHING")
    .bind(orgId, orgId === ORG ? "Local demo" : "Foreign demo")
    .run();
  await bindings.DB.prepare(
    "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(id, "saga-id", saga, `${saga}-v1`, orgId, USER, "{}", 1, status, stamp, stamp)
    .run();
  const usage = buildUsage({
    saga,
    sagaRevision: `${saga}-v1`,
    executionId: id,
    orgId,
    status,
    operationRows: 4,
    reads: options.reads ?? 4,
    writes: options.writes ?? 8,
    stepsExecuted: 4,
    durationMs: 12,
  });
  await persistUsage(bindings.DB, id, usage);
  if (options.usageCreatedAt) {
    await bindings.DB.prepare("UPDATE usage_blocks SET created_at=? WHERE execution_id=?")
      .bind(options.usageCreatedAt, id)
      .run();
  }
  return id;
}

beforeEach(async () => {
  seq = 0;
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(migration3);
  await bindings.DB.exec(migrationOrg);
  await bindings.DB.exec(seed);
});

afterEach(async () => {
  await reset();
});

it("summarizes own-org blocks per Saga with honest gaps and no money", async () => {
  await seedExecution({ saga: "system.smoke", reads: 4, writes: 8 });
  await seedExecution({ saga: "system.smoke", reads: 6, writes: 2 });
  await seedExecution({ saga: "other.saga", reads: 1, writes: 1 });
  const { usage } = await summary();
  expect(usage.orgId).toBe(ORG);
  expect(usage.totals).toMatchObject({ executions: 3, d1Reads: 11, d1Writes: 11 });
  expect(usage.bySaga).toHaveLength(2);
  expect(usage.bySaga.find((row) => row.saga === "system.smoke")).toMatchObject({ executions: 2 });
  expect(usage.byStatus).toMatchObject({ Succeeded: 3 });
  expect(usage.cancelledExecutions).toBe(0);
  expect(usage.gaps).toMatchObject({
    modelTokenCosts: "unpriced",
    providerBilling: "unavailable",
    estimates: "none",
    currency: null,
  });
  // S2 no-build: no money figure rides the response — only the explicit
  // gap labels (which name the missing dimensions without valuing them).
  // Recurse the whole payload: any cost/price/savings/currency key with a
  // non-null value fails.
  const moneyKeys = ["cost", "price", "pricing", "total_value", "savings", "revenue", "currency"];
  const stack: unknown[] = [usage];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      stack.push(...current);
    } else if (typeof current === "object" && current !== null) {
      for (const [key, value] of Object.entries(current)) {
        if (moneyKeys.includes(key) && value !== null) {
          throw new Error(`S2 no-build violation: money field ${key}=${JSON.stringify(value)}`);
        }
        stack.push(value);
      }
    }
  }
  expect(usage.note).toMatch(/not Cloudflare metering/i);
});

it("reports the truncation contract instead of a silent prefix", async () => {
  await seedExecution({ usageCreatedAt: "2026-09-01T00:00:00.000Z" });
  await seedExecution({ usageCreatedAt: "2026-09-02T00:00:00.000Z" });
  await seedExecution({ usageCreatedAt: "2026-09-03T00:00:00.000Z" });
  const query = { saga: null, startAt: null, endAt: null };
  const full = await getUsageSummary(bindings.DB, ORG, query);
  expect(full).toMatchObject({ matchedExecutions: 3, truncated: false });
  // Oldest rows win the cap, and the response says it is a prefix.
  const capped = await getUsageSummary(bindings.DB, ORG, query, 2);
  expect(capped).toMatchObject({ matchedExecutions: 3, truncated: true });
  expect(capped.totals.executions).toBe(2);
  const overHttp = await summary();
  expect(overHttp.usage).toMatchObject({ matchedExecutions: 3, truncated: false });
});

it("counts a duplicate persist once per execution_id", async () => {
  const id = await seedExecution({});
  const again = buildUsage({
    saga: "system.smoke",
    sagaRevision: "system.smoke-v1",
    executionId: id,
    orgId: ORG,
    status: "Succeeded",
    operationRows: 400,
    reads: 400,
    writes: 400,
    stepsExecuted: 40,
    durationMs: 400,
  });
  await persistUsage(bindings.DB, id, again);
  const { usage } = await summary();
  expect(usage.totals).toMatchObject({ executions: 1, d1Reads: 4, d1Writes: 8 });
});

it("is cancellation-aware", async () => {
  await seedExecution({ status: "Succeeded" });
  await seedExecution({ status: "Cancelled" });
  await seedExecution({ status: "Cancelling" });
  const { usage } = await summary();
  expect(usage.totals.executions).toBe(3);
  expect(usage.byStatus).toMatchObject({ Succeeded: 1, Cancelled: 1, Cancelling: 1 });
  expect(usage.cancelledExecutions).toBe(2);
});

it("filters by inclusive time window and saga, failing closed on bad queries", async () => {
  await seedExecution({ saga: "system.smoke", usageCreatedAt: "2026-09-01T00:00:00.000Z" });
  await seedExecution({ saga: "other.saga", usageCreatedAt: "2026-09-10T00:00:00.000Z" });
  // A date-only endDate covers its whole calendar day: a late record on the
  // end day is inside the inclusive window, the next day is outside it.
  await seedExecution({ saga: "other.saga", usageCreatedAt: "2026-09-15T18:30:00.000Z" });
  await seedExecution({ saga: "other.saga", usageCreatedAt: "2026-09-16T00:00:01.000Z" });
  const windowed = await summary("/api/usage/summary?startDate=2026-09-05&endDate=2026-09-15");
  expect(windowed.usage.totals.executions).toBe(2);
  expect(windowed.usage.window).toMatchObject({
    start: "2026-09-05T00:00:00.000Z",
    end: "2026-09-15T23:59:59.999Z",
  });
  // A full-instant endDate keeps its exact bound (no day rounding).
  const exact = await summary("/api/usage/summary?startDate=2026-09-05&endDate=2026-09-15T18:30:00.000Z");
  expect(exact.usage.totals.executions).toBe(2);
  const before = await summary("/api/usage/summary?startDate=2026-09-05&endDate=2026-09-15T18:29:59.999Z");
  expect(before.usage.totals.executions).toBe(1);
  const bySaga = await summary("/api/usage/summary?saga=other.saga");
  expect(bySaga.usage.totals.executions).toBe(3);
  expect(bySaga.usage.bySaga).toHaveLength(1);
  expect((await call("/api/usage/summary?startDate=2026-09-15&endDate=2026-09-05")).status).toBe(400);
  expect(await (await call("/api/usage/summary?startDate=nope")).json()).toMatchObject({
    error: { code: "INVALID_START_DATE" },
  });
  expect(await (await call("/api/usage/summary?orgId=whatever")).json()).toMatchObject({
    error: { code: "UNSUPPORTED_QUERY" },
  });
});

it("never leaks counts across Organizations", async () => {
  await seedExecution({ orgId: ORG });
  await seedExecution({ orgId: OTHER_ORG });
  const home = await summary("/api/usage/summary", ORG);
  expect(home.usage.totals.executions).toBe(1);
  const foreign = await summary("/api/usage/summary", OTHER_ORG);
  expect(foreign.usage.orgId).toBe(OTHER_ORG);
  expect(foreign.usage.totals.executions).toBe(1);
  // Spoofed usage_json.orgId cannot move counts: the join binds executions.
  await bindings.DB.prepare("UPDATE usage_blocks SET usage_json=replace(usage_json,?,?)").bind(OTHER_ORG, ORG).run();
  const releaked = await summary("/api/usage/summary", ORG);
  expect(releaked.usage.totals.executions).toBe(1);
});

it("denies strangers and lets viewers read (viewer-ceiling reads)", async () => {
  await seedExecution({});
  const stamp = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
    .bind(OTHER_USER, stamp)
    .run();
  // Stranger: no membership row — the membership gate answers 404, never counts.
  const strangerBindings = {
    ...bindings,
    LAB_USER_ID: OTHER_USER,
    LAB_FIXTURE_USER_ID: USER,
  };
  const stranger = await worker.fetch(new Request("https://local.test/api/usage/summary", { headers: headers() }), {
    ...strangerBindings,
    LAB_ORG_ID: ORG,
  });
  expect(stranger.status).toBe(404);
  // Viewer: read-only ceiling still permits reads (no admin-only gate here).
  await bindings.DB.prepare(
    "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(ORG, OTHER_USER, "viewer", "active", "ordinary", stamp, stamp)
    .run();
  const viewer = await summary("/api/usage/summary", ORG, OTHER_USER);
  expect(viewer.usage.totals.executions).toBe(1);
});

it("counts corrupt blocks as gaps instead of failing", async () => {
  const id = await seedExecution({});
  await bindings.DB.prepare("UPDATE usage_blocks SET usage_json='{{{corrupt' WHERE execution_id=?").bind(id).run();
  const { usage } = await summary();
  expect(usage.totals.executions).toBe(0);
  expect(usage.gaps).toMatchObject({ unreadableBlocks: 1 });
});

it("degrades to zeros on a pre-migration database instead of failing", async () => {
  const noTable = {
    prepare: () => {
      throw new Error("no such table: usage_blocks");
    },
  } as unknown as D1Database;
  const degraded = await getUsageSummary(noTable, ORG, { saga: null, startAt: null, endAt: null });
  expect(degraded).toMatchObject({
    orgId: ORG,
    totals: { executions: 0 },
    cancelledExecutions: 0,
  });
  expect(degraded.bySaga).toEqual([]);
  expect(degraded.gaps).toMatchObject({ modelTokenCosts: "unpriced" });
  // Genuine store failures still surface instead of degrading to zeros.
  const broken = {
    prepare: () => {
      throw new Error("D1 overloaded");
    },
  } as unknown as D1Database;
  await expect(getUsageSummary(broken, ORG, { saga: null, startAt: null, endAt: null })).rejects.toThrow(
    "D1 overloaded",
  );
});

it("treats hostile block shapes as zero counters, never a throw", async () => {
  const payloads = [
    "42",
    "null",
    JSON.stringify({ d1: { reads: -5, writes: "many", operationRows: NaN }, workflows: null }),
    JSON.stringify({ version: "wrangnarok.usage.v1" }),
  ];
  let n = 0;
  for (const payload of payloads) {
    n += 1;
    const id = `${String(n).padStart(2, "0")}cd`.padEnd(64, "0").slice(0, 64);
    const stamp = "2026-09-01T00:00:00.000Z";
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(id, "saga-id", "odd.shapes", "odd.shapes-v1", ORG, USER, "{}", 1, "Succeeded", stamp, stamp)
      .run();
    await bindings.DB.prepare("INSERT INTO usage_blocks(execution_id,usage_json,created_at) VALUES (?,?,?)")
      .bind(id, payload, stamp)
      .run();
  }
  const { usage } = await summary();
  expect(usage.totals).toMatchObject({ executions: 2, d1Reads: 0, d1Writes: 0 });
  expect(usage.gaps).toMatchObject({ unreadableBlocks: 2 });
});

it("rejects unknown query keys without touching the database", () => {
  expect(() => parseUsageSummaryQuery(new URLSearchParams("foo=1"))).toThrowError(
    expect.objectContaining({ code: "UNSUPPORTED_QUERY" }),
  );
  expect(() => parseUsageSummaryQuery(new URLSearchParams("saga="))).toThrowError(
    expect.objectContaining({ code: "INVALID_SAGA" }),
  );
});
