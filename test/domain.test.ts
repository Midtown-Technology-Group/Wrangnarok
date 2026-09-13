import { describe, expect, it } from "vitest";
import {
  boundedJson,
  canTransition,
  canTransitionOperation,
  classifyTerminateError,
  decodeHistoryCursor,
  digestSaga,
  echoSaga,
  encodeHistoryCursor,
  executionId,
  HISTORY_LIMIT_DEFAULT,
  ninjaSaga,
  parseDigestInput,
  parseHistoryQuery,
  parseInput,
  parseCallerKey,
  parseSubmission,
  shapeDigest,
  STEP_RETRY_CEILING,
  stepRetryLimit,
} from "../src/domain";

describe("MVP slice contracts", () => {
  it("uses a stable Saga UUID rather than a class or file name", () => {
    expect(echoSaga.id).toBe("720b9ebf-9b6a-4eac-bae9-6ed22c970401");
    expect(parseSubmission({ sagaId: echoSaga.id, input: { message: "hello" } })).toEqual({
      saga: expect.objectContaining({ id: echoSaga.id }),
      input: { message: "hello" },
    });
    expect(ninjaSaga.id).toBe("2c79a880-f1ac-4183-b324-d05daffc321a");
    expect(parseSubmission({ sagaId: ninjaSaga.id, input: {} })).toEqual({
      saga: expect.objectContaining({ id: ninjaSaga.id }),
      input: {},
    });
    expect(digestSaga.id).toBe("5f3bf136-ba9e-4529-8842-6786270ee80d");
    expect(parseSubmission({ sagaId: digestSaga.id, input: {} })).toEqual({
      saga: expect.objectContaining({ id: digestSaga.id }),
      input: {},
    });
    expect(() => parseDigestInput({ message: "x" })).toThrow();
  });
  it("rejects submitted Organization overrides and unexpected input", () => {
    expect(() => parseSubmission({ sagaId: echoSaga.id, orgId: "other", input: { message: "x" } })).toThrow();
    expect(() => parseInput({ message: "x", token: "secret" })).toThrow();
    expect(() => parseInput({ message: "🎃".repeat(257) })).toThrow();
  });
  it("scopes idempotency to the requester and Organization", async () => {
    const principal = { orgId: "organization-a", userId: "user-a" };
    const id = await executionId(principal, "mvp-slice-key-001");
    expect(await executionId(principal, "mvp-slice-key-001")).toBe(id);
    expect(await executionId({ ...principal, userId: "other" }, "mvp-slice-key-001")).not.toBe(id);
    expect(await executionId({ ...principal, orgId: "other" }, "mvp-slice-key-001")).not.toBe(id);
    // TRG-01 (issue #137): schedule-window keys own the sch- namespace the
    // way endpoint deliveries own wep-; caller keys squatting it fail closed.
    expect(() => parseCallerKey("sch-abc1234567890123")).toThrow(/reserved/);
    expect(parseCallerKey("caller-key-00000001")).toBe("caller-key-00000001");
  });
  it("counts actual streamed bytes before parsing JSON", async () => {
    const body = new Response(" ".repeat(4097)).body;
    await expect(boundedJson(body)).rejects.toMatchObject({ status: 413 });
  });
  it("gates step retries to engine-loss-only with an operator ceiling", () => {
    // Vendor/Integration steps never auto-retry; only idempotent D1
    // checkpoints may retry, up to the ceiling. Unknown names fail closed.
    expect(stepRetryLimit("echo-http-v1")).toBe(0);
    expect(stepRetryLimit("ninja-list-orgs-v1")).toBe(0);
    expect(stepRetryLimit("echo-digest-v1")).toBe(0);
    // SmokeWorkflow D1 probe steps are not idempotent checkpoints: fail closed to 0 (issue #54).
    expect(stepRetryLimit("smoke-write-v1")).toBe(0);
    expect(stepRetryLimit("smoke-verify-v1")).toBe(0);
    expect(stepRetryLimit("prepare-input-v1")).toBe(STEP_RETRY_CEILING);
    expect(stepRetryLimit("persist-success-v1")).toBe(STEP_RETRY_CEILING);
    expect(stepRetryLimit("persist-failure-v1")).toBe(STEP_RETRY_CEILING);
    expect(stepRetryLimit("timeout-mark-v1")).toBe(STEP_RETRY_CEILING);
    expect(STEP_RETRY_CEILING).toBe(2);
    expect(stepRetryLimit("some-future-mutation-v1")).toBe(0);
  });
  it("restricts execution transitions to the canonical table", () => {
    expect(canTransition("Pending", "Running")).toBe(true);
    expect(canTransition("Pending", "Cancelling")).toBe(true);
    expect(canTransition("Running", "Succeeded")).toBe(true);
    expect(canTransition("Running", "Failed")).toBe(true);
    expect(canTransition("Running", "TimedOut")).toBe(true);
    expect(canTransition("Running", "Cancelling")).toBe(true);
    expect(canTransition("Cancelling", "Cancelled")).toBe(true);
    // ADR 001: once Cancelling is written, cancel wins — a racing terminal
    // checkpoint is stale and no-ops, so no Failed edge out of Cancelling.
    expect(canTransition("Cancelling", "Failed")).toBe(false);
    for (const terminal of ["Succeeded", "Failed", "TimedOut", "Cancelled"] as const) {
      for (const next of [
        "Pending",
        "Running",
        "Succeeded",
        "Failed",
        "TimedOut",
        "Cancelling",
        "Cancelled",
      ] as const) {
        expect(canTransition(terminal, next)).toBe(false);
      }
    }
    expect(canTransition("Pending", "Succeeded")).toBe(false);
    expect(canTransition("Pending", "Cancelled")).toBe(false);
    expect(canTransition("Cancelling", "Succeeded")).toBe(false);
    expect(canTransition("Cancelling", "Cancelling")).toBe(false);
    expect(canTransition("Cancelling", "TimedOut")).toBe(false);
    expect(canTransition("Cancelling", "Running")).toBe(false);
  });
  it("classifies native terminate outcomes and fails closed to ambiguous", () => {
    // Exact native codes mapped from the local REST layer (RUN-04, issue
    // #151): an already-settled engine (finite state) confirms logical
    // cancel; a missing instance is reported separately; everything else
    // (transient/control-plane, unknown codes, non-Errors) is ambiguous.
    expect(
      classifyTerminateError(
        new Error("WorkflowError: (instance.cannot_terminate) Cannot terminate instance since its on a finite state"),
      ),
    ).toBe("already-settled");
    expect(classifyTerminateError(new Error("instance.not_found"))).toBe("not-found");
    expect(classifyTerminateError(new Error("WorkflowError: something new broke"))).toBe("ambiguous");
    expect(classifyTerminateError(new Error("boom"))).toBe("ambiguous");
    expect(classifyTerminateError("instance.cannot_terminate")).toBe("already-settled");
    expect(classifyTerminateError(undefined)).toBe("ambiguous");
    expect(classifyTerminateError(null)).toBe("ambiguous");
    expect(classifyTerminateError(42)).toBe("ambiguous");
  });
  it("restricts operation transitions to Running plus terminal states", () => {
    expect(canTransitionOperation("Running", "Succeeded")).toBe(true);
    expect(canTransitionOperation("Running", "Failed")).toBe(true);
    expect(canTransitionOperation("Running", "Running")).toBe(false);
    for (const terminal of ["Succeeded", "Failed"] as const) {
      for (const next of ["Running", "Succeeded", "Failed"] as const) {
        expect(canTransitionOperation(terminal, next)).toBe(false);
      }
    }
  });
  it("shapes a bounded echoable digest from a NinjaOne census", () => {
    expect(
      shapeDigest({
        organizationCount: 2,
        organizations: [
          { id: 1, name: "Acme" },
          { id: 2, name: "Globex" },
        ],
      }),
    ).toEqual({ message: "NinjaOne organizations (2 total): Acme, Globex" });
    expect(shapeDigest({ organizationCount: 0, organizations: [] })).toEqual({
      message: "NinjaOne organizations (0 total): none",
    });
    // Unbounded vendor lists never leak into the echo input bound: names cap
    // at 5 and the message truncates to 1024 UTF-8 bytes on a boundary.
    const many = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, name: `Org ${index + 1}` }));
    const digested = shapeDigest({ organizationCount: 100, organizations: many });
    expect(new TextEncoder().encode(digested.message).length).toBeLessThanOrEqual(1024);
    expect(digested.message).toContain("(100 total)");
    const wide = shapeDigest({ organizationCount: 1, organizations: [{ id: 1, name: "🎃".repeat(500) }] });
    expect(new TextEncoder().encode(wide.message).length).toBeLessThanOrEqual(1024);
    expect(() => parseInput(wide)).not.toThrow();
  });
  it("parses history queries with an allowlisted key set", () => {
    expect(parseHistoryQuery(new URLSearchParams())).toEqual({ statuses: [], limit: HISTORY_LIMIT_DEFAULT });
    expect(parseHistoryQuery(new URLSearchParams("status=Failed"))).toEqual({ statuses: ["Failed"], limit: 20 });
    expect(parseHistoryQuery(new URLSearchParams(`sagaId=${echoSaga.id}&limit=5`))).toEqual({
      statuses: [],
      sagaId: echoSaga.id,
      limit: 5,
    });
    // Multi-status, exact Saga name, and ISO date bounds (issue #152).
    expect(parseHistoryQuery(new URLSearchParams("status=Failed,TimedOut"))).toEqual({
      statuses: ["Failed", "TimedOut"],
      limit: 20,
    });
    expect(parseHistoryQuery(new URLSearchParams("status=Failed,Failed"))).toEqual({
      statuses: ["Failed"],
      limit: 20,
    });
    expect(parseHistoryQuery(new URLSearchParams("sagaName=echo"))).toEqual({
      statuses: [],
      sagaName: "echo",
      limit: 20,
    });
    expect(parseHistoryQuery(new URLSearchParams("startDate=2026-09-01&endDate=2026-09-10"))).toEqual({
      statuses: [],
      startAt: "2026-09-01T00:00:00.000Z",
      endBefore: "2026-09-11T00:00:00.000Z",
      limit: 20,
    });
    expect(parseHistoryQuery(new URLSearchParams("startDate=2026-09-01T12:00:00.000Z"))).toEqual({
      statuses: [],
      startAt: "2026-09-01T12:00:00.000Z",
      limit: 20,
    });
    const queryError = (query: string): string => {
      try {
        parseHistoryQuery(new URLSearchParams(query));
      } catch (error) {
        return (error as { code?: string }).code ?? "NO_CODE";
      }
      throw new Error(`expected parseHistoryQuery(${query}) to throw`);
    };
    expect(queryError("status=Bogus")).toBe("INVALID_STATUS");
    expect(queryError("status=Failed,")).toBe("INVALID_STATUS");
    expect(queryError("status=")).toBe("INVALID_STATUS");
    expect(queryError("status=,,")).toBe("INVALID_STATUS");
    expect(queryError("status= , ")).toBe("INVALID_STATUS");
    expect(queryError("sagaId=nope")).toBe("INVALID_SAGA_ID");
    expect(queryError("sagaName=")).toBe("INVALID_SAGA_NAME");
    expect(queryError("startDate=not-a-date")).toBe("INVALID_START_DATE");
    expect(queryError("endDate=2026-13-99")).toBe("INVALID_END_DATE");
    expect(queryError("startDate=2026-09-10&endDate=2026-09-01")).toBe("INVALID_DATE_RANGE");
    for (const bad of ["0", "51", "abc", "2.5"]) {
      expect(queryError(`limit=${bad}`)).toBe("INVALID_LIMIT");
    }
    expect(queryError("cursor=!!!")).toBe("INVALID_CURSOR");
    expect(queryError("order=asc")).toBe("UNSUPPORTED_QUERY");
    expect(queryError("scope=x")).toBe("UNSUPPORTED_QUERY");
  });
  it("round-trips opaque history cursors without readable row content", () => {
    const id = "a".repeat(64);
    const cursor = encodeHistoryCursor({ createdAt: "2026-09-05T00:00:00.000Z", id });
    expect(cursor).not.toContain("2026-09-05");
    expect(decodeHistoryCursor(cursor)).toEqual({ createdAt: "2026-09-05T00:00:00.000Z", id });
    expect(() => decodeHistoryCursor("not-a-cursor!!")).toThrow();
    expect(() => decodeHistoryCursor(encodeHistoryCursor({ createdAt: "", id }))).toThrow();
  });
});
