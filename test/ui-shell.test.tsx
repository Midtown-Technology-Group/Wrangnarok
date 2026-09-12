// SPDX-License-Identifier: AGPL-3.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { NAV_ENTRIES, Nav } from "../client/src/components/Nav";
import { fetchExecutionHistory } from "../client/src/lib/api-client";
import { DashboardView, summarizeDashboardStatuses } from "../client/src/pages/Dashboard";
import { ExecutionHistoryList } from "../client/src/pages/ExecutionHistory";
import type { ExecutionHistoryResponse } from "../client/src/lib/client-types";

const bindings = env as unknown as Bindings;
const executionId = "a".repeat(64);

const payload: ExecutionHistoryResponse = {
  executions: [
    {
      executionId,
      sagaId: "720b9ebf-9b6a-4eac-bae9-6ed22c970401",
      sagaName: "echo",
      sagaRevision: "echo-v1",
      orgId: "00000000-0000-4000-8000-000000000001",
      userId: "00000000-0000-4000-8000-000000000002",
      status: "Succeeded",
      dispatchConfirmed: true,
      createdAt: "2026-09-09T00:00:00.000Z",
      startedAt: "2026-09-09T00:00:01.000Z",
      completedAt: "2026-09-09T00:00:02.000Z",
    },
  ],
  hasMore: true,
  nextCursor: "cursor-2",
};

afterEach(() => {
  vi.restoreAllMocks();
});

it("renders ExecutionHistory rows from a mocked /api/* payload (no input/results in rows)", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ executions: payload.executions, hasMore: true }));
  const data = await fetchExecutionHistory();
  expect(data.executions).toHaveLength(1);
  expect(data.hasMore).toBe(true);

  const html = renderToStaticMarkup(
    <MemoryRouter>
      <ExecutionHistoryList initial={data} />
    </MemoryRouter>,
  );
  expect(html).toContain("echo");
  expect(html).toContain("Succeeded");
  expect(html).toContain(executionId.slice(0, 12));
  expect(html).toContain(`/history/${executionId}`);
  expect(html).toContain("More results available server-side.");
  const row = JSON.stringify(data.executions[0]);
  expect(row).not.toContain("input");
  expect(row).not.toContain("result");
});

it("marks unported nav entries disabled and links each tracking issue", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <Nav />
    </MemoryRouter>,
  );
  expect(html).toContain('aria-disabled="true"');
  expect(html).toContain("/history");
  for (const entry of NAV_ENTRIES.filter((e) => !e.enabled)) {
    expect(entry.issue).toBeDefined();
    expect(html).toContain(entry.label);
    expect(html).toContain(entry.issue as string);
  }
  expect(html).toContain("/issues/15");
  expect(html).toContain("/issues/16");
  expect(html).toContain("/issues/18");
});

it("enables the Dashboard nav entry at /dashboard", () => {
  const dashboard = NAV_ENTRIES.find((entry) => entry.label === "Dashboard");
  expect(dashboard?.enabled).toBe(true);
  expect(dashboard?.to).toBe("/dashboard");
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <Nav />
    </MemoryRouter>,
  );
  expect(html).toContain("/dashboard");
});

it("renders the Dashboard summary with honestly-scoped sample counts", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <DashboardView
        initial={{
          sagas: 3,
          recentExecutions: 2,
          recentHasMore: true,
          connections: 1,
          integrations: 2,
          artifacts: 0,
          artifactsHasMore: false,
          fileLocations: 1,
        }}
      />
    </MemoryRouter>,
  );
  expect(html).toContain("dashboard-summary");
  expect(html).toContain("3 Sagas");
  expect(html).toContain("2 recent Executions loaded");
  expect(html).toContain("more available server-side");
  expect(html).toContain("dashboard-row");
  expect(html).toContain("/sagas");
  expect(html).toContain("/history");
  expect(html).toContain("/connections");
  expect(html).toContain("/artifacts");
  expect(html).toContain("/files");
  expect(html).toContain("never platform totals");
  expect(summarizeDashboardStatuses(["Succeeded", "Failed", "Failed"]).Failed).toBe(2);
  expect(summarizeDashboardStatuses(["Succeeded", "Failed", "Failed"]).Succeeded).toBe(1);
  expect(summarizeDashboardStatuses(["Succeeded", "Failed", "Failed"]).Pending).toBe(0);
});

it("enforces gray-out server-side: unmapped /api/* is UNIMPLEMENTED, not NOT_FOUND", async () => {
  const authed = (path: string) =>
    new Request(`http://local.test${path}`, {
      headers: { Authorization: `Bearer ${"a".repeat(64)}` },
    });
  const response = await worker.fetch(authed("/api/dashboard"), bindings);
  expect(response.status).toBe(501);
  expect(await response.json()).toMatchObject({
    error: { code: "UNIMPLEMENTED" },
  });
});
