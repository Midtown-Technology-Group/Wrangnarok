// SPDX-License-Identifier: AGPL-3.0
// TOOL-01 (issue #170): opt-in Saga tool registry tests. Runs in real
// workerd with a real D1 binding (migrations 0001-0002 plus 0024); no vendor
// HTTP on this path. Pins the acceptance slice: explicit opt-in with stable
// identity, derived schemas, distinctive descriptions, collision-safe names,
// and identical scoping of discovery and execution (disabled/stale gone
// from both).
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { echoSaga, helloSaga } from "../src/domain";
import { toolRegistry } from "../src/tools";
import { SAGA_CATALOG } from "../src/sagas";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration24 from "../migrations/0024_tool_enrollments.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const principal = { orgId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" };

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...extra };
}

function call(path: string, method = "GET", body?: unknown, key?: string) {
  return new Request(`http://local.test${path}`, {
    method,
    headers: headers(key ? { "Idempotency-Key": key } : {}),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(seed);
  await bindings.DB.exec(migration24);
  await bindings.DB.prepare("DELETE FROM tool_enrollments").run();
});

afterEach(async () => {
  await reset();
});

describe("tool enrollment (TOOL-01 opt-in)", () => {
  it("starts with an empty discovery list", async () => {
    const response = await worker.fetch(call("/api/tools"), bindings);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tools: [] });
  });

  it("enrolls with stable identity, derived name, and distinctive description", async () => {
    const response = await worker.fetch(call("/api/tools", "POST", { sagaId: helloSaga.id }), bindings);
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      tool: { name: string; sagaId: string; sagaRevision: string; description: string };
    };
    expect(body.tool.sagaId).toBe(helloSaga.id);
    expect(body.tool.sagaRevision).toBe(helloSaga.revision);
    expect(body.tool.name).toBe(toolRegistry.toolNameFor(helloSaga.name));
    expect(body.tool.description.startsWith(`[${body.tool.name}]`)).toBe(true);
    expect(body.tool.description).toContain(helloSaga.description);
  });

  it("rejects unknown sagas, bad names, and duplicate enrollments", async () => {
    const unknown = await worker.fetch(
      call("/api/tools", "POST", { sagaId: "00000000-0000-4000-8000-000000000000" }),
      bindings,
    );
    expect(unknown.status).toBe(404);
    const badName = await worker.fetch(
      call("/api/tools", "POST", { sagaId: helloSaga.id, name: "Bad Name!" }),
      bindings,
    );
    expect(badName.status).toBe(400);
    expect(await badName.json()).toMatchObject({ error: { code: "INVALID_TOOL" } });
    const first = await worker.fetch(call("/api/tools", "POST", { sagaId: helloSaga.id }), bindings);
    expect(first.status).toBe(201);
    const second = await worker.fetch(call("/api/tools", "POST", { sagaId: helloSaga.id }), bindings);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: { code: "TOOL_EXISTS" } });
    // A second Saga cannot squat the first tool's name.
    const squat = await worker.fetch(
      call("/api/tools", "POST", {
        sagaId: echoSaga.id,
        name: ((await (await worker.fetch(call("/api/tools"), bindings)).json()) as { tools: { name: string }[] })
          .tools[0]?.name,
      }),
      bindings,
    );
    expect(squat.status).toBe(409);
  });

  it("derives collision-safe names per Saga", () => {
    expect(toolRegistry.toolNameFor("hello")).toBe("hello_tool");
    expect(toolRegistry.toolNameFor("ninjaone-orgs")).toBe("ninjaone_orgs_tool");
    expect(toolRegistry.toolNameFor("Hello World!")).toBe("hello_world_tool");
    expect(toolRegistry.toolNameFor("hello")).not.toBe(toolRegistry.toolNameFor("hello-world"));
  });

  it("hides disabled enrollments from discovery and execution", async () => {
    const enrolled = (await (
      await worker.fetch(call("/api/tools", "POST", { sagaId: helloSaga.id }), bindings)
    ).json()) as { tool: { name: string } };
    const disabled = await worker.fetch(call(`/api/tools/${enrolled.tool.name}/disable`, "POST", {}), bindings);
    expect(disabled.status).toBe(200);
    const listed = (await (await worker.fetch(call("/api/tools"), bindings)).json()) as { tools: unknown[] };
    expect(listed.tools).toEqual([]);
    const execute = await worker.fetch(
      call(`/api/tools/${enrolled.tool.name}/execute`, "POST", { input: { name: "Al" } }, "tool-disabled-exec-0001"),
      bindings,
    );
    expect(execute.status).toBe(404);
    expect(await execute.json()).toMatchObject({ error: { code: "TOOL_DISABLED" } });
  });

  it("fails stale enrollments closed at execution with TOOL_STALE", async () => {
    await bindings.DB.prepare(
      "INSERT INTO tool_enrollments(id,org_id,tool_name,saga_id,saga_revision,enabled,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)",
    )
      .bind(
        "00000000-0000-4000-8000-000000000701",
        principal.orgId,
        "stale_tool",
        helloSaga.id,
        "hello-v0",
        new Date().toISOString(),
        new Date().toISOString(),
      )
      .run();
    const listed = (await (await worker.fetch(call("/api/tools"), bindings)).json()) as { tools: unknown[] };
    expect(listed.tools).toEqual([]);
    const execute = await worker.fetch(
      call("/api/tools/stale_tool/execute", "POST", { input: { name: "Al" } }, "tool-stale-exec-0001"),
      bindings,
    );
    expect(execute.status).toBe(409);
    expect(await execute.json()).toMatchObject({ error: { code: "TOOL_STALE" } });
  });

  it("scopes discovery and execution identically per organization", async () => {
    await worker.fetch(call("/api/tools", "POST", { sagaId: helloSaga.id }), bindings);
    const listed = (await (await worker.fetch(call("/api/tools"), bindings)).json()) as {
      tools: { name: string }[];
    };
    expect(listed.tools).toHaveLength(1);
    // A stranger with no membership cannot reach the route at all (401/403
    // via the membership gate), and a same-org sibling sees the same list.
    // Cross-org leakage is covered by the registry resolve tests below.
    const resolved = await toolRegistry.resolve(bindings.DB, principal, listed.tools[0]?.name ?? "", SAGA_CATALOG);
    expect(resolved.sagaId).toBe(helloSaga.id);
    const foreign = await toolRegistry
      .resolve(
        bindings.DB,
        { orgId: "00000000-0000-4000-8000-000000000004", userId: principal.userId },
        listed.tools[0]?.name ?? "",
        SAGA_CATALOG,
      )
      .then(() => null)
      .catch((error: unknown) => error);
    expect(foreign).toMatchObject({ code: "TOOL_NOT_FOUND" });
  });

  it("denies unauthenticated discovery and rejects query strings", async () => {
    expect((await worker.fetch(new Request("http://local.test/api/tools"), bindings)).status).toBe(401);
    expect((await worker.fetch(call("/api/tools?scope=all"), bindings)).status).toBe(400);
  });

  it("covers enrollment parsers and registry branches", async () => {
    // Unknown keys fail closed at the registry parser (the route forwards
    // only name/description, so this pins parseBody directly).
    await expect(toolRegistry.enroll(bindings.DB, principal, helloSaga, { bogus: true })).rejects.toMatchObject({
      code: "INVALID_TOOL",
    });
    for (const extra of [{ description: 7 }, { name: "Bad Name!" }]) {
      const denied = await worker.fetch(call("/api/tools", "POST", { sagaId: helloSaga.id, ...extra }), bindings);
      expect(denied.status).toBe(400);
    }
    const nonObject = await worker.fetch(
      new Request("http://local.test/api/tools", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify([1, 2]),
      }),
      bindings,
    );
    expect(nonObject.status).toBe(400);
    const badDescription = await worker.fetch(
      call("/api/tools", "POST", { sagaId: helloSaga.id, description: "" }),
      bindings,
    );
    expect(badDescription.status).toBe(400);
    const longDescription = await worker.fetch(
      call("/api/tools", "POST", { sagaId: helloSaga.id, description: "x".repeat(281) }),
      bindings,
    );
    expect(longDescription.status).toBe(400);
    // Custom name and description enroll verbatim.
    const custom = await worker.fetch(
      call("/api/tools", "POST", { sagaId: helloSaga.id, name: "greet_tool", description: "Greet warmly." }),
      bindings,
    );
    expect(custom.status).toBe(201);
    expect(await custom.json()).toMatchObject({
      tool: { name: "greet_tool", description: "[greet_tool] Greet warmly." },
    });
    // Same name + same Saga + same revision re-enroll conflicts.
    const dup = await worker.fetch(call("/api/tools", "POST", { sagaId: helloSaga.id, name: "greet_tool" }), bindings);
    expect(dup.status).toBe(409);
    // Missing sagaId fails closed; unknown tool names 404.
    const noSaga = await worker.fetch(call("/api/tools", "POST", {}), bindings);
    expect(noSaga.status).toBe(400);
    const badDisable = await worker.fetch(call("/api/tools/bad_tool/disable", "POST", {}), bindings);
    expect(badDisable.status).toBe(404);
    const badExecute = await worker.fetch(
      call("/api/tools/bad_tool/execute", "POST", {}, "tool-bad-exec-0001"),
      bindings,
    );
    expect(badExecute.status).toBe(404);
    // Double disable conflicts.
    const second = await worker.fetch(call("/api/tools/greet_tool/disable", "POST", {}), bindings);
    expect(second.status).toBe(200);
    const third = await worker.fetch(call("/api/tools/greet_tool/disable", "POST", {}), bindings);
    expect(third.status).toBe(409);
    // Unknown-row disable 404s.
    const ghost = await worker.fetch(call("/api/tools/ghost_tool/disable", "POST", {}), bindings);
    expect(ghost.status).toBe(404);
    // Direct registry: non-UUID saga enrollment fails; non-object bodies
    // and regex-failing names fail before any D1 read.
    await expect(
      toolRegistry.enroll(bindings.DB, principal, { id: "nope", name: "x", revision: "r", description: "d" }, {}),
    ).rejects.toMatchObject({ code: "UNKNOWN_SAGA" });
    await expect(toolRegistry.enroll(bindings.DB, principal, helloSaga, "nope")).rejects.toMatchObject({
      code: "INVALID_TOOL",
    });
    await expect(toolRegistry.resolve(bindings.DB, principal, "BAD NAME!", SAGA_CATALOG)).rejects.toMatchObject({
      code: "TOOL_NOT_FOUND",
    });
    await expect(toolRegistry.disable(bindings.DB, principal, "BAD NAME!")).rejects.toMatchObject({
      code: "TOOL_NOT_FOUND",
    });
    // liveRow null row: resolve on an empty org answers TOOL_NOT_FOUND.
    await expect(
      toolRegistry.resolve(
        bindings.DB,
        { orgId: "00000000-0000-4000-8000-000000000099", userId: principal.userId },
        "greet_tool",
        SAGA_CATALOG,
      ),
    ).rejects.toMatchObject({ code: "TOOL_NOT_FOUND" });
  });

  it("covers stub-DB pre-migration paths, name fallbacks, and taken-name conflicts", async () => {
    // A D1 handle whose prepares throw simulates a pre-migration database:
    // discovery is empty, resolution answers TOOL_NOT_FOUND (never 500).
    const throwingDb = {
      prepare() {
        throw new Error("no such table: tool_enrollments");
      },
    } as unknown as D1Database;
    expect(await toolRegistry.list(throwingDb, principal, SAGA_CATALOG)).toEqual([]);
    await expect(toolRegistry.resolve(throwingDb, principal, "greet_tool", SAGA_CATALOG)).rejects.toMatchObject({
      code: "TOOL_NOT_FOUND",
    });
    await expect(toolRegistry.disable(throwingDb, principal, "greet_tool")).rejects.toMatchObject({
      code: "TOOL_NOT_FOUND",
    });
    await expect(toolRegistry.enroll(throwingDb, principal, helloSaga, {})).rejects.toMatchObject({
      code: "TOOL_STORE_NOT_MIGRATED",
    });
    // toolNameFor digit-leading stems gain the saga_ prefix.
    expect(toolRegistry.toolNameFor("9lives")).toBe("saga_9lives_tool");
    expect(toolRegistry.toolNameFor("!!!")).toBe("saga__tool");
    // A taken name on a DIFFERENT saga conflicts (not the same-enrollment path).
    // (The prior test disabled greet_tool, so re-own the name first to keep
    // this deterministic regardless of test order.)
    await toolRegistry.disable(bindings.DB, principal, "greet_tool").catch(() => null);
    await bindings.DB.prepare("DELETE FROM tool_enrollments WHERE tool_name=?").bind("greet_tool").run();
    await toolRegistry.enroll(bindings.DB, principal, helloSaga, { name: "greet_tool" });
    await expect(toolRegistry.enroll(bindings.DB, principal, echoSaga, { name: "greet_tool" })).rejects.toMatchObject({
      code: "TOOL_EXISTS",
    });
    // list skips rows whose Saga left the catalog: insert a ghost row
    // directly (bypassing enroll validation) and prove omission.
    await bindings.DB.prepare(
      "INSERT INTO tool_enrollments(id,org_id,tool_name,saga_id,saga_revision,enabled,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)",
    )
      .bind(
        "00000000-0000-4000-8000-000000000702",
        principal.orgId,
        "ghost_tool",
        "00000000-0000-4000-8000-000000000000",
        "ghost-v1",
        new Date().toISOString(),
        new Date().toISOString(),
      )
      .run();
    const tools = await toolRegistry.list(bindings.DB, principal, SAGA_CATALOG);
    expect(tools.map((entry) => entry.name)).not.toContain("ghost_tool");
    await bindings.DB.prepare("DELETE FROM tool_enrollments WHERE tool_name=?").bind("ghost_tool").run();
  });

  it("covers post-write racing deletes and custom descriptions", async () => {
    // Enroll-then-delete races the post-write re-read: the 500 path proves
    // the write was verified, never assumed.
    const racedDb = {
      prepare(sql: string) {
        const inner = (
          bindings.DB.prepare as (sql: string) => {
            bind: (...args: unknown[]) => { run: () => Promise<unknown>; first: () => Promise<null> };
          }
        )(sql);
        return {
          bind: (...args: unknown[]) => {
            const bound = inner.bind(...args);
            return {
              run: () => bound.run(),
              first: async () => {
                if (sql.startsWith("SELECT id,org_id,tool_name") && (args[1] as string).startsWith("race_")) {
                  return null;
                }
                return bound.first();
              },
              all: () => ({ results: [] }),
            };
          },
        };
      },
    } as unknown as D1Database;
    await expect(toolRegistry.enroll(racedDb, principal, helloSaga, { name: "race_tool" })).rejects.toMatchObject({
      code: "TOOL_NOT_FOUND",
    });
    // Disable race: the row exists for the pre-check but vanishes before the
    // post-write re-read. Count SELECTs for the name: first passes through,
    // later ones answer null.
    await toolRegistry.enroll(bindings.DB, principal, helloSaga, { name: "race_disable_tool" });
    let reads = 0;
    const vanishingDb = {
      prepare(sql: string) {
        const inner = (
          bindings.DB.prepare as (sql: string) => {
            bind: (...args: unknown[]) => {
              run: () => Promise<unknown>;
              first: () => Promise<unknown>;
              all: () => Promise<{ results: unknown[] }>;
            };
          }
        )(sql);
        return {
          bind: (...args: unknown[]) => {
            const bound = inner.bind(...args);
            return {
              run: () => bound.run(),
              first: async () => {
                if (sql.startsWith("SELECT id,org_id,tool_name") && args[1] === "race_disable_tool") {
                  reads += 1;
                  if (reads > 1) return null;
                }
                return bound.first();
              },
              all: () => bound.all(),
            };
          },
        };
      },
    } as unknown as D1Database;
    await expect(toolRegistry.disable(vanishingDb, principal, "race_disable_tool")).rejects.toMatchObject({
      code: "TOOL_NOT_FOUND",
    });
    await bindings.DB.prepare("DELETE FROM tool_enrollments WHERE tool_name=?").bind("race_disable_tool").run();
    // A NULL-description row falls back to the Saga description text.
    await bindings.DB.prepare(
      "INSERT INTO tool_enrollments(id,org_id,tool_name,saga_id,saga_revision,description,enabled,created_at,updated_at) VALUES (?,?,?,?,?,NULL,1,?,?)",
    )
      .bind(
        "00000000-0000-4000-8000-000000000703",
        principal.orgId,
        "nodesc_tool",
        helloSaga.id,
        helloSaga.revision,
        new Date().toISOString(),
        new Date().toISOString(),
      )
      .run();
    const listed = await toolRegistry.list(bindings.DB, principal, SAGA_CATALOG);
    const nodesc = listed.find((entry) => entry.name === "nodesc_tool");
    expect(nodesc?.description).toBe(`[nodesc_tool] ${helloSaga.description}`);
    await bindings.DB.prepare("DELETE FROM tool_enrollments WHERE tool_name=?").bind("nodesc_tool").run();
  });
});
