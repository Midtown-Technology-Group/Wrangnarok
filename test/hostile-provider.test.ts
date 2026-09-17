// SPDX-License-Identifier: AGPL-3.0
// Hostile-provider regression slice (issue #248): deterministic proof on the
// echo Integration path that platform retries never duplicate a
// non-idempotent side effect on their own, redirects never leave the fixture
// origin, and secret-bearing vendor output never reaches outward shapes.
// Test-only fixture at test/helpers/hostile-provider.ts; no production code.
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_SAGA_POLICY, Fault, stepRetryLimit, vendorRetryLimit } from "../src/domain";
import { echo } from "../src/integrations/echo";
import { scrubExecutionError } from "../src/secrets";
import { HOSTILE_ECHO_URL, installHostileEcho } from "./helpers/hostile-provider";

const CONNECTION = { endpoint: HOSTILE_ECHO_URL };
const INPUT = { message: "hello" };
// Synthetic hostile marker: long enough to substring-scrub, shaped like no
// real credential, so Gitleaks and push protection stay quiet.
const HOSTILE_SECRET = "hostile-provider-sentinel-9f3c7a1e2b4d";
const EVIL_LOCATIONS = ["http://169.254.169.254/latest/meta-data/", "https://echo-evil.invalid/hook"];

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
