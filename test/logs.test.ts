// SPDX-License-Identifier: AGPL-3.0
// OBS-02 (issue #153): bounded author logs/progress with reconnect recovery.
// Runs in real workerd via @cloudflare/vitest-plugin; D1/Workflow bindings
// are never replaced, only outbound vendor HTTP is intercepted. No production
// deployment. No WebSocket/DO/Queue surface: polling over durable D1 rows is
// the first slice, and any live-push design needs an earned ADR.
import { env } from "cloudflare:workers";
import { introspectWorkflowInstance, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { echoSaga, executionId, helloSaga } from "../src/domain";
import {
  appendAuthorLog,
  decodeLogCursor,
  encodeLogCursor,
  LOG_MESSAGE_MAX_CHARS,
  LOG_RETENTION_PER_EXECUTION,
  mergeLogPages,
  parseLogSearchQuery,
  parseLogTailQuery,
} from "../src/logs";
import { createSdkClient, parseLogPage } from "../src/sdk";
import { ensureLabFixture } from "../src/orgs";
import { clearAllExecutionSecrets, registerExecutionSecrets } from "../src/secrets";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration7 from "../migrations/0007_org_membership.sql?raw";
import migration8 from "../migrations/0008_executions_org_fk.sql?raw";
import migration9 from "../migrations/0014_execution_logs.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const principal = { orgId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" };
const SECRET = "test-client-secret-sentinel";

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...extra };
}

function tailRequest(id: string, query = "") {
  return new Request(`http://local.test/api/executions/${id}/logs${query}`, { headers: authHeaders() });
}

function searchRequest(query = "") {
  return new Request(`http://local.test/api/logs${query}`, { headers: authHeaders() });
}

async function insertExecution(
  id: string,
  saga: { id: string; name: string; revision: string } = helloSaga,
): Promise<void> {
  await bindings.DB.prepare(
    "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      saga.id,
      saga.name,
      saga.revision,
      principal.orgId,
      principal.userId,
      JSON.stringify(saga === helloSaga ? { name: "Ada" } : { message: "hi" }),
      1,
      "Succeeded",
      new Date().toISOString(),
    )
    .run();
}

async function logCount(executionIdValue: string): Promise<number> {
  const row = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM execution_logs WHERE execution_id=?")
    .bind(executionIdValue)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(seed);
  await bindings.DB.exec(migration7);
  await bindings.DB.exec(migration8);
  await bindings.DB.exec(migration9);
  // AUTH-01 membership gate: the LAB fixture caller needs an active
  // membership row or every /api/* request fails closed.
  await ensureLabFixture(bindings.DB, principal.orgId, principal.userId);
  clearAllExecutionSecrets();
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("OBS-02 must not fetch");
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  clearAllExecutionSecrets();
  await reset();
});

describe("OBS-02 hello pilot emission (issue #153)", () => {
  it("emits bounded PROGRESS + INFO rows with execution/org/caller attribution in seq order", async () => {
    const key = "obs02-hello-emit-01";
    const id = await executionId(principal, key);
    await using instance = await introspectWorkflowInstance(bindings.HELLO_WORKFLOW, id);
    const accepted = await worker.fetch(
      new Request("http://local.test/api/executions", {
        method: "POST",
        headers: authHeaders({ "Idempotency-Key": key }),
        body: JSON.stringify({ sagaId: helloSaga.id, input: { name: "Ada" } }),
      }),
      bindings,
    );
    expect(accepted.status).toBe(202);
    await instance.waitForStatus("complete");
    const tail = await worker.fetch(tailRequest(id), bindings);
    expect(tail.status).toBe(200);
    const page = parseLogPage(await tail.json());
    expect(page.logs).toHaveLength(2);
    expect(page.logs.map((entry) => entry.level)).toEqual(["PROGRESS", "INFO"]);
    expect(page.logs[0]?.seq).toBeLessThan(page.logs[1]?.seq ?? 0);
    for (const entry of page.logs) {
      expect(entry).toMatchObject({
        executionId: id,
        sagaId: helloSaga.id,
        sagaName: "hello",
        orgId: principal.orgId,
        userId: principal.userId,
      });
    }
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).not.toBeNull();
  });
});

describe("OBS-02 visibility tiers and bounds (issue #153)", () => {
  it("hides DEBUG rows from default reads and returns them only when explicitly asked", async () => {
    const id = "d".repeat(64);
    await insertExecution(id);
    await appendAuthorLog(bindings.DB, id, { level: "DEBUG", message: "diagnostic detail" });
    await appendAuthorLog(bindings.DB, id, { level: "INFO", message: "visible row" });
    const hidden = parseLogPage(await (await worker.fetch(tailRequest(id), bindings)).json());
    expect(hidden.logs.map((entry) => entry.level)).toEqual(["INFO"]);
    const shown = parseLogPage(await (await worker.fetch(tailRequest(id, "?level=DEBUG"), bindings)).json());
    expect(shown.logs.map((entry) => entry.level)).toEqual(["DEBUG"]);
    const both = parseLogPage(await (await worker.fetch(tailRequest(id, "?level=DEBUG,INFO"), bindings)).json());
    expect(both.logs.map((entry) => entry.level)).toEqual(["DEBUG", "INFO"]);
  });

  it("enforces message/data bounds and deterministic seq ordering with cursor pagination", async () => {
    const id = "e".repeat(64);
    await insertExecution(id);
    await expect(appendAuthorLog(bindings.DB, id, { level: "INFO", message: "" })).rejects.toThrow();
    await expect(
      appendAuthorLog(bindings.DB, id, { level: "INFO", message: "x".repeat(LOG_MESSAGE_MAX_CHARS + 1) }),
    ).rejects.toThrow();
    await expect(
      appendAuthorLog(bindings.DB, id, { level: "INFO", message: "ok", data: { big: "x".repeat(2048) } }),
    ).rejects.toThrow();
    await expect(appendAuthorLog(bindings.DB, id, { level: "NOPE" as never, message: "ok" })).rejects.toThrow();
    for (let n = 0; n < 5; n += 1) {
      await appendAuthorLog(bindings.DB, id, { level: "INFO", message: `row-${n}` });
    }
    const first = parseLogPage(await (await worker.fetch(tailRequest(id, "?limit=2"), bindings)).json());
    expect(first.logs.map((entry) => entry.message)).toEqual(["row-0", "row-1"]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    const second = parseLogPage(
      await (
        await worker.fetch(
          tailRequest(id, `?limit=2&cursor=${encodeURIComponent(first.nextCursor as string)}`),
          bindings,
        )
      ).json(),
    );
    expect(second.logs.map((entry) => entry.message)).toEqual(["row-2", "row-3"]);
    expect(second.hasMore).toBe(true);
    const third = parseLogPage(
      await (
        await worker.fetch(
          tailRequest(id, `?limit=2&cursor=${encodeURIComponent(second.nextCursor as string)}`),
          bindings,
        )
      ).json(),
    );
    expect(third.logs.map((entry) => entry.message)).toEqual(["row-4"]);
    expect(third.hasMore).toBe(false);
  });

  it("rejects bad level/limit/cursor/query keys with stable codes", async () => {
    const id = "f".repeat(64);
    await insertExecution(id);
    for (const query of ["?level=Bogus", "?limit=0", "?limit=101", "?cursor=zzz", "?unknown=1"]) {
      const response = await worker.fetch(tailRequest(id, query), bindings);
      expect(response.status).toBe(400);
      const code = ((await response.json()) as { error: { code: string } }).error.code;
      expect(["INVALID_LEVEL", "INVALID_LIMIT", "INVALID_CURSOR", "UNSUPPORTED_QUERY"]).toContain(code);
    }
  });

  it("prunes retention to the newest rows per Execution", async () => {
    const id = "a".repeat(64);
    await insertExecution(id);
    for (let n = 0; n < LOG_RETENTION_PER_EXECUTION + 10; n += 1) {
      await appendAuthorLog(bindings.DB, id, { level: "INFO", message: `retention-${n}` });
    }
    expect(await logCount(id)).toBe(LOG_RETENTION_PER_EXECUTION);
    const tail = parseLogPage(await (await worker.fetch(tailRequest(id, "?limit=100"), bindings)).json());
    expect(tail.logs).toHaveLength(100);
    expect(tail.logs[0]?.message).toBe("retention-10");
  });
});

describe("OBS-02 operator search (issue #153)", () => {
  it("filters by date/level/Saga across the caller's own rows in seq order", async () => {
    const first = "b".repeat(64);
    const second = "c".repeat(64);
    await insertExecution(first, helloSaga);
    await insertExecution(second, echoSaga);
    await appendAuthorLog(bindings.DB, first, { level: "INFO", message: "first-info" });
    await appendAuthorLog(bindings.DB, first, { level: "WARN", message: "first-warn" });
    await appendAuthorLog(bindings.DB, second, { level: "ERROR", message: "second-error" });
    // Backdate AFTER the writes: the window below must exclude first's rows
    // while keeping the fresh second-execution row.
    await bindings.DB.prepare("UPDATE execution_logs SET created_at=? WHERE execution_id=?")
      .bind("2020-01-01T00:00:00.000Z", first)
      .run();
    const bySaga = parseLogPage(await (await worker.fetch(searchRequest(`?sagaId=${helloSaga.id}`), bindings)).json());
    expect(bySaga.logs.length).toBeGreaterThan(0);
    expect(bySaga.logs.every((entry) => entry.sagaId === helloSaga.id)).toBe(true);
    const byName = parseLogPage(await (await worker.fetch(searchRequest("?sagaName=echo"), bindings)).json());
    expect(byName.logs.every((entry) => entry.sagaName === "echo")).toBe(true);
    const byLevel = parseLogPage(await (await worker.fetch(searchRequest("?level=ERROR"), bindings)).json());
    expect(byLevel.logs.map((entry) => entry.message)).toEqual(["second-error"]);
    const window = parseLogPage(
      await (await worker.fetch(searchRequest("?startDate=2021-01-01&endDate=2030-12-31"), bindings)).json(),
    );
    expect(window.logs.every((entry) => entry.executionId !== first)).toBe(true);
    // Cursor traversal preserves filters.
    const page = parseLogPage(await (await worker.fetch(searchRequest("?limit=2"), bindings)).json());
    expect(page.hasMore).toBe(true);
    const resumed = parseLogPage(
      await (
        await worker.fetch(searchRequest(`?limit=2&cursor=${encodeURIComponent(page.nextCursor as string)}`), bindings)
      ).json(),
    );
    const seqs = [...page.logs, ...resumed.logs].map((entry) => entry.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it("rejects bad search keys with stable codes", async () => {
    for (const query of [
      "?sagaId=nope",
      "?sagaName=",
      "?startDate=nope",
      "?endDate=nope",
      "?startDate=2026-09-10&endDate=2026-09-01",
      "?level=Bogus",
      "?limit=51",
      "?cursor=zzz",
      "?unknown=1",
    ]) {
      const response = await worker.fetch(searchRequest(query), bindings);
      expect(response.status).toBe(400);
    }
  });
});

describe("OBS-02 authorization (issue #153)", () => {
  it("denies anonymous tail/search with 401 and hides foreign rows with 404", async () => {
    const id = "9".repeat(64);
    await insertExecution(id);
    await appendAuthorLog(bindings.DB, id, { level: "INFO", message: "owner row" });
    const anon = await worker.fetch(new Request(`http://local.test/api/executions/${id}/logs`), bindings);
    expect(anon.status).toBe(401);
    const anonSearch = await worker.fetch(new Request("http://local.test/api/logs"), bindings);
    expect(anonSearch.status).toBe(401);
    // Foreign owner with a valid token shape: 404, never rows.
    const foreign = { ...bindings, LAB_USER_ID: "00000000-0000-4000-8000-000000000003" };
    const hidden = await worker.fetch(tailRequest(id), foreign);
    expect(hidden.status).toBe(404);
    expect(((await hidden.json()) as { error: { code: string } }).error.code).toBe("EXECUTION_NOT_FOUND");
    const foreignSearch = parseLogPage(await (await worker.fetch(searchRequest(), foreign)).json());
    expect(foreignSearch.logs).toEqual([]);
  });
});

describe("OBS-02 reconnect recovery (issue #153)", () => {
  it("backfills from the cursor after a disconnect and dedupes replayed events by seq", async () => {
    const id = "8".repeat(64);
    await insertExecution(id);
    await appendAuthorLog(bindings.DB, id, { level: "INFO", message: "one" });
    await appendAuthorLog(bindings.DB, id, { level: "INFO", message: "two" });
    const first = parseLogPage(await (await worker.fetch(tailRequest(id), bindings)).json());
    expect(first.logs).toHaveLength(2);
    // Simulated disconnect: the client keeps only its last cursor.
    const cursor = first.nextCursor as string;
    // New rows land while the client is away.
    await appendAuthorLog(bindings.DB, id, { level: "PROGRESS", message: "three" });
    const resumed = parseLogPage(
      await (await worker.fetch(tailRequest(id, `?cursor=${encodeURIComponent(cursor)}`), bindings)).json(),
    );
    expect(resumed.logs.map((entry) => entry.message)).toEqual(["three"]);
    // A full refetch replays rows the client already holds plus the new one:
    // the merge unions by seq with no duplicates (that IS the dedupe proof).
    const replay = parseLogPage(await (await worker.fetch(tailRequest(id), bindings)).json());
    const merged = mergeLogPages(first.logs, replay.logs);
    expect(merged.map((entry) => entry.message)).toEqual(["one", "two", "three"]);
    expect(new Set(merged.map((entry) => entry.seq)).size).toBe(merged.length);
    const mergedGap = mergeLogPages(first.logs, resumed.logs);
    expect(mergedGap.map((entry) => entry.message)).toEqual(["one", "two", "three"]);
    // Empty page keeps the caller's place: the cursor echoes back.
    const idle = parseLogPage(
      await (await worker.fetch(tailRequest(id, `?cursor=${encodeURIComponent(cursor)}&limit=1`), bindings)).json(),
    );
    expect(idle.nextCursor).not.toBeNull();
  });
});

describe("OBS-02 SEC-01 redaction (issue #153)", () => {
  it("scrubs secret substrings before persistence and before streaming", async () => {
    const key = "obs02-secret-redact-01";
    const id = await executionId(principal, key);
    await using instance = await introspectWorkflowInstance(bindings.HELLO_WORKFLOW, id);
    const accepted = await worker.fetch(
      new Request("http://local.test/api/executions", {
        method: "POST",
        headers: authHeaders({ "Idempotency-Key": key }),
        body: JSON.stringify({ sagaId: helloSaga.id, input: { name: `Ada ${SECRET} leak` } }),
      }),
      bindings,
    );
    expect(accepted.status).toBe(202);
    await instance.waitForStatus("complete");
    const dumped = JSON.stringify(
      (await bindings.DB.prepare("SELECT message,data_json FROM execution_logs WHERE execution_id=?").bind(id).all())
        .results,
    );
    expect(dumped).not.toContain(SECRET);
    expect(dumped).toContain("[REDACTED]");
    const tail = await worker.fetch(tailRequest(id), bindings);
    const body = await tail.text();
    expect(body).not.toContain(SECRET);
    const search = await worker.fetch(searchRequest(`?sagaId=${helloSaga.id}`), bindings);
    expect(await search.text()).not.toContain(SECRET);
  });
});

describe("OBS-02 pure log helpers (issue #153)", () => {
  it("round-trips cursors, parses queries, and merges pages deterministically", () => {
    expect(decodeLogCursor(encodeLogCursor(7))).toBe(7);
    expect(() => decodeLogCursor("zzz")).toThrow(/cursor/i);
    expect(() => decodeLogCursor(btoa(JSON.stringify(null)))).toThrow(/cursor/i);
    expect(() => decodeLogCursor(btoa(JSON.stringify({ nope: 1 })))).toThrow(/cursor/i);
    expect(() => decodeLogCursor(btoa(JSON.stringify({ seq: 1.5 })))).toThrow(/cursor/i);
    expect(() => decodeLogCursor(btoa(JSON.stringify({ seq: -1 })))).toThrow(/cursor/i);
    expect(parseLogTailQuery(new URLSearchParams("level=INFO&limit=10"))).toMatchObject({
      levels: ["INFO"],
      limit: 10,
    });
    // Duplicate levels collapse; blank entries fail loud.
    expect(parseLogTailQuery(new URLSearchParams("level=INFO,INFO"))).toMatchObject({ levels: ["INFO"] });
    expect(() => parseLogTailQuery(new URLSearchParams("level="))).toThrow(/Level/);
    expect(() => parseLogTailQuery(new URLSearchParams("level=Bogus"))).toThrow(/Level/);
    expect(() => parseLogTailQuery(new URLSearchParams("nope=1"))).toThrow(/Only level/);
    expect(parseLogSearchQuery(new URLSearchParams("sagaName=echo&level=ERROR"))).toMatchObject({
      sagaName: "echo",
      levels: ["ERROR"],
    });
    // Full datetimes stay exact; plain days roll to the next midnight.
    expect(parseLogSearchQuery(new URLSearchParams("endDate=2026-09-10T12:00:00.000Z")).endBefore).toBe(
      "2026-09-10T12:00:00.000Z",
    );
    expect(parseLogSearchQuery(new URLSearchParams("endDate=2026-09-10")).endBefore).toBe("2026-09-11T00:00:00.000Z");
    expect(() => parseLogSearchQuery(new URLSearchParams("nope=1"))).toThrow(/Only level/);
    const a = [
      {
        seq: 2,
        executionId: "x",
        sagaId: "s",
        sagaName: "n",
        orgId: "o",
        userId: "u",
        level: "INFO",
        message: "b",
        data: null,
        createdAt: "t",
      },
      {
        seq: 1,
        executionId: "x",
        sagaId: "s",
        sagaName: "n",
        orgId: "o",
        userId: "u",
        level: "INFO",
        message: "a",
        data: null,
        createdAt: "t",
      },
    ] as const;
    const merged = mergeLogPages(a.slice(1), [a[0] as (typeof a)[number], a[1] as (typeof a)[number]]);
    expect(merged.map((entry) => entry.seq)).toEqual([1, 2]);
    // Wire guards fail loud on drift, and accept absent cursors.
    expect(() => parseLogPage({})).toThrow(/unexpected shape/);
    expect(() => parseLogPage({ logs: [{ seq: 1 }], hasMore: false })).toThrow(/unexpected shape/);
    expect(() => parseLogPage({ logs: [], hasMore: false, nextCursor: 7 })).toThrow(/unexpected shape/);
    expect(parseLogPage({ logs: [], hasMore: false }).nextCursor).toBeNull();
    expect(parseLogPage({ logs: [], hasMore: false, nextCursor: "c" }).nextCursor).toBe("c");
  });
});

describe("OBS-02 SDK log client (issue #153)", () => {
  function authedFetch(): typeof fetch {
    return (async (url: string | URL | Request, init?: RequestInit) =>
      worker.fetch(
        new Request(url, { ...(init ?? {}), headers: authHeaders(init?.headers as Record<string, string>) }),
        { ...bindings },
      )) as typeof fetch;
  }

  it("tails and searches through the typed client against the live Worker", async () => {
    const id = "7".repeat(64);
    await insertExecution(id);
    await appendAuthorLog(bindings.DB, id, { level: "INFO", message: "client-info" });
    await appendAuthorLog(bindings.DB, id, { level: "PROGRESS", message: "client-progress" });
    const client = createSdkClient({ base: "http://local.test", token: TOKEN, fetchImpl: authedFetch() });
    const tail = await client.tailLogs(id, { level: "INFO", limit: 10 });
    expect(tail.logs.map((entry) => entry.message)).toEqual(["client-info"]);
    const resumed = await client.tailLogs(id, { cursor: tail.nextCursor ?? undefined });
    expect(resumed.logs.map((entry) => entry.message)).toEqual(["client-progress"]);
    const found = await client.searchLogs({ saga: "hello", from: "2020-01-01", to: "2030-01-01", limit: 10 });
    expect(found.logs.length).toBeGreaterThan(0);
    const named = await client.searchLogs({ sagaName: "hello", level: "PROGRESS", limit: 10 });
    expect(named.logs.every((entry) => entry.level === "PROGRESS")).toBe(true);
    await expect(client.tailLogs("abc")).rejects.toMatchObject({ code: "SDK_INVALID_REF" });
  });

  it("fails writes for unknown Executions and non-serializable data", async () => {
    await expect(appendAuthorLog(bindings.DB, "0".repeat(64), { level: "INFO", message: "ghost" })).rejects.toThrow(
      /Unknown Execution/,
    );
    const id = "6".repeat(64);
    await insertExecution(id);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(appendAuthorLog(bindings.DB, id, { level: "INFO", message: "ok", data: circular })).rejects.toThrow();
    // A pile-up of secret substrings truncates post-scrub instead of failing.
    registerExecutionSecrets(id, [SECRET]);
    const piled = `${SECRET} `.repeat(200);
    const seq = await appendAuthorLog(bindings.DB, id, { level: "INFO", message: piled.slice(0, 1024) });
    expect(typeof seq).toBe("number");
    const stored = await bindings.DB.prepare("SELECT message FROM execution_logs WHERE seq=?")
      .bind(seq)
      .first<{ message: string }>();
    expect(stored?.message).not.toContain(SECRET);
    expect(stored?.message.length).toBeLessThanOrEqual(1024);
  });
});
