// SPDX-License-Identifier: AGPL-3.0
// FORM-02 UI parity (issue #155): the Forms list/detail renderer reads
// live /api/* payloads through the typed api-client and renders
// server-authoritative declarations (display-only layout, conditionals,
// provider options), the startup handshake, and the submit receipt with
// execution linkage. Worker form routes run in real workerd; the React
// pages render from mocked payloads like the configs UI tests (no
// production deployment).
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { helloSaga } from "../src/domain";
import { describeContract } from "../src/sdk";
import { fetchFormDetail, listForms, startFormSession } from "../client/src/lib/api-client";
import type { FormDetail, FormsResponse } from "../client/src/lib/client-types";
import { FormDetailView, FormsList, submitValues } from "../client/src/pages/Forms";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration5 from "../migrations/0005_forms.sql?raw";
import migration7 from "../migrations/0007_org_membership.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const ORG = "00000000-0000-4000-8000-000000000001";
const OWNER = "00000000-0000-4000-8000-000000000002";

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...extra };
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration5);
  await bindings.DB.exec(migration7);
  const stamp = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?)").bind(ORG, "Local demo").run();
  await bindings.DB.prepare("INSERT INTO forms(id,org_id,name,saga_id,fields_json,created_at) VALUES (?,?,?,?,?,?)")
    .bind(
      "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5",
      ORG,
      "hello-greeting",
      helloSaga.id,
      JSON.stringify({
        title: "Greet",
        fields: [{ name: "name", type: "text", required: true, maxLength: 1024 }],
      }),
      stamp,
    )
    .run();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("FORM-02 client over the live Worker", () => {
  function authedFetch(url: string | URL | Request, init?: RequestInit) {
    // The typed client calls fetch with relative /api/* paths; bridge them
    // onto the local test origin before proxying into worker.fetch (a bare
    // relative URL is not a valid Request input). Request inputs pass
    // through so method/body survive.
    const target = url instanceof Request ? url : new URL(String(url), "http://local.test").toString();
    return worker.fetch(
      new Request(target, { ...(init ?? {}), headers: authHeaders(init?.headers as Record<string, string>) }),
      { ...bindings, LAB_ORG_ID: ORG, LAB_USER_ID: OWNER },
    );
  }

  it("serves the form lifecycle through the typed client", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(((url: string | URL | Request, init?: RequestInit) =>
      authedFetch(url, init)) as typeof fetch);
    const listed = await listForms();
    expect(listed.forms).toEqual([{ id: expect.any(String), name: "hello-greeting", sagaId: helloSaga.id }]);
    const detail = await fetchFormDetail("hello-greeting");
    expect(detail.fields).toHaveLength(1);
    const started = await startFormSession("hello-greeting");
    expect(started.handle).toMatch(/^[a-f0-9]{64}$/);
    expect(started.snapshot).toEqual({});
  });

  it("pins the dynamic-forms capability in the served descriptor", () => {
    expect(describeContract().capabilities.find((entry) => entry.name === "dynamic-forms")?.status).toBe("supported");
  });
});

describe("FORM-02 Forms pages", () => {
  const payload: FormsResponse = {
    forms: [{ id: "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5", name: "hello-greeting", sagaId: helloSaga.id }],
  };

  const detail: FormDetail = {
    id: "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5",
    name: "hello-greeting",
    sagaId: helloSaga.id,
    title: "Greet",
    allowPrefill: false,
    fields: [
      { name: "name", type: "text", label: "Name", required: true, maxLength: 1024 },
      { name: "title", type: "heading", required: false, maxLength: 1024, content: "Welcome" },
      { name: "note", type: "paragraph", required: false, maxLength: 1024, content: "Say hello." },
      { name: "nick", type: "text", required: false, maxLength: 64, visibleWhen: { field: "name", equals: "other" } },
    ],
  };

  it("renders the list with open/delete and the empty state", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ forms: payload.forms }));
    const data = await listForms();
    expect(data.forms).toHaveLength(1);
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FormsList initial={data} />
      </MemoryRouter>,
    );
    expect(html).toContain("hello-greeting");
    expect(html).toContain("/forms/hello-greeting");
    expect(html).toContain("Delete");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ forms: [] }));
    const empty = await listForms();
    const emptyHtml = renderToStaticMarkup(
      <MemoryRouter>
        <FormsList initial={empty} />
      </MemoryRouter>,
    );
    expect(emptyHtml).toContain("No forms yet.");
  });

  it("renders the declaration with layout kinds, conditionals, and session controls", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FormDetailView name="hello-greeting" initial={detail} />
      </MemoryRouter>,
    );
    expect(html).toContain("Greet");
    expect(html).toContain("Welcome");
    expect(html).toContain("Say hello.");
    expect(html).toContain("form-field-name");
    // The conditional nick field hides until name equals "other".
    expect(html).not.toContain("form-field-nick");
    expect(html).toContain("Start session");
    expect(html).toContain("Reload providers");
    expect(html).toContain("Schedule at");
    expect(html).toContain("Submit");
  });

  it("rejects bad form names offline", async () => {
    await expect(fetchFormDetail("Bad Name")).rejects.toThrow(/shape/);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        form: {
          id: "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5",
          name: "hello-greeting",
          sagaId: helloSaga.id,
          allowPrefill: false,
          fields: [{ name: "x", type: "watermelon", required: false, maxLength: 8 }],
        },
      }),
    );
    await expect(fetchFormDetail("hello-greeting")).rejects.toThrow(/shape/);
  });

  it("submits snapshot-backed values so untouched prefill survives", () => {
    expect(submitValues(detail.fields, { name: "Ada" }, {})).toEqual({ name: "Ada" });
    expect(submitValues(detail.fields, { name: "Ada" }, { name: "Grace" })).toEqual({ name: "Grace" });
    expect(submitValues(detail.fields, { name: "Ada", nick: "Al" }, {})).toEqual({ name: "Ada" });
    // Cleared fields send explicit null so server visibility sees the gap
    // too; the server reads null as omitted (defaults fill, required fails).
    expect(submitValues(detail.fields, { name: "Ada" }, { name: null })).toEqual({ name: null });
  });
});
