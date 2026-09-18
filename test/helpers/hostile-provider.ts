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
//
// Ambiguous outcomes need more than a request count: a vendor can apply a
// remote side effect and then lose the response (timeout, disconnect, or a
// 429/500 after partial processing). Behaviors therefore carry an explicit
// `sideEffect` flag, and the handle counts served side effects separately
// from requests. A platform retry that must not duplicate work is proven by
// `requests.length === 1` beside `sideEffects === 1`, and an explicit caller
// redelivery is proven by a stable Idempotency-Key across attempts.
import { vi } from "vitest";

export const HOSTILE_ECHO_URL = "http://127.0.0.1:8788/echo";

export interface HostileRequest {
  readonly url: string;
  readonly method: string;
  readonly idempotencyKey: string | null;
}

export type HostileBehavior =
  | { readonly kind: "ok"; readonly message?: string; readonly sideEffect?: boolean }
  | {
      readonly kind: "status";
      readonly status: number;
      readonly body?: unknown;
      readonly headers?: Record<string, string>;
      readonly sideEffect?: boolean;
    }
  | { readonly kind: "redirect"; readonly location: string }
  | { readonly kind: "malformed"; readonly raw: string; readonly contentType?: string; readonly sideEffect?: boolean }
  | {
      readonly kind: "secret500";
      readonly secret: string;
      readonly headerSecret?: boolean;
    }
  | { readonly kind: "oversized"; readonly bytes: number; readonly message?: string; readonly sideEffect?: boolean }
  | { readonly kind: "truncated"; readonly prefix?: string; readonly sideEffect?: boolean }
  | {
      readonly kind: "timeout";
      readonly name?: "TimeoutError" | "AbortError";
      readonly sideEffect?: boolean;
    }
  | { readonly kind: "hang"; readonly sideEffect?: boolean };

function toResponse(behavior: HostileBehavior, message: string): Response {
  switch (behavior.kind) {
    case "ok":
      return Response.json({ message: behavior.message ?? message });
    case "status":
      return Response.json(behavior.body ?? { error: "hostile" }, {
        status: behavior.status,
        headers: behavior.headers,
      });
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
    case "oversized": {
      // Valid echo-shaped JSON padded past the transport byte bound with
      // trailing whitespace, so a shape mismatch can never mask the bound.
      const shape = JSON.stringify({ message: behavior.message ?? message });
      const padding = " ".repeat(Math.max(0, behavior.bytes - shape.length));
      return new Response(`${shape}${padding}`, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    case "truncated": {
      // A disconnect mid-stream: the first bytes arrive, then the transport
      // fails. This must surface a transport fault, never a parse shape.
      const prefix = behavior.prefix ?? `{"message": "hel`;
      const bytes = new TextEncoder().encode(prefix);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.error(new Error("hostile-truncated-mid-stream"));
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    case "timeout":
    case "hang":
      throw new Error(`Hostile fixture misconfigured: ${behavior.kind} never serves a response.`);
  }
}

function behaviorSideEffect(behavior: HostileBehavior): boolean {
  switch (behavior.kind) {
    case "redirect":
    case "secret500":
      return false;
    default:
      return behavior.sideEffect ?? false;
  }
}

export interface HostileHandle {
  readonly requests: HostileRequest[];
  /** Remote side effects the vendor claims to have applied. Independent of
   * `requests.length`: a lost response still counts its effect, so an
   * ambiguous attempt reads `requests.length === 1, sideEffects === 1`. */
  readonly sideEffects: { count: number };
}

/** Intercept outbound fetch for one test. Serves the behavior sequence in
 * call order (the last entry repeats) against the echo endpoint only. */
export function installHostileEcho(
  behaviors: HostileBehavior | readonly HostileBehavior[],
  message = "hello",
): HostileHandle {
  const sequence = Array.isArray(behaviors) ? behaviors : [behaviors];
  const requests: HostileRequest[] = [];
  const sideEffects = { count: 0 };
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
    const behavior = sequence[Math.min(requests.length - 1, sequence.length - 1)] as HostileBehavior;
    if (behavior.kind === "timeout") {
      // The response is lost after the (optional) remote effect: fail-closed
      // here so no test can mistake this for a vendor response.
      if (behaviorSideEffect(behavior)) sideEffects.count += 1;
      throw new DOMException("hostile-response-lost", behavior.name ?? "TimeoutError");
    }
    if (behavior.kind === "hang") {
      // A connection that never settles: honor the caller's abort signal so
      // the Integration deadline path fires deterministically, instead of
      // hanging the test on the real clock.
      if (behaviorSideEffect(behavior)) sideEffects.count += 1;
      const signal = (init as RequestInit | undefined)?.signal as AbortSignal | null | undefined;
      if (signal?.aborted) throw new DOMException("hostile-hang-aborted", "AbortError");
      if (!signal) throw new DOMException("hostile-hang-no-signal", "AbortError");
      await new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("hostile-hang-aborted", "AbortError")), {
          once: true,
        });
      });
    }
    if (behaviorSideEffect(behavior)) sideEffects.count += 1;
    return toResponse(behavior, message);
  });
  return { requests, sideEffects };
}
