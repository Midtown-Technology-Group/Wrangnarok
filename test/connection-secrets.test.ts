// SPDX-License-Identifier: AGPL-3.0
// SEC-02 per-Organization secrets (issue #411, P4 matrix): encrypted write
// path, masked views, exact-org resolution, and the full failure taxonomy —
// plus end-to-end proof that a provisioned per-org token wins over the
// deployment credential on the real runtime with mocked vendor HTTP only.
// Fixture sentinels only — never production credentials.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import {
  CLOUDFLARE_API_BASE,
  CLOUDFLARE_INTEGRATION_ID,
  cloudflareVerifySaga,
  executionId,
  NINJA_INTEGRATION_ID,
} from "../src/domain";
import {
  createConnection,
  deleteConnection,
  getConnection,
  listConnections,
  putConnectionSecrets,
  resolveConnectionSecrets,
} from "../src/connections";
import { resolveExecutionOrgSecrets } from "../src/sagas/shared";
import { clearExecutionSecrets, getExecutionSecrets } from "../src/secrets";
import { trackWorkflowInstance, useWorkflowHarness } from "./helpers/workflow-harness";

const bindings = env as unknown as Bindings;
const ORG = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000002";
const OTHER_ORG = "00000000-0000-4000-8000-000000000004";
const OTHER_USER = "00000000-0000-4000-8000-000000000005";
const caller = { orgId: ORG, userId: USER };
const TOKEN = "a".repeat(64);
const KEK = "test-secrets-kek-sentinel-fixture-only";
const OTHER_KEK = "test-other-kek-sentinel-fixture-only";
const VALUE = "test-per-org-token-value-sentinel";
const VALUE_NEXT = "test-per-org-token-rotation-sentinel";
const DEPLOYMENT_TOKEN = "test-cloudflare-token-sentinel";
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

function call(path: string, method = "GET", body?: unknown, extra: Record<string, string> = {}) {
  return new Request(`https://local.test${path}`, {
    method,
    headers: { ...auth, ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

useWorkflowHarness(bindings.DB);

beforeEach(async () => {
  await bindings.DB.prepare("DELETE FROM connection_secrets WHERE org_id=?").bind(ORG).run();
  await bindings.DB.prepare("DELETE FROM connections WHERE org_id=?").bind(ORG).run();
  await bindings.DB.prepare("DELETE FROM connection_secrets WHERE org_id=?").bind(OTHER_ORG).run();
  await bindings.DB.prepare("DELETE FROM connections WHERE org_id=?").bind(OTHER_ORG).run();
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?) ON CONFLICT(id) DO NOTHING")
    .bind(OTHER_ORG, "Other")
    .run();
});

async function seedCloudflareMapping() {
  return createConnection(bindings.DB, caller, CLOUDFLARE_INTEGRATION_ID, {
    config: { endpoint: CLOUDFLARE_API_BASE },
  });
}

async function storedRows() {
  const found = await bindings.DB.prepare(
    "SELECT connection_id,org_id,field,ciphertext,nonce,wrapped_dek,key_version,algorithm FROM connection_secrets",
  ).all<Record<string, unknown>>();
  return found.results;
}

describe("per-Organization secrets write path (SEC-02)", () => {
  it("stores ciphertext only and reports provisioned names, never values", async () => {
    await seedCloudflareMapping();
    const view = await putConnectionSecrets(bindings.DB, caller, CLOUDFLARE_INTEGRATION_ID, { apiToken: VALUE }, KEK);
    expect(view.secretsProvisioned).toEqual(["apiToken"]);
    expect(JSON.stringify(view)).not.toContain(VALUE);
    const rows = await storedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ org_id: ORG, field: "apiToken", key_version: 1, algorithm: "AES-GCM-256" });
    expect(JSON.stringify(rows)).not.toContain(VALUE);
    expect(JSON.stringify(rows)).not.toContain(KEK);
    // Reads carry the same masked contract.
    const read = await getConnection(bindings.DB, caller, CLOUDFLARE_INTEGRATION_ID);
    expect(read.secretsProvisioned).toEqual(["apiToken"]);
    expect(JSON.stringify(read)).not.toContain(VALUE);
    const listed = await listConnections(bindings.DB, caller);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.secretsProvisioned).toEqual(["apiToken"]);
    expect(JSON.stringify(listed)).not.toContain(VALUE);
  });

  it("rotates on rewrite with fresh nonces and preserves on empty", async () => {
    await seedCloudflareMapping();
    await putConnectionSecrets(bindings.DB, caller, CLOUDFLARE_INTEGRATION_ID, { apiToken: VALUE }, KEK);
    const first = (await storedRows())[0]!;
    await putConnectionSecrets(bindings.DB, caller, CLOUDFLARE_INTEGRATION_ID, { apiToken: VALUE_NEXT }, KEK);
    const second = (await storedRows())[0]!;
    expect(await resolveConnectionSecrets(bindings.DB, ORG, first.connection_id as string, { 1: KEK })).toEqual({
      apiToken: VALUE_NEXT,
    });
    expect(second.nonce).not.toBe(first.nonce);
    expect(second.ciphertext).not.toBe(first.ciphertext);
    // Empty-string edit preserves: UI blank-password keeps ciphertext.
    const preserved = await putConnectionSecrets(bindings.DB, caller, CLOUDFLARE_INTEGRATION_ID, { apiToken: "" }, KEK);
    expect(preserved.secretsProvisioned).toEqual(["apiToken"]);
    expect(await resolveConnectionSecrets(bindings.DB, ORG, first.connection_id as string, { 1: KEK })).toEqual({
      apiToken: VALUE_NEXT,
    });
  });

  it("rejects undeclared fields, bad values, and bad targets without writing", async () => {
    await seedCloudflareMapping();
    await expect(
      putConnectionSecrets(bindings.DB, caller, CLOUDFLARE_INTEGRATION_ID, { nope: VALUE }, KEK),
    ).rejects.toMatchObject({ code: "INVALID_CONNECTION" });
    await expect(
      putConnectionSecrets(bindings.DB, caller, CLOUDFLARE_INTEGRATION_ID, { apiToken: 42 }, KEK),
    ).rejects.toMatchObject({ code: "INVALID_CONNECTION" });
    await expect(
      putConnectionSecrets(bindings.DB, caller, CLOUDFLARE_INTEGRATION_ID, "nope", KEK),
    ).rejects.toMatchObject({ code: "INVALID_CONNECTION" });
    await expect(putConnectionSecrets(bindings.DB, caller, CLOUDFLARE_INTEGRATION_ID, {}, KEK)).rejects.toMatchObject({
      code: "INVALID_CONNECTION",
    });
    await expect(
      putConnectionSecrets(bindings.DB, caller, CLOUDFLARE_INTEGRATION_ID, { apiToken: VALUE }, undefined),
    ).rejects.toMatchObject({ code: "SECRET_STORE_NOT_CONFIGURED" });
    await expect(
      putConnectionSecrets(bindings.DB, caller, "not-a-uuid", { apiToken: VALUE }, KEK),
    ).rejects.toMatchObject({ code: "UNKNOWN_INTEGRATION" });
    await expect(
      putConnectionSecrets(bindings.DB, caller, NINJA_INTEGRATION_ID, { clientSecret: VALUE }, KEK),
    ).rejects.toMatchObject({ code: "CONNECTION_NOT_FOUND" });
    expect(await storedRows()).toHaveLength(0);
  });

  it("rejects managed rows and foreign mappings", async () => {
    await bindings.DB.prepare(
      "INSERT INTO connections(id,org_id,integration_id,endpoint,managed_by) VALUES (?,?,?,?,'test-bundle@1.0.0')",
    )
      .bind("00000000-0000-4000-8000-000000000301", ORG, NINJA_INTEGRATION_ID, "https://m.managed.invalid/api")
      .run();
    await expect(
      putConnectionSecrets(bindings.DB, caller, NINJA_INTEGRATION_ID, { clientSecret: VALUE }, KEK),
    ).rejects.toMatchObject({ code: "MANAGED_RESOURCE" });
    await seedCloudflareMapping();
    await expect(
      putConnectionSecrets(
        bindings.DB,
        { orgId: OTHER_ORG, userId: OTHER_USER },
        CLOUDFLARE_INTEGRATION_ID,
        { apiToken: VALUE },
        KEK,
      ),
    ).rejects.toMatchObject({ code: "CONNECTION_NOT_FOUND" });
    expect(await storedRows()).toHaveLength(0);
  });

  it("scopes resolution exact-org and fails loud on wrong KEK or tampering", async () => {
    const created = await seedCloudflareMapping();
    await putConnectionSecrets(bindings.DB, caller, CLOUDFLARE_INTEGRATION_ID, { apiToken: VALUE }, KEK);
    expect(await resolveConnectionSecrets(bindings.DB, ORG, created.id, { 1: KEK })).toEqual({ apiToken: VALUE });
    // Wrong org resolves to no secrets — never someone else's.
    expect(await resolveConnectionSecrets(bindings.DB, OTHER_ORG, created.id, { 1: KEK })).toEqual({});
    // An empty KEK map fails version-gated, never silent.
    await expect(resolveConnectionSecrets(bindings.DB, ORG, created.id, {})).rejects.toMatchObject({
      code: "CONNECTION_SECRET_UNREADABLE",
    });
    await expect(resolveConnectionSecrets(bindings.DB, ORG, created.id, { 1: OTHER_KEK })).rejects.toMatchObject({
      code: "CONNECTION_SECRET_UNREADABLE",
    });
    await bindings.DB.prepare("UPDATE connection_secrets SET ciphertext=ciphertext || 'AA' WHERE connection_id=?")
      .bind(created.id)
      .run();
    await expect(resolveConnectionSecrets(bindings.DB, ORG, created.id, { 1: KEK })).rejects.toMatchObject({
      code: "CONNECTION_SECRET_UNREADABLE",
    });
  });

  it("restores ciphertext-only backups only with the matching KEK (recovery drill)", async () => {
    // ADR 005 loss/restore: D1 backups carry ciphertext and are
    // unrecoverable without the matching KEK. Dump the rows (the backup),
    // lose the table contents, re-insert the same bytes (the restore), and
    // prove recovery depends on the KEK — never on the ciphertext alone.
    const created = await seedCloudflareMapping();
    await putConnectionSecrets(bindings.DB, caller, CLOUDFLARE_INTEGRATION_ID, { apiToken: VALUE }, KEK);
    const backup = await storedRows();
    expect(backup).toHaveLength(1);
    expect(JSON.stringify(backup)).not.toContain(VALUE);
    expect(JSON.stringify(backup)).not.toContain(KEK);
    await bindings.DB.prepare("DELETE FROM connection_secrets WHERE connection_id=?").bind(created.id).run();
    expect(await resolveConnectionSecrets(bindings.DB, ORG, created.id, { 1: KEK })).toEqual({});
    const row = backup[0] as Record<string, unknown>;
    await bindings.DB.prepare(
      "INSERT INTO connection_secrets(connection_id,org_id,field,ciphertext,nonce,wrapped_dek,key_version,algorithm,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'2026-09-17T00:00:00.000Z','2026-09-17T00:00:00.000Z')",
    )
      .bind(created.id, ORG, "apiToken", row.ciphertext, row.nonce, row.wrapped_dek, row.key_version, row.algorithm)
      .run();
    // Restored rows without the KEK (or the wrong one) fail closed.
    await expect(resolveConnectionSecrets(bindings.DB, ORG, created.id, {})).rejects.toMatchObject({
      code: "CONNECTION_SECRET_UNREADABLE",
    });
    await expect(resolveConnectionSecrets(bindings.DB, ORG, created.id, { 1: OTHER_KEK })).rejects.toMatchObject({
      code: "CONNECTION_SECRET_UNREADABLE",
    });
    // With the matching KEK the credential recovers exactly.
    expect(await resolveConnectionSecrets(bindings.DB, ORG, created.id, { 1: KEK })).toEqual({ apiToken: VALUE });
  });

  it("deletes provisioned secrets with the mapping", async () => {
    await seedCloudflareMapping();
    await putConnectionSecrets(bindings.DB, caller, CLOUDFLARE_INTEGRATION_ID, { apiToken: VALUE }, KEK);
    expect(await storedRows()).toHaveLength(1);
    await deleteConnection(bindings.DB, caller, CLOUDFLARE_INTEGRATION_ID);
    expect(await storedRows()).toHaveLength(0);
  });
});

describe("per-Organization secrets route (SEC-02)", () => {
  it("accepts values on PUT and answers masked; strangers are refused", async () => {
    await seedCloudflareMapping();
    const stored = await worker.fetch(
      call(`/api/connections/${CLOUDFLARE_INTEGRATION_ID}/secrets`, "PUT", { secrets: { apiToken: VALUE } }),
      bindings,
    );
    expect(stored.status).toBe(200);
    const body = (await stored.json()) as { connection: { secretsProvisioned: string[] } };
    expect(body.connection.secretsProvisioned).toEqual(["apiToken"]);
    expect(JSON.stringify(body)).not.toContain(VALUE);
    const rows = await storedRows();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(VALUE);
    // Ordinary members (same org, non-admin) get 403, never a masked view.
    // Plant the membership explicitly: the LAB bootstrap would otherwise
    // promote the swapped identity on first use (same pattern as the Halo
    // proof's non-admin member test).
    const stamp = new Date().toISOString();
    await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
      .bind(OTHER_USER, stamp)
      .run();
    await bindings.DB.prepare(
      "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    )
      .bind(ORG, OTHER_USER, "member", "active", "ordinary", stamp, stamp)
      .run();
    const member = { ...bindings, LAB_USER_ID: OTHER_USER };
    const refused = await worker.fetch(
      call(`/api/connections/${CLOUDFLARE_INTEGRATION_ID}/secrets`, "PUT", { secrets: { apiToken: VALUE } }),
      member,
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: "CONNECTION_FORBIDDEN" } });
    // Foreign orgs see 404 on our mapping (same isolation as mapping writes).
    const foreign = { ...bindings, LAB_ORG_ID: OTHER_ORG, LAB_USER_ID: OTHER_USER };
    const strange = await worker.fetch(
      call(`/api/connections/${CLOUDFLARE_INTEGRATION_ID}/secrets`, "PUT", { secrets: { apiToken: VALUE } }),
      foreign,
    );
    expect(strange.status).toBe(404);
    // Unknown integrations and missing mappings fail loud.
    expect(
      (
        await worker.fetch(
          call(`/api/connections/00000000-0000-4000-8000-000000000099/secrets`, "PUT", {
            secrets: { apiToken: VALUE },
          }),
          bindings,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await worker.fetch(
          call(`/api/connections/${NINJA_INTEGRATION_ID}/secrets`, "PUT", { secrets: { clientSecret: VALUE } }),
          bindings,
        )
      ).status,
    ).toBe(404);
  });
});

describe("execution org-secret resolution (SEC-02)", () => {
  async function seedExecution(id: string, orgId: string, userId: string) {
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        id,
        cloudflareVerifySaga.id,
        "cloudflare",
        cloudflareVerifySaga.revision,
        orgId,
        userId,
        JSON.stringify({}),
        1,
        "Pending",
        new Date().toISOString(),
      )
      .run();
  }

  it("returns empty without a KEK, for unknown executions, and without a mapping", async () => {
    const saga = { id: cloudflareVerifySaga.id, revision: cloudflareVerifySaga.revision };
    expect(await resolveExecutionOrgSecrets(bindings.DB, "e".repeat(64), saga, undefined)).toEqual({});
    expect(await resolveExecutionOrgSecrets(bindings.DB, "e".repeat(64), saga, "")).toEqual({});
    expect(await resolveExecutionOrgSecrets(bindings.DB, "e".repeat(64), saga, KEK)).toEqual({});
    await seedExecution("f".repeat(64), OTHER_ORG, OTHER_USER);
    expect(await resolveExecutionOrgSecrets(bindings.DB, "f".repeat(64), saga, KEK)).toEqual({});
  });

  it("resolves the provisioned value and registers it for scrubbing", async () => {
    await seedCloudflareMapping();
    await putConnectionSecrets(bindings.DB, caller, CLOUDFLARE_INTEGRATION_ID, { apiToken: VALUE }, KEK);
    const execId = "d".repeat(64);
    await seedExecution(execId, ORG, USER);
    const saga = { id: cloudflareVerifySaga.id, revision: cloudflareVerifySaga.revision };
    expect(await resolveExecutionOrgSecrets(bindings.DB, execId, saga, KEK)).toEqual({ apiToken: VALUE });
    expect(getExecutionSecrets(execId)).toContain(VALUE);
    clearExecutionSecrets(execId);
    expect(getExecutionSecrets(execId)).toEqual([]);
  });
});

describe("per-Organization secrets at execution (SEC-02)", () => {
  it("prefers the provisioned per-org token over the deployment credential", async () => {
    await seedCloudflareMapping();
    await putConnectionSecrets(bindings.DB, caller, CLOUDFLARE_INTEGRATION_ID, { apiToken: VALUE }, KEK);
    const seen: string[] = [];
    const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith("https://api.cloudflare.com/")) throw new Error(`Unexpected outbound request: ${url}`);
      const headers = init?.headers as Record<string, string>;
      seen.push(headers["Authorization"] ?? "");
      return new Response(
        JSON.stringify({ success: true, errors: [], messages: [], result: { id: "x", status: "active" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const key = "cf-perorg-wins-0001";
    const id = await executionId({ orgId: ORG, userId: USER }, key);
    const { inner: instance } = await trackWorkflowInstance(bindings.CLOUDFLARE_VERIFY_WORKFLOW, id);
    const accepted = await worker.fetch(
      new Request("https://local.test/api/executions", {
        method: "POST",
        headers: { ...auth, "Idempotency-Key": key },
        body: JSON.stringify({
          sagaId: cloudflareVerifySaga.id,
          input: { account: { id: ACCOUNT_ID, name: "Example MSP" } },
        }),
      }),
      bindings,
    );
    expect(accepted.status).toBe(202);
    await instance.waitForStatus("complete");
    const detail = await worker.fetch(
      new Request(`https://local.test/api/executions/${id}`, { headers: auth }),
      bindings,
    );
    const payload = (await detail.json()) as { status: string; result: unknown };
    expect(payload.status).toBe("Succeeded");
    // The vendor saw the per-org value, never the deployment sentinel.
    expect(mock).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([`Bearer ${VALUE}`]);
    expect(JSON.stringify(payload)).not.toContain(VALUE);
    expect(JSON.stringify(payload)).not.toContain(DEPLOYMENT_TOKEN);
    const ops = await bindings.DB.prepare("SELECT result_json,error_json FROM operations WHERE execution_id=?")
      .bind(id)
      .all<{ result_json: string | null; error_json: string | null }>();
    expect(JSON.stringify(ops.results)).not.toContain(VALUE);
    expect(JSON.stringify(ops.results)).not.toContain(DEPLOYMENT_TOKEN);
    mock.mockRestore();
  });
});
