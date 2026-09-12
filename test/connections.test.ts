// SPDX-License-Identifier: AGPL-3.0
// CON-01 (issue #146): authorized Integration/Connection management through
// one Worker boundary. Runs in real workerd with a real D1 binding (full
// migration chain 0001-0008 plus 0011); only outbound vendor HTTP is intercepted.
// Secret values never appear on any path: management writes carry non-secret
// config only, views carry required-secret names only, and the deployment
// scrub pins every response.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import {
  createConnection,
  deleteConnection,
  getConnection,
  testConnection,
  updateConnection,
} from "../src/connections";
import { ECHO_INTEGRATION_ID, NINJA_INTEGRATION_ID } from "../src/domain";
import { buildOrgCtx } from "../src/saga";
import { resolveConnection } from "../src/executions";
import type { ExecutionRow } from "../src/executions";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration3 from "../migrations/0003_usage_blocks.sql?raw";
import migration4 from "../migrations/0004_solutions_install.sql?raw";
import migration5 from "../migrations/0005_forms.sql?raw";
import migration6 from "../migrations/0006_apps.sql?raw";
import migration7 from "../migrations/0007_org_membership.sql?raw";
import migration8 from "../migrations/0008_executions_org_fk.sql?raw";
import migration9 from "../migrations/0011_connection_admin.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const ORG = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000002";
const OTHER_USER = "00000000-0000-4000-8000-000000000003";
const OTHER_ORG = "00000000-0000-4000-8000-000000000004";
const TOKEN = "a".repeat(64);
const SECRET_SENTINEL = "test-client-secret-sentinel";

const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

function call(path: string, method = "GET", body?: unknown, extra: Record<string, string> = {}) {
  return new Request(`http://local.test${path}`, {
    method,
    headers: { ...auth, ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function jsonOf(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(migration3);
  await bindings.DB.exec(migration4);
  await bindings.DB.exec(seed);
  await bindings.DB.exec(migration5);
  await bindings.DB.exec(migration6);
  await bindings.DB.exec(migration7);
  await bindings.DB.exec(migration8);
  await bindings.DB.exec(migration9);
  // The LAB fixture identity self-bootstraps membership on first request
  // (src/auth.ts); the second org is created directly since cross-org
  // membership for the fixture caller would widen its scope. The foreign
  // caller below overrides LAB_USER_ID per request, which bootstraps
  // nothing — exactly the stranger posture the lifecycle tests pin.
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?) ON CONFLICT(id) DO NOTHING")
    .bind(OTHER_ORG, "Other")
    .run();
  // The local seed owns the fixture echo row for the LAB org; this suite
  // owns every mapping it asserts on, so start without it.
  await bindings.DB.prepare("DELETE FROM connections WHERE org_id=?").bind(ORG).run();
  // Intercept only outbound vendor HTTP. Native D1/Workflow bindings are never replaced.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "http://127.0.0.1:8788/echo") return Response.json({ message: "connection-test" });
    if (url.endsWith("/oauth/token")) return Response.json({ access_token: "probe", token_type: "Bearer" });
    throw new Error(`Unexpected outbound request: ${url}`);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("Integration discovery (CON-01)", () => {
  it("serves portable definitions with schema, defaults, and health — never org state", async () => {
    const response = await worker.fetch(call("/api/integrations"), bindings);
    expect(response.status).toBe(200);
    const body = await jsonOf(response);
    const integrations = body.integrations as { id: string; name: string; requiredSecrets: string[] }[];
    expect(integrations.map((entry) => entry.name).sort()).toEqual(["echo", "ninjaone"]);
    const echo = integrations.find((entry) => entry.name === "echo");
    const text = JSON.stringify(body);
    // The echo default endpoint is a portable declaration (schema default),
    // not tenant state: no org rows or secret values ride discovery.
    expect(echo).toMatchObject({ id: ECHO_INTEGRATION_ID, requiredSecrets: [] });
    expect(text).not.toContain(SECRET_SENTINEL);
    expect(text).not.toContain(ORG);
  });

  it("denies unauthenticated discovery and rejects query strings", async () => {
    expect((await worker.fetch(new Request("http://local.test/api/integrations"), bindings)).status).toBe(401);
    const bad = await worker.fetch(call("/api/integrations?scope=all"), bindings);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "UNSUPPORTED_QUERY" } });
  });
});

describe("Connection CRUD (CON-01)", () => {
  it("creates, reads, updates, disables, and deletes a loose mapping with stable identity", async () => {
    const created = await worker.fetch(
      call("/api/connections", "POST", {
        integrationId: ECHO_INTEGRATION_ID,
        config: {},
        displayName: "Fixture echo",
      }),
      bindings,
    );
    expect(created.status).toBe(201);
    const createdBody = await jsonOf(created);
    const connection = createdBody.connection as { id: string; endpoint: string; enabled: boolean };
    const stableId = connection.id;
    // The echo default endpoint applies when the writer omits it.
    expect(connection.endpoint).toBe("http://127.0.0.1:8788/echo");
    expect(connection.enabled).toBe(true);

    const read = await worker.fetch(call(`/api/connections/${ECHO_INTEGRATION_ID}`), bindings);
    expect(await read.json()).toMatchObject({
      connection: { id: stableId, displayName: "Fixture echo", ownerKind: "loose", managedBy: null },
    });

    const listed = await worker.fetch(call("/api/connections"), bindings);
    expect(await listed.json()).toMatchObject({ connections: [{ id: stableId }] });

    const disabled = await worker.fetch(
      call(`/api/connections/${ECHO_INTEGRATION_ID}`, "PUT", { enabled: false }),
      bindings,
    );
    expect(await disabled.json()).toMatchObject({ connection: { id: stableId, enabled: false } });

    const removed = await worker.fetch(call(`/api/connections/${ECHO_INTEGRATION_ID}`, "DELETE"), bindings);
    expect(removed.status).toBe(200);
    expect((await worker.fetch(call(`/api/connections/${ECHO_INTEGRATION_ID}`), bindings)).status).toBe(404);
  });

  it("refuses duplicates, unknown Integrations, and credential-shaped config", async () => {
    const first = await worker.fetch(
      call("/api/connections", "POST", { integrationId: ECHO_INTEGRATION_ID, config: {} }),
      bindings,
    );
    expect(first.status).toBe(201);
    const duplicate = await worker.fetch(
      call("/api/connections", "POST", { integrationId: ECHO_INTEGRATION_ID, config: {} }),
      bindings,
    );
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: { code: "CONNECTION_EXISTS" } });

    const ghost = await worker.fetch(
      call("/api/connections", "POST", {
        integrationId: "00000000-0000-4000-8000-000000000000",
        config: {},
      }),
      bindings,
    );
    expect(ghost.status).toBe(404);
    expect(await ghost.json()).toMatchObject({ error: { code: "UNKNOWN_INTEGRATION" } });

    const leaky = await worker.fetch(
      call("/api/connections", "POST", {
        integrationId: NINJA_INTEGRATION_ID,
        config: { endpoint: "https://us2.ninjarmm.com/api", clientSecret: "hunter2" },
      }),
      bindings,
    );
    expect(leaky.status).toBe(400);
    expect(await leaky.json()).toMatchObject({ error: { code: "CONNECTION_SCHEMA_INVALID" } });

    const missing = await worker.fetch(
      call("/api/connections", "POST", { integrationId: NINJA_INTEGRATION_ID, config: {} }),
      bindings,
    );
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: { code: "CONNECTION_SCHEMA_INVALID" } });
  });

  it("rejects managed-row writes with MANAGED_RESOURCE but keeps the test open", async () => {
    await bindings.DB.prepare(
      "INSERT INTO connections(id,org_id,integration_id,endpoint,managed_by) VALUES (?,?,?,?,?)",
    )
      .bind(
        "00000000-0000-4000-8000-000000000102",
        ORG,
        ECHO_INTEGRATION_ID,
        "http://127.0.0.1:8788/echo",
        "bundle@1.0.0",
      )
      .run();
    const update = await worker.fetch(
      call(`/api/connections/${ECHO_INTEGRATION_ID}`, "PUT", {
        config: { endpoint: "http://127.0.0.1:8789/echo" },
      }),
      bindings,
    );
    expect(update.status).toBe(409);
    expect(await update.json()).toMatchObject({ error: { code: "MANAGED_RESOURCE" } });
    const remove = await worker.fetch(call(`/api/connections/${ECHO_INTEGRATION_ID}`, "DELETE"), bindings);
    expect(remove.status).toBe(409);
    expect(await remove.json()).toMatchObject({ error: { code: "MANAGED_RESOURCE" } });
    const listed = await worker.fetch(call("/api/connections"), bindings);
    expect(await listed.json()).toMatchObject({
      connections: [{ integrationId: ECHO_INTEGRATION_ID, ownerKind: "managed" }],
    });
  });

  it("scopes mappings per Organization: no cross-org reads, writes, or fallback", async () => {
    await bindings.DB.prepare("INSERT INTO connections(id,org_id,integration_id,endpoint) VALUES (?,?,?,?)")
      .bind("00000000-0000-4000-8000-000000000103", ORG, ECHO_INTEGRATION_ID, "http://127.0.0.1:8788/echo")
      .run();
    const foreign = { ...bindings, LAB_ORG_ID: OTHER_ORG, LAB_USER_ID: OTHER_USER };
    // Foreign org sees an empty list and 404 on the exact mapping — never the row.
    expect(await (await worker.fetch(call("/api/connections"), foreign)).json()).toEqual({ connections: [] });
    expect((await worker.fetch(call(`/api/connections/${ECHO_INTEGRATION_ID}`), foreign)).status).toBe(404);
    const foreignWrite = await worker.fetch(
      call(`/api/connections/${ECHO_INTEGRATION_ID}`, "PUT", { enabled: false }),
      foreign,
    );
    expect(foreignWrite.status).toBe(404);
    // The foreign org can still create its own mapping for the same Integration.
    const own = await worker.fetch(
      call("/api/connections", "POST", { integrationId: ECHO_INTEGRATION_ID, config: {} }),
      foreign,
    );
    expect(own.status).toBe(201);
    // And the Execution path resolves exact-org only (no global fallback).
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        "f".repeat(64),
        "720b9ebf-9b6a-4eac-bae9-6ed22c970401",
        "echo",
        "echo-v1",
        OTHER_ORG,
        OTHER_USER,
        JSON.stringify({ message: "hello" }),
        1,
        "Pending",
        new Date().toISOString(),
      )
      .run();
    const row = await bindings.DB.prepare("SELECT * FROM executions WHERE id=?")
      .bind("f".repeat(64))
      .first<ExecutionRow>();
    if (!row) throw new Error("missing execution");
    const resolved = await resolveConnection(bindings.DB, buildOrgCtx(row, "echo-http-v1"), ECHO_INTEGRATION_ID, [
      ECHO_INTEGRATION_ID,
    ]);
    expect(resolved).toMatchObject({ found: true });
  });

  it("resolves a disabled mapping as missing-required, never a silent skip", async () => {
    await bindings.DB.prepare("INSERT INTO connections(id,org_id,integration_id,endpoint,enabled) VALUES (?,?,?,?,?)")
      .bind("00000000-0000-4000-8000-000000000104", ORG, ECHO_INTEGRATION_ID, "http://127.0.0.1:8788/echo", 0)
      .run();
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        "e".repeat(64),
        "720b9ebf-9b6a-4eac-bae9-6ed22c970401",
        "echo",
        "echo-v1",
        ORG,
        USER,
        JSON.stringify({ message: "hello" }),
        1,
        "Pending",
        new Date().toISOString(),
      )
      .run();
    const row = await bindings.DB.prepare("SELECT * FROM executions WHERE id=?")
      .bind("e".repeat(64))
      .first<ExecutionRow>();
    if (!row) throw new Error("missing execution");
    const loud = await resolveConnection(bindings.DB, buildOrgCtx(row, "echo-http-v1"), ECHO_INTEGRATION_ID, [
      ECHO_INTEGRATION_ID,
    ]);
    expect(loud).toMatchObject({
      found: false,
      declared: true,
      error: { code: "INTEGRATION_REQUIREMENT_UNSATISFIED" },
    });
    const silent = await resolveConnection(bindings.DB, buildOrgCtx(row, "echo-http-v1"), ECHO_INTEGRATION_ID, []);
    expect(silent).toEqual({ found: false, declared: false });
  });
});

describe("Connection health (CON-01)", () => {
  it("passes the echo test and proves reachability for ninjaone without secret values", async () => {
    await bindings.DB.prepare("INSERT INTO connections(id,org_id,integration_id,endpoint) VALUES (?,?,?,?)")
      .bind("00000000-0000-4000-8000-000000000105", ORG, ECHO_INTEGRATION_ID, "http://127.0.0.1:8788/echo")
      .run();
    const echoTest = await worker.fetch(call(`/api/connections/${ECHO_INTEGRATION_ID}/test`, "POST", {}), bindings);
    expect(echoTest.status).toBe(200);
    expect(await echoTest.json()).toMatchObject({ test: { ok: true } });
    expect(fetch).toHaveBeenCalledTimes(1);

    await bindings.DB.prepare("INSERT INTO connections(id,org_id,integration_id,endpoint) VALUES (?,?,?,?)")
      .bind("00000000-0000-4000-8000-000000000106", ORG, NINJA_INTEGRATION_ID, "https://probe.ninja.invalid/api")
      .run();
    const ninjaTest = await worker.fetch(call(`/api/connections/${NINJA_INTEGRATION_ID}/test`, "POST", {}), bindings);
    expect(ninjaTest.status).toBe(200);
    expect(await ninjaTest.json()).toMatchObject({ test: { ok: true } });
    // The probe carries a fixed sentinel, never the deployment credential.
    const posted = vi
      .mocked(fetch)
      .mock.calls.map((args) => String(args[1] instanceof Request ? args[1].url : args[0]));
    expect(posted.some((url) => url.endsWith("/oauth/token"))).toBe(true);
    const bodies = vi.mocked(fetch).mock.calls.map((args) => JSON.stringify(args[1] ?? ""));
    expect(bodies.join(" ")).not.toContain(SECRET_SENTINEL);
  });

  it("fails loud on missing mappings, disabled mappings, and missing credentials", async () => {
    const missing = await worker.fetch(call(`/api/connections/${ECHO_INTEGRATION_ID}/test`, "POST", {}), bindings);
    expect(missing.status).toBe(424);
    expect(await missing.json()).toMatchObject({ test: { ok: false, code: "INTEGRATION_REQUIREMENT_UNSATISFIED" } });

    await bindings.DB.prepare("INSERT INTO connections(id,org_id,integration_id,endpoint,enabled) VALUES (?,?,?,?,?)")
      .bind("00000000-0000-4000-8000-000000000107", ORG, ECHO_INTEGRATION_ID, "http://127.0.0.1:8788/echo", 0)
      .run();
    const disabled = await worker.fetch(call(`/api/connections/${ECHO_INTEGRATION_ID}/test`, "POST", {}), bindings);
    expect(disabled.status).toBe(404);
    expect(await disabled.json()).toMatchObject({ test: { ok: false, code: "CONNECTION_DISABLED" } });
    await bindings.DB.prepare("DELETE FROM connections WHERE org_id=?").bind(ORG).run();

    await bindings.DB.prepare("INSERT INTO connections(id,org_id,integration_id,endpoint) VALUES (?,?,?,?)")
      .bind("00000000-0000-4000-8000-000000000108", ORG, NINJA_INTEGRATION_ID, "https://probe.ninja.invalid/api")
      .run();
    const halfCredentialed = await worker.fetch(call(`/api/connections/${NINJA_INTEGRATION_ID}/test`, "POST", {}), {
      ...bindings,
      NINJA_CLIENT_SECRET: "",
    });
    expect(halfCredentialed.status).toBe(502);
    expect(await halfCredentialed.json()).toMatchObject({ test: { ok: false, code: "SECRET_NOT_CONFIGURED" } });
  });

  it("rejects unauthorized test callers", async () => {
    expect(
      (
        await worker.fetch(
          new Request(`http://local.test/api/connections/${ECHO_INTEGRATION_ID}/test`, { method: "POST" }),
          bindings,
        )
      ).status,
    ).toBe(401);
  });
});

describe("Connection redaction (CON-01)", () => {
  it("carries no secret material through any management payload", async () => {
    await bindings.DB.prepare("INSERT INTO connections(id,org_id,integration_id,endpoint) VALUES (?,?,?,?)")
      .bind("00000000-0000-4000-8000-000000000109", ORG, ECHO_INTEGRATION_ID, "http://127.0.0.1:8788/echo")
      .run();
    const paths: [string, string, unknown?][] = [
      ["/api/integrations", "GET"],
      ["/api/connections", "GET"],
      [`/api/connections/${ECHO_INTEGRATION_ID}`, "GET"],
      [`/api/connections/${ECHO_INTEGRATION_ID}/test`, "POST", {}],
    ];
    for (const [path, method, body] of paths) {
      const response = await worker.fetch(call(path, method, body), bindings);
      const text = await response.text();
      expect(text).not.toContain(SECRET_SENTINEL);
      expect(text).not.toContain("test-client-id");
    }
    const update = await worker.fetch(
      call(`/api/connections/${ECHO_INTEGRATION_ID}`, "PUT", { displayName: SECRET_SENTINEL }),
      bindings,
    );
    // The echo-back of the operator label is scrubbed before send.
    expect((await update.text()).replaceAll("[REDACTED]", "")).not.toContain(SECRET_SENTINEL);
  });
});

describe("Connection management branches (CON-01 coverage)", () => {
  const GHOST = "00000000-0000-4000-8000-000000000000";

  it("rejects malformed and unknown Integration ids on every route", async () => {
    // Non-UUID ids match no route matcher: the gray-out answers 501
    // UNIMPLEMENTED, never a leak and never a fake 404 from this surface.
    for (const [path, method, body] of [
      ["/api/connections/not-a-uuid", "GET", undefined],
      ["/api/connections/not-a-uuid", "PUT", {}],
      ["/api/connections/not-a-uuid", "DELETE", undefined],
      ["/api/connections/not-a-uuid/test", "POST", {}],
    ] as [string, string, unknown?][]) {
      const response = await worker.fetch(call(path, method, body), bindings);
      expect(response.status).toBe(501);
      expect(await response.json()).toMatchObject({ error: { code: "UNIMPLEMENTED" } });
    }
    // The testConnection format arm (unreachable via the UUID-shaped route
    // matcher) answers UNKNOWN_INTEGRATION without touching D1.
    const malformed = await testConnection(bindings.DB, { orgId: ORG, userId: USER }, "not-a-uuid", bindings);
    expect(malformed).toMatchObject({ ok: false, code: "UNKNOWN_INTEGRATION" });
    // Well-formed but unregistered UUIDs take the same code through the
    // registry arm (create/get/update/delete/test).
    const ghostBody = { integrationId: GHOST, config: {} };
    expect((await worker.fetch(call("/api/connections", "POST", ghostBody), bindings)).status).toBe(404);
    expect((await worker.fetch(call(`/api/connections/${GHOST}`, "GET"), bindings)).status).toBe(404);
    expect((await worker.fetch(call(`/api/connections/${GHOST}`, "PUT", {}), bindings)).status).toBe(404);
    expect((await worker.fetch(call(`/api/connections/${GHOST}`, "DELETE"), bindings)).status).toBe(404);
    const ghostTest = await worker.fetch(call(`/api/connections/${GHOST}/test`, "POST", {}), bindings);
    expect(ghostTest.status).toBe(404);
    expect(await ghostTest.json()).toMatchObject({ test: { ok: false, code: "UNKNOWN_INTEGRATION" } });
    // POST without an integrationId string fails before the registry.
    const noId = await worker.fetch(call("/api/connections", "POST", { config: {} }), bindings);
    expect(noId.status).toBe(400);
    expect(await noId.json()).toMatchObject({ error: { code: "UNKNOWN_INTEGRATION" } });
  });

  it("404s missing mappings on get/update/delete and requires config on create", async () => {
    expect((await worker.fetch(call(`/api/connections/${ECHO_INTEGRATION_ID}`, "GET"), bindings)).status).toBe(404);
    expect((await worker.fetch(call(`/api/connections/${ECHO_INTEGRATION_ID}`, "PUT", {}), bindings)).status).toBe(404);
    expect((await worker.fetch(call(`/api/connections/${ECHO_INTEGRATION_ID}`, "DELETE"), bindings)).status).toBe(404);
    const noConfig = await worker.fetch(
      call("/api/connections", "POST", { integrationId: ECHO_INTEGRATION_ID }),
      bindings,
    );
    expect(noConfig.status).toBe(400);
    expect(await noConfig.json()).toMatchObject({ error: { code: "CONNECTION_SCHEMA_INVALID" } });
  });

  it("rejects bad displayName and enabled values on create and update", async () => {
    const base = { integrationId: ECHO_INTEGRATION_ID, config: {} };
    for (const displayName of ["", "x".repeat(129), 42]) {
      const response = await worker.fetch(call("/api/connections", "POST", { ...base, displayName }), bindings);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "INVALID_CONNECTION" } });
    }
    for (const enabled of ["false", 1, null]) {
      const response = await worker.fetch(call("/api/connections", "POST", { ...base, enabled }), bindings);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "INVALID_CONNECTION" } });
    }
    // Null displayName clears back to null through the null arm.
    const created = await worker.fetch(call("/api/connections", "POST", { ...base, displayName: "Fixture" }), bindings);
    expect(created.status).toBe(201);
    const cleared = await worker.fetch(
      call(`/api/connections/${ECHO_INTEGRATION_ID}`, "PUT", { displayName: null }),
      bindings,
    );
    expect(await cleared.json()).toMatchObject({ connection: { displayName: null } });
    const badUpdate = await worker.fetch(
      call(`/api/connections/${ECHO_INTEGRATION_ID}`, "PUT", { displayName: "", enabled: "yes" }),
      bindings,
    );
    expect(badUpdate.status).toBe(400);
    expect(await badUpdate.json()).toMatchObject({ error: { code: "INVALID_CONNECTION" } });
  });

  it("updates config and displayName through the merge arm", async () => {
    const created = await worker.fetch(
      call("/api/connections", "POST", { integrationId: ECHO_INTEGRATION_ID, config: {} }),
      bindings,
    );
    expect(created.status).toBe(201);
    // Explicit config merges over the persisted endpoint; displayName sets.
    const updated = await worker.fetch(
      call(`/api/connections/${ECHO_INTEGRATION_ID}`, "PUT", {
        config: { endpoint: "http://127.0.0.1:8788/echo" },
        displayName: "Renamed",
        enabled: true,
      }),
      bindings,
    );
    expect(await updated.json()).toMatchObject({
      connection: { displayName: "Renamed", endpoint: "http://127.0.0.1:8788/echo", enabled: true },
    });
    // Unknown config keys fail through the merged validation arm.
    const unknown = await worker.fetch(
      call(`/api/connections/${ECHO_INTEGRATION_ID}`, "PUT", {
        config: { endpoint: "http://127.0.0.1:8788/echo", bogus: "x" },
      }),
      bindings,
    );
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: { code: "CONNECTION_SCHEMA_INVALID" } });
  });

  it("skips stale rows for unknown Integrations in the list", async () => {
    await bindings.DB.prepare("INSERT INTO connections(id,org_id,integration_id,endpoint) VALUES (?,?,?,?)")
      .bind("00000000-0000-4000-8000-000000000110", ORG, GHOST, "https://stale.invalid")
      .run();
    const listed = await worker.fetch(call("/api/connections"), bindings);
    expect(await listed.json()).toEqual({ connections: [] });
  });

  it("fails the echo probe on non-ok responses and transport throws", async () => {
    await bindings.DB.prepare("INSERT INTO connections(id,org_id,integration_id,endpoint) VALUES (?,?,?,?)")
      .bind("00000000-0000-4000-8000-000000000111", ORG, ECHO_INTEGRATION_ID, "http://127.0.0.1:8788/echo")
      .run();
    vi.mocked(fetch).mockResolvedValueOnce(new Response("down", { status: 503 }));
    const failed = await worker.fetch(call(`/api/connections/${ECHO_INTEGRATION_ID}/test`, "POST", {}), bindings);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ test: { ok: false, code: "CONNECTION_TEST_FAILED" } });
    vi.mocked(fetch).mockRejectedValueOnce(new Error("boom"));
    const threw = await worker.fetch(call(`/api/connections/${ECHO_INTEGRATION_ID}/test`, "POST", {}), bindings);
    expect(threw.status).toBe(502);
    expect(await threw.json()).toMatchObject({ test: { ok: false, code: "CONNECTION_TEST_FAILED" } });
  });

  it("fails the ninja probe on 5xx and on transport throws", async () => {
    await bindings.DB.prepare("INSERT INTO connections(id,org_id,integration_id,endpoint) VALUES (?,?,?,?)")
      .bind("00000000-0000-4000-8000-000000000112", ORG, NINJA_INTEGRATION_ID, "https://probe.ninja.invalid/api")
      .run();
    vi.mocked(fetch).mockResolvedValueOnce(new Response("down", { status: 502 }));
    const failed = await worker.fetch(call(`/api/connections/${NINJA_INTEGRATION_ID}/test`, "POST", {}), bindings);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ test: { ok: false, code: "CONNECTION_TEST_FAILED" } });
    vi.mocked(fetch).mockRejectedValueOnce(new Error("boom"));
    const threw = await worker.fetch(call(`/api/connections/${NINJA_INTEGRATION_ID}/test`, "POST", {}), bindings);
    expect(threw.status).toBe(502);
    expect(await threw.json()).toMatchObject({ test: { ok: false, code: "CONNECTION_TEST_FAILED" } });
  });

  it("tests with a non-string deployment credential present", async () => {
    await bindings.DB.prepare("INSERT INTO connections(id,org_id,integration_id,endpoint) VALUES (?,?,?,?)")
      .bind("00000000-0000-4000-8000-000000000113", ORG, NINJA_INTEGRATION_ID, "https://probe.ninja.invalid/api")
      .run();
    // A non-string binding value is not a configured credential: fail loud.
    const bad = await worker.fetch(call(`/api/connections/${NINJA_INTEGRATION_ID}/test`, "POST", {}), {
      ...bindings,
      NINJA_CLIENT_SECRET: 42 as unknown as string,
    });
    expect(bad.status).toBe(502);
    expect(await bad.json()).toMatchObject({ test: { ok: false, code: "SECRET_NOT_CONFIGURED" } });
  });

  it("rejects malformed ids through the direct module boundary", async () => {
    // The UUID-shaped route matcher keeps these arms off the HTTP path;
    // direct calls pin the same 404 contract without touching D1.
    const caller = { orgId: ORG, userId: USER };
    await expect(getConnection(bindings.DB, caller, "not-a-uuid")).rejects.toMatchObject({
      code: "UNKNOWN_INTEGRATION",
    });
    await expect(createConnection(bindings.DB, caller, "not-a-uuid", { config: {} })).rejects.toMatchObject({
      code: "UNKNOWN_INTEGRATION",
    });
    await expect(updateConnection(bindings.DB, caller, "not-a-uuid", {})).rejects.toMatchObject({
      code: "UNKNOWN_INTEGRATION",
    });
    await expect(deleteConnection(bindings.DB, caller, "not-a-uuid")).rejects.toMatchObject({
      code: "UNKNOWN_INTEGRATION",
    });
  });

  it("probes ninja without a client id binding", async () => {
    await bindings.DB.prepare("INSERT INTO connections(id,org_id,integration_id,endpoint) VALUES (?,?,?,?)")
      .bind("00000000-0000-4000-8000-000000000114", ORG, NINJA_INTEGRATION_ID, "https://probe.ninja.invalid/api")
      .run();
    // NINJA_CLIENT_ID unset: the probe still runs with an empty handle and
    // the token host answers, proving the id is a handle, never a secret.
    const tested = await testConnection(bindings.DB, { orgId: ORG, userId: USER }, NINJA_INTEGRATION_ID, {
      NINJA_CLIENT_SECRET: "test-client-secret-sentinel",
    });
    expect(tested).toMatchObject({ ok: true });
  });
});
