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
});

// UX-01 slice 1 (issue #176): each disabled nav entry must name its actual
// OPEN parity owner — never a closed scaffolding issue (#15/#16/#18, all
// CLOSED) and never #160 (APP-02, closed since the UX-01c retarget).
// Triggers -> #139 TRG-03 (only open trigger issue). Tables shipped its UI
// in #556, so it is enabled and names no disabled owner. The Integrations
// family is served by the enabled Connections page, so no disabled
// Integrations entry exists at all.
it("points each disabled nav entry at its open parity owner", () => {
  const owners: Record<string, number> = {
    Triggers: 139,
  };
  const disabled = NAV_ENTRIES.filter((e) => !e.enabled);
  expect(disabled.map((e) => e.label).sort()).toEqual(Object.keys(owners).sort());
  for (const [label, issue] of Object.entries(owners)) {
    const entry = NAV_ENTRIES.find((e) => e.label === label);
    expect(entry?.enabled).toBe(false);
    expect(entry?.issue).toBe(`https://github.com/Midtown-Technology-Group/Wrangnarok/issues/${issue}`);
  }
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <Nav />
    </MemoryRouter>,
  );
  for (const issue of Object.values(owners)) {
    expect(html).toContain(`/issues/${issue}`);
  }
  // Quote-boundaried: /issues/154 must not satisfy a /issues/15 check.
  // #160 joined the closed set when APP-02 shipped (UX-01 slice 1).
  for (const closed of [15, 16, 18, 160]) {
    expect(html).not.toContain(`/issues/${closed}"`);
  }
  expect(NAV_ENTRIES.find((e) => e.label === "Integrations")).toBeUndefined();
  // Tables shipped its UI in #556: enabled and routed, not disabled.
  expect(NAV_ENTRIES.find((e) => e.label === "Tables")).toMatchObject({ enabled: true, to: "/tables" });
});

// UX-01c (issue #176): disabled entries stay honestly grayed out AND
// keyboard-honest — the label itself is not a tab stop, the tracking issue
// is a real focusable anchor with a stable accessible name.
it("renders disabled nav entries with label, disabled state, and keyboard-reachable issue link", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <Nav />
    </MemoryRouter>,
  );
  for (const entry of NAV_ENTRIES.filter((e) => !e.enabled)) {
    // Visible label plus the honest "soon" marker.
    expect(html).toContain(entry.label);
    expect(html).toContain("(soon)");
    // Disabled state is exposed to assistive tech on the list item.
    expect(html).toContain('aria-disabled="true"');
    // The tracking link is a real anchor to the live issue URL with a
    // stable accessible name, and is not removed from tab order.
    const liveUrl = entry.issue as string;
    expect(html).toContain(`href="${liveUrl}"`);
    expect(html).toContain(`aria-label="${entry.label} tracking issue"`);
    expect(html).not.toContain(`href="${liveUrl}" tabindex="-1"`);
  }
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

// UX-01 slice 1 (issue #176): the settings families are reachable,
// enabled navigation — own profile plus admin branding.
it("enables the Profile and Branding nav entries", () => {
  const profile = NAV_ENTRIES.find((entry) => entry.label === "Profile");
  expect(profile?.enabled).toBe(true);
  expect(profile?.to).toBe("/profile");
  const branding = NAV_ENTRIES.find((entry) => entry.label === "Branding");
  expect(branding?.enabled).toBe(true);
  expect(branding?.to).toBe("/admin/branding");
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <Nav />
    </MemoryRouter>,
  );
  expect(html).toContain("/profile");
  expect(html).toContain("/admin/branding");
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
    new Request(`https://local.test${path}`, {
      headers: { Authorization: `Bearer ${"a".repeat(64)}` },
    });
  const response = await worker.fetch(authed("/api/dashboard"), bindings);
  expect(response.status).toBe(501);
  expect(await response.json()).toMatchObject({
    error: { code: "UNIMPLEMENTED" },
  });
});
