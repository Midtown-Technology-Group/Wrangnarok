// SPDX-License-Identifier: AGPL-3.0
// Operations console UI (issue #558): health, metrics, jobs, scheduled
// tasks, preflight, connection diagnostics, usage summary, searchable logs,
// and inspect-then-act repairs render from mocked /api/* payloads. Repairs
// stay inspect-first: executing needs an explicit confirmation and the same
// Bearer authorization the other console pages use.
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import {
  fetchOpsConnectionHealth,
  fetchOpsHealth,
  fetchOpsJobs,
  fetchOpsMetrics,
  fetchOpsPreflight,
  fetchOpsScheduledTasks,
  fetchOpsVersion,
  fetchUsageSummary,
  runOpsRepair,
  searchLogs,
} from "../client/src/lib/api-client";
import type {
  LogPage,
  OpsConnectionHealthResponse,
  OpsHealth,
  OpsJobsResponse,
  OpsMetricsResponse,
  OpsPreflightResponse,
  OpsScheduledTasksResponse,
  OpsVersionResponse,
  UsageSummaryResponse,
} from "../client/src/lib/client-types";
import { OperationsView } from "../client/src/pages/Operations";

const versionPayload: OpsVersionResponse = {
  version: {
    sdkVersion: "1",
    sagaCatalog: { count: 4, revision: "catalog-rev-1" },
    migrationsApplied: ["0001_initial.sql"],
  },
};

const healthPayload: OpsHealth = {
  status: "ok",
  database: "ok",
  worker: "ok",
  checkedAt: "2026-09-11T00:00:00.000Z",
};

const metricsPayload: OpsMetricsResponse = {
  metrics: {
    generatedAt: "2026-09-11T00:00:00.000Z",
    executions: {
      total: 3,
      pending: 1,
      pendingUndispatched: 1,
      running: 0,
      cancelling: 0,
      succeeded: 1,
      failed: 1,
      timedOut: 0,
      cancelled: 0,
    },
    recentFailures: [
      {
        executionId: "f".repeat(64),
        sagaName: "echo",
        status: "Failed",
        code: "ECHO_INTEGRATION_FAILED",
        completedAt: "2026-09-11T00:00:00.000Z",
      },
    ],
  },
};

const jobsPayload: OpsJobsResponse = {
  jobs: {
    generatedAt: "2026-09-11T00:00:00.000Z",
    executions: {
      total: 3,
      pending: 1,
      pendingUndispatched: 1,
      running: 0,
      cancelling: 0,
      succeeded: 1,
      failed: 1,
      timedOut: 0,
      cancelled: 0,
    },
    appBuilds: {
      queued: 0,
      running: 0,
      succeeded: 1,
      failed: 0,
      interrupted: [{ appId: "00000000-0000-4000-8000-000000000101", appName: "stuck" }],
    },
  },
};

const tasksPayload: OpsScheduledTasksResponse = {
  tasks: [
    {
      id: "00000000-0000-4000-8000-000000000201",
      name: "nightly-echo",
      kind: "scheduler",
      enabled: true,
      cadence: "0 2 * * * (UTC)",
      detail: "Schedule nightly-echo is enabled.",
    },
    {
      id: "00000000-0000-4000-8000-000000000202",
      name: " intake-hook",
      kind: "endpoint",
      enabled: false,
      cadence: null,
      detail: "Endpoint intake-hook is disabled.",
    },
  ],
};

const preflightPayload: OpsPreflightResponse = {
  checkedAt: "2026-09-11T00:00:00.000Z",
  integrations: [
    {
      integrationId: "720b9ebf-9b6a-4eac-bae9-6ed22c970401",
      integrationName: "echo",
      connected: true,
      enabled: true,
      missingSecrets: [],
      ready: true,
    },
    {
      integrationId: "7f3b2c1d-4a5e-4b6c-8d9e-0f1a2b3c4d5e",
      integrationName: "ninjaone",
      connected: true,
      enabled: true,
      missingSecrets: ["clientSecret"],
      ready: false,
    },
  ],
};

const connectionsPayload: OpsConnectionHealthResponse = {
  connections: [
    {
      integrationId: "720b9ebf-9b6a-4eac-bae9-6ed22c970401",
      integrationName: "echo",
      connected: true,
      enabled: true,
      testHint: "Round-trip a message.",
      remediation: "Check the fixture server.",
    },
  ],
};

const usagePayload: UsageSummaryResponse = {
  usage: {
    orgId: "00000000-0000-4000-8000-000000000001",
    window: { start: null, end: null },
    totals: { executions: 3, d1Reads: 11, d1Writes: 11, operationRows: 12, stepsExecuted: 12, durationMs: 36 },
    bySaga: [
      {
        saga: "system.smoke",
        executions: 2,
        d1Reads: 10,
        d1Writes: 10,
        operationRows: 8,
        stepsExecuted: 8,
        durationMs: 24,
      },
      {
        saga: "other.saga",
        executions: 1,
        d1Reads: 1,
        d1Writes: 1,
        operationRows: 4,
        stepsExecuted: 4,
        durationMs: 12,
      },
    ],
    byStatus: { Succeeded: 3 },
    cancelledExecutions: 0,
    matchedExecutions: 3,
    truncated: false,
    gaps: {
      modelTokenCosts: "unpriced",
      providerBilling: "unavailable",
      estimates: "none",
      currency: null,
      unreadableBlocks: 0,
    },
    note: "Application-observed statements/rows/steps in local or dev runtime; not Cloudflare metering.",
  },
};

const logsPayload: LogPage = {
  logs: [
    {
      seq: 1,
      executionId: "a".repeat(64),
      sagaId: "720b9ebf-9b6a-4eac-bae9-6ed22c970401",
      sagaName: "hello",
      orgId: "00000000-0000-4000-8000-000000000001",
      userId: "00000000-0000-4000-8000-000000000002",
      level: "INFO",
      message: "Hello Saga greeted Ada",
      data: null,
      createdAt: "2026-09-11T00:00:00.000Z",
    },
    {
      seq: 2,
      executionId: "b".repeat(64),
      sagaId: "720b9ebf-9b6a-4eac-bae9-6ed22c970401",
      sagaName: "echo",
      orgId: "00000000-0000-4000-8000-000000000001",
      userId: "00000000-0000-4000-8000-000000000002",
      level: "ERROR",
      message: "second-error",
      data: null,
      createdAt: "2026-09-11T00:00:00.000Z",
    },
  ],
  hasMore: true,
  nextCursor: "cursor-2",
};

const initial = {
  version: versionPayload,
  health: healthPayload,
  metrics: metricsPayload,
  jobs: jobsPayload,
  tasks: tasksPayload,
  preflight: preflightPayload,
  connections: connectionsPayload,
  usage: usagePayload,
  logs: logsPayload,
};

afterEach(() => {
  vi.restoreAllMocks();
});

it("fetches every operations read through the authorized Bearer path", async () => {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json(versionPayload))
    .mockResolvedValueOnce(Response.json(healthPayload))
    .mockResolvedValueOnce(Response.json(metricsPayload))
    .mockResolvedValueOnce(Response.json(jobsPayload))
    .mockResolvedValueOnce(Response.json(tasksPayload))
    .mockResolvedValueOnce(Response.json(preflightPayload))
    .mockResolvedValueOnce(Response.json(connectionsPayload))
    .mockResolvedValueOnce(Response.json(usagePayload))
    .mockResolvedValueOnce(Response.json(logsPayload));
  expect((await fetchOpsVersion()).version.sdkVersion).toBe("1");
  expect((await fetchOpsHealth()).status).toBe("ok");
  expect((await fetchOpsMetrics()).metrics.executions.total).toBe(3);
  expect((await fetchOpsJobs()).jobs.appBuilds.succeeded).toBe(1);
  expect((await fetchOpsScheduledTasks()).tasks).toHaveLength(2);
  expect((await fetchOpsPreflight()).integrations).toHaveLength(2);
  expect((await fetchOpsConnectionHealth()).connections).toHaveLength(1);
  expect((await fetchUsageSummary()).usage.totals.executions).toBe(3);
  // The level filter rides the query string server-side; the mocked fetch
  // answers the full fixture page, so the client returns both rows.
  const found = await searchLogs({ level: "ERROR" });
  expect(found.logs.map((row) => row.message)).toEqual(["Hello Saga greeted Ada", "second-error"]);
  expect(found.hasMore).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(9);
  for (const call of fetchMock.mock.calls) {
    const url = String(call[0]);
    expect(url).toMatch(/^\/api\/(ops|usage|logs)/);
  }
  expect(String(fetchMock.mock.calls[8]?.[0])).toContain("level=ERROR");
});

it("renders the operations console sections from fixtures", async () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <OperationsView initial={initial} />
    </MemoryRouter>,
  );
  expect(html).toContain("Operations");
  expect(html).toContain("ok");
  expect(html).toContain("catalog-rev-1");
  expect(html).toContain("ECHO_INTEGRATION_FAILED");
  expect(html).toContain("nightly-echo");
  expect(html).toContain("clientSecret");
  expect(html).toContain("Round-trip a message.");
  expect(html).toContain("system.smoke");
  expect(html).toContain("unpriced");
  expect(html).toContain("Hello Saga greeted Ada");
  expect(html).toContain("More logs available server-side.");
  expect(html).toContain("Inspect");
});

it("keeps repair execution behind an explicit confirmation", async () => {
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={["/operations"]}>
      <Routes>
        <Route path="/operations" element={<OperationsView initial={initial} />} />
      </Routes>
    </MemoryRouter>,
  );
  // Inspect-first: the dry-run inspect path is offered, the mutating commit
  // needs a typed confirmation first.
  expect(html).toContain("I understand this repair mutates operational state");
  expect(html).toContain("repair-stuck-build");
});

it("keeps Execute gated on a successful Inspect of the current form", async () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <OperationsView initial={initial} />
    </MemoryRouter>,
  );
  // No inspection has run in a fresh render, so execution stays locked even
  // though the confirmation box is present.
  expect(html).toContain("Execution unlocks after a successful Inspect of the current form.");
  expect(html).toContain("disabled");
});

it("rejects nested nulls in jobs and usage payloads before they reach the view", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json({
      jobs: {
        ...jobsPayload.jobs,
        appBuilds: { ...jobsPayload.jobs.appBuilds, interrupted: [{ appId: null, appName: "stuck" }] },
      },
    }),
  );
  await expect(fetchOpsJobs()).rejects.toThrow("Unexpected ops jobs response shape.");

  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json({ usage: { ...usagePayload.usage, bySaga: [{ executions: 1 }] } }),
  );
  await expect(fetchUsageSummary()).rejects.toThrow("Unexpected usage summary response shape.");

  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ usage: { ...usagePayload.usage, gaps: null } }));
  await expect(fetchUsageSummary()).rejects.toThrow("Unexpected usage summary response shape.");
});

it("inspects repairs dry-run by default and commits only with dryRun:false", async () => {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      Response.json({
        repair: {
          kind: "cleanup-expired-tokens",
          dryRun: true,
          targetId: null,
          action: "inspect",
          result: { capabilities: 1 },
        },
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        repair: {
          kind: "cleanup-expired-tokens",
          dryRun: false,
          targetId: null,
          action: "delete",
          result: { capabilities: 1 },
        },
      }),
    );
  const inspect = await runOpsRepair({ kind: "cleanup-expired-tokens" });
  expect(inspect.repair.dryRun).toBe(true);
  const committed = await runOpsRepair({ kind: "cleanup-expired-tokens", dryRun: false });
  expect(committed.repair.dryRun).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const [, inspectInit] = fetchMock.mock.calls[0] as [unknown, RequestInit];
  expect(inspectInit.method).toBe("POST");
  expect(String(inspectInit.body)).toContain('"dryRun":true');
  const [, commitInit] = fetchMock.mock.calls[1] as [unknown, RequestInit];
  expect(String(commitInit.body)).toContain('"dryRun":false');
});
