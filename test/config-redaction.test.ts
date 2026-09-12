// SPDX-License-Identifier: AGPL-3.0
// CON-02 secret-redaction slice (issue #147; ADR 005 v0 + ADR 020): config
// secret references resolve transiently and register with the
// execution-scoped registry, so a resolved value embedded in an Operation
// result, terminal row, or error is scrubbed by substring on every egress
// path. Proven against real local D1 in workerd with sentinel secrets at the
// config boundary (not exact-value matches alone).
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { getExecutionSecrets, registerExecutionSecrets, scrubExecutionValue } from "../src/secrets";
import { resolveConfig, setConfig } from "../src/config";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration4 from "../migrations/0004_solutions_install.sql?raw";
import migration5 from "../migrations/0010_solutions_activation.sql?raw";
import migration7 from "../migrations/0007_org_membership.sql?raw";
import migration10 from "../migrations/0023_config.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const ORG = "00000000-0000-4000-8000-000000000001";
const OWNER = "00000000-0000-4000-8000-000000000002";
// Long sentinel secrets: short values are shaping-protected, never
// substring-scrubbed (ADR 005 explicit limit).
const CONFIG_SECRET = "config-secret-sentinel-value-001";
const OTHER_SECRET = "other-secret-sentinel-value-002";

function headers(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
}

function call(path: string, method = "GET", body?: unknown) {
  return worker.fetch(
    new Request(`http://local.test${path}`, {
      method,
      headers: headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { ...bindings, LAB_ORG_ID: ORG, LAB_USER_ID: OWNER },
  );
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
  await reset();
});

describe("CON-02 config secret redaction", () => {
  it("registers resolved config secrets for execution-scoped scrubbing", async () => {
    const caller = { orgId: ORG, userId: OWNER };
    await setConfig(
      bindings.DB,
      caller,
      { key: "apiKey", type: "secret", value: { ref: "clientSecret" } },
      { NINJA_CLIENT_SECRET: CONFIG_SECRET },
    );
    const executionId = "c0".repeat(32);
    const resolved = await resolveConfig(
      { db: bindings.DB, orgId: ORG, executionId, secrets: { NINJA_CLIENT_SECRET: CONFIG_SECRET } },
      "apiKey",
      ["apiKey"],
      {},
    );
    expect(resolved).toMatchObject({ found: true, value: CONFIG_SECRET });
    expect(getExecutionSecrets(executionId)).toContain(CONFIG_SECRET);
    // A resolved value embedded as a substring (URL, header, vendor error
    // body) scrubs on the way out — the registry mechanism, not call-site
    // discipline.
    const scrubbed = scrubExecutionValue(
      { url: `https://vendor.invalid/?key=${CONFIG_SECRET}`, nested: [`bearer ${CONFIG_SECRET}`] },
      executionId,
    );
    expect(JSON.stringify(scrubbed)).not.toContain(CONFIG_SECRET);
  });

  it("keeps secret references out of every operator read surface", async () => {
    await call("/api/config", "POST", { key: "apiKey", type: "secret", value: { ref: "clientSecret" } });
    const listed = await call("/api/config");
    const listText = await listed.text();
    expect(listText).not.toContain(CONFIG_SECRET);
    expect(listText).not.toContain("clientSecret");
    expect(listText).toContain("[SECRET]");
    // Direct D1 read: no secret value in any column, only the reference.
    const row = await bindings.DB.prepare("SELECT value_json FROM configs WHERE org_id = ? AND key = ?")
      .bind(ORG, "apiKey")
      .first<{ value_json: string }>();
    expect(row?.value_json).toBe(JSON.stringify({ ref: "clientSecret" }));
    expect(row?.value_json).not.toContain(CONFIG_SECRET);
  });

  it("scrubs config secrets from outward Fault envelopes", async () => {
    registerExecutionSecrets("d0".repeat(32), [OTHER_SECRET]);
    const res = await call("/api/config", "POST", {
      key: "leak",
      type: "string",
      value: `prefix-${OTHER_SECRET}-suffix`,
    });
    // The write itself rejects (credential-shaped value), and the rejection
    // envelope carries no secret substring.
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain(OTHER_SECRET);
  });

  it("rejects raw secret values through the reference-only shape", async () => {
    const raw = await call("/api/config", "POST", { key: "apiKey", type: "secret", value: CONFIG_SECRET });
    expect(raw.status).toBe(400);
    // The row must not exist: a rejected write stores nothing.
    const row = await bindings.DB.prepare("SELECT id FROM configs WHERE org_id = ? AND key = ?")
      .bind(ORG, "apiKey")
      .first<{ id: string }>();
    expect(row).toBe(null);
  });
});
