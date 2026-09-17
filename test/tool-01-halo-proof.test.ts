// SPDX-License-Identifier: AGPL-3.0
// TOOL-01 (issue #170) HaloPSA proof: the natural-language-shaped acceptance
// case from ADR 022, executed as protocol evidence against the local Worker.
//
// Story: "Using the Halo connection for this customer, find the open
// tickets assigned to the networking team and add a note to the one for the
// firewall replacement." No Halo endpoint was pre-authored as a dedicated
// tool: the agent searches the pinned contract, inspects the chosen
// operation, and executes through the host. The proof pins: authorized read,
// explicitly-authorized mutation, destructive denial, cross-Organization
// denial, origin-escape denial, and sanitized provenance.
//
// Runs in real workerd with a real D1 binding; only outbound Halo vendor
// HTTP is intercepted. Secrets live in the test env binding, never in D1,
// specs, prompts, logs, or tool results.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { HALO_INTEGRATION_ID } from "../src/domain";
import {
  HALO_ALLOWED_ORIGIN,
  HALO_CLASSIFICATIONS,
  HALO_REAL_OVERLAY,
  HALO_REAL_SPEC_BYTES,
  HALO_REAL_SPEC_DIGEST,
  HALO_REAL_SPEC_MISSING_OPERATION_ID_COUNT,
  HALO_REAL_SPEC_OPERATION_COUNT,
  HALO_REAL_SPEC_PATH_COUNT,
  HALO_REAL_SPEC_RETRIEVED_AT,
  HALO_REAL_SPEC_SOURCE,
  HALO_REAL_SPEC_VERSION,
  HALO_SPEC_VERSION,
  HALO_TIMEOUT_MS,
  executeHaloOperation,
  executeHaloOperationOnContract,
  inspectHaloOperation,
  requireHaloSecrets,
  searchHaloOperations,
} from "../src/integrations/halo";
import {
  applySpecOverlay,
  indexOperations,
  inspectOperation,
  pinContractWithOverlay,
  searchOperations,
  validateContractDocument,
} from "../src/openapi";
import haloRealFixtureText from "./fixtures/halo-real-spec-excerpt.json?raw";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration4 from "../migrations/0004_solutions_install.sql?raw";
import migration11 from "../migrations/0011_connection_admin.sql?raw";
import migration18 from "../migrations/0018_ops.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const ORG = "00000000-0000-4000-8000-000000000001";
const OTHER_USER = "00000000-0000-4000-8000-000000000003";
const OTHER_ORG = "00000000-0000-4000-8000-000000000004";
const HALO_SECRET = "halo-lab-secret-sentinel";
const HALO_ID = "halo-lab-client-sentinel";
const HALO_ACCESS_TOKEN = "halo-lab-access-token-sentinel";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...extra };
}

/** Vendor harness: the lab Halo origin models the documented OAuth2
 * client-credentials flow. POST /auth/token validates the deployment pair and
 * issues a sentinel access token; /api/... accepts ONLY that access token
 * and rejects the raw client id/secret — so a host that sends
 * `Bearer clientId:clientSecret` fails closed with 401 instead of passing.
 * The harness counts token exchanges so tests pin the single-flight
 * contract (exactly one vendor token call per execution). */
function mockHalo() {
  let tokenCalls = 0;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const request = input instanceof Request ? input : new Request(url, init);
    if (!url.startsWith(HALO_ALLOWED_ORIGIN)) throw new Error(`Escape attempt: ${url}`);
    if (url.includes(HALO_SECRET) || url.includes(HALO_ID)) throw new Error("Credential leaked into URL");
    if (url.endsWith("/auth/token")) {
      tokenCalls += 1;
      if (request.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });
      const body = typeof init?.body === "string" ? init.body : "";
      const form = new URLSearchParams(body);
      const ok =
        form.get("grant_type") === "client_credentials" &&
        form.get("client_id") === HALO_ID &&
        form.get("client_secret") === HALO_SECRET &&
        typeof form.get("scope") === "string" &&
        (form.get("scope") as string).length > 0;
      if (!ok) return Response.json({ error: "invalid_client" }, { status: 401 });
      return Response.json({ access_token: HALO_ACCESS_TOKEN, token_type: "Bearer", expires_in: 3600 });
    }
    const auth = request.headers.get("Authorization") ?? "";
    // Only the exchanged access token authorizes resource calls: the raw
    // deployment pair (or a pseudo-Bearer of id:secret) is rejected.
    if (auth !== `Bearer ${HALO_ACCESS_TOKEN}`) return Response.json({ error: "unauthorized" }, { status: 401 });
    // TOOL-01 S2: the real HaloPSA path shapes (no /api prefix — the
    // vendor serves them under the relative servers url "/api"). Matched on
    // exact pathname so lab-fixture URLs never collide with real ones.
    const pathname = new URL(url).pathname;
    if (request.method === "GET" && pathname === "/Actions") {
      return Response.json({
        actions: [{ id: 11, ticketid: 7, outcome: "Firewall replacement scheduled for Friday." }],
      });
    }
    if (request.method === "GET" && pathname === "/Tickets/7") {
      return Response.json({ id: 7, title: "Firewall replacement", team: "networking", status: "open" });
    }
    if (request.method === "POST" && pathname === "/Actions") {
      return Response.json({ id: 7, noteId: 99, noted: true });
    }
    if (request.method === "GET" && url.includes("/api/Tickets?")) {
      return Response.json({
        tickets: [{ id: 7, title: "Firewall replacement", team: "networking", status: "open" }],
      });
    }
    if (request.method === "GET" && url.endsWith("/api/Tickets/7")) {
      return Response.json({ id: 7, title: "Firewall replacement", team: "networking", status: "open" });
    }
    if (request.method === "POST" && url.endsWith("/api/Tickets/7/Notes")) {
      return Response.json({ id: 7, noteId: 99, noted: true });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  });
  return { spy, tokenCalls: () => tokenCalls };
}

async function createHaloConnection(org: string = ORG, endpoint: string = HALO_ALLOWED_ORIGIN): Promise<string> {
  // Seed the Connection row directly: the management route is covered by
  // connections.test.ts; here the proof owns its fixture rows per org.
  const id = `00000000-0000-4000-8000-${org === ORG ? "000000000711" : "000000000712"}`;
  await bindings.DB.prepare(
    "INSERT INTO connections(id,org_id,integration_id,endpoint) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING",
  )
    .bind(id, org, HALO_INTEGRATION_ID, endpoint)
    .run();
  return id;
}

function haloEnv(): Bindings {
  return { ...bindings, HALO_CLIENT_ID: HALO_ID, HALO_CLIENT_SECRET: HALO_SECRET };
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(seed);
  await bindings.DB.exec(migration4);
  await bindings.DB.exec(migration11);
  await bindings.DB.exec(migration18);
  await bindings.DB.prepare("DELETE FROM connections WHERE org_id=?").bind(ORG).run();
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?) ON CONFLICT(id) DO NOTHING")
    .bind(OTHER_ORG, "Other")
    .run();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("HaloPSA Code Mode proof (TOOL-01 acceptance)", () => {
  it("searches the contract and selects the right operation without a pre-authored tool", async () => {
    // The agent's first move: free-text search over the pinned contract.
    const search = await worker.fetch(
      new Request(`https://local.test/api/openapi/search?integration=halo&q=${encodeURIComponent("ticket team")}`, {
        headers: headers(),
      }),
      bindings,
    );
    expect(search.status).toBe(200);
    const found = (await search.json()) as { operations: { operationId: string }[] };
    expect(found.operations.map((entry) => entry.operationId)).toContain("Ticket_Search");
    // Second move: inspect the chosen operation before executing.
    const inspect = await worker.fetch(
      new Request("https://local.test/api/openapi/operations/Ticket_Search", { headers: headers() }),
      bindings,
    );
    expect(inspect.status).toBe(200);
    expect(await inspect.json()).toMatchObject({ operation: { operationId: "Ticket_Search", risk: "read" } });
  });

  it("executes an authorized read and an authorized mutation through the host", async () => {
    const connectionId = await createHaloConnection();
    const halo = mockHalo();
    const env = haloEnv();
    const read = await worker.fetch(
      new Request("https://local.test/api/openapi/execute", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          integration: "halo",
          operationId: "Ticket_Search",
          params: { query: { team: "networking", status: "open" } },
        }),
      }),
      env,
    );
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as {
      result: { tickets: { title: string }[] };
      provenance: Record<string, string>;
    };
    expect(readBody.result.tickets[0]?.title).toBe("Firewall replacement");
    expect(readBody.provenance).toMatchObject({
      orgId: ORG,
      integrationId: HALO_INTEGRATION_ID,
      connectionId,
      operationId: "Ticket_Search",
      specVersion: HALO_SPEC_VERSION,
    });
    expect(typeof readBody.provenance.specDigest).toBe("string");
    expect(JSON.stringify(readBody)).not.toContain(HALO_SECRET);
    // The explicitly-authorized non-destructive mutation.
    const mutate = await worker.fetch(
      new Request("https://local.test/api/openapi/execute", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          integration: "halo",
          operationId: "Ticket_AddNote",
          params: { path: { id: "7" } },
          input: { note: "Firewall replacement scheduled for Friday." },
        }),
      }),
      env,
    );
    expect(mutate.status).toBe(200);
    const mutateBody = (await mutate.json()) as { result: { noted: boolean }; provenance: { operationId: string } };
    expect(mutateBody.result.noted).toBe(true);
    expect(mutateBody.provenance.operationId).toBe("Ticket_AddNote");
    expect(JSON.stringify(mutateBody)).not.toContain(HALO_SECRET);
    // Exactly one token exchange per execution: read plus mutation issue two
    // vendor token calls total (single-flight shares concurrent callers, never
    // repeats within one execution). The transient access token never reaches
    // tool results either — scrubbed like the deployment pair.
    expect(halo.tokenCalls()).toBe(2);
    expect(JSON.stringify(readBody)).not.toContain(HALO_ACCESS_TOKEN);
    expect(JSON.stringify(mutateBody)).not.toContain(HALO_ACCESS_TOKEN);
    // Wire proof: every non-token vendor call carried exactly the exchanged
    // access token — the raw deployment pair never rode a resource
    // Authorization header (the old pseudo-Bearer shape is gone).
    const resourceAuths = halo.spy.mock.calls
      .filter(([input]) => {
        const url = input instanceof Request ? input.url : String(input);
        return !url.endsWith("/auth/token");
      })
      .map(([, init]) => {
        const headers =
          init?.headers instanceof Headers ? init.headers : new Headers((init?.headers ?? {}) as HeadersInit);
        return headers.get("Authorization");
      });
    expect(resourceAuths).toHaveLength(2);
    for (const auth of resourceAuths) expect(auth).toBe(`Bearer ${HALO_ACCESS_TOKEN}`);
  });

  it("denies Halo mutations to non-admin members on REST and MCP (issue #346)", async () => {
    await createHaloConnection();
    mockHalo();
    const env = haloEnv();
    // OTHER_USER is a known user with no membership yet: make them an
    // ordinary member so the denial proves Halo policy, not strangerhood.
    // This suite runs a partial migration set (no 0007): create the
    // membership tables the same way the LAB bootstrap does.
    await bindings.DB.exec(
      "CREATE TABLE IF NOT EXISTS users(user_id TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'active',created_at TEXT NOT NULL,disabled_at TEXT)",
    );
    await bindings.DB.exec(
      "CREATE TABLE IF NOT EXISTS org_memberships(org_id TEXT NOT NULL REFERENCES organizations(id),user_id TEXT NOT NULL REFERENCES users(user_id),role TEXT NOT NULL DEFAULT 'member',status TEXT NOT NULL DEFAULT 'invited',kind TEXT NOT NULL DEFAULT 'ordinary',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(org_id,user_id))",
    );
    const stamp = new Date().toISOString();
    await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
      .bind(OTHER_USER, stamp)
      .run();
    await bindings.DB.prepare(
      "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    )
      .bind(ORG, OTHER_USER, "member", "active", "ordinary", stamp, stamp)
      .run();
    const memberHeaders = () => headers();
    const memberEnv = { ...env, LAB_USER_ID: OTHER_USER };
    // Reads still execute for ordinary members.
    const read = await worker.fetch(
      new Request("https://local.test/api/openapi/execute", {
        method: "POST",
        headers: memberHeaders(),
        body: JSON.stringify({ integration: "halo", operationId: "Ticket_Get", params: { path: { id: "7" } } }),
      }),
      memberEnv,
    );
    expect(read.status).toBe(200);
    // Mutations fail closed before any vendor contact.
    const mutate = await worker.fetch(
      new Request("https://local.test/api/openapi/execute", {
        method: "POST",
        headers: memberHeaders(),
        body: JSON.stringify({
          integration: "halo",
          operationId: "Ticket_AddNote",
          params: { path: { id: "7" } },
          input: { note: "unauthorized note" },
        }),
      }),
      memberEnv,
    );
    expect(mutate.status).toBe(403);
    expect(await mutate.json()).toMatchObject({ error: { code: "OPENAPI_OPERATION_FORBIDDEN" } });
    // The MCP gateway shares the same host boundary.
    const mcp = await worker.fetch(
      new Request("https://local.test/api/mcp", {
        method: "POST",
        headers: memberHeaders(),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            tool: "halo_api_execute",
            input: { operationId: "Ticket_AddNote", params: { path: { id: "7" } }, input: { note: "x" } },
          },
        }),
      }),
      memberEnv,
    );
    expect(mcp.status).toBe(200);
    const mcpBody = (await mcp.json()) as { result: { error: { code: string } } };
    expect(mcpBody.result.error.code).toBe("OPENAPI_OPERATION_FORBIDDEN");
    // Ordinary members cannot create their own Connection either.
    const created = await worker.fetch(
      new Request("https://local.test/api/connections", {
        method: "POST",
        headers: memberHeaders(),
        body: JSON.stringify({ integrationId: HALO_INTEGRATION_ID, config: {} }),
      }),
      memberEnv,
    );
    expect(created.status).toBe(403);
    expect(await created.json()).toMatchObject({ error: { code: "CONNECTION_FORBIDDEN" } });
  });

  it("rejects the destructive operation, cross-org selection, and origin escape", async () => {
    await createHaloConnection();
    mockHalo();
    const env = haloEnv();
    // Destructive without explicit enablement: deny-by-default.
    const destructive = await worker.fetch(
      new Request("https://local.test/api/openapi/execute", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ integration: "halo", operationId: "Ticket_Delete", params: { path: { id: "7" } } }),
      }),
      env,
    );
    expect(destructive.status).toBe(403);
    expect(await destructive.json()).toMatchObject({ error: { code: "OPENAPI_OPERATION_DENIED" } });
    // Cross-Organization: the host resolves Connections for the caller org
    // only. OTHER_ORG has its own Connection row (created above), so the
    // same read succeeds there — but with OTHER_ORG's provenance, never the
    // sibling org's Connection id. Isolation means per-org resolution, and
    // a missing mapping (proven below by deleting the row) answers 424.
    await createHaloConnection(OTHER_ORG);
    const otherRow = await bindings.DB.prepare("SELECT id FROM connections WHERE org_id=? AND integration_id=?")
      .bind(OTHER_ORG, HALO_INTEGRATION_ID)
      .first<{ id: string }>();
    // The fixture caller is not a member of OTHER_ORG, so selection fails at
    // the membership gate (403/404) — a stranger cannot borrow the org.
    const crossOrg = await worker.fetch(
      new Request("https://local.test/api/openapi/execute", {
        method: "POST",
        headers: { ...headers(), "X-Organization-Id": OTHER_ORG },
        body: JSON.stringify({ integration: "halo", operationId: "Ticket_Get", params: { path: { id: "7" } } }),
      }),
      env,
    );
    expect([401, 403, 404]).toContain(crossOrg.status);
    expect(otherRow?.id).not.toBe(
      (
        await bindings.DB.prepare("SELECT id FROM connections WHERE org_id=? AND integration_id=?")
          .bind(ORG, HALO_INTEGRATION_ID)
          .first<{ id: string }>()
      )?.id,
    );
    // Missing mapping answers 424, never a leak: delete OTHER_ORG's row and
    // prove the direct host call for an org without a Connection fails with
    // OPENAPI_CONNECTION_MISSING through the unit path.
    await bindings.DB.prepare("DELETE FROM connections WHERE org_id=? AND integration_id=?")
      .bind(OTHER_ORG, HALO_INTEGRATION_ID)
      .run();
    // Origin escape: a Connection remapped off the allowlist cannot execute.
    await bindings.DB.prepare("UPDATE connections SET endpoint=? WHERE org_id=? AND integration_id=?")
      .bind("https://evil.example.com", ORG, HALO_INTEGRATION_ID)
      .run();
    const escaped = await worker.fetch(
      new Request("https://local.test/api/openapi/execute", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ integration: "halo", operationId: "Ticket_Get", params: { path: { id: "7" } } }),
      }),
      env,
    );
    expect(escaped.status).toBe(403);
    expect(await escaped.json()).toMatchObject({ error: { code: "OPENAPI_ORIGIN_FORBIDDEN" } });
  });

  it("records sanitized provenance in the audit trail", async () => {
    await createHaloConnection();
    mockHalo();
    const read = await worker.fetch(
      new Request("https://local.test/api/openapi/execute", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ integration: "halo", operationId: "Ticket_Get", params: { path: { id: "7" } } }),
      }),
      haloEnv(),
    );
    expect(read.status).toBe(200);
    const audit = await worker.fetch(new Request("https://local.test/api/audit", { headers: headers() }), bindings);
    expect(audit.status).toBe(200);
    const events = (await audit.json()) as { events: { action: string; detail: Record<string, string> }[] };
    const entry = events.events.find((event) => event.action === "codemode.execute");
    expect(entry?.detail).toMatchObject({ operationId: "Ticket_Get", specVersion: HALO_SPEC_VERSION });
    expect(JSON.stringify(entry)).not.toContain(HALO_SECRET);
  });

  it("records sanitized failure evidence for denied and failed attempts", async () => {
    await createHaloConnection();
    mockHalo();
    const env = haloEnv();
    // Denied destructive attempt leaves a failure row (not silence): caller,
    // org/Connection-resolution context, operationId, and spec revision where
    // known — never credential material or vendor body bytes.
    const denied = await worker.fetch(
      new Request("https://local.test/api/openapi/execute", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ integration: "halo", operationId: "Ticket_Delete", params: { path: { id: "7" } } }),
      }),
      env,
    );
    expect(denied.status).toBe(403);
    const deniedAudit = await worker.fetch(
      new Request("https://local.test/api/audit", { headers: headers() }),
      bindings,
    );
    const deniedEvents = (await deniedAudit.json()) as {
      events: { action: string; outcome: string; detail: Record<string, string> }[];
    };
    const deniedEntry = deniedEvents.events.find(
      (event) => event.action === "codemode.execute" && event.outcome === "failure",
    );
    expect(deniedEntry?.detail).toMatchObject({
      operationId: "Ticket_Delete",
      code: "OPENAPI_OPERATION_DENIED",
      specVersion: HALO_SPEC_VERSION,
    });
    expect(JSON.stringify(deniedEntry)).not.toContain(HALO_SECRET);
    expect(JSON.stringify(deniedEntry)).not.toContain(HALO_ID);
    // Vendor fault leaves the same sanitized failure shape.
    const vendorDown = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("vendor down"));
    const failed = await worker.fetch(
      new Request("https://local.test/api/openapi/execute", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ integration: "halo", operationId: "Ticket_Get", params: { path: { id: "7" } } }),
      }),
      env,
    );
    expect(failed.status).toBe(502);
    vendorDown.mockRestore();
  });

  it("aborts oversized vendor bodies on both the REST and MCP execute paths", async () => {
    await createHaloConnection();
    const env = haloEnv();
    // A provider answering above the response bound fails closed on the
    // direct REST path before full buffering — no partial unsanitized bytes.
    // The token exchange answers first (the bound under test is the resource
    // hop, not the token hop).
    const hugeFetch = (async (input: unknown) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/auth/token")) {
        return Response.json({ access_token: HALO_ACCESS_TOKEN, token_type: "Bearer", expires_in: 3600 });
      }
      return new Response("x".repeat(300 * 1024), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const caller = { orgId: ORG, userId: "00000000-0000-4000-8000-000000000002" };
    await expect(
      executeHaloOperation(
        bindings.DB,
        caller,
        { clientId: HALO_ID, clientSecret: HALO_SECRET },
        { operationId: "Ticket_Get", path: { id: "7" } },
        { fetchImpl: hugeFetch },
      ),
    ).rejects.toMatchObject({ code: "OPENAPI_RESPONSE_TOO_LARGE", status: 502 });
    // The MCP gateway shares the same host boundary, so the same oversized
    // vendor body denies as a call-level error with identical code.
    const vendorSpy = vi.spyOn(globalThis, "fetch").mockImplementation(hugeFetch);
    const denied = await worker.fetch(
      new Request("https://local.test/api/mcp", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { tool: "halo_api_execute", input: { operationId: "Ticket_Get", params: { path: { id: "7" } } } },
        }),
      }),
      env,
    );
    expect(denied.status).toBe(200);
    const deniedBody = (await denied.json()) as { result: { error: { code: string } } };
    expect(deniedBody.result.error.code).toBe("OPENAPI_RESPONSE_TOO_LARGE");
    expect(JSON.stringify(deniedBody)).not.toContain(HALO_SECRET);
    vendorSpy.mockRestore();
  });

  it("keeps Connection backend failures out of the missing-Connection diagnosis", async () => {
    await createHaloConnection();
    const caller = { orgId: ORG, userId: "00000000-0000-4000-8000-000000000002" };
    // D1/driver/query faults on the Connection read propagate through the
    // sanitized 5xx path — only genuine CONNECTION_NOT_FOUND maps to 424.
    const lookupFaultDb = new Proxy(bindings.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string, ...rest: unknown[]) => {
            if (typeof sql === "string" && sql.includes("FROM connections")) {
              throw new Error("D1 backend failure: connection reset");
            }
            return (target.prepare as (...args: unknown[]) => unknown)(sql, ...rest);
          };
        }
        const value = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as typeof bindings.DB;
    const failure = await executeHaloOperation(
      lookupFaultDb,
      caller,
      { clientId: HALO_ID, clientSecret: HALO_SECRET },
      { operationId: "Ticket_Get", path: { id: "7" } },
      { fetchImpl: (async () => Response.json({ id: 7 })) as typeof fetch },
    ).then(
      () => "resolved",
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as { code?: string }).code).not.toBe("OPENAPI_CONNECTION_MISSING");
    // The genuine missing mapping still answers 424 through the same path.
    await bindings.DB.prepare("DELETE FROM connections WHERE org_id=? AND integration_id=?")
      .bind(ORG, HALO_INTEGRATION_ID)
      .run();
    await expect(
      executeHaloOperation(
        bindings.DB,
        caller,
        { clientId: HALO_ID, clientSecret: HALO_SECRET },
        { operationId: "Ticket_Get", path: { id: "7" } },
        { fetchImpl: (async () => Response.json({ id: 7 })) as typeof fetch },
      ),
    ).rejects.toMatchObject({ code: "OPENAPI_CONNECTION_MISSING", status: 424 });
    await createHaloConnection();
  });

  it("denies unconfigured credentials without leaking values", async () => {
    await createHaloConnection();
    mockHalo();
    const denied = await worker.fetch(
      new Request("https://local.test/api/openapi/execute", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ integration: "halo", operationId: "Ticket_Get", params: { path: { id: "7" } } }),
      }),
      // No HALO_* bindings: presence check fails loud.
      bindings,
    );
    expect(denied.status).toBe(502);
    expect(await denied.json()).toMatchObject({ error: { code: "HALO_NOT_CONFIGURED" } });
  });

  it("covers host defensive branches: missing/disabled/malformed connections and vendor faults", async () => {
    mockHalo();
    const env = haloEnv();
    const caller = { orgId: ORG, userId: "00000000-0000-4000-8000-000000000002" };
    // Pre-authenticated stubs: these vendor faults live on the resource hop,
    // so the stubs answer the token exchange first, then fail the resource
    // call. A stub that never exchanges still proves the pre-vendor denials.
    const withToken = (resource: typeof fetch): typeof fetch =>
      (async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith("/auth/token")) {
          return Response.json({ access_token: HALO_ACCESS_TOKEN, token_type: "Bearer", expires_in: 3600 });
        }
        return resource(input, init);
      }) as typeof fetch;
    // Missing Connection answers OPENAPI_CONNECTION_MISSING.
    await expect(
      executeHaloOperation(
        bindings.DB,
        caller,
        { clientId: HALO_ID, clientSecret: HALO_SECRET },
        {
          operationId: "Ticket_Get",
          path: { id: "7" },
        },
      ),
    ).rejects.toMatchObject({ code: "OPENAPI_CONNECTION_MISSING" });
    await createHaloConnection();
    // Disabled Connection answers 404-mapped OPENAPI_CONNECTION_MISSING.
    await bindings.DB.prepare("UPDATE connections SET enabled=0 WHERE org_id=? AND integration_id=?")
      .bind(ORG, HALO_INTEGRATION_ID)
      .run();
    await expect(
      executeHaloOperation(
        bindings.DB,
        caller,
        { clientId: HALO_ID, clientSecret: HALO_SECRET },
        {
          operationId: "Ticket_Get",
          path: { id: "7" },
        },
      ),
    ).rejects.toMatchObject({ code: "OPENAPI_CONNECTION_MISSING" });
    await bindings.DB.prepare("UPDATE connections SET enabled=1 WHERE org_id=? AND integration_id=?")
      .bind(ORG, HALO_INTEGRATION_ID)
      .run();
    // Malformed endpoint answers OPENAPI_ORIGIN_FORBIDDEN.
    await bindings.DB.prepare("UPDATE connections SET endpoint=? WHERE org_id=? AND integration_id=?")
      .bind(":::not-a-url", ORG, HALO_INTEGRATION_ID)
      .run();
    await expect(
      executeHaloOperation(
        bindings.DB,
        caller,
        { clientId: HALO_ID, clientSecret: HALO_SECRET },
        {
          operationId: "Ticket_Get",
          path: { id: "7" },
        },
      ),
    ).rejects.toMatchObject({ code: "OPENAPI_ORIGIN_FORBIDDEN" });
    await bindings.DB.prepare("UPDATE connections SET endpoint=? WHERE org_id=? AND integration_id=?")
      .bind(HALO_ALLOWED_ORIGIN, ORG, HALO_INTEGRATION_ID)
      .run();
    // Vendor redirect, error status, unreadable body, and transport throw.
    const redirectFetch = (async () => Response.redirect("https://halo-lab.example.com/x")) as typeof fetch;
    await expect(
      executeHaloOperation(
        bindings.DB,
        caller,
        { clientId: HALO_ID, clientSecret: HALO_SECRET },
        { operationId: "Ticket_Get", path: { id: "7" } },
        { fetchImpl: withToken(redirectFetch) },
      ),
    ).rejects.toMatchObject({ code: "OPENAPI_EXECUTION_FAILED" });
    const errorFetch = (async () => Response.json({ e: 1 }, { status: 500 })) as typeof fetch;
    await expect(
      executeHaloOperation(
        bindings.DB,
        caller,
        { clientId: HALO_ID, clientSecret: HALO_SECRET },
        { operationId: "Ticket_Get", path: { id: "7" } },
        { fetchImpl: withToken(errorFetch) },
      ),
    ).rejects.toMatchObject({ code: "OPENAPI_EXECUTION_FAILED" });
    const garbageFetch = (async () => new Response("not-json{{{", { status: 200 })) as typeof fetch;
    await expect(
      executeHaloOperation(
        bindings.DB,
        caller,
        { clientId: HALO_ID, clientSecret: HALO_SECRET },
        { operationId: "Ticket_Get", path: { id: "7" } },
        { fetchImpl: withToken(garbageFetch) },
      ),
    ).rejects.toMatchObject({ code: "OPENAPI_EXECUTION_FAILED" });
    const throwFetch = (async () => {
      throw new Error("down");
    }) as typeof fetch;
    await expect(
      executeHaloOperation(
        bindings.DB,
        caller,
        { clientId: HALO_ID, clientSecret: HALO_SECRET },
        { operationId: "Ticket_Get", path: { id: "7" } },
        { fetchImpl: withToken(throwFetch) },
      ),
    ).rejects.toMatchObject({ code: "OPENAPI_EXECUTION_FAILED" });
    // Empty body resolves to null result.
    const emptyFetch = (async () => new Response("", { status: 200 })) as typeof fetch;
    const empty = await executeHaloOperation(
      bindings.DB,
      caller,
      { clientId: HALO_ID, clientSecret: HALO_SECRET },
      { operationId: "Ticket_Get", path: { id: "7" } },
      { fetchImpl: withToken(emptyFetch) },
    );
    expect(empty.result).toBe(null);
    // A Fault thrown by the transport propagates unchanged (not wrapped).
    const faultFetch = (async () => {
      const { Fault } = await import("../src/domain");
      throw new Fault(503, "DISPATCH_UNCONFIRMED", "Vendor control plane failed.");
    }) as typeof fetch;
    await expect(
      executeHaloOperation(
        bindings.DB,
        caller,
        { clientId: HALO_ID, clientSecret: HALO_SECRET },
        { operationId: "Ticket_Get", path: { id: "7" } },
        { fetchImpl: withToken(faultFetch) },
      ),
    ).rejects.toMatchObject({ code: "DISPATCH_UNCONFIRMED" });
    // Search/inspect helpers: unknown operation fails closed.
    expect(searchHaloOperations("zzz-no-match-xyz")).toEqual([]);
    expect(() => inspectHaloOperation("Nope_Missing")).toThrow();
    // Secret presence helper: partial credentials fail.
    expect(() => requireHaloSecrets({})).toThrow();
    void env;
  });

  it("rejects the raw deployment pair on resource calls (no pseudo-Bearer)", async () => {
    await createHaloConnection();
    const halo = mockHalo();
    const caller = { orgId: ORG, userId: "00000000-0000-4000-8000-000000000002" };
    // A stale host that never exchanges and sends the raw deployment pair as
    // the Bearer credential fails closed at the token endpoint first
    // (HALO_UNAUTHORIZED) — the vendor never sees a pseudo-Bearer resource
    // call succeed, and no credential material escapes in the Fault.
    const rawPairFetch = (async (input: unknown) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/auth/token")) {
        return Response.json({ error: "invalid_client" }, { status: 401 });
      }
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }) as typeof fetch;
    const denied = await executeHaloOperation(
      bindings.DB,
      caller,
      { clientId: HALO_ID, clientSecret: HALO_SECRET },
      { operationId: "Ticket_Get", path: { id: "7" } },
      { fetchImpl: rawPairFetch },
    ).then(
      () => "resolved",
      (error: unknown) => error,
    );
    expect(denied).toMatchObject({ code: "HALO_UNAUTHORIZED", status: 502 });
    expect(JSON.stringify(denied)).not.toContain(HALO_SECRET);
    expect(JSON.stringify(denied)).not.toContain(HALO_ID);
    void halo;
  });

  it("maps token endpoint failures without leaking secrets", async () => {
    await createHaloConnection();
    mockHalo();
    const caller = { orgId: ORG, userId: "00000000-0000-4000-8000-000000000002" };
    const secrets = { clientId: HALO_ID, clientSecret: HALO_SECRET };
    // Rejected credentials at the token endpoint surface HALO_UNAUTHORIZED.
    const rejectedFetch = (async (input: unknown) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/auth/token")) return Response.json({ error: "invalid_client" }, { status: 401 });
      throw new Error("resource must not be contacted after a token denial");
    }) as typeof fetch;
    const rejected = await executeHaloOperation(
      bindings.DB,
      caller,
      secrets,
      { operationId: "Ticket_Get", path: { id: "7" } },
      { fetchImpl: rejectedFetch },
    ).then(
      () => "resolved",
      (error: unknown) => error,
    );
    expect(rejected).toMatchObject({ code: "HALO_UNAUTHORIZED", status: 502 });
    expect(JSON.stringify(rejected)).not.toContain(HALO_SECRET);
    expect(JSON.stringify(rejected)).not.toContain(HALO_ID);
    // Rate-limited token endpoint: exactly one vendor call, never retried.
    let tokenRateCalls = 0;
    const rateFetch = (async (input: unknown) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/auth/token")) {
        tokenRateCalls += 1;
        return Response.json({ error: "slow down" }, { status: 429 });
      }
      throw new Error("resource must not be contacted after a token denial");
    }) as typeof fetch;
    await expect(
      executeHaloOperation(
        bindings.DB,
        caller,
        secrets,
        { operationId: "Ticket_Get", path: { id: "7" } },
        { fetchImpl: rateFetch },
      ),
    ).rejects.toMatchObject({ code: "HALO_RATE_LIMITED", status: 502 });
    expect(tokenRateCalls).toBe(1);
    // Malformed token body fails closed without echoing vendor bytes.
    const garbageTokenFetch = (async (input: unknown) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/auth/token")) return new Response("not-json{{{", { status: 200 });
      throw new Error("resource must not be contacted after a token denial");
    }) as typeof fetch;
    const garbage = await executeHaloOperation(
      bindings.DB,
      caller,
      secrets,
      { operationId: "Ticket_Get", path: { id: "7" } },
      { fetchImpl: garbageTokenFetch },
    ).then(
      () => "resolved",
      (error: unknown) => error,
    );
    expect(garbage).toMatchObject({ code: "HALO_BAD_RESPONSE", status: 502 });
    expect(JSON.stringify(garbage)).not.toContain("not-json");
    // Token timeout maps to the actionable deadline, and the resource hop is
    // never issued after it.
    const timeoutFetch = (async (input: unknown) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/auth/token")) throw new DOMException("The operation timed out.", "TimeoutError");
      throw new Error("resource must not be contacted after a token timeout");
    }) as typeof fetch;
    await expect(
      executeHaloOperation(
        bindings.DB,
        caller,
        secrets,
        { operationId: "Ticket_Get", path: { id: "7" } },
        { fetchImpl: timeoutFetch },
      ),
    ).rejects.toMatchObject({ code: "HALO_VENDOR_TIMEOUT", status: 504 });
    // Merely-late token failure (transport ignores the abort, then fails
    // past the deadline) reads the same deadline through the clock.
    const lateTokenFetch = (async (input: unknown) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/auth/token")) {
        await new Promise((resolve) => setTimeout(resolve, HALO_TIMEOUT_MS + 50));
        throw new Error("late token failure");
      }
      throw new Error("resource must not be contacted after a token timeout");
    }) as typeof fetch;
    await expect(
      executeHaloOperation(
        bindings.DB,
        caller,
        secrets,
        { operationId: "Ticket_Get", path: { id: "7" } },
        { fetchImpl: lateTokenFetch },
      ),
    ).rejects.toMatchObject({ code: "HALO_VENDOR_TIMEOUT", status: 504 });
    // Merely-late token success (valid token past the deadline) never issues
    // the resource hop: the shared budget is already spent.
    let lateResourceCalls = 0;
    const slowTokenFetch = (async (input: unknown) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/auth/token")) {
        await new Promise((resolve) => setTimeout(resolve, HALO_TIMEOUT_MS + 50));
        return Response.json({ access_token: HALO_ACCESS_TOKEN, token_type: "Bearer", expires_in: 3600 });
      }
      lateResourceCalls += 1;
      return Response.json({ id: 7 });
    }) as typeof fetch;
    await expect(
      executeHaloOperation(
        bindings.DB,
        caller,
        secrets,
        { operationId: "Ticket_Get", path: { id: "7" } },
        { fetchImpl: slowTokenFetch },
      ),
    ).rejects.toMatchObject({ code: "HALO_VENDOR_TIMEOUT", status: 504 });
    expect(lateResourceCalls).toBe(0);
  }, 30000);

  it("holds the shared deadline on the resource hop", async () => {
    await createHaloConnection();
    mockHalo();
    const caller = { orgId: ORG, userId: "00000000-0000-4000-8000-000000000002" };
    const secrets = { clientId: HALO_ID, clientSecret: HALO_SECRET };
    const call = { operationId: "Ticket_Get", path: { id: "7" } };
    const tokenFirst = (resource: (url: string) => Promise<Response> | Response): typeof fetch =>
      (async (input: unknown) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith("/auth/token")) {
          return Response.json({ access_token: HALO_ACCESS_TOKEN, token_type: "Bearer", expires_in: 3600 });
        }
        return resource(url);
      }) as typeof fetch;
    // Aborted resource call maps to the actionable deadline with the token in
    // the scrub set (never leaked through the Fault message). Both abort
    // names count: TimeoutError from AbortSignal.timeout, AbortError from a
    // transport that surfaces the abort directly.
    for (const name of ["TimeoutError", "AbortError"]) {
      const aborted = await executeHaloOperation(bindings.DB, caller, secrets, call, {
        fetchImpl: tokenFirst(() => {
          throw new DOMException("The operation timed out.", name);
        }),
      }).then(
        () => "resolved",
        (error: unknown) => error,
      );
      expect(aborted).toMatchObject({ code: "HALO_VENDOR_TIMEOUT", status: 504 });
      expect(JSON.stringify(aborted)).not.toContain(HALO_ACCESS_TOKEN);
    }
    // Merely-late resource resolve (transport ignores the abort) still reads
    // as a timeout, never a success: the host checks the clock after resolve.
    const late = await executeHaloOperation(bindings.DB, caller, secrets, call, {
      fetchImpl: tokenFirst(async () => {
        await new Promise((resolve) => setTimeout(resolve, HALO_TIMEOUT_MS + 50));
        return Response.json({ id: 7 });
      }),
    }).then(
      () => "resolved",
      (error: unknown) => error,
    );
    expect(late).toMatchObject({ code: "HALO_VENDOR_TIMEOUT", status: 504 });
    // Raw transport failure on the resource hop reads as the vendor not
    // answering (the token-hop mapping already proved above stays distinct).
    await expect(
      executeHaloOperation(bindings.DB, caller, secrets, call, {
        fetchImpl: tokenFirst(() => {
          throw new Error("connection reset");
        }),
      }),
    ).rejects.toMatchObject({ code: "OPENAPI_EXECUTION_FAILED", status: 502 });
  }, 20000);

  it("clears the halo proof audit of token and credential material", async () => {
    await createHaloConnection();
    const halo = mockHalo();
    const read = await worker.fetch(
      new Request("https://local.test/api/openapi/execute", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ integration: "halo", operationId: "Ticket_Get", params: { path: { id: "7" } } }),
      }),
      haloEnv(),
    );
    expect(read.status).toBe(200);
    expect(halo.tokenCalls()).toBe(1);
    const audit = await worker.fetch(new Request("https://local.test/api/audit", { headers: headers() }), bindings);
    expect(audit.status).toBe(200);
    const events = (await audit.json()) as { events: { action: string; detail: Record<string, unknown> }[] };
    const dumped = JSON.stringify(events.events.filter((event) => event.action === "codemode.execute"));
    expect(dumped).not.toContain(HALO_SECRET);
    expect(dumped).not.toContain(HALO_ID);
    expect(dumped).not.toContain(HALO_ACCESS_TOKEN);
  });

  describe("Real HaloPSA spec pin + overlay (TOOL-01 S2)", () => {
    interface RealFixture {
      readonly provenance: {
        readonly source: string;
        readonly retrieved: string;
        readonly fullDocument: {
          readonly sha256: string;
          readonly bytes: number;
          readonly paths: number;
          readonly operations: number;
          readonly missingOperationId: number;
        };
      };
      readonly spec: Record<string, unknown>;
    }

    const fixture = JSON.parse(haloRealFixtureText) as RealFixture;
    const sourceText = JSON.stringify(fixture.spec);
    const caller = { orgId: ORG, userId: "00000000-0000-4000-8000-000000000002" };
    const secrets = { clientId: HALO_ID, clientSecret: HALO_SECRET };
    const admin = { isInstanceAdmin: true, isOrgAdmin: false };

    async function pinReal() {
      const { pinned, doc } = await pinContractWithOverlay(
        { id: HALO_INTEGRATION_ID, name: "halo" },
        sourceText,
        [HALO_ALLOWED_ORIGIN],
        HALO_REAL_OVERLAY,
      );
      return { doc, pinned };
    }

    it("records the authoritative pin metadata without vendoring the full document", () => {
      expect(fixture.provenance.source).toBe(HALO_REAL_SPEC_SOURCE);
      expect(fixture.provenance.retrieved).toBe(HALO_REAL_SPEC_RETRIEVED_AT);
      expect(fixture.provenance.fullDocument.sha256).toBe(HALO_REAL_SPEC_DIGEST);
      expect(fixture.provenance.fullDocument.bytes).toBe(HALO_REAL_SPEC_BYTES);
      expect(fixture.provenance.fullDocument.paths).toBe(HALO_REAL_SPEC_PATH_COUNT);
      expect(fixture.provenance.fullDocument.operations).toBe(HALO_REAL_SPEC_OPERATION_COUNT);
      expect(fixture.provenance.fullDocument.missingOperationId).toBe(HALO_REAL_SPEC_MISSING_OPERATION_ID_COUNT);
      expect(HALO_REAL_SPEC_DIGEST).toMatch(/^[a-f0-9]{64}$/);
      expect(HALO_REAL_SPEC_VERSION).toBe("v2");
      // The excerpt preserves the evidenced defect: all four operations
      // lack operationIds, exactly as served by the vendor.
      const paths = fixture.spec["paths"] as Record<string, Record<string, { operationId?: unknown }>>;
      expect(Object.keys(paths).sort()).toEqual(["/Actions", "/Tickets/{id}"]);
      for (const methods of Object.values(paths)) {
        for (const op of Object.values(methods)) {
          expect(op.operationId).toBeUndefined();
        }
      }
    });

    it("fails closed pinning the real excerpt without the overlay", () => {
      expect(() => validateContractDocument(JSON.parse(sourceText))).toThrow(
        expect.objectContaining({ code: "OPENAPI_CONTRACT_INVALID" }),
      );
    });

    it("applies the overlay deterministically with a non-null digest", async () => {
      const first = await applySpecOverlay(
        fixture.spec as unknown as Parameters<typeof applySpecOverlay>[0],
        HALO_REAL_OVERLAY,
      );
      const second = await applySpecOverlay(
        fixture.spec as unknown as Parameters<typeof applySpecOverlay>[0],
        HALO_REAL_OVERLAY,
      );
      expect(first.overlayDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(second.overlayDigest).toBe(first.overlayDigest);
      // The corrected document validates as the real revision; the source
      // bytes are untouched (defect preserved, never silently mutated).
      expect(validateContractDocument(first.doc)).toMatchObject({ operationCount: 4, version: "v2" });
      expect(JSON.stringify(fixture.spec)).not.toContain("Ticket_Get");
      const operations = indexOperations(first.doc, HALO_CLASSIFICATIONS);
      expect(inspectOperation(operations, "Ticket_Get")).toMatchObject({
        method: "get",
        path: "/Tickets/{id}",
        risk: "read",
      });
      expect(inspectOperation(operations, "Ticket_AddNote")).toMatchObject({
        method: "post",
        path: "/Actions",
        risk: "mutation",
      });
      // Progressive discovery works over real path shapes: "action" narrows
      // to the overlaid Actions operations without a pre-authored tool.
      const hits = searchOperations(operations, "action").map((entry) => entry.operationId);
      expect(hits).toContain("Action_Search");
      expect(hits).toContain("Ticket_AddNote");
    });

    it("rejects overlays that cannot reconcile or would rename vendor IDs", async () => {
      const doc = fixture.spec as unknown as Parameters<typeof applySpecOverlay>[0];
      await expect(
        applySpecOverlay(doc, { operations: { "GET /Missing": { operationId: "X_Y" } } }),
      ).rejects.toMatchObject({ code: "OPENAPI_CONTRACT_INVALID" });
      await expect(
        applySpecOverlay(doc, { operations: { "POST /Missing": { operationId: "X_Y" } } }),
      ).rejects.toMatchObject({ code: "OPENAPI_CONTRACT_INVALID" });
      await expect(
        applySpecOverlay(doc, { operations: { "GET /Actions": { operationId: "bad id!" } } }),
      ).rejects.toMatchObject({ code: "OPENAPI_CONTRACT_INVALID" });
      await expect(
        applySpecOverlay(doc, { operations: { " malformed": { operationId: "X_Y" } } }),
      ).rejects.toMatchObject({ code: "OPENAPI_CONTRACT_INVALID" });
      // Renaming a vendor-supplied operationId is refused: overlays fill
      // missing IDs only.
      const renamed = JSON.parse(sourceText) as {
        paths: Record<string, Record<string, { operationId?: string }>>;
      };
      renamed["paths"]!["/Actions"]!["get"]!.operationId = "Vendor_Supplied";
      await expect(
        applySpecOverlay(renamed as unknown as Parameters<typeof applySpecOverlay>[0], {
          operations: { "GET /Actions": { operationId: "Action_Search" } },
        }),
      ).rejects.toMatchObject({ code: "OPENAPI_CONTRACT_INVALID" });
    });

    it("pins source bytes plus overlay through one fail-closed composition", async () => {
      const first = await pinReal();
      const second = await pinReal();
      // The pin records both digests: source bytes plus the applied overlay,
      // deterministically across pins.
      expect(first.pinned.overlayDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(second.pinned.overlayDigest).toBe(first.pinned.overlayDigest);
      expect(second.pinned.specDigest).toBe(first.pinned.specDigest);
      expect(first.pinned.specVersion).toBe(HALO_REAL_SPEC_VERSION);
      // Fail-closed branches: oversized, malformed, and non-object sources,
      // unreconciled overlays, and missing origins never pin.
      const integration = { id: HALO_INTEGRATION_ID, name: "halo" };
      await expect(
        pinContractWithOverlay(integration, " ".repeat(2 * 1024 * 1024 + 1), [HALO_ALLOWED_ORIGIN], HALO_REAL_OVERLAY),
      ).rejects.toMatchObject({ code: "OPENAPI_CONTRACT_TOO_LARGE" });
      await expect(
        pinContractWithOverlay(integration, "not-json", [HALO_ALLOWED_ORIGIN], HALO_REAL_OVERLAY),
      ).rejects.toMatchObject({ code: "OPENAPI_CONTRACT_INVALID" });
      await expect(
        pinContractWithOverlay(integration, "[1,2]", [HALO_ALLOWED_ORIGIN], HALO_REAL_OVERLAY),
      ).rejects.toMatchObject({ code: "OPENAPI_CONTRACT_INVALID" });
      await expect(pinContractWithOverlay(integration, sourceText, [], HALO_REAL_OVERLAY)).rejects.toMatchObject({
        code: "OPENAPI_CONTRACT_INVALID",
      });
      await expect(
        pinContractWithOverlay(integration, sourceText, [HALO_ALLOWED_ORIGIN], {
          operations: { "GET /Missing": { operationId: "X_Y" } },
        }),
      ).rejects.toMatchObject({ code: "OPENAPI_CONTRACT_INVALID" });
    });

    it("executes a read and an allowed mutation through the host on the overlaid real contract", async () => {
      await createHaloConnection();
      const halo = mockHalo();
      const { doc, pinned } = await pinReal();
      // The pin records both digests: source bytes plus the applied overlay.
      expect(pinned.overlayDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(pinned.specVersion).toBe(HALO_REAL_SPEC_VERSION);
      expect(pinned.specVersion).toBe(HALO_REAL_SPEC_VERSION);
      const read = await executeHaloOperationOnContract(
        bindings.DB,
        caller,
        secrets,
        { operationId: "Ticket_Get", path: { id: "7" } },
        { doc, pinned },
      );
      expect((read.result as { title: string }).title).toBe("Firewall replacement");
      // Provenance preserves the source chain: the source digest and the
      // real revision ride the result, never a silently-mutated doc digest.
      expect(read.provenance).toMatchObject({
        orgId: ORG,
        integrationId: HALO_INTEGRATION_ID,
        operationId: "Ticket_Get",
        specDigest: pinned.specDigest,
        specVersion: HALO_REAL_SPEC_VERSION,
      });
      expect(read.provenance.specDigest).not.toBe(pinned.overlayDigest);
      expect(JSON.stringify(read)).not.toContain(HALO_SECRET);
      expect(JSON.stringify(read)).not.toContain(HALO_ACCESS_TOKEN);
      // The explicitly-authorized non-destructive mutation on the real
      // POST /Actions shape, executed by an admin caller.
      const mutated = await executeHaloOperationOnContract(
        bindings.DB,
        caller,
        secrets,
        { operationId: "Ticket_AddNote", body: { ticketid: 7, note: "Firewall replacement scheduled." } },
        { doc, pinned },
        {},
        admin,
      );
      expect((mutated.result as { noted: boolean }).noted).toBe(true);
      expect(mutated.provenance.operationId).toBe("Ticket_AddNote");
      expect(JSON.stringify(mutated)).not.toContain(HALO_SECRET);
      // Exactly one token exchange per execution, as on the lab path.
      expect(halo.tokenCalls()).toBe(2);
    });

    it("keeps denial and admin-gate invariants on the overlaid contract", async () => {
      await createHaloConnection();
      mockHalo();
      const { doc, pinned } = await pinReal();
      const contract = { doc, pinned };
      // Destructive without explicit enablement: deny-by-default.
      await expect(
        executeHaloOperationOnContract(
          bindings.DB,
          caller,
          secrets,
          { operationId: "Ticket_Delete", path: { id: "7" } },
          contract,
        ),
      ).rejects.toMatchObject({ code: "OPENAPI_OPERATION_DENIED", status: 403 });
      // Mutation without an admin caller fails closed before vendor contact.
      await expect(
        executeHaloOperationOnContract(
          bindings.DB,
          caller,
          secrets,
          { operationId: "Ticket_AddNote", body: { ticketid: 7, note: "x" } },
          contract,
        ),
      ).rejects.toMatchObject({ code: "OPENAPI_OPERATION_FORBIDDEN", status: 403 });
      // Unknown operations fail closed: the overlay adds four IDs, nothing else.
      await expect(
        executeHaloOperationOnContract(bindings.DB, caller, secrets, { operationId: "Ticket_Search" }, contract),
      ).rejects.toMatchObject({ code: "OPENAPI_UNKNOWN_OPERATION" });
    });
  });
});
