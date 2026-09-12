// SPDX-License-Identifier: AGPL-3.0
// CON-02 SDK and UI parity (issue #147; ADR 020): the typed SDK client
// (list/set/update/delete plus guards) and the Configs page render from live
// /api/* payloads, secret-masked everywhere. Worker routes run in real
// workerd; the React page renders from mocked payloads like the apps UI
// tests (no production deployment).
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import {
  createSdkClient,
  describeContract,
  parseConfigEntry,
  parseConfigList,
  SDK_ERROR_CODES,
  SdkError,
} from "../src/sdk";
import { listConfigs } from "../client/src/lib/api-client";
import type { ConfigListResponse } from "../client/src/lib/client-types";
import { ConfigsList } from "../client/src/pages/Configs";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration4 from "../migrations/0004_solutions_install.sql?raw";
import migration5 from "../migrations/0010_solutions_activation.sql?raw";
import migration7 from "../migrations/0007_org_membership.sql?raw";
import migration10 from "../migrations/0023_config.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const ORG = "00000000-0000-4000-8000-000000000001";
const OWNER = "00000000-0000-4000-8000-000000000002";

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...extra };
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration4);
  await bindings.DB.exec(migration5);
  await bindings.DB.exec(migration7);
  await bindings.DB.exec(migration10);
  const stamp = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?)").bind(ORG, "Local demo").run();
  await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
    .bind(OWNER, stamp)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(ORG, OWNER, "admin", "active", "ordinary", stamp, stamp)
    .run();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("CON-02 SDK config client over the live Worker", () => {
  function authedFetch(url: string | URL | Request, init?: RequestInit) {
    return worker.fetch(
      new Request(url, { ...(init ?? {}), headers: authHeaders(init?.headers as Record<string, string>) }),
      { ...bindings, LAB_ORG_ID: ORG, LAB_USER_ID: OWNER },
    );
  }

  it("serves the config routes and codes in the versioned contract", () => {
    const descriptor = describeContract();
    expect(descriptor.routes.map((route) => `${route.method} ${route.path}`)).toEqual(
      expect.arrayContaining(["GET /api/config", "POST /api/config", "PUT /api/config/:id", "DELETE /api/config/:id"]),
    );
    expect(descriptor.capabilities.find((entry) => entry.name === "author-config")?.status).toBe("supported");
    for (const code of [
      "INVALID_CONFIG",
      "INVALID_CONFIG_KEY",
      "INVALID_CONFIG_TYPE",
      "INVALID_CONFIG_VALUE",
      "CONFIG_NOT_FOUND",
      "CONFIG_REQUIREMENT_UNSATISFIED",
      "CREDENTIAL_IN_VALUE",
      "SECRET_NOT_CONFIGURED",
      "SECRET_SCHEMA_MISMATCH",
    ]) {
      expect(SDK_ERROR_CODES).toContain(code);
    }
  });

  it("lists, sets, updates, and deletes config through the typed client", async () => {
    const client = createSdkClient({
      base: "http://local.test",
      token: TOKEN,
      fetchImpl: authedFetch as typeof fetch,
      pollMs: 0,
    });
    expect(await client.listConfigs()).toEqual([]);
    const created = await client.setConfig({ key: "timeout", type: "int", value: "30" });
    expect(created).toMatchObject({ key: "timeout", type: "int", value: 30 });
    expect(parseConfigEntry({ config: created })).toMatchObject({ key: "timeout" });
    const listed = await client.listConfigs();
    expect(parseConfigList({ configs: listed })).toHaveLength(1);
    const updated = await client.updateConfig({ id: created.id, value: "60" });
    expect(updated).toMatchObject({ value: 60 });
    await client.deleteConfig(created.id);
    expect(await client.listConfigs()).toEqual([]);
  });

  it("masks secrets through the typed client and rejects bad refs", async () => {
    const client = createSdkClient({
      base: "http://local.test",
      token: TOKEN,
      fetchImpl: authedFetch as typeof fetch,
      pollMs: 0,
    });
    const secret = await client.setConfig({ key: "apiKey", type: "secret", value: { ref: "clientSecret" } });
    expect(secret.value).toBe("[SECRET]");
    await expect(client.setConfig({ key: "k", type: "secret", value: { ref: "nope" } })).rejects.toBeInstanceOf(
      SdkError,
    );
    await expect(client.setConfig({ key: "k", type: "secret", value: { ref: "nope" } })).rejects.toMatchObject({
      code: "SECRET_SCHEMA_MISMATCH",
    });
    await expect(client.deleteConfig("abc")).rejects.toMatchObject({ code: "SDK_INVALID_REF" });
  });

  it("denies anonymous config reads with UNAUTHORIZED", async () => {
    const anon = createSdkClient({
      base: "http://local.test",
      token: "wrong-token",
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) =>
        worker.fetch(new Request(url, init ?? {}), { ...bindings })) as typeof fetch,
    });
    await expect(anon.listConfigs()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("CON-02 Configs page", () => {
  const payload: ConfigListResponse = {
    configs: [
      {
        id: "aaaaaaaa-1111-4111-8111-111111111111",
        key: "timeout",
        type: "int",
        value: 30,
        description: "Vendor deadline seconds",
        managedBy: null,
        updatedAt: "2026-09-11T00:00:00.000Z",
        updatedBy: OWNER,
      },
      {
        id: "bbbbbbbb-2222-4222-8222-222222222222",
        key: "apiKey",
        type: "secret",
        value: "[SECRET]",
        description: null,
        managedBy: "b10a7c2e-3f4d-4a5b-8c6d-7e8f9a0b1c2d@1.0.0",
        updatedAt: "2026-09-11T00:00:00.000Z",
        updatedBy: OWNER,
      },
    ],
  };

  it("renders rows masked with ownership, linking no secret material", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ configs: payload.configs }));
    const data = await listConfigs();
    expect(data.configs).toHaveLength(2);

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ConfigsList initial={data} />
      </MemoryRouter>,
    );
    expect(html).toContain("timeout");
    expect(html).toContain("apiKey");
    expect(html).toContain("[SECRET]");
    expect(html).toContain("managed");
    expect(html).toContain("loose");
    expect(html).toContain("installer-owned");
    expect(html).toContain("Delete");
    const text = JSON.stringify(data);
    expect(text).not.toContain("test-client-secret-sentinel");
  });

  it("renders the empty state with no rows", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ configs: [] }));
    const data = await listConfigs();
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ConfigsList initial={data} />
      </MemoryRouter>,
    );
    expect(html).toContain("No config rows yet.");
    expect(html).toContain("Set config");
  });
});
