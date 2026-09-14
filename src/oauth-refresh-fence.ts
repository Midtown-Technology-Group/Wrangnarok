// SPDX-License-Identifier: AGPL-3.0
// Cross-instance rotating-refresh fence (OAUTH-01 follow-up, issue #149).
//
// The isolate-local single-flight map in `src/oauth.ts` cannot serialize two
// concurrent refreshes routed to different Worker instances: each instance
// has its own empty map, so both can POST the same one-time rotating refresh
// token and one racer burns on `invalid_grant`. This Durable Object is the
// cross-instance serialization point: one stub per (tenant, generation)
// fence key performs exactly one vendor POST per refresh round, and every
// racer routed to that stub shares the one in-flight call.
//
// Memory-only by construction. The object carries zero persistent state: no
// `storage` writes, no D1 I/O, no token material retained after the flight
// settles. The caller posts the refresh form fields opaquely; the object
// runs one volatile vendor POST per fence key at a time, streams the shaped
// token body back, and drops everything on settle. SEC-02 stays shut.
import { Fault } from "./domain";

const VALID_FENCE_PATH = /^\/refresh\/[A-Za-z0-9._%-]{1,400}$/u;
const MAX_FORM_BYTES = 8192;

/** One shaped fault line the fence may raise or relay. */
export interface FenceFaultText {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

/** Fault lines the fence relay needs: the vendor-timeout mapping plus the
 * auth-failure and bad-response shapes the caller replays onto the relayed
 * response. Redirect/rate-limit/unauthorized map by status in
 * `readTokenResponse`, so they need no table entry here. */
export interface FenceFaultTable {
  readonly authFailed: FenceFaultText;
  readonly badResponse: FenceFaultText;
  readonly vendorTimeout: FenceFaultText;
}

function fenceKeyFromUrl(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    throw new Fault(400, "OAUTH_FENCE_INVALID", "The refresh fence request is invalid.");
  }
  if (!VALID_FENCE_PATH.test(path)) {
    throw new Fault(400, "OAUTH_FENCE_INVALID", "The refresh fence request is invalid.");
  }
  return path.slice("/refresh/".length);
}

function shapeFaultTable(raw: string): FenceFaultTable {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Fault(400, "OAUTH_FENCE_INVALID", "The refresh fence request is invalid.");
  }
  const table = parsed as Record<string, unknown>;
  const shape = (slot: string): FenceFaultText => {
    const entry = table[slot];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Fault(400, "OAUTH_FENCE_INVALID", "The refresh fence request is invalid.");
    }
    const shaped = entry as Record<string, unknown>;
    if (typeof shaped.status !== "number" || typeof shaped.code !== "string" || typeof shaped.message !== "string") {
      throw new Fault(400, "OAUTH_FENCE_INVALID", "The refresh fence request is invalid.");
    }
    return { status: shaped.status, code: shaped.code, message: shaped.message };
  };
  return { authFailed: shape("authFailed"), badResponse: shape("badResponse"), vendorTimeout: shape("vendorTimeout") };
}

/** Cross-instance rotating-refresh fence. One stub per (tenant, generation)
 * fence key; concurrent `/refresh/<key>` POSTs share one in-flight vendor
 * call so the provider sees exactly one refresh POST per rotation round.
 * Memory-only: no storage writes, no D1, no persisted token. */
export class OAuthRefreshFence {
  private readonly flights = new Map<string, Promise<{ status: number; body: Uint8Array }>>();

  // Durable Object constructors receive (state, env) from the runtime; this
  // class holds no state handle because the fence is purely volatile.
  constructor() {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json(
        { code: "OAUTH_FENCE_INVALID", message: "The refresh fence request is invalid." },
        { status: 405 },
      );
    }
    let key: string;
    try {
      key = fenceKeyFromUrl(request.url);
    } catch (error) {
      return fenceError(error);
    }
    const body = await request.text();
    if (body.length === 0 || body.length > MAX_FORM_BYTES) {
      return Response.json(
        { code: "OAUTH_FENCE_INVALID", message: "The refresh fence request is invalid." },
        { status: 400 },
      );
    }
    const flight = this.flightFor(key, body);
    try {
      const shared = await flight;
      // Fresh body per waiter: one Response body can be consumed only once.
      return new Response(shared.body.slice(), {
        status: shared.status,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      // No leaked flight survives here: flightFor releases on settle, so a
      // failure never poisons the next rotation round for this key.
      return fenceError(error);
    }
  }

  private flightFor(key: string, body: string): Promise<{ status: number; body: Uint8Array }> {
    const existing = this.flights.get(key);
    if (existing !== undefined) return existing;
    const task = (async (): Promise<Response> => {
      const fields = new URLSearchParams(body);
      const tokenUrl = fields.get("token_url");
      const form = fields.get("form");
      const faultsRaw = fields.get("faults");
      const timeoutRaw = fields.get("timeout_ms");
      if (tokenUrl === null || form === null || faultsRaw === null || timeoutRaw === null) {
        throw new Fault(400, "OAUTH_FENCE_INVALID", "The refresh fence request is invalid.");
      }
      let faults: FenceFaultTable;
      try {
        faults = shapeFaultTable(faultsRaw);
      } catch (error) {
        if (error instanceof Fault && error.code === "OAUTH_FENCE_INVALID") throw error;
        throw new Fault(400, "OAUTH_FENCE_INVALID", "The refresh fence request is invalid.");
      }
      const timeoutMs = Number(timeoutRaw);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
        throw new Fault(400, "OAUTH_FENCE_INVALID", "The refresh fence request is invalid.");
      }
      let vendor: Response;
      try {
        vendor = await fetch(tokenUrl, {
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: form,
        });
      } catch (error) {
        if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
          throw new Fault(faults.vendorTimeout.status, faults.vendorTimeout.code, faults.vendorTimeout.message);
        }
        throw error;
      }
      // Buffer the vendor body inside the object so every waiter gets its own
      // copy; the 4 KiB transport bound still applies hop by hop.
      const bytes = new Uint8Array(await vendor.arrayBuffer());
      if (bytes.length > 4096) {
        throw new Fault(413, "BODY_TOO_LARGE", "The body exceeds 4096 bytes.");
      }
      return new Response(bytes, { status: vendor.status, headers: { "Content-Type": "application/json" } });
    })();
    // Cache the buffered outcome: waiters share the bytes, and the fence
    // releases on settle so the next rotation round fetches again.
    const shared = task.then(async (response) => ({
      status: response.status,
      body: new Uint8Array(await response.arrayBuffer()),
    }));
    this.flights.set(key, shared);
    const cleanup = (): void => {
      if (this.flights.get(key) === shared) this.flights.delete(key);
    };
    void shared.then(cleanup, cleanup);
    return shared;
  }
}

function fenceError(error: unknown): Response {
  if (error instanceof Fault) {
    return Response.json({ code: error.code, message: error.message }, { status: error.status });
  }
  throw error;
}
