// SPDX-License-Identifier: AGPL-3.0
// Test-only hostile-provider fixture (issue #248): deterministic programmable
// vendor behavior at the Integration boundary with exact request recording.
//
// Scope: the echo fixture endpoint only. Every outbound call is recorded
// (url, method, Idempotency-Key) so tests can assert how many side effects
// actually occurred. Any request to another URL throws — a redirect follow
// or SSRF bypass would explode the test instead of silently succeeding.
// Vendor bodies/headers are never copied anywhere by this fixture; the
// Integration under test owns shaping and redaction.
import { vi } from "vitest";

export const HOSTILE_ECHO_URL = "http://127.0.0.1:8788/echo";

export interface HostileRequest {
  readonly url: string;
  readonly method: string;
  readonly idempotencyKey: string | null;
}

export type HostileBehavior =
  | { readonly kind: "ok"; readonly message?: string }
  | { readonly kind: "status"; readonly status: number; readonly body?: unknown }
  | { readonly kind: "redirect"; readonly location: string }
  | { readonly kind: "malformed"; readonly raw: string; readonly contentType?: string }
  | {
      readonly kind: "secret500";
      readonly secret: string;
      readonly headerSecret?: boolean;
    };

function toResponse(behavior: HostileBehavior, message: string): Response {
  switch (behavior.kind) {
    case "ok":
      return Response.json({ message: behavior.message ?? message });
    case "status":
      return Response.json(behavior.body ?? { error: "hostile" }, { status: behavior.status });
    case "redirect":
      return new Response(null, { status: 302, headers: { Location: behavior.location } });
    case "malformed":
      return new Response(behavior.raw, {
        status: 200,
        headers: { "Content-Type": behavior.contentType ?? "text/plain" },
      });
    case "secret500": {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (behavior.headerSecret) headers["x-vendor-debug"] = behavior.secret;
      return new Response(JSON.stringify({ error: `vendor down ${behavior.secret}`, detail: behavior.secret }), {
        status: 500,
        headers,
      });
    }
  }
}

export interface HostileHandle {
  readonly requests: HostileRequest[];
}

/** Intercept outbound fetch for one test. Serves the behavior sequence in
 * call order (the last entry repeats) against the echo endpoint only. */
export function installHostileEcho(
  behaviors: HostileBehavior | readonly HostileBehavior[],
  message = "hello",
): HostileHandle {
  const sequence = Array.isArray(behaviors) ? behaviors : [behaviors];
  const requests: HostileRequest[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = input instanceof Request ? input.method : ((init as RequestInit | undefined)?.method ?? "GET");
    const headers = input instanceof Request ? input.headers : new Headers((init as RequestInit | undefined)?.headers);
    requests.push({
      url,
      method,
      idempotencyKey: headers.get("Idempotency-Key"),
    });
    if (url !== HOSTILE_ECHO_URL) throw new Error(`Hostile fixture forbids outbound request: ${url}`);
    const behavior = sequence[Math.min(requests.length - 1, sequence.length - 1)];
    return toResponse(behavior as HostileBehavior, message);
  });
  return { requests };
}
