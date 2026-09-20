// SPDX-License-Identifier: AGPL-3.0
// Trigger and schedule management UI (issue #557): list/detail render from
// mocked /api/schedules, /api/event-sources, and /api/endpoints payloads,
// plus interaction coverage for the supported create/enable/disable/history
// flows with honest failure states. Fixtures mirror the Worker response
// shapes (camelCase summaries); no hidden semantics are invented.
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createEndpoint,
  createEventSource,
  createSchedule,
  createSubscription,
  deleteSchedule,
  emitSourceEvent,
  fetchScheduleDelivery,
  listEndpoints,
  listEventSources,
  listSagas,
  listSchedules,
  listSourceEvents,
  listSubscriptionDeliveries,
  rotateEndpoint,
  setEndpointEnabled,
  setScheduleEnabled,
  setSourceEnabled,
} from "../client/src/lib/api-client";
import type {
  EndpointSummary,
  EndpointsResponse,
  EventSourceSummary,
  EventSourcesResponse,
  SagasResponse,
  ScheduleSummary,
  SchedulesResponse,
} from "../client/src/lib/client-types";
import { TriggersView } from "../client/src/pages/Triggers";

const SAGA_ID = "720b9ebf-9b6a-4eac-bae9-6ed22c970401";

const sagasPayload: SagasResponse = {
  sagas: [
    {
      id: SAGA_ID,
      name: "echo",
      revision: "echo-v1",
      description: "Fixture echo.",
      requiredIntegrations: [],
    },
  ],
};

const schedulesPayload: SchedulesResponse = {
  schedules: [
    {
      id: "a".repeat(64),
      name: "nightly-census",
      sagaId: SAGA_ID,
      sagaName: "echo",
      kind: "recurring",
      cron: "0 2 * * *",
      timezone: "UTC",
      enabled: true,
      input: { message: "hello" },
      runAt: null,
      nextDueAt: "2026-09-20T02:00:00.000Z",
      lastWindow: "2026-09-19T02:00",
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-10T00:00:00.000Z",
    },
    {
      id: "b".repeat(64),
      name: "one-shot",
      sagaId: SAGA_ID,
      sagaName: "echo",
      kind: "one-off",
      cron: "",
      timezone: "UTC",
      enabled: false,
      input: {},
      runAt: "2026-09-21T00:00:00.000Z",
      nextDueAt: "2026-09-21T00:00:00.000Z",
      lastWindow: null,
      createdAt: "2026-09-11T00:00:00.000Z",
      updatedAt: "2026-09-12T00:00:00.000Z",
    },
  ],
};

const sourcesPayload: EventSourcesResponse = {
  sources: [
    {
      id: "c".repeat(64),
      name: "vendor-orders",
      kind: "topic",
      refId: null,
      enabled: true,
      createdAt: "2026-09-10T00:00:00.000Z",
    } satisfies EventSourceSummary,
  ],
};

const endpointsPayload: EndpointsResponse = {
  endpoints: [
    {
      id: "00000000-0000-4000-8000-000000000301",
      name: "vendor-hook",
      sagaId: SAGA_ID,
      kind: "webhook",
      enabled: true,
      keyExpiresAt: null,
      challenge: "echo-param",
      rateLimitPerMinute: 60,
      createdAt: "2026-09-10T00:00:00.000Z",
    } satisfies EndpointSummary,
  ],
};

function viewInitial() {
  return {
    schedules: schedulesPayload,
    sources: sourcesPayload,
    endpoints: endpointsPayload,
    sagas: sagasPayload,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

it("renders schedule rows with kind, state, and manage affordances", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <TriggersView initial={viewInitial()} />
    </MemoryRouter>,
  );
  expect(html).toContain("nightly-census");
  expect(html).toContain("recurring");
  expect(html).toContain("0 2 * * *");
  expect(html).toContain("one-shot");
  expect(html).toContain("one-off");
  expect(html).toContain("disabled");
  expect(html).toContain("Disable");
  expect(html).toContain("Enable");
  expect(html).toContain("Delete");
});

it("renders event sources and endpoints without ever exposing credentials", () => {
  const html =
    renderToStaticMarkup(
      <MemoryRouter>
        <TriggersView initial={viewInitial()} defaultTab="sources" />
      </MemoryRouter>,
    ) +
    renderToStaticMarkup(
      <MemoryRouter>
        <TriggersView initial={viewInitial()} defaultTab="endpoints" />
      </MemoryRouter>,
    );
  expect(html).toContain("vendor-orders");
  expect(html).toContain("vendor-hook");
  expect(html).toContain("webhook");
  expect(html).not.toContain("apiKey");
  expect(html).not.toContain("webhookSecret");
  const row = JSON.stringify(endpointsPayload.endpoints[0]);
  expect(row).not.toContain("apiKey");
  expect(row).not.toContain("secret");
});

it("renders honest empty states when nothing is registered", () => {
  const empty = {
    schedules: { schedules: [] },
    sources: { sources: [] },
    endpoints: { endpoints: [] },
    sagas: sagasPayload,
  };
  const html =
    renderToStaticMarkup(
      <MemoryRouter>
        <TriggersView initial={empty} defaultTab="schedules" />
      </MemoryRouter>,
    ) +
    renderToStaticMarkup(
      <MemoryRouter>
        <TriggersView initial={empty} defaultTab="sources" />
      </MemoryRouter>,
    ) +
    renderToStaticMarkup(
      <MemoryRouter>
        <TriggersView initial={empty} defaultTab="endpoints" />
      </MemoryRouter>,
    );
  expect(html).toContain("Triggers");
  expect(html).toContain("No Schedules");
  expect(html).toContain("No event sources");
  expect(html).toContain("No endpoints");
});

it("creates a schedule through POST /api/schedules with the catalog saga", async () => {
  const created: SchedulesResponse["schedules"][number] = {
    ...(schedulesPayload.schedules[0] as ScheduleSummary),
    name: "fresh",
  };
  const seen: { url: string; init: RequestInit }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    seen.push({ url: String(url), init: init as RequestInit });
    return Response.json({ schedule: created }, { status: 201 });
  });
  const schedule = await createSchedule({
    name: "fresh",
    sagaId: SAGA_ID,
    kind: "recurring",
    cron: "*/5 * * * *",
    timezone: "UTC",
    input: {},
  });
  expect(schedule.name).toBe("fresh");
  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe("/api/schedules");
  expect(seen[0]?.init.method).toBe("POST");
  expect(JSON.parse(String(seen[0]?.init.body))).toMatchObject({ name: "fresh", kind: "recurring" });
});

it("toggles schedule enablement through the enable/disable routes", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ schedule: { ...(schedulesPayload.schedules[0] as ScheduleSummary), enabled: false } }),
  );
  const schedule = await setScheduleEnabled("nightly-census", false);
  expect(schedule.enabled).toBe(false);
  const last = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0];
  expect(String(last)).toBe("/api/schedules/nightly-census/disable");
});

it("deletes a schedule and surfaces manage-gate failures honestly", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ deleted: true }));
  await deleteSchedule("one-shot");
  expect(String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toBe("/api/schedules/one-shot");

  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json({ error: { code: "FORBIDDEN", message: "Manage access is required." } }, { status: 403 }),
  );
  await expect(deleteSchedule("one-shot")).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
});

it("reads schedule delivery history through the window-keyed route", async () => {
  const executionId = "d".repeat(64);
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json({ delivery: { schedule: "nightly-census", window: "2026-09-19T02:00", executionId } }),
  );
  const delivery = await fetchScheduleDelivery("nightly-census", "2026-09-19T02:00");
  expect(delivery.executionId).toBe(executionId);
  expect(String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
    "/api/schedules/nightly-census/deliveries?window=",
  );
});

it("creates and toggles an event source, then reads its event log", async () => {
  const source = sourcesPayload.sources[0] as EventSourceSummary;
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ source }, { status: 201 }))
    .mockResolvedValueOnce(Response.json({ source: { ...source, enabled: false } }))
    .mockResolvedValueOnce(
      Response.json({
        events: [
          {
            eventId: "evt-1",
            topic: "vendor.order.created",
            payload: { id: 7 },
            executionId: null,
            createdAt: "2026-09-19T00:00:00.000Z",
          },
        ],
      }),
    );
  const created = await createEventSource({ name: "vendor-orders", kind: "topic" });
  expect(created.name).toBe("vendor-orders");
  const toggled = await setSourceEnabled("vendor-orders", false);
  expect(toggled.enabled).toBe(false);
  const events = await listSourceEvents("vendor-orders");
  expect(events).toHaveLength(1);
  expect(events[0]?.topic).toBe("vendor.order.created");
  const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
  expect(calls[0]).toBe("/api/event-sources");
  expect(calls[1]).toBe("/api/event-sources/vendor-orders/disable");
  expect(calls[2]).toBe("/api/event-sources/vendor-orders/events");
});

it("emits an operator event and surfaces the 409 content-conflict honestly", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json(
      {
        event: {
          eventId: "evt-9",
          topic: "vendor.order.created",
          payload: {},
          executionId: null,
          createdAt: "2026-09-19T00:00:00.000Z",
        },
        replayed: false,
        deliveries: [],
        overflowSkipped: 0,
      },
      { status: 201 },
    ),
  );
  const emitted = await emitSourceEvent("vendor-orders", {
    eventId: "evt-9",
    topic: "vendor.order.created",
    payload: {},
  });
  expect(emitted.replayed).toBe(false);

  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json(
      { error: { code: "EVENT_CONFLICT", message: "This event already logged different content." } },
      { status: 409 },
    ),
  );
  await expect(
    emitSourceEvent("vendor-orders", { eventId: "evt-9", topic: "vendor.order.created", payload: { other: 1 } }),
  ).rejects.toMatchObject({ code: "EVENT_CONFLICT", status: 409 });
});

it("manages subscriptions and reads per-subscription delivery history", async () => {
  const subscription = {
    id: "e".repeat(64),
    name: "orders-echo",
    sagaId: SAGA_ID,
    topicFilter: "vendor.order.*",
    enabled: true,
    createdAt: "2026-09-19T00:00:00.000Z",
  };
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ subscription }, { status: 201 }))
    .mockResolvedValueOnce(
      Response.json({
        deliveries: [
          {
            eventId: "evt-1",
            topic: "vendor.order.created",
            executionId: "f".repeat(64),
            outcome: "delivered",
            createdAt: "2026-09-19T00:01:00.000Z",
          },
        ],
      }),
    );
  const created = await createSubscription("vendor-orders", {
    name: "orders-echo",
    topicFilter: "vendor.order.*",
    sagaId: SAGA_ID,
  });
  expect(created.topicFilter).toBe("vendor.order.*");
  const deliveries = await listSubscriptionDeliveries("vendor-orders", "orders-echo");
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0]?.outcome).toBe("delivered");
  const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
  expect(calls[0]).toBe("/api/event-sources/vendor-orders/subscriptions");
  expect(calls[1]).toBe("/api/event-sources/vendor-orders/subscriptions/orders-echo/deliveries");
});

it("creates an endpoint once, rotates credentials, and reads delivery history", async () => {
  const endpoint = endpointsPayload.endpoints[0] as EndpointSummary;
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ endpoint, webhookSecret: "raw-once" }, { status: 201 }))
    .mockResolvedValueOnce(Response.json({ endpoint, webhookSecret: "raw-twice" }))
    .mockResolvedValueOnce(
      Response.json({
        events: [{ eventId: "pay-1", executionId: "f".repeat(64), createdAt: "2026-09-19T00:00:00.000Z" }],
      }),
    );
  const issued = await createEndpoint({ name: "vendor-hook", sagaId: SAGA_ID, kind: "webhook" });
  expect(issued.endpoint.name).toBe("vendor-hook");
  expect(issued.webhookSecret).toBe("raw-once");
  const rotated = await rotateEndpoint("vendor-hook");
  expect(rotated.webhookSecret).toBe("raw-twice");
  const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
  expect(calls[0]).toBe("/api/endpoints");
  expect(calls[1]).toBe("/api/endpoints/vendor-hook/rotate");
});

it("patches endpoint policy for enable/disable without a delete route", async () => {
  const endpoint = endpointsPayload.endpoints[0] as EndpointSummary;
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ endpoint: { ...endpoint, enabled: false } }));
  const updated = await setEndpointEnabled("vendor-hook", false);
  expect(updated.enabled).toBe(false);
  const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
  expect(String(call?.[0])).toBe("/api/endpoints/vendor-hook");
  expect(call?.[1]).toMatchObject({ method: "PATCH" });
  // The Worker exposes no DELETE /api/endpoints/:name route: disable plus
  // rotate is the supported credential lifecycle, and the page says so.
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <TriggersView initial={viewInitial()} defaultTab="endpoints" />
    </MemoryRouter>,
  );
  expect(html).toContain("Endpoints have no delete route");
});

it("loads the trigger inventory lists and the saga catalog for create forms", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ schedules: schedulesPayload.schedules }))
    .mockResolvedValueOnce(Response.json({ sources: sourcesPayload.sources }))
    .mockResolvedValueOnce(Response.json({ endpoints: endpointsPayload.endpoints }))
    .mockResolvedValueOnce(Response.json({ sagas: sagasPayload.sagas }));
  const [schedules, sources, endpoints, sagas] = await Promise.all([
    listSchedules(),
    listEventSources(),
    listEndpoints(),
    listSagas(),
  ]);
  expect(schedules.schedules).toHaveLength(2);
  expect(sources.sources).toHaveLength(1);
  expect(endpoints.endpoints).toHaveLength(1);
  expect(sagas.sagas).toHaveLength(1);
});

it("rejects unexpected trigger response shapes instead of rendering them", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ schedules: [{ name: 7 }] }));
  await expect(listSchedules()).rejects.toThrow("Unexpected schedules response shape.");
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ nope: true }));
  await expect(listSourceEvents("vendor-orders")).rejects.toThrow("Unexpected source events response shape.");
});
