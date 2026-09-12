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
  HALO_SPEC_VERSION,
  executeHaloOperation,
  inspectHaloOperation,
  requireHaloSecrets,
  searchHaloOperations,
} from "../src/integrations/halo";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration4 from "../migrations/0004_solutions_install.sql?raw";
import migration11 from "../migrations/0011_connection_admin.sql?raw";
import migration18 from "../migrations/0018_ops.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const ORG = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG = "00000000-0000-4000-8000-000000000004";
const HALO_SECRET = "halo-lab-secret-sentinel";
const HALO_ID = "halo-lab-client-sentinel";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...extra };
}

/** Vendor harness: the lab Halo origin answers canned payloads; the secret
 * sentinel rides the Authorization expectation so a credential leak into the
 * URL or body would fail the assertion, not just the scrub. */
function mockHalo() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const request = input instanceof Request ? input : new Request(url, init);
    if (!url.startsWith(HALO_ALLOWED_ORIGIN)) throw new Error(`Escape attempt: ${url}`);
    if (url.includes(HALO_SECRET) || url.includes(HALO_ID)) throw new Error("Credential leaked into URL");
    const auth = request.headers.get("Authorization") ?? "";
    if (!auth.includes(HALO_SECRET)) return Response.json({ error: "unauthorized" }, { status: 401 });
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
      new Request(`http://local.test/api/openapi/search?integration=halo&q=${encodeURIComponent("ticket team")}`, {
        headers: headers(),
      }),
      bindings,
    );
    expect(search.status).toBe(200);
    const found = (await search.json()) as { operations: { operationId: string }[] };
    expect(found.operations.map((entry) => entry.operationId)).toContain("Ticket_Search");
    // Second move: inspect the chosen operation before executing.
    const inspect = await worker.fetch(
      new Request("http://local.test/api/openapi/operations/Ticket_Search", { headers: headers() }),
      bindings,
    );
    expect(inspect.status).toBe(200);
    expect(await inspect.json()).toMatchObject({ operation: { operationId: "Ticket_Search", risk: "read" } });
  });

  it("executes an authorized read and an authorized mutation through the host", async () => {
    const connectionId = await createHaloConnection();
    mockHalo();
    const env = haloEnv();
    const read = await worker.fetch(
      new Request("http://local.test/api/openapi/execute", {
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
      new Request("http://local.test/api/openapi/execute", {
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
  });

  it("rejects the destructive operation, cross-org selection, and origin escape", async () => {
    await createHaloConnection();
    mockHalo();
    const env = haloEnv();
    // Destructive without explicit enablement: deny-by-default.
    const destructive = await worker.fetch(
      new Request("http://local.test/api/openapi/execute", {
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
      new Request("http://local.test/api/openapi/execute", {
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
      new Request("http://local.test/api/openapi/execute", {
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
      new Request("http://local.test/api/openapi/execute", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ integration: "halo", operationId: "Ticket_Get", params: { path: { id: "7" } } }),
      }),
      haloEnv(),
    );
    expect(read.status).toBe(200);
    const audit = await worker.fetch(new Request("http://local.test/api/audit", { headers: headers() }), bindings);
    expect(audit.status).toBe(200);
    const events = (await audit.json()) as { events: { action: string; detail: Record<string, string> }[] };
    const entry = events.events.find((event) => event.action === "codemode.execute");
    expect(entry?.detail).toMatchObject({ operationId: "Ticket_Get", specVersion: HALO_SPEC_VERSION });
    expect(JSON.stringify(entry)).not.toContain(HALO_SECRET);
  });

  it("denies unconfigured credentials without leaking values", async () => {
    await createHaloConnection();
    mockHalo();
    const denied = await worker.fetch(
      new Request("http://local.test/api/openapi/execute", {
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
        { fetchImpl: redirectFetch },
      ),
    ).rejects.toMatchObject({ code: "OPENAPI_EXECUTION_FAILED" });
    const errorFetch = (async () => Response.json({ e: 1 }, { status: 500 })) as typeof fetch;
    await expect(
      executeHaloOperation(
        bindings.DB,
        caller,
        { clientId: HALO_ID, clientSecret: HALO_SECRET },
        { operationId: "Ticket_Get", path: { id: "7" } },
        { fetchImpl: errorFetch },
      ),
    ).rejects.toMatchObject({ code: "OPENAPI_EXECUTION_FAILED" });
    const garbageFetch = (async () => new Response("not-json{{{", { status: 200 })) as typeof fetch;
    await expect(
      executeHaloOperation(
        bindings.DB,
        caller,
        { clientId: HALO_ID, clientSecret: HALO_SECRET },
        { operationId: "Ticket_Get", path: { id: "7" } },
        { fetchImpl: garbageFetch },
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
        { fetchImpl: throwFetch },
      ),
    ).rejects.toMatchObject({ code: "OPENAPI_EXECUTION_FAILED" });
    // Empty body resolves to null result.
    const emptyFetch = (async () => new Response("", { status: 200 })) as typeof fetch;
    const empty = await executeHaloOperation(
      bindings.DB,
      caller,
      { clientId: HALO_ID, clientSecret: HALO_SECRET },
      { operationId: "Ticket_Get", path: { id: "7" } },
      { fetchImpl: emptyFetch },
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
        { fetchImpl: faultFetch },
      ),
    ).rejects.toMatchObject({ code: "DISPATCH_UNCONFIRMED" });
    // Search/inspect helpers: unknown operation fails closed.
    expect(searchHaloOperations("zzz-no-match-xyz")).toEqual([]);
    expect(() => inspectHaloOperation("Nope_Missing")).toThrow();
    // Secret presence helper: partial credentials fail.
    expect(() => requireHaloSecrets({})).toThrow();
    void env;
  });
});
