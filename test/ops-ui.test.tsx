// SPDX-License-Identifier: AGPL-3.0
// OPS-01 UI (issue #172): audit trail and notifications inbox render from
// mocked /api/* payloads. No secret-bearing details leak into list copy.
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { fetchAuditEvents, listNotifications } from "../client/src/lib/api-client";
import type { AppNotification, AuditResponse } from "../client/src/lib/client-types";
import { AuditList } from "../client/src/pages/Audit";
import { NotificationsList } from "../client/src/pages/Notifications";

const auditPayload: AuditResponse = {
  events: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      orgId: "00000000-0000-4000-8000-000000000001",
      actorUserId: "00000000-0000-4000-8000-000000000002",
      action: "app.build.complete",
      targetType: "app",
      targetId: "22222222-2222-4222-8222-222222222222",
      outcome: "success",
      detail: { jobId: "33333333-3333-4333-8333-333333333333" },
      createdAt: "2026-09-11T00:00:00.000Z",
    },
    {
      id: "44444444-4444-4444-8444-444444444444",
      orgId: "00000000-0000-4000-8000-000000000001",
      actorUserId: "00000000-0000-4000-8000-000000000002",
      action: "app.managed_deny",
      targetType: "app",
      targetId: "55555555-5555-4555-8555-555555555555",
      outcome: "failure",
      detail: { code: "MANAGED_RESOURCE" },
      createdAt: "2026-09-10T00:00:00.000Z",
    },
  ],
  hasMore: true,
  nextCursor: "cursor-2",
};

const inbox: AppNotification[] = [
  {
    id: "66666666-6666-4666-8666-666666666666",
    orgId: "00000000-0000-4000-8000-000000000001",
    userId: "00000000-0000-4000-8000-000000000002",
    scope: "personal",
    category: "app_build",
    title: "App build succeeded",
    body: null,
    status: "completed",
    progressPercent: null,
    detail: { appId: "22222222-2222-4222-8222-222222222222" },
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:01.000Z",
    dismissedAt: null,
  },
  {
    id: "77777777-7777-4777-8777-777777777777",
    orgId: "00000000-0000-4000-8000-000000000001",
    userId: "00000000-0000-4000-8000-000000000003",
    scope: "org",
    category: "system",
    title: "Maintenance window",
    body: "Sunday 02:00 UTC.",
    status: "pending",
    progressPercent: 50,
    detail: null,
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:01.000Z",
    dismissedAt: null,
  },
];

afterEach(() => {
  vi.restoreAllMocks();
});

it("renders audit rows with action, outcome, target, and actor", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(auditPayload));
  const data = await fetchAuditEvents({ action: "app." });
  expect(data.events).toHaveLength(2);
  expect(data.hasMore).toBe(true);

  const html = renderToStaticMarkup(
    <MemoryRouter>
      <AuditList initial={data} />
    </MemoryRouter>,
  );
  expect(html).toContain("app.build.complete");
  expect(html).toContain("app.managed_deny");
  expect(html).toContain("success");
  expect(html).toContain("failure");
  expect(html).toContain("More events available server-side.");
});

it("renders the notifications inbox with status, scope, progress, and dismiss", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ notifications: inbox }));
  const data = await listNotifications();
  expect(data.notifications).toHaveLength(2);

  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={["/notifications"]}>
      <Routes>
        <Route path="/notifications" element={<NotificationsList initial={data.notifications} />} />
      </Routes>
    </MemoryRouter>,
  );
  expect(html).toContain("App build succeeded");
  expect(html).toContain("Maintenance window");
  expect(html).toContain("completed");
  expect(html).toContain("personal");
  expect(html).toContain("Dismiss");
  expect(html).toContain("50%");
});
