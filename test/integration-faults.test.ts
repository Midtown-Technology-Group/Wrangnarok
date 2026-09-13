// Direct fault-path tests for the Integration Actions (src/integrations/*).
// The end-to-end suites cover happy paths through real Workflows; this file
// pins every vendor-fault mapping (auth, transport, deadline, shape) by
// intercepting outbound fetch only — the Integration boundary.
import { afterEach, expect, it, vi } from "vitest";
import { Fault, NINJA_TIMEOUT_MS } from "../src/domain";
import { echo } from "../src/integrations/echo";
import { listOrganizations } from "../src/integrations/ninjaone";

const NINJA_ENDPOINT = "https://ninja-in-test.invalid/api";
const NINJA_TOKEN_URL = "https://ninja-in-test.invalid/oauth/token";
const NINJA_ORGS_URL = "https://ninja-in-test.invalid/api/v2/organizations";
const ECHO_ENDPOINT = "http://127.0.0.1:8788/echo";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockVendor(handler: (url: string) => Response | Promise<Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    return handler(url);
  });
}

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

it("requires NinjaOne credentials behind the Action boundary", async () => {
  const missing = await faultOf(listOrganizations({ endpoint: NINJA_ENDPOINT }, {}));
  expect(missing).toMatchObject({ status: 502, code: "NINJA_NOT_CONFIGURED" });
  const half = await faultOf(listOrganizations({ endpoint: NINJA_ENDPOINT }, { clientId: "id" }));
  expect(half).toMatchObject({ status: 502, code: "NINJA_NOT_CONFIGURED" });
});

it("maps token redirect, rejection, and failure to auth faults", async () => {
  const secrets = { clientId: "id", clientSecret: "secret" };
  mockVendor((url) => {
    if (url === NINJA_TOKEN_URL) return new Response(null, { status: 302 });
    throw new Error(`Unexpected outbound request: ${url}`);
  });
  expect(await faultOf(listOrganizations({ endpoint: NINJA_ENDPOINT }, secrets))).toMatchObject({
    status: 502,
    code: "NINJA_AUTH_FAILED",
  });

  mockVendor((url) => {
    if (url === NINJA_TOKEN_URL) return jsonResponse({ error: "invalid_client" }, 401);
    throw new Error(`Unexpected outbound request: ${url}`);
  });
  expect(await faultOf(listOrganizations({ endpoint: NINJA_ENDPOINT }, secrets))).toMatchObject({
    status: 502,
    code: "NINJA_UNAUTHORIZED",
  });

  mockVendor((url) => {
    if (url === NINJA_TOKEN_URL) return jsonResponse({ error: "down" }, 500);
    throw new Error(`Unexpected outbound request: ${url}`);
  });
  expect(await faultOf(listOrganizations({ endpoint: NINJA_ENDPOINT }, secrets))).toMatchObject({
    status: 502,
    code: "NINJA_AUTH_FAILED",
  });
});

it("maps token transport aborts to timeouts and propagates raw errors", async () => {
  const secrets = { clientId: "id", clientSecret: "secret" };
  for (const name of ["TimeoutError", "AbortError"] as const) {
    mockVendor((url) => {
      if (url === NINJA_TOKEN_URL) throw new DOMException("slow", name);
      throw new Error(`Unexpected outbound request: ${url}`);
    });
    expect(await faultOf(listOrganizations({ endpoint: NINJA_ENDPOINT }, secrets))).toMatchObject({
      status: 504,
      code: "NINJA_VENDOR_TIMEOUT",
    });
  }
  mockVendor((url) => {
    if (url === NINJA_TOKEN_URL) throw new Error("transport down");
    throw new Error(`Unexpected outbound request: ${url}`);
  });
  await expect(listOrganizations({ endpoint: NINJA_ENDPOINT }, secrets)).rejects.toThrow("transport down");
});

it("rejects unexpected token response shapes", async () => {
  const secrets = { clientId: "id", clientSecret: "secret" };
  const shapes: unknown[] = [null, "token", [1], {}, { access_token: 5 }, { access_token: "" }];
  for (const shape of shapes) {
    mockVendor((url) => {
      if (url === NINJA_TOKEN_URL) return jsonResponse(shape);
      throw new Error(`Unexpected outbound request: ${url}`);
    });
    expect(await faultOf(listOrganizations({ endpoint: NINJA_ENDPOINT }, secrets))).toMatchObject({
      status: 502,
      code: "NINJA_BAD_RESPONSE",
    });
  }
});

it("maps organization transport faults and deadlines", async () => {
  const secrets = { clientId: "id", clientSecret: "secret" };
  const token = { access_token: "tok", expires_in: 3600 };
  const cases: Array<{ status: number; code: string }> = [
    { status: 302, code: "NINJA_VENDOR_FAILED" },
    { status: 401, code: "NINJA_UNAUTHORIZED" },
    { status: 429, code: "NINJA_RATE_LIMITED" },
    { status: 500, code: "NINJA_VENDOR_FAILED" },
  ];
  for (const { status, code } of cases) {
    mockVendor((url) => {
      if (url === NINJA_TOKEN_URL) return jsonResponse(token);
      if (url === NINJA_ORGS_URL) {
        return status === 302 ? new Response(null, { status }) : jsonResponse({ error: "x" }, status);
      }
      throw new Error(`Unexpected outbound request: ${url}`);
    });
    expect(await faultOf(listOrganizations({ endpoint: NINJA_ENDPOINT }, secrets))).toMatchObject({
      status: 502,
      code,
    });
  }

  for (const name of ["TimeoutError", "AbortError"] as const) {
    mockVendor((url) => {
      if (url === NINJA_TOKEN_URL) return jsonResponse(token);
      if (url === NINJA_ORGS_URL) throw new DOMException("slow", name);
      throw new Error(`Unexpected outbound request: ${url}`);
    });
    expect(await faultOf(listOrganizations({ endpoint: NINJA_ENDPOINT }, secrets))).toMatchObject({
      status: 504,
      code: "NINJA_VENDOR_TIMEOUT",
    });
  }

  mockVendor((url) => {
    if (url === NINJA_TOKEN_URL) return jsonResponse(token);
    if (url === NINJA_ORGS_URL) throw new Error("transport down");
    throw new Error(`Unexpected outbound request: ${url}`);
  });
  await expect(listOrganizations({ endpoint: NINJA_ENDPOINT }, secrets)).rejects.toThrow("transport down");

  // A vendor that resolves after the deadline (transport ignored the abort)
  // is still a timeout.
  vi.spyOn(Date, "now")
    .mockImplementationOnce(() => 0)
    .mockImplementation(() => NINJA_TIMEOUT_MS + 1000);
  mockVendor((url) => {
    if (url === NINJA_TOKEN_URL) return jsonResponse(token);
    if (url === NINJA_ORGS_URL) return jsonResponse([{ id: 1, name: "Late" }]);
    throw new Error(`Unexpected outbound request: ${url}`);
  });
  expect(await faultOf(listOrganizations({ endpoint: NINJA_ENDPOINT }, secrets))).toMatchObject({
    status: 504,
    code: "NINJA_VENDOR_TIMEOUT",
  });
});

it("rejects unexpected organization list shapes", async () => {
  const secrets = { clientId: "id", clientSecret: "secret" };
  const token = { access_token: "tok", expires_in: 3600 };
  const shapes: unknown[] = [
    { orgs: [{ id: 1 }] },
    null,
    [null],
    [[1]],
    [{ id: "1", name: "Acme" }],
    [{ id: 1, name: 2 }],
  ];
  for (const shape of shapes) {
    mockVendor((url) => {
      if (url === NINJA_TOKEN_URL) return jsonResponse(token);
      if (url === NINJA_ORGS_URL) return jsonResponse(shape);
      throw new Error(`Unexpected outbound request: ${url}`);
    });
    expect(await faultOf(listOrganizations({ endpoint: NINJA_ENDPOINT }, secrets))).toMatchObject({
      status: 502,
      code: "NINJA_BAD_RESPONSE",
    });
  }
});

it("lists organizations and truncates the persisted summary to the bound", async () => {
  const secrets = { clientId: "id", clientSecret: "secret" };
  const many = Array.from({ length: 30 }, (_, index) => ({ id: index + 1, name: `Org ${index + 1}` }));
  mockVendor((url) => {
    if (url === NINJA_TOKEN_URL) return jsonResponse({ access_token: "tok", expires_in: 3600 });
    if (url === NINJA_ORGS_URL) return jsonResponse(many);
    throw new Error(`Unexpected outbound request: ${url}`);
  });
  const result = await listOrganizations({ endpoint: NINJA_ENDPOINT }, secrets);
  expect(result.organizationCount).toBe(30);
  expect(result.organizations).toHaveLength(25);
  expect(result.organizations[0]).toEqual({ id: 1, name: "Org 1" });
});

it("pins the echo Integration to its loopback fixture (issues #236 #239)", async () => {
  // Main's #236 safe-URL policy keeps echo loopback-only at the Action: the
  // exact fixture pin plus the use-time guard fail any other endpoint closed
  // before a vendor fetch — cleartext and public HTTPS alike. The #239
  // environment gate (omitted/explicit-loopback defaults outside local) lives
  // at the Connection validation boundary, pinned in test/integrations.test.ts.
  const cleartext = await faultOf(echo({ endpoint: "http://example.invalid/echo" }, { message: "hi" }, "op-1"));
  expect(cleartext).toMatchObject({ status: 500, code: "INVALID_CONNECTION" });
  const publicHttps = await faultOf(echo({ endpoint: "https://echo.example.com/hook" }, { message: "hi" }, "op-1"));
  expect(publicHttps).toMatchObject({ status: 500, code: "INVALID_CONNECTION" });
});

it("fails closed on unsafe persisted endpoints before any vendor fetch (issue #236)", async () => {
  // Unsafe values never reach fetch: the guard parses first, so the mock
  // would explode if the Action attempted a request.
  mockVendor(() => {
    throw new Error("must not fetch an unsafe endpoint");
  });
  const secrets = { clientId: "id", clientSecret: "secret" };
  expect(await faultOf(listOrganizations({ endpoint: "http://10.9.9.9/api" }, secrets))).toMatchObject({
    status: 500,
    code: "INVALID_CONNECTION",
  });
  expect(await faultOf(listOrganizations({ endpoint: "not-a-url" }, secrets))).toMatchObject({
    status: 500,
    code: "INVALID_CONNECTION",
  });
  expect(await faultOf(echo({ endpoint: "http://10.9.9.9/echo" }, { message: "hi" }, "op-1"))).toMatchObject({
    status: 500,
    code: "INVALID_CONNECTION",
  });
});

it("maps echo transport faults without leaking vendor detail", async () => {
  const input = { message: "hi" };
  mockVendor(() => new Response(null, { status: 302 }));
  expect(await faultOf(echo({ endpoint: ECHO_ENDPOINT }, input, "op-1"))).toMatchObject({
    status: 502,
    code: "ECHO_INTEGRATION_FAILED",
  });

  mockVendor(() => jsonResponse({ error: "down" }, 500));
  expect(await faultOf(echo({ endpoint: ECHO_ENDPOINT }, input, "op-1"))).toMatchObject({
    status: 502,
    code: "ECHO_INTEGRATION_FAILED",
  });

  mockVendor(() => jsonResponse({ message: "other" }));
  expect(await faultOf(echo({ endpoint: ECHO_ENDPOINT }, input, "op-1"))).toMatchObject({
    status: 502,
    code: "ECHO_INTEGRATION_FAILED",
  });

  // A vendor body that fails input parsing surfaces its Fault untouched.
  mockVendor(() => jsonResponse({ nope: true }));
  expect(await faultOf(echo({ endpoint: ECHO_ENDPOINT }, input, "op-1"))).toMatchObject({
    status: 400,
    code: "INVALID_INPUT",
  });

  // A Fault thrown by the transport propagates as-is.
  const direct = new Fault(500, "CUSTOM_FAULT", "custom");
  mockVendor(() => {
    throw direct;
  });
  await expect(echo({ endpoint: ECHO_ENDPOINT }, input, "op-1")).rejects.toBe(direct);

  for (const name of ["TimeoutError", "AbortError"] as const) {
    mockVendor(() => {
      throw new DOMException("slow", name);
    });
    expect(await faultOf(echo({ endpoint: ECHO_ENDPOINT }, input, "op-1"))).toMatchObject({
      status: 504,
      code: "ECHO_VENDOR_TIMEOUT",
    });
  }

  mockVendor(() => {
    throw new Error("transport down");
  });
  expect(await faultOf(echo({ endpoint: ECHO_ENDPOINT }, input, "op-1"))).toMatchObject({
    status: 502,
    code: "ECHO_INTEGRATION_FAILED",
  });
});

it("treats a zero deadline as an exceeded deadline", async () => {
  const input = { message: "hi" };
  mockVendor(() => jsonResponse(input));
  // A late success and a late transport error both surface the timeout:
  // the deadline is explicit, never inferred.
  expect(await faultOf(echo({ endpoint: ECHO_ENDPOINT }, input, "op-1", 0))).toMatchObject({
    status: 504,
    code: "ECHO_VENDOR_TIMEOUT",
  });
  mockVendor(() => {
    throw new Error("transport down");
  });
  expect(await faultOf(echo({ endpoint: ECHO_ENDPOINT }, input, "op-1", 0))).toMatchObject({
    status: 504,
    code: "ECHO_VENDOR_TIMEOUT",
  });
});
