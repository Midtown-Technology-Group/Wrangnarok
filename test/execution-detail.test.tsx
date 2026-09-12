// SPDX-License-Identifier: AGPL-3.0
// OBS-01 (issue #152): Execution detail UI + history traversal. Detail
// rendering (bounded input/result/error, Operation rows with timestamps,
// runtime-unavailable state, cancel controls) runs as static-markup
// assertions; polling/cancel/expired-runtime behavior runs against the real
// local Worker + D1. History traversal runs against the real Worker too.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { echoSaga, executionId } from "../src/domain";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import seed from "../scripts/seed-local.sql?raw";
import { boundedJsonPreview, DETAIL_JSON_BOUND } from "../client/src/pages/ExecutionDetail";
import { ExecutionDetailView } from "../client/src/pages/ExecutionDetail";
import { ExecutionHistoryList } from "../client/src/pages/ExecutionHistory";
import type { ExecutionDetail, ExecutionHistoryResponse } from "../client/src/lib/client-types";
import { isTerminalStatus } from "../client/src/lib/api-client";

const bindings = env as unknown as Bindings;
const principal = { orgId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" };
const auth = { Authorization: `Bearer ${"a".repeat(64)}` };

function detailFixture(overrides: Partial<ExecutionDetail> = {}): ExecutionDetail {
  return {
    executionId: "a".repeat(64),
    sagaId: echoSaga.id,
    sagaName: "echo",
    sagaRevision: "echo-v1",
    orgId: principal.orgId,
    userId: principal.userId,
    status: "Succeeded",
    dispatchConfirmed: true,
    createdAt: "2026-09-10T08:00:00.000Z",
    startedAt: "2026-09-10T08:00:01.000Z",
    completedAt: "2026-09-10T08:00:02.000Z",
    runtimeStatus: "complete",
    policy: {
      sagaId: echoSaga.id,
      version: 1,
      policy: {
        timeout: { vendorTimeoutMs: 0, stepTimeout: "10 seconds" },
        retry: { checkpointRetries: 2, vendorRetries: 0 },
        admission: { enabled: true, maxConcurrent: 0 },
      },
    },
    input: { message: "hello" },
    result: { message: "hello" },
    error: null,
    operations: [
      {
        name: "prepare-input-v1",
        status: "Succeeded",
        startedAt: "2026-09-10T08:00:01.000Z",
        completedAt: "2026-09-10T08:00:01.100Z",
        result: { message: "hello" },
        error: null,
      },
      {
        name: "echo-http-v1",
        status: "Succeeded",
        startedAt: "2026-09-10T08:00:01.100Z",
        completedAt: "2026-09-10T08:00:01.200Z",
        result: { message: "hello" },
        error: null,
      },
    ],
    ...overrides,
  };
}

describe("execution detail rendering", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders bounded input/result, Operation output/timestamps, and a live marker while active", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ExecutionDetailView initial={detailFixture({ status: "Running", runtimeStatus: "running", result: null })} />
      </MemoryRouter>,
    );
    expect(html).toContain("detail-input");
    expect(html).toContain("hello");
    expect(html).toContain("operation-row");
    expect(html).toContain("prepare-input-v1");
    expect(html).toContain("echo-http-v1");
    expect(html).toContain("started 2026-09-10T08:00:01.000Z");
    expect(html).toContain("completed 2026-09-10T08:00:01.200Z");
    expect(html).toContain("still active");
    expect(html).toContain("detail-live");
    expect(html).toContain("detail-cancel");
  });

  it("renders terminal failure output and no cancel control once terminal", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ExecutionDetailView
          initial={detailFixture({
            status: "Failed",
            result: null,
            error: { code: "ECHO_INTEGRATION_FAILED", message: "The echo Integration could not complete." },
            runtimeStatus: "errored",
          })}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("detail-error");
    expect(html).toContain("ECHO_INTEGRATION_FAILED");
    expect(html).not.toContain("detail-cancel");
    expect(html).not.toContain("detail-live");
  });

  it("renders the runtime-unavailable state when native history is gone", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ExecutionDetailView initial={detailFixture({ runtimeStatus: null })} />
      </MemoryRouter>,
    );
    expect(html).toContain("detail-runtime");
    expect(html).toContain("unavailable (native history expired or not yet dispatched)");
  });

  it("renders the applied runtime-policy snapshot", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ExecutionDetailView
          initial={detailFixture({
            policy: {
              sagaId: echoSaga.id,
              version: 3,
              policy: {
                timeout: { vendorTimeoutMs: 250, stepTimeout: "10 seconds" },
                retry: { checkpointRetries: 1, vendorRetries: 1 },
                admission: { enabled: true, maxConcurrent: 2 },
              },
            },
          })}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("detail-policy");
    expect(html).toContain("v3");
    expect(html).toContain("250ms");
    expect(html).toContain("max 2 concurrent");
  });

  it("bounds JSON rendering at the D1 payload bound", () => {
    const big = { blob: "x".repeat(DETAIL_JSON_BOUND + 100) };
    const { text, truncated } = boundedJsonPreview(big);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(DETAIL_JSON_BOUND + 100);
    expect(text).toContain("truncated");
    expect(boundedJsonPreview({ small: 1 }).truncated).toBe(false);
  });

  it("classifies terminal statuses for polling stop", () => {
    for (const status of ["Succeeded", "Failed", "TimedOut", "Cancelled"]) expect(isTerminalStatus(status)).toBe(true);
    for (const status of ["Pending", "Running", "Cancelling"]) expect(isTerminalStatus(status)).toBe(false);
  });
});

describe("execution detail + history traversal over the real Worker", () => {
  beforeEach(async () => {
    await bindings.DB.exec(migration1);
    await bindings.DB.exec(migration2);
    await bindings.DB.exec(seed);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await reset();
  });

  async function insertHistoryRow(key: string, status: string, createdAt: string): Promise<string> {
    const id = await executionId(principal, key);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at,result_json,error_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        id,
        echoSaga.id,
        "echo",
        "echo-v1",
        principal.orgId,
        principal.userId,
        JSON.stringify({ message: key }),
        1,
        status,
        createdAt,
        status === "Succeeded" ? JSON.stringify({ message: key }) : null,
        status === "Failed" ? JSON.stringify({ code: "ECHO_INTEGRATION_FAILED", message: "nope" }) : null,
      )
      .run();
    return id;
  }

  it("serves bounded detail with Operations and honors owner scoping", async () => {
    const id = await insertHistoryRow("obs01-detail-00001", "Succeeded", "2026-09-10T08:00:00.000Z");
    await bindings.DB.prepare(
      "INSERT INTO operations(execution_id,name,position,status,started_at,completed_at,result_json) VALUES (?,?,?,?,?,?,?)",
    )
      .bind(
        id,
        "prepare-input-v1",
        0,
        "Succeeded",
        "2026-09-10T08:00:01.000Z",
        "2026-09-10T08:00:01.100Z",
        JSON.stringify({ message: "obs01-detail-00001" }),
      )
      .run();
    const response = await worker.fetch(
      new Request(`http://local.test/api/executions/${id}`, { headers: { ...auth } }),
      bindings,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ executionId: id, status: "Succeeded", result: { message: "obs01-detail-00001" } });
    expect(JSON.stringify(body.operations)).toContain("prepare-input-v1");
    // Hidden-owner denial: a foreign requester gets 404, never the payload.
    const foreign = await worker.fetch(
      new Request(`http://local.test/api/executions/${id}`, { headers: { ...auth } }),
      {
        ...bindings,
        LAB_USER_ID: "00000000-0000-4000-8000-000000000003",
      },
    );
    expect(foreign.status).toBe(404);
  });

  it("denies foreign cancellation with 404 and keeps the row", async () => {
    const id = await insertHistoryRow("obs01-deny-00001", "Running", "2026-09-10T09:00:00.000Z");
    const foreign = await worker.fetch(
      new Request(`http://local.test/api/executions/${id}/cancel`, { method: "POST", headers: { ...auth } }),
      {
        ...bindings,
        LAB_USER_ID: "00000000-0000-4000-8000-000000000003",
      },
    );
    expect(foreign.status).toBe(404);
    const row = await bindings.DB.prepare("SELECT status FROM executions WHERE id=?")
      .bind(id)
      .first<{ status: string }>();
    expect(row?.status).toBe("Running");
  });

  it("traverses multi-page history with cursor + filters through the worker", async () => {
    for (let i = 0; i < 5; i++) {
      await insertHistoryRow(
        `obs01-page-0000${i}`,
        i % 2 === 0 ? "Succeeded" : "Failed",
        `2026-09-0${1 + i}T00:00:00.000Z`,
      );
    }
    const first = (await (
      await worker.fetch(new Request("http://local.test/api/executions?limit=2", { headers: { ...auth } }), bindings)
    ).json()) as { executions: { executionId: string }[]; hasMore: boolean; nextCursor: string | null };
    expect(first.executions).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(typeof first.nextCursor).toBe("string");
    const second = (await (
      await worker.fetch(
        new Request(
          `http://local.test/api/executions?limit=2&cursor=${encodeURIComponent(first.nextCursor as string)}`,
          {
            headers: { ...auth },
          },
        ),
        bindings,
      )
    ).json()) as { executions: { executionId: string }[]; hasMore: boolean; nextCursor: string | null };
    expect(second.executions).toHaveLength(2);
    expect(new Set([...first.executions, ...second.executions].map((row) => row.executionId)).size).toBe(4);
    // Filtered traversal: same cursor mechanics under a status filter.
    const failed = (await (
      await worker.fetch(
        new Request("http://local.test/api/executions?status=Failed&limit=1", { headers: { ...auth } }),
        bindings,
      )
    ).json()) as { executions: unknown[]; hasMore: boolean; nextCursor: string | null };
    expect(failed.executions).toHaveLength(1);
    expect(failed.hasMore).toBe(true);
  });

  it("surfaces expired native history as runtime-unavailable without inventing status", async () => {
    // A dispatched-but-never-started Pending row with no native Workflow
    // instance left: stored status stays Pending, runtime is null.
    const id = await executionId(principal, "obs01-expired-00001");
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        id,
        echoSaga.id,
        "echo",
        "echo-v1",
        principal.orgId,
        principal.userId,
        JSON.stringify({ message: "x" }),
        0,
        "Pending",
        new Date().toISOString(),
      )
      .run();
    const response = await worker.fetch(
      new Request(`http://local.test/api/executions/${id}`, { headers: { ...auth } }),
      bindings,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      runtimeStatus: string | null;
      dispatchConfirmed: boolean;
    };
    expect(body.status).toBe("Pending");
    expect(body.dispatchConfirmed).toBe(false);
    // runtimeStatus may be null (expired) or a live advisory string; either
    // way the stored D1 status is never rewritten by introspection.
    const row = await bindings.DB.prepare("SELECT status FROM executions WHERE id=?")
      .bind(id)
      .first<{ status: string }>();
    expect(row?.status).toBe("Pending");
  });

  it("renders traversed pages without presenting first-page counts as totals", () => {
    const page = (ids: string[], hasMore: boolean): ExecutionHistoryResponse => ({
      executions: ids.map((executionId, index) => ({
        executionId,
        sagaId: echoSaga.id,
        sagaName: "echo",
        sagaRevision: "echo-v1",
        orgId: principal.orgId,
        userId: principal.userId,
        status: "Succeeded",
        dispatchConfirmed: true,
        createdAt: `2026-09-0${index + 1}T00:00:00.000Z`,
        startedAt: `2026-09-0${index + 1}T00:00:01.000Z`,
        completedAt: `2026-09-0${index + 1}T00:00:02.000Z`,
      })),
      hasMore,
      nextCursor: hasMore ? "cursor-next" : null,
    });
    const firstHtml = renderToStaticMarkup(
      <MemoryRouter>
        <ExecutionHistoryList initial={page(["a".repeat(64), "b".repeat(64)], true)} />
      </MemoryRouter>,
    );
    expect(firstHtml).toContain("2 Executions loaded");
    expect(firstHtml).toContain("more available server-side");
    expect(firstHtml).toContain("history-load-more");
    expect(firstHtml).not.toContain("complete under these filters");
  });
});
