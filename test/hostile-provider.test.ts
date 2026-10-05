// SPDX-License-Identifier: AGPL-3.0
// Hostile-provider regression slice (issue #248): deterministic proof on the
// echo Integration path that platform retries never duplicate a
// non-idempotent side effect on their own, redirects never leave the fixture
// origin, and secret-bearing vendor output never reaches outward shapes.
// A transient pin proves 429 with/without Retry-After and 503-transient map
// to the fixed fault with exactly one request and no fabricated retry promise.
// Ambiguous-outcome pins prove a lost response after a remote side effect and
// 429/500 after partial processing record exactly one attempt each with no
// silent retry, oversized bodies stop at the transport byte bound, and a hung
// connection or truncated body surfaces timeout/transport faults.
// Test-only fixture at test/helpers/hostile-provider.ts; no production code.
import { afterEach, expect, it, vi } from "vitest";
import { BODY_LIMIT, DEFAULT_SAGA_POLICY, Fault, stepRetryLimit, vendorRetryLimit } from "../src/domain";
import { echo } from "../src/integrations/echo";
import { scrubExecutionError } from "../src/secrets";
import { HOSTILE_ECHO_URL, installHostileEcho } from "./helpers/hostile-provider";
import type { HostileBehavior } from "./helpers/hostile-provider";

const CONNECTION = { endpoint: HOSTILE_ECHO_URL };
const INPUT = { message: "hello" };
// Synthetic hostile marker: long enough to substring-scrub, shaped like no
// real credential, so Gitleaks and push protection stay quiet.
const HOSTILE_SECRET = "hostile-provider-sentinel-9f3c7a1e2b4d";
const EVIL_LOCATIONS = ["http://169.254.169.254/latest/meta-data/", "https://echo-evil.invalid/hook"];
// Named scripted Retry-After value for the 429-with-header case (seconds).
const RETRY_AFTER_SECONDS = "120";

async function faultOf(promise: Promise<unknown>): Promise<Fault> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Fault);
    return error as Fault;
  }
  throw new Error("Expected the promise to reject with a Fault.");
}

afterEach(() => {
  vi.restoreAllMocks();
});

it("never auto-retries a failed POST: one request per call, stable Idempotency-Key on explicit caller retry", async () => {
  // Policy pins: the vendor step has no engine retry and the default Saga
  // policy grants no vendor retries. A retry is always an explicit new call.
  expect(stepRetryLimit("echo-http-v1")).toBe(0);
  expect(vendorRetryLimit(DEFAULT_SAGA_POLICY)).toBe(0);

  const first = installHostileEcho({ kind: "status", status: 500 });
  const fault = await faultOf(echo(CONNECTION, INPUT, "op-hostile-retry-1"));
  expect(fault).toMatchObject({ status: 502, code: "ECHO_INTEGRATION_FAILED" });
  expect(first.requests).toHaveLength(1);
  expect(first.requests[0]).toMatchObject({
    url: HOSTILE_ECHO_URL,
    method: "POST",
    idempotencyKey: "op-hostile-retry-1",
  });
  vi.restoreAllMocks();

  // Explicit caller redelivery reuses the same operation key, so a
  // destination-side dedup key stays stable; nothing below the caller invents
  // a second side effect on its own.
  const second = installHostileEcho({ kind: "ok" });
  const result = await echo(CONNECTION, INPUT, "op-hostile-retry-1");
  expect(result).toEqual(INPUT);
  expect(second.requests).toHaveLength(1);
  expect(second.requests[0]?.idempotencyKey).toBe("op-hostile-retry-1");
});

it("never follows a redirect off the fixture origin, including link-local SSRF targets", async () => {
  for (const location of EVIL_LOCATIONS) {
    const handle = installHostileEcho({ kind: "redirect", location });
    const fault = await faultOf(echo(CONNECTION, INPUT, "op-hostile-redirect-1"));
    expect(fault).toMatchObject({ status: 502, code: "ECHO_INTEGRATION_FAILED" });
    // Exactly the fixture call; the Location target is never requested.
    expect(handle.requests).toHaveLength(1);
    expect(handle.requests[0]?.url).toBe(HOSTILE_ECHO_URL);
    expect(handle.requests.some((request) => request.url === location)).toBe(false);
    vi.restoreAllMocks();
  }
});

it("keeps secret-bearing and malformed vendor output out of error, history, log, and UI shapes", async () => {
  const handle = installHostileEcho({ kind: "secret500", secret: HOSTILE_SECRET, headerSecret: true });
  const fault = await faultOf(echo(CONNECTION, INPUT, "op-hostile-secret-1"));
  expect(fault).toMatchObject({ status: 502, code: "ECHO_INTEGRATION_FAILED" });
  expect(handle.requests).toHaveLength(1);
  // The outward Fault is a fixed envelope: vendor bodies/headers never ride it.
  expect(`${fault.code} ${fault.message}`).not.toContain(HOSTILE_SECRET);

  // The shapes a caller, history row, log line, or UI detail can carry.
  const apiEnvelope = JSON.stringify({ error: { code: fault.code, message: fault.message } });
  const historyRow = JSON.stringify({
    operation: "echo-http-v1",
    error: { code: fault.code, message: fault.message },
  });
  const logLine = `echo-http-v1 failed ${fault.code}: ${fault.message}`;
  const scrubbed = scrubExecutionError({ code: fault.code, message: fault.message }, "op-hostile-secret-1");
  for (const shape of [apiEnvelope, historyRow, logLine, JSON.stringify(scrubbed)]) {
    expect(shape).not.toContain(HOSTILE_SECRET);
  }
  expect(Object.keys(JSON.parse(apiEnvelope).error).sort()).toEqual(["code", "message"]);
  vi.restoreAllMocks();

  // Malformed hostile bytes surface the fixed parse Fault, untouched.
  installHostileEcho({ kind: "malformed", raw: `not-json ${HOSTILE_SECRET}` });
  const malformed = await faultOf(echo(CONNECTION, INPUT, "op-hostile-secret-2"));
  expect(malformed).toMatchObject({ status: 400, code: "INVALID_JSON" });
  expect(`${malformed.code} ${malformed.message}`).not.toContain(HOSTILE_SECRET);
});

it("maps 429 with/without Retry-After and 503-transient to the fixed fault with no blind retry and exact counts", async () => {
  // Same policy pins as the retry test: the vendor step carries no engine
  // retry, so any second request would be a platform bug, not policy.
  expect(stepRetryLimit("echo-http-v1")).toBe(0);
  expect(vendorRetryLimit(DEFAULT_SAGA_POLICY)).toBe(0);

  const cases: ReadonlyArray<{ readonly behavior: HostileBehavior; readonly op: string }> = [
    {
      behavior: { kind: "status", status: 429, headers: { "Retry-After": RETRY_AFTER_SECONDS } },
      op: "op-hostile-429-header-1",
    },
    { behavior: { kind: "status", status: 429 }, op: "op-hostile-429-bare-1" },
    { behavior: { kind: "status", status: 503 }, op: "op-hostile-503-1" },
  ];
  const messages: string[] = [];
  for (const { behavior, op } of cases) {
    const handle = installHostileEcho(behavior);
    const fault = await faultOf(echo(CONNECTION, INPUT, op));
    // Current mapping: every non-2xx echo response surfaces the fixed fault.
    expect(fault).toMatchObject({ status: 502, code: "ECHO_INTEGRATION_FAILED" });
    messages.push(fault.message);
    // No blind retry: exactly the one scripted outbound request.
    expect(handle.requests).toHaveLength(1);
    expect(handle.requests[0]).toMatchObject({ url: HOSTILE_ECHO_URL, method: "POST", idempotencyKey: op });
    // No fabricated retry promise: the envelope claims no retry, and the
    // named Retry-After value never rides the outward fault — vendor headers
    // stay inside the Integration, per the redaction test above.
    expect(fault.message).not.toMatch(/retr/i);
    expect(`${fault.code} ${fault.message}`).not.toContain(RETRY_AFTER_SECONDS);
    vi.restoreAllMocks();
  }
  // With- and without-header 429 share one fault class and one message: the
  // platform invents no backoff for the bare case.
  expect(new Set(messages).size).toBe(1);
});

it("represents a lost response after a remote side effect as one ambiguous attempt, never a silent retry", async () => {
  // The vendor applied the effect, then the response was lost. The platform
  // must surface failure with exactly the one attempt recorded — a blind
  // retry here would duplicate the remote side effect.
  const handle = installHostileEcho([{ kind: "timeout", sideEffect: true }, { kind: "ok" }]);
  const lost = await faultOf(echo(CONNECTION, INPUT, "op-hostile-lost-1"));
  expect(lost).toMatchObject({ status: 504, code: "ECHO_VENDOR_TIMEOUT" });
  expect(handle.requests).toHaveLength(1);
  expect(handle.sideEffects.count).toBe(1);

  // Explicit caller redelivery reuses the same operation key, so a
  // destination-side dedup key stays stable; the recording proves the second
  // side effect came from the explicit call, not platform invention.
  const result = await echo(CONNECTION, INPUT, "op-hostile-lost-1");
  expect(result).toEqual(INPUT);
  expect(handle.requests).toHaveLength(2);
  expect(handle.requests[0]?.idempotencyKey).toBe("op-hostile-lost-1");
  expect(handle.requests[1]?.idempotencyKey).toBe("op-hostile-lost-1");
});

it("maps 429/500 after partial processing to the fixed fault with one recorded side effect each", async () => {
  // Rate-limit and server failure AFTER the vendor partially processed the
  // call: each explicit attempt records exactly one request and one effect,
  // and the outward fault never claims a retry will happen.
  const handle = installHostileEcho([
    { kind: "status", status: 429, headers: { "Retry-After": RETRY_AFTER_SECONDS }, sideEffect: true },
    { kind: "status", status: 500, sideEffect: true },
  ]);
  const limited = await faultOf(echo(CONNECTION, INPUT, "op-hostile-partial-429"));
  expect(limited).toMatchObject({ status: 502, code: "ECHO_INTEGRATION_FAILED" });
  const failed = await faultOf(echo(CONNECTION, INPUT, "op-hostile-partial-500"));
  expect(failed).toMatchObject({ status: 502, code: "ECHO_INTEGRATION_FAILED" });
  expect(handle.requests).toHaveLength(2);
  expect(handle.sideEffects.count).toBe(2);
  for (const request of handle.requests) {
    expect(request).toMatchObject({ url: HOSTILE_ECHO_URL, method: "POST" });
  }
});

it("rejects oversized vendor bodies at the transport byte bound", async () => {
  // Valid echo-shaped JSON padded past BODY_LIMIT: the bound fires before
  // any shaping, and the fixed fault carries no vendor bytes.
  const handle = installHostileEcho({ kind: "oversized", bytes: BODY_LIMIT + 1024 });
  const fault = await faultOf(echo(CONNECTION, INPUT, "op-hostile-oversized-1"));
  expect(fault).toMatchObject({ status: 413, code: "BODY_TOO_LARGE" });
  expect(handle.requests).toHaveLength(1);
  expect(fault.message).toContain(String(BODY_LIMIT));
});

it("maps a hung connection and a truncated body to timeout/transport faults with no second attempt", async () => {
  // Hang: the connection never settles, so the caller's abort signal ends
  // it. A small explicit deadline keeps this deterministic and fast; the
  // vendor is scripted as having applied the effect before losing contact.
  const hanging = installHostileEcho({ kind: "hang", sideEffect: true });
  const timedOut = await faultOf(echo(CONNECTION, INPUT, "op-hostile-hang-1", 50));
  expect(timedOut).toMatchObject({ status: 504, code: "ECHO_VENDOR_TIMEOUT" });
  expect(hanging.requests).toHaveLength(1);
  expect(hanging.sideEffects.count).toBe(1);
  vi.restoreAllMocks();

  // Truncated: bytes arrive, then the transport fails mid-stream. This is a
  // transport fault, never a parse shape and never a silent partial result.
  const truncated = installHostileEcho({ kind: "truncated" });
  const cut = await faultOf(echo(CONNECTION, INPUT, "op-hostile-truncated-1"));
  expect(cut).toMatchObject({ status: 502, code: "ECHO_INTEGRATION_FAILED" });
  expect(truncated.requests).toHaveLength(1);
  expect(truncated.sideEffects.count).toBe(0);
});

it("keeps the harness credential-free and echo-origin-only: off-origin fetch throws, recordings carry no bodies or headers", async () => {
  const handle = installHostileEcho({ kind: "ok" });
  await expect(fetch("http://127.0.0.1:8788/not-echo")).rejects.toThrow(/forbids outbound request/);
  // The attempt is recorded for counting, then refused: nothing leaves the origin.
  expect(handle.requests).toHaveLength(1);
  expect(handle.requests[0]).toMatchObject({ url: "http://127.0.0.1:8788/not-echo", method: "GET" });
  // Recordings carry routing only — no bodies, no headers, no credentials.
  for (const request of handle.requests) {
    expect(Object.keys(request).sort()).toEqual(["idempotencyKey", "method", "url"]);
  }
});
