// SPDX-License-Identifier: AGPL-3.0
import { boundedJson, ECHO_INTEGRATION_ID, Fault, parseInput, VENDOR_TIMEOUT_MS } from "../domain";
import type { EchoInput } from "../domain";
import { assertSafeEndpoint } from "./index";
export const echoIntegration = Object.freeze({ id: ECHO_INTEGRATION_ID, name: "echo" });
export interface EchoConnection {
  endpoint: string;
}
/** Fixture-only Action: POST echoes data without mutating any external resource.
 * Enforces its own explicit deadline: a vendor that is slow (abort fires) or
 * merely late (resolves after the deadline because the transport ignored the
 * abort) surfaces ECHO_VENDOR_TIMEOUT. The Saga maps that code onto the
 * explicit timeout-mark-v1 checkpoint; TimedOut is never inferred. */
export async function echo(
  connection: EchoConnection,
  input: EchoInput,
  operationId: string,
  timeoutMs?: number,
): Promise<EchoInput> {
  const deadline = timeoutMs ?? VENDOR_TIMEOUT_MS;
  // The first slice supports only this local vendor fixture, not arbitrary user URLs.
  // The safe-URL guard parses the persisted value before the exact pin, so
  // rows that predate persist-time validation fail closed here too.
  assertSafeEndpoint("echo", connection.endpoint);
  if (connection.endpoint !== "http://127.0.0.1:8788/echo") {
    throw new Fault(500, "INVALID_CONNECTION", "The echo Integration requires its local fixture endpoint.");
  }
  const started = Date.now();
  const timedOut = () => Date.now() - started >= deadline;
  try {
    const response = await fetch(connection.endpoint, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(deadline),
      headers: { "Content-Type": "application/json", "Idempotency-Key": operationId },
      body: JSON.stringify(input),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error("echo_http_redirect");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("echo_http_failure");
    }
    const output = parseInput(await boundedJson(response.body));
    if (output.message !== input.message) throw new Error("echo_output_mismatch");
    if (timedOut()) throw new Fault(504, "ECHO_VENDOR_TIMEOUT", "The echo Integration exceeded its deadline.");
    return output;
  } catch (error) {
    // Never persist a vendor response body, URL, request headers, or raw exception.
    if (error instanceof Fault) throw error;
    if (
      timedOut() ||
      (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"))
    ) {
      throw new Fault(504, "ECHO_VENDOR_TIMEOUT", "The echo Integration exceeded its deadline.");
    }
    throw new Fault(502, "ECHO_INTEGRATION_FAILED", "The local echo Integration did not return the expected response.");
  }
}
