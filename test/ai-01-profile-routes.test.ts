// SPDX-License-Identifier: AGPL-3.0
// AI-01 build slice 2 (issue #164, ADR 032): profile/assignment/embedding/
// behavior routes over migration 0028. Runs in real workerd with a real D1
// binding (CON-01 chain plus 0028); only outbound vendor HTTP is mocked.
// Pins: admin-gated CRUD reusing the CON-01 boundary, all four lifecycle
// guards, fail-closed resolution, 404-on-foreign, ownership/disabled checks,
// bounded verify/discovery with mocked vendor HTTP, and identities-only
// browser views (no provider model ids, no key material anywhere).
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import {
  ANTHROPIC_INTEGRATION_ID,
  ECHO_INTEGRATION_ID,
  GOOGLE_INTEGRATION_ID,
  OPENAI_COMPATIBLE_INTEGRATION_ID,
  OPENAI_INTEGRATION_ID,
  OPENROUTER_INTEGRATION_ID,
} from "../src/domain";
import {
  AI_VENDOR_TIMEOUT_MS,
  collectVendorModelIds,
  deleteProfile,
  discoverModels,
  getProfile,
  joinVendorListPath,
  updateProfile,
  vendorTarget,
  verifyProfile,
} from "../src/ai-profiles";
import { describeContract, SDK_ERROR_CODES } from "../src/sdk";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration3 from "../migrations/0003_usage_blocks.sql?raw";
import migration4 from "../migrations/0004_solutions_install.sql?raw";
import migration5 from "../migrations/0005_forms.sql?raw";
import migration6 from "../migrations/0006_apps.sql?raw";
import migration7 from "../migrations/0007_org_membership.sql?raw";
import migration8 from "../migrations/0008_executions_org_fk.sql?raw";
import migration9 from "../migrations/0011_connection_admin.sql?raw";
import migration10 from "../migrations/0029_connection_secrets.sql?raw";
import migration28 from "../migrations/0028_ai_profiles.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const ORG = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000002";
const OTHER_ORG = "00000000-0000-4000-8000-000000000004";
const OTHER_USER = "00000000-0000-4000-8000-000000000003";
const MEMBER_USER = "00000000-0000-4000-8000-000000000005";
const caller = { orgId: ORG, userId: USER };
const TOKEN = "a".repeat(64);
const KEY_SENTINEL = "test-openai-key-sentinel-value";
const MODEL_SENTINEL = "sentinel-model-9z";

const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

function call(path: string, method = "GET", body?: unknown, extra: Record<string, string> = {}) {
  return new Request(`https://local.test${path}`, {
    method,
    headers: { ...auth, ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

interface SeenVendorCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

type VendorHandler = (seen: SeenVendorCall) => Response | Promise<Response>;

function captureCalls(calls: SeenVendorCall[], handler: VendorHandler) {
  return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const request = input instanceof Request ? input : new Request(url, init);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const seen = { url: request.url, method: request.method, headers };
    calls.push(seen);
    return handler(seen);
  };
}

function mockVendor(handler: VendorHandler) {
  const calls: SeenVendorCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(captureCalls(calls, handler) as typeof fetch);
  return calls;
}

/** Re-point the beforeEach vendor spy without re-spying (vitest forbids a
 * second spyOn on the same method). */
function remockVendor(handler: VendorHandler) {
  const calls: SeenVendorCall[] = [];
  vi.mocked(globalThis.fetch).mockImplementation(captureCalls(calls, handler) as typeof fetch);
  return calls;
}

let vendorCalls: SeenVendorCall[] = [];

const openaiModels = { data: [{ id: "gpt-4o" }, { id: MODEL_SENTINEL }] };

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
  await bindings.DB.exec(migration10);
  await bindings.DB.exec(migration28);
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?) ON CONFLICT(id) DO NOTHING")
    .bind(OTHER_ORG, "Other")
    .run();
  await bindings.DB.prepare("DELETE FROM connections WHERE org_id=?").bind(ORG).run();
  // Default vendor mock: OpenAI lists two models. Tests override per case.
  vendorCalls = mockVendor((seen) => {
    if (seen.url === "https://api.openai.com/v1/models") return Response.json(openaiModels);
    throw new Error(`Unexpected outbound request: ${seen.url}`);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

async function createConnection(integrationId: string, endpoint?: string): Promise<{ id: string }> {
  const response = await worker.fetch(
    call("/api/connections", "POST", {
      integrationId,
      ...(endpoint === undefined ? { config: {} } : { config: { endpoint } }),
    }),
    bindings,
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { connection: { id: string } };
  return { id: body.connection.id };
}

async function createProfile(
  connectionId: string,
  extra: Record<string, unknown> = {},
  name = "chat",
): Promise<{ id: string; name: string }> {
  const response = await worker.fetch(
    call("/api/ai/profiles", "POST", { name, connectionId, modelId: MODEL_SENTINEL, ...extra }),
    bindings,
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { profile: { id: string; name: string } };
  return body.profile;
}

async function plantMember(): Promise<Bindings> {
  const stamp = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
    .bind(MEMBER_USER, stamp)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(ORG, MEMBER_USER, "member", "active", "ordinary", stamp, stamp)
    .run();
  return { ...bindings, LAB_USER_ID: MEMBER_USER };
}

describe("AI profile CRUD (issue #164)", () => {
  it("creates the first profile chat-enabled with all six assignments, identities only", async () => {
    const connection = await createConnection(OPENAI_INTEGRATION_ID);
    // enabledForChat:false is overridden on the first profile (upstream
    // first-profile guard): the org must always have a usable default.
    const profile = await createProfile(connection.id, { enabledForChat: false });
    const listed = await worker.fetch(call("/api/ai/profiles"), bindings);
    expect(listed.status).toBe(200);
    const profiles = ((await listed.json()) as { profiles: Record<string, unknown>[] }).profiles;
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      id: profile.id,
      name: "chat",
      connectionId: connection.id,
      integrationId: OPENAI_INTEGRATION_ID,
      integrationName: "openai",
      enabledForChat: true,
      capabilities: {},
      capabilityState: "unknown",
      openaiTransport: null,
    });
    // Identities only: the provider model id never rides the view.
    expect(JSON.stringify(profiles)).not.toContain(MODEL_SENTINEL);
    const assignments = (await (await worker.fetch(call("/api/ai/assignments"), bindings)).json()) as {
      assignments: { key: string; profile: { id: string } | null }[];
    };
    expect(assignments.assignments.map((entry) => entry.key)).toEqual([
      "primary",
      "summarization",
      "tuning",
      "image_generation",
      "video_generation",
      "chat_default",
    ]);
    for (const entry of assignments.assignments) {
      expect(entry.profile?.id).toBe(profile.id);
    }
    const one = await worker.fetch(call(`/api/ai/profiles/${profile.id}`), bindings);
    expect(one.status).toBe(200);
    expect(JSON.stringify(await one.json())).not.toContain(MODEL_SENTINEL);
  });

  it("rejects duplicate names case-insensitively and invalid bodies", async () => {
    const connection = await createConnection(OPENAI_INTEGRATION_ID);
    await createProfile(connection.id);
    const dup = await worker.fetch(
      call("/api/ai/profiles", "POST", { name: "CHAT", connectionId: connection.id, modelId: "gpt-4o" }),
      bindings,
    );
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ error: { code: "AI_PROFILE_EXISTS" } });
    for (const body of [
      { connectionId: connection.id, modelId: "gpt-4o" },
      { name: "  ", connectionId: connection.id, modelId: "gpt-4o" },
      { name: "x".repeat(129), connectionId: connection.id, modelId: "gpt-4o" },
      { name: "second", modelId: "gpt-4o" },
      { name: "second", connectionId: connection.id },
      { name: "second", connectionId: connection.id, modelId: "gpt-4o", capabilities: ["vision"] },
      { name: "second", connectionId: connection.id, modelId: "gpt-4o", enabledForChat: "yes" },
      { name: "second", connectionId: connection.id, modelId: "gpt-4o", openaiTransport: "" },
      { name: "second", connectionId: connection.id, modelId: "gpt-4o", capabilityState: "maybe" },
    ]) {
      const bad = await worker.fetch(call("/api/ai/profiles", "POST", body), bindings);
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ error: { code: "AI_INVALID_PROFILE" } });
    }
    const overlong = await worker.fetch(
      call("/api/ai/profiles", "POST", {
        name: "second",
        connectionId: connection.id,
        modelId: "gpt-4o",
        capabilities: { blob: "x".repeat(2049) },
      }),
      bindings,
    );
    expect(overlong.status).toBe(400);
    expect(await overlong.json()).toMatchObject({ error: { code: "AI_INVALID_PROFILE" } });
    const manyKeys = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, true]));
    const crowded = await worker.fetch(
      call("/api/ai/profiles", "POST", {
        name: "second",
        connectionId: connection.id,
        modelId: "gpt-4o",
        capabilities: manyKeys,
      }),
      bindings,
    );
    expect(crowded.status).toBe(400);
    const longKey = await worker.fetch(
      call("/api/ai/profiles", "POST", {
        name: "second",
        connectionId: connection.id,
        modelId: "gpt-4o",
        capabilities: { ["k".repeat(129)]: true },
      }),
      bindings,
    );
    expect(longKey.status).toBe(400);
  });

  it("enforces Connection ownership, kind, and enabled checks on attach", async () => {
    const openai = await createConnection(OPENAI_INTEGRATION_ID);
    const echo = await createConnection(ECHO_INTEGRATION_ID, "http://127.0.0.1:8788/echo");
    // Non-AI provider kinds cannot back profiles.
    const wrongKind = await worker.fetch(
      call("/api/ai/profiles", "POST", { name: "chat", connectionId: echo.id, modelId: "x" }),
      bindings,
    );
    expect(wrongKind.status).toBe(400);
    expect(await wrongKind.json()).toMatchObject({ error: { code: "AI_INVALID_PROFILE" } });
    // Foreign and malformed Connection ids 404 (never a leak, never a guess).
    const foreign = { ...bindings, LAB_ORG_ID: OTHER_ORG, LAB_USER_ID: OTHER_USER };
    await worker.fetch(call("/api/connections", "POST", { integrationId: OPENAI_INTEGRATION_ID, config: {} }), foreign);
    const foreignRow = await bindings.DB.prepare("SELECT id FROM connections WHERE org_id=?")
      .bind(OTHER_ORG)
      .first<{ id: string }>();
    for (const connectionId of [foreignRow?.id ?? "missing", "not-a-uuid", "00000000-0000-4000-8000-000000000099"]) {
      const missing = await worker.fetch(
        call("/api/ai/profiles", "POST", { name: "chat", connectionId, modelId: "x" }),
        bindings,
      );
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ error: { code: "CONNECTION_NOT_FOUND" } });
    }
    // Disabled Connections read as missing (CON-01 test-route posture).
    await worker.fetch(call(`/api/connections/${OPENAI_INTEGRATION_ID}`, "PUT", { enabled: false }), bindings);
    const disabled = await worker.fetch(
      call("/api/ai/profiles", "POST", { name: "chat", connectionId: openai.id, modelId: "x" }),
      bindings,
    );
    expect(disabled.status).toBe(404);
    expect(await disabled.json()).toMatchObject({ error: { code: "CONNECTION_DISABLED" } });
  });

  it("updates partially and 404s on foreign profiles", async () => {
    const connection = await createConnection(OPENAI_INTEGRATION_ID);
    const profile = await createProfile(connection.id);
    const updated = await worker.fetch(
      call(`/api/ai/profiles/${profile.id}`, "PUT", {
        name: " renamed ",
        capabilities: { vision: true },
        openaiTransport: "responses",
      }),
      bindings,
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      profile: { id: profile.id, name: "renamed", capabilities: { vision: true }, openaiTransport: "responses" },
    });
    // An explicit capability override persists while identity is stable.
    const overridden = await worker.fetch(
      call(`/api/ai/profiles/${profile.id}`, "PUT", { capabilityState: "supported" }),
      bindings,
    );
    expect(await overridden.json()).toMatchObject({ profile: { capabilityState: "supported" } });
    const second = await createProfile(connection.id, { enabledForChat: false }, "second");
    const dupRename = await worker.fetch(call(`/api/ai/profiles/${second.id}`, "PUT", { name: "RENAMED" }), bindings);
    expect(dupRename.status).toBe(409);
    const badConnection = await worker.fetch(
      call(`/api/ai/profiles/${second.id}`, "PUT", { connectionId: 42 }),
      bindings,
    );
    expect(badConnection.status).toBe(400);
    const badFlag = await worker.fetch(
      call(`/api/ai/profiles/${second.id}`, "PUT", { enabledForChat: "yes" }),
      bindings,
    );
    expect(badFlag.status).toBe(400);
    expect(await badFlag.json()).toMatchObject({ error: { code: "AI_INVALID_PROFILE" } });
    const foreign = { ...bindings, LAB_ORG_ID: OTHER_ORG, LAB_USER_ID: OTHER_USER };
    expect((await worker.fetch(call(`/api/ai/profiles/${profile.id}`), foreign)).status).toBe(404);
    expect((await worker.fetch(call(`/api/ai/profiles/${profile.id}`, "PUT", { name: "x" }), foreign)).status).toBe(
      404,
    );
    expect((await worker.fetch(call(`/api/ai/profiles/${profile.id}`, "DELETE"), foreign)).status).toBe(404);
    expect((await worker.fetch(call(`/api/ai/profiles/00000000-0000-4000-8000-000000000099`), bindings)).status).toBe(
      404,
    );
    expect(JSON.stringify(await (await worker.fetch(call("/api/ai/profiles"), foreign)).json())).toBe(
      JSON.stringify({ profiles: [] }),
    );
  });

  it("tolerates corrupt capability blobs and unresolving backing rows on reads", async () => {
    const connection = await createConnection(OPENAI_INTEGRATION_ID);
    const profile = await createProfile(connection.id);
    await bindings.DB.prepare("UPDATE ai_model_profiles SET capabilities_json=? WHERE id=?")
      .bind("{not json", profile.id)
      .run();
    const one = await worker.fetch(call(`/api/ai/profiles/${profile.id}`), bindings);
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({ profile: { capabilities: {} } });
    // A blob that parses but is not a plain object reads as empty too.
    await bindings.DB.prepare("UPDATE ai_model_profiles SET capabilities_json=? WHERE id=?")
      .bind("[1]", profile.id)
      .run();
    const shaped = await worker.fetch(call(`/api/ai/profiles/${profile.id}`), bindings);
    expect(await shaped.json()).toMatchObject({ profile: { capabilities: {} } });
    // Rows written outside validation vanish from reads like CON-01's stale
    // Integration rows — never half-shaped. All three shapes below satisfy
    // the storage FKs yet fail the org/kind/registry checks: a cross-org
    // Connection reference, a non-AI Connection reference, and a Connection
    // naming an unknown Integration.
    const foreign = { ...bindings, LAB_ORG_ID: OTHER_ORG, LAB_USER_ID: OTHER_USER };
    await worker.fetch(call("/api/connections", "POST", { integrationId: OPENAI_INTEGRATION_ID, config: {} }), foreign);
    const foreignRow = await bindings.DB.prepare("SELECT id FROM connections WHERE org_id=?")
      .bind(OTHER_ORG)
      .first<{ id: string }>();
    if (!foreignRow) throw new Error("missing foreign connection");
    const echo = await createConnection(ECHO_INTEGRATION_ID, "http://127.0.0.1:8788/echo");
    const unknownIntegrationId = "00000000-0000-4000-8000-000000000098";
    const unknownConnectionId = "00000000-0000-4000-8000-000000000802";
    await bindings.DB.prepare("INSERT INTO connections(id,org_id,integration_id,endpoint) VALUES (?,?,?,?)")
      .bind(unknownConnectionId, ORG, unknownIntegrationId, "https://unknown.example.com")
      .run();
    const stamp = new Date().toISOString();
    const stale: [string, string, string][] = [
      ["00000000-0000-4000-8000-000000000901", foreignRow.id, "cross-org"],
      ["00000000-0000-4000-8000-000000000902", echo.id, "wrong-kind"],
      ["00000000-0000-4000-8000-000000000903", unknownConnectionId, "unknown-integration"],
    ];
    for (const [id, connectionId, name] of stale) {
      await bindings.DB.prepare(
        "INSERT INTO ai_model_profiles(id,org_id,connection_id,name,model_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
      )
        .bind(id, ORG, connectionId, name, "stale-model", stamp, stamp)
        .run();
    }
    for (const [id] of stale) {
      expect((await worker.fetch(call(`/api/ai/profiles/${id}`), bindings)).status).toBe(404);
    }
    const profiles = (
      (await (await worker.fetch(call("/api/ai/profiles"), bindings)).json()) as {
        profiles: { id: string }[];
      }
    ).profiles;
    expect(profiles.map((entry) => entry.id)).toEqual([profile.id]);
    // An assignment mapped at such a row fails closed too.
    await bindings.DB.prepare("UPDATE ai_assignments SET profile_id=? WHERE org_id=? AND assignment_key=?")
      .bind("00000000-0000-4000-8000-000000000903", ORG, "tuning")
      .run();
    expect((await worker.fetch(call("/api/ai/resolve/tuning"), bindings)).status).toBe(404);
    expect(connection.id).toBeTruthy();
  });
});

describe("AI lifecycle guards (issue #164)", () => {
  it("rejects disabling chat while holding chat_default", async () => {
    const connection = await createConnection(OPENAI_INTEGRATION_ID);
    const profile = await createProfile(connection.id);
    const refused = await worker.fetch(
      call(`/api/ai/profiles/${profile.id}`, "PUT", { enabledForChat: false }),
      bindings,
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "AI_CHAT_DEFAULT_HELD" } });
    // A profile holding no chat_default disables cleanly.
    const second = await createProfile(connection.id, { enabledForChat: false }, "second");
    const ok = await worker.fetch(call(`/api/ai/profiles/${second.id}`, "PUT", { enabledForChat: false }), bindings);
    expect(ok.status).toBe(200);
  });

  it("blocks deletes while referenced and allows them once freed", async () => {
    const connection = await createConnection(OPENAI_INTEGRATION_ID);
    const first = await createProfile(connection.id);
    const blocked = await worker.fetch(call(`/api/ai/profiles/${first.id}`, "DELETE"), bindings);
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { code: "AI_PROFILE_REFERENCED" } });
    const second = await createProfile(connection.id, { enabledForChat: true }, "second");
    for (const key of ["primary", "summarization", "tuning", "image_generation", "video_generation", "chat_default"]) {
      const moved = await worker.fetch(call(`/api/ai/assignments/${key}`, "PUT", { profileId: second.id }), bindings);
      expect(moved.status).toBe(200);
    }
    const freed = await worker.fetch(call(`/api/ai/profiles/${first.id}`, "DELETE"), bindings);
    expect(freed.status).toBe(200);
    expect((await worker.fetch(call(`/api/ai/profiles/${first.id}`), bindings)).status).toBe(404);
    expect(
      (await worker.fetch(call(`/api/ai/profiles/00000000-0000-4000-8000-000000000099`, "DELETE"), bindings)).status,
    ).toBe(404);
  });

  it("merges sources into the target, reassigning assignments and ORing chat flags", async () => {
    const connection = await createConnection(OPENAI_INTEGRATION_ID);
    const first = await createProfile(connection.id);
    const second = await createProfile(connection.id, { enabledForChat: false }, "second");
    const third = await createProfile(connection.id, { enabledForChat: true }, "third");
    await worker.fetch(call("/api/ai/assignments/tuning", "PUT", { profileId: second.id }), bindings);
    const merged = await worker.fetch(
      call("/api/ai/profiles/merge", "POST", { profileIds: [first.id, second.id], targetProfileId: second.id }),
      bindings,
    );
    expect(merged.status).toBe(200);
    const body = (await merged.json()) as {
      merge: {
        profile: { id: string; enabledForChat: boolean };
        mergedProfileIds: string[];
        reassignedAssignmentKeys: string[];
      };
    };
    expect(body.merge.profile.id).toBe(second.id);
    // First was chat-enabled: the OR keeps the target chat-enabled.
    expect(body.merge.profile.enabledForChat).toBe(true);
    expect(body.merge.mergedProfileIds).toEqual([first.id]);
    expect(body.merge.reassignedAssignmentKeys).toEqual([
      "chat_default",
      "image_generation",
      "primary",
      "summarization",
      "video_generation",
    ]);
    expect((await worker.fetch(call(`/api/ai/profiles/${first.id}`), bindings)).status).toBe(404);
    const resolved = await worker.fetch(call("/api/ai/resolve/primary"), bindings);
    expect(await resolved.json()).toMatchObject({ resolution: { profile: { id: second.id } } });
    // Merging sources that hold nothing reassigns nothing but still ORs.
    const quiet = await worker.fetch(
      call("/api/ai/profiles/merge", "POST", { profileIds: [second.id, third.id], targetProfileId: third.id }),
      bindings,
    );
    expect(quiet.status).toBe(200);
    expect(await quiet.json()).toMatchObject({
      merge: {
        profile: { id: third.id, enabledForChat: true },
        reassignedAssignmentKeys: [
          "chat_default",
          "image_generation",
          "primary",
          "summarization",
          "tuning",
          "video_generation",
        ],
      },
    });
  });

  it("rejects bad merges without touching rows", async () => {
    const connection = await createConnection(OPENAI_INTEGRATION_ID);
    const first = await createProfile(connection.id);
    const second = await createProfile(connection.id, { enabledForChat: false }, "second");
    for (const body of [
      {},
      { profileIds: [first.id], targetProfileId: first.id },
      { profileIds: [first.id, first.id], targetProfileId: first.id },
      { profileIds: [first.id, 42], targetProfileId: first.id },
      { profileIds: [first.id, second.id], targetProfileId: "00000000-0000-4000-8000-000000000099" },
      {
        profileIds: Array.from({ length: 26 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`),
        targetProfileId: first.id,
      },
    ]) {
      const bad = await worker.fetch(call("/api/ai/profiles/merge", "POST", body), bindings);
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ error: { code: "AI_INVALID_MERGE" } });
    }
    const foreign = await worker.fetch(
      call("/api/ai/profiles/merge", "POST", {
        profileIds: [first.id, "00000000-0000-4000-8000-000000000099"],
        targetProfileId: first.id,
      }),
      bindings,
    );
    expect(foreign.status).toBe(404);
    // Merging chat-disabled sources keeps the target chat-disabled (OR false).
    const third = await createProfile(connection.id, { enabledForChat: false }, "third");
    const quiet = await worker.fetch(
      call("/api/ai/profiles/merge", "POST", { profileIds: [second.id, third.id], targetProfileId: second.id }),
      bindings,
    );
    expect(quiet.status).toBe(200);
    expect(await quiet.json()).toMatchObject({ merge: { profile: { enabledForChat: false } } });
    expect((await worker.fetch(call("/api/ai/profiles"), bindings)).status).toBe(200);
    const profiles = (
      (await (await worker.fetch(call("/api/ai/profiles"), bindings)).json()) as { profiles: unknown[] }
    ).profiles;
    expect(profiles).toHaveLength(2);
  });

  it("backfills a missing chat_default when a chat profile appears", async () => {
    const connection = await createConnection(OPENAI_INTEGRATION_ID);
    const first = await createProfile(connection.id, { enabledForChat: false }, "first");
    expect(first).toBeDefined();
    await bindings.DB.prepare("DELETE FROM ai_assignments WHERE org_id=? AND assignment_key=?")
      .bind(ORG, "chat_default")
      .run();
    const resolveId = async (): Promise<string> => {
      const body = (await (await worker.fetch(call("/api/ai/resolve/chat_default"), bindings)).json()) as {
        resolution: { profile: { id: string } };
      };
      return body.resolution.profile.id;
    };
    // Create-backfill: a new chat-enabled profile claims the missing key.
    const second = await createProfile(connection.id, { enabledForChat: true }, "second");
    expect(await resolveId()).toBe(second.id);
    await bindings.DB.prepare("DELETE FROM ai_assignments WHERE org_id=? AND assignment_key=?")
      .bind(ORG, "chat_default")
      .run();
    // Update-backfill: enabling chat on a profile claims the missing key.
    const third = await createProfile(connection.id, { enabledForChat: false }, "third");
    await worker.fetch(call(`/api/ai/profiles/${third.id}`, "PUT", { enabledForChat: true }), bindings);
    expect(await resolveId()).toBe(third.id);
  });

  it("resets transport and capability knowledge when identity changes", async () => {
    const openai = await createConnection(OPENAI_INTEGRATION_ID);
    await createConnection(ANTHROPIC_INTEGRATION_ID);
    const profile = await createProfile(openai.id, {}, "chat");
    await worker.fetch(
      call(`/api/ai/profiles/${profile.id}`, "PUT", { openaiTransport: "responses", capabilityState: "supported" }),
      bindings,
    );
    // A model change resets both transport and capability state.
    const modelChanged = await worker.fetch(
      call(`/api/ai/profiles/${profile.id}`, "PUT", { modelId: "gpt-4o-mini" }),
      bindings,
    );
    expect(await modelChanged.json()).toMatchObject({
      profile: { openaiTransport: null, capabilityState: "unknown" },
    });
    await worker.fetch(
      call(`/api/ai/profiles/${profile.id}`, "PUT", { openaiTransport: "responses", capabilityState: "supported" }),
      bindings,
    );
    // A Connection change resets both as well.
    const anthropicRow = await bindings.DB.prepare("SELECT id FROM connections WHERE org_id=? AND integration_id=?")
      .bind(ORG, ANTHROPIC_INTEGRATION_ID)
      .first<{ id: string }>();
    const moved = await worker.fetch(
      call(`/api/ai/profiles/${profile.id}`, "PUT", { connectionId: anthropicRow?.id }),
      bindings,
    );
    expect(await moved.json()).toMatchObject({
      profile: { openaiTransport: null, capabilityState: "unknown", integrationName: "anthropic" },
    });
    // An explicit transport edit resets capability state but keeps the value.
    await worker.fetch(
      call(`/api/ai/profiles/${profile.id}`, "PUT", { openaiTransport: "chat", capabilityState: "supported" }),
      bindings,
    );
    const transportChanged = await worker.fetch(
      call(`/api/ai/profiles/${profile.id}`, "PUT", { openaiTransport: "responses" }),
      bindings,
    );
    expect(await transportChanged.json()).toMatchObject({
      profile: { openaiTransport: "responses", capabilityState: "unknown" },
    });
    // An explicit capability override persists while identity is stable.
    const override = await worker.fetch(
      call(`/api/ai/profiles/${profile.id}`, "PUT", { capabilityState: "unsupported" }),
      bindings,
    );
    expect(await override.json()).toMatchObject({ profile: { capabilityState: "unsupported" } });
  });
});

describe("AI assignments and fail-closed resolution (issue #164)", () => {
  it("sets, clears, and guards the six keys", async () => {
    const connection = await createConnection(OPENAI_INTEGRATION_ID);
    const first = await createProfile(connection.id);
    const second = await createProfile(connection.id, { enabledForChat: false }, "second");
    // chat_default needs a chat-enabled profile (upstream set_assignment).
    const notChat = await worker.fetch(
      call("/api/ai/assignments/chat_default", "PUT", { profileId: second.id }),
      bindings,
    );
    expect(notChat.status).toBe(400);
    expect(await notChat.json()).toMatchObject({ error: { code: "AI_PROFILE_NOT_CHAT" } });
    const moved = await worker.fetch(call("/api/ai/assignments/tuning", "PUT", { profileId: second.id }), bindings);
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({ assignment: { key: "tuning", profile: { id: second.id } } });
    // Clearing is explicit null only; primary/chat_default cannot clear.
    const cleared = await worker.fetch(call("/api/ai/assignments/tuning", "PUT", { profileId: null }), bindings);
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ assignment: { key: "tuning", profile: null } });
    for (const key of ["primary", "chat_default"]) {
      const required = await worker.fetch(call(`/api/ai/assignments/${key}`, "PUT", { profileId: null }), bindings);
      expect(required.status).toBe(409);
      expect(await required.json()).toMatchObject({ error: { code: "AI_ASSIGNMENT_REQUIRED" } });
    }
    for (const body of [{}, { profileId: 42 }, { profileId: "00000000-0000-4000-8000-000000000099" }]) {
      const bad = await worker.fetch(call("/api/ai/assignments/tuning", "PUT", body), bindings);
      expect([400, 404]).toContain(bad.status);
    }
    const unknown = await worker.fetch(call("/api/ai/assignments/bogus", "PUT", { profileId: first.id }), bindings);
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: { code: "AI_INVALID_ASSIGNMENT" } });
    // A profile whose Connection is disabled cannot be assigned.
    await worker.fetch(call(`/api/connections/${OPENAI_INTEGRATION_ID}`, "PUT", { enabled: false }), bindings);
    const third = { id: "00000000-0000-4000-8000-000000000901" };
    const stamp = new Date().toISOString();
    await bindings.DB.prepare(
      "INSERT INTO ai_model_profiles(id,org_id,connection_id,name,model_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    )
      .bind(third.id, ORG, connection.id, "third", "gpt-4o", stamp, stamp)
      .run();
    const gated = await worker.fetch(call("/api/ai/assignments/tuning", "PUT", { profileId: third.id }), bindings);
    expect(gated.status).toBe(404);
    expect(await gated.json()).toMatchObject({ error: { code: "CONNECTION_DISABLED" } });
  });

  it("resolves usable mappings and fails closed on every unusable state", async () => {
    const connection = await createConnection(OPENAI_INTEGRATION_ID);
    const first = await createProfile(connection.id);
    const resolved = await worker.fetch(call("/api/ai/resolve/primary"), bindings);
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({ resolution: { key: "primary", profile: { id: first.id } } });
    // Unknown keys reject; cleared keys fail closed (404, never a guess).
    const unknown = await worker.fetch(call("/api/ai/resolve/bogus"), bindings);
    expect(unknown.status).toBe(400);
    await worker.fetch(call("/api/ai/assignments/tuning", "PUT", { profileId: null }), bindings);
    const cleared = await worker.fetch(call("/api/ai/resolve/tuning"), bindings);
    expect(cleared.status).toBe(404);
    expect(await cleared.json()).toMatchObject({ error: { code: "AI_ASSIGNMENT_UNRESOLVED" } });
    // Mappings that no longer resolve fail closed: a cross-org profile
    // reference and a profile on a cross-org Connection (both satisfy the
    // storage FKs yet fail the org checks).
    const foreign = { ...bindings, LAB_ORG_ID: OTHER_ORG, LAB_USER_ID: OTHER_USER };
    const foreignCreated = await worker.fetch(
      call("/api/connections", "POST", { integrationId: OPENAI_INTEGRATION_ID, config: {} }),
      foreign,
    );
    const foreignConnection = ((await foreignCreated.json()) as { connection: { id: string } }).connection;
    const foreignProfile = await worker.fetch(
      call("/api/ai/profiles", "POST", {
        name: "foreign",
        connectionId: foreignConnection.id,
        modelId: "foreign-model",
      }),
      foreign,
    );
    const foreignProfileId = ((await foreignProfile.json()) as { profile: { id: string } }).profile.id;
    const stamp = new Date().toISOString();
    const crossConnId = "00000000-0000-4000-8000-000000000901";
    await bindings.DB.prepare(
      "INSERT INTO ai_model_profiles(id,org_id,connection_id,name,model_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    )
      .bind(crossConnId, ORG, foreignConnection.id, "cross-conn", "cross-model", stamp, stamp)
      .run();
    await bindings.DB.prepare("UPDATE ai_assignments SET profile_id=? WHERE org_id=? AND assignment_key=?")
      .bind(crossConnId, ORG, "primary")
      .run();
    await bindings.DB.prepare(
      "INSERT INTO ai_assignments(org_id,assignment_key,profile_id,updated_at) VALUES (?,?,?,?)",
    )
      .bind(ORG, "tuning", foreignProfileId, stamp)
      .run();
    for (const key of ["primary", "tuning"]) {
      const dangling = await worker.fetch(call(`/api/ai/resolve/${key}`), bindings);
      expect(dangling.status).toBe(404);
      expect(await dangling.json()).toMatchObject({ error: { code: "AI_ASSIGNMENT_UNRESOLVED" } });
    }
    const listed = (await (await worker.fetch(call("/api/ai/assignments"), bindings)).json()) as {
      assignments: { key: string; profile: unknown }[];
    };
    expect(listed.assignments.find((entry) => entry.key === "primary")?.profile).toBeNull();
    expect(listed.assignments.find((entry) => entry.key === "tuning")?.profile).toBeNull();
    expect(connection.id).toBeTruthy();
  });

  it("fails closed when the backing Connection is disabled", async () => {
    const connection = await createConnection(OPENAI_INTEGRATION_ID);
    await createProfile(connection.id);
    expect((await worker.fetch(call("/api/ai/resolve/primary"), bindings)).status).toBe(200);
    await worker.fetch(call(`/api/connections/${OPENAI_INTEGRATION_ID}`, "PUT", { enabled: false }), bindings);
    const gated = await worker.fetch(call("/api/ai/resolve/primary"), bindings);
    expect(gated.status).toBe(404);
    expect(await gated.json()).toMatchObject({ error: { code: "AI_ASSIGNMENT_UNRESOLVED" } });
  });
});

describe("AI authorization and isolation (issue #164)", () => {
  it("lets members read but refuses every mutation with AI_FORBIDDEN", async () => {
    const connection = await createConnection(OPENAI_INTEGRATION_ID);
    const profile = await createProfile(connection.id);
    const member = await plantMember();
    for (const path of [
      "/api/ai/profiles",
      `/api/ai/profiles/${profile.id}`,
      "/api/ai/assignments",
      "/api/ai/resolve/primary",
      "/api/ai/embedding",
      "/api/ai/behavior",
    ]) {
      expect((await worker.fetch(call(path), member)).status).toBe(200);
    }
    // Members discover too (key-authenticated server-side, availability only).
    const keyedMember = { ...member, OPENAI_API_KEY: KEY_SENTINEL };
    expect((await worker.fetch(call(`/api/ai/discover/${OPENAI_INTEGRATION_ID}`), keyedMember)).status).toBe(200);
    const writes: [string, string, unknown][] = [
      ["/api/ai/profiles", "POST", { name: "x", connectionId: connection.id, modelId: "x" }],
      [`/api/ai/profiles/${profile.id}`, "PUT", { name: "x" }],
      [`/api/ai/profiles/${profile.id}`, "DELETE", undefined],
      ["/api/ai/profiles/merge", "POST", { profileIds: [], targetProfileId: profile.id }],
      [`/api/ai/profiles/${profile.id}/verify`, "POST", {}],
      ["/api/ai/assignments/tuning", "PUT", { profileId: null }],
      ["/api/ai/embedding", "PUT", { connectionId: connection.id, modelId: "x" }],
      ["/api/ai/behavior", "PUT", { defaultSystemPrompt: "x" }],
    ];
    for (const [path, method, body] of writes) {
      const refused = await worker.fetch(call(path, method, body), member);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ error: { code: "AI_FORBIDDEN" } });
    }
  });

  it("scopes every AI row per Organization", async () => {
    const connection = await createConnection(OPENAI_INTEGRATION_ID);
    const profile = await createProfile(connection.id);
    await worker.fetch(
      call("/api/ai/embedding", "PUT", { connectionId: connection.id, modelId: "text-embedding-3", dimensions: 512 }),
      bindings,
    );
    await worker.fetch(call("/api/ai/behavior", "PUT", { defaultSystemPrompt: "Be helpful." }), bindings);
    const foreign = { ...bindings, LAB_ORG_ID: OTHER_ORG, LAB_USER_ID: OTHER_USER };
    expect(JSON.stringify(await (await worker.fetch(call("/api/ai/assignments"), foreign)).json())).toBe(
      JSON.stringify({
        assignments: ["primary", "summarization", "tuning", "image_generation", "video_generation", "chat_default"].map(
          (key) => ({ key, profile: null, updatedAt: null }),
        ),
      }),
    );
    expect((await worker.fetch(call("/api/ai/resolve/primary"), foreign)).status).toBe(404);
    expect(await (await worker.fetch(call("/api/ai/embedding"), foreign)).json()).toEqual({ embedding: null });
    expect(await (await worker.fetch(call("/api/ai/behavior"), foreign)).json()).toEqual({ behavior: null });
    // Foreign writes never touch home rows (404 before any guard runs).
    const foreignWrite = await worker.fetch(
      call("/api/ai/assignments/primary", "PUT", { profileId: profile.id }),
      foreign,
    );
    expect(foreignWrite.status).toBe(404);
    const home = await worker.fetch(call("/api/ai/resolve/primary"), bindings);
    expect(await home.json()).toMatchObject({ resolution: { profile: { id: profile.id } } });
  });
});

describe("AI embedding and behavior singletons (issue #164)", () => {
  it("round-trips the embedding singleton with AI-Connection checks", async () => {
    expect(await (await worker.fetch(call("/api/ai/embedding"), bindings)).json()).toEqual({ embedding: null });
    const connection = await createConnection(OPENAI_INTEGRATION_ID);
    const echo = await createConnection(ECHO_INTEGRATION_ID, "http://127.0.0.1:8788/echo");
    const stored = await worker.fetch(
      call("/api/ai/embedding", "PUT", { connectionId: connection.id, modelId: "text-embedding-3", dimensions: 1536 }),
      bindings,
    );
    expect(stored.status).toBe(200);
    const storedBody = await stored.json();
    expect(storedBody).toMatchObject({
      embedding: { connectionId: connection.id, integrationName: "openai", dimensions: 1536 },
    });
    // The model id persists server-side but never rides the view.
    expect(JSON.stringify(storedBody)).not.toContain("text-embedding-3");
    const read = await worker.fetch(call("/api/ai/embedding"), bindings);
    const readBody = await read.json();
    expect(readBody).toMatchObject({ embedding: { dimensions: 1536 } });
    expect(JSON.stringify(readBody)).not.toContain("text-embedding-3");
    const nulled = await worker.fetch(
      call("/api/ai/embedding", "PUT", { connectionId: connection.id, modelId: "text-embedding-3" }),
      bindings,
    );
    expect(await nulled.json()).toMatchObject({ embedding: { dimensions: null } });
    for (const body of [
      {},
      { connectionId: connection.id },
      { connectionId: connection.id, modelId: "  " },
      { connectionId: connection.id, modelId: "x", dimensions: 0 },
      { connectionId: connection.id, modelId: "x", dimensions: 1.5 },
      { connectionId: connection.id, modelId: "x", dimensions: 32769 },
      { connectionId: echo.id, modelId: "x" },
      { connectionId: "not-a-uuid", modelId: "x" },
    ]) {
      const bad = await worker.fetch(call("/api/ai/embedding", "PUT", body), bindings);
      expect([400, 404]).toContain(bad.status);
    }
    await worker.fetch(call(`/api/connections/${OPENAI_INTEGRATION_ID}`, "PUT", { enabled: false }), bindings);
    const gated = await worker.fetch(
      call("/api/ai/embedding", "PUT", { connectionId: connection.id, modelId: "x" }),
      bindings,
    );
    expect(gated.status).toBe(404);
  });

  it("unresolving embedding Connections read as unconfigured", async () => {
    const connection = await createConnection(OPENAI_INTEGRATION_ID);
    await worker.fetch(
      call("/api/ai/embedding", "PUT", { connectionId: connection.id, modelId: "text-embedding-3" }),
      bindings,
    );
    // A cross-org Connection reference (FK-satisfied, org-rejected) reads
    // as unconfigured rather than leaking the foreign mapping.
    const foreign = { ...bindings, LAB_ORG_ID: OTHER_ORG, LAB_USER_ID: OTHER_USER };
    await worker.fetch(call("/api/connections", "POST", { integrationId: OPENAI_INTEGRATION_ID, config: {} }), foreign);
    const foreignRow = await bindings.DB.prepare("SELECT id FROM connections WHERE org_id=?")
      .bind(OTHER_ORG)
      .first<{ id: string }>();
    if (!foreignRow) throw new Error("missing foreign connection");
    await bindings.DB.prepare("UPDATE ai_embedding_config SET connection_id=? WHERE org_id=?")
      .bind(foreignRow.id, ORG)
      .run();
    expect(await (await worker.fetch(call("/api/ai/embedding"), bindings)).json()).toEqual({ embedding: null });
    // So does a non-AI Connection reference written outside validation.
    const echo = await createConnection(ECHO_INTEGRATION_ID, "http://127.0.0.1:8788/echo");
    await bindings.DB.prepare("UPDATE ai_embedding_config SET connection_id=? WHERE org_id=?").bind(echo.id, ORG).run();
    expect(await (await worker.fetch(call("/api/ai/embedding"), bindings)).json()).toEqual({ embedding: null });
  });

  it("round-trips the behavior row with prompt bounds", async () => {
    expect(await (await worker.fetch(call("/api/ai/behavior"), bindings)).json()).toEqual({ behavior: null });
    const stored = await worker.fetch(
      call("/api/ai/behavior", "PUT", { defaultSystemPrompt: "You are a helpful operator assistant." }),
      bindings,
    );
    expect(stored.status).toBe(200);
    expect(await stored.json()).toMatchObject({
      behavior: { defaultSystemPrompt: "You are a helpful operator assistant." },
    });
    const read = await worker.fetch(call("/api/ai/behavior"), bindings);
    expect(await read.json()).toMatchObject({
      behavior: { defaultSystemPrompt: "You are a helpful operator assistant." },
    });
    for (const body of [
      {},
      { defaultSystemPrompt: "" },
      { defaultSystemPrompt: "x".repeat(2049) },
      { defaultSystemPrompt: 42 },
    ]) {
      const bad = await worker.fetch(call("/api/ai/behavior", "PUT", body), bindings);
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ error: { code: "AI_INVALID_BEHAVIOR" } });
    }
  });
});

describe("AI verify-with-key (issue #164)", () => {
  const keyed = () => ({ ...bindings, OPENAI_API_KEY: KEY_SENTINEL });

  it("presence-checks the deployment key before any vendor contact", async () => {
    const connection = await createConnection(OPENAI_INTEGRATION_ID);
    const profile = await createProfile(connection.id);
    const refused = await worker.fetch(call(`/api/ai/profiles/${profile.id}/verify`, "POST", {}), bindings);
    expect(refused.status).toBe(502);
    expect(await refused.json()).toMatchObject({ verification: { ok: false, code: "SECRET_NOT_CONFIGURED" } });
    expect(vendorCalls).toHaveLength(0);
  });

  it("verifies with the key and reports model availability, never key or model", async () => {
    const connection = await createConnection(OPENAI_INTEGRATION_ID);
    const profile = await createProfile(connection.id);
    const calls = remockVendor((seen) => {
      if (seen.url === "https://api.openai.com/v1/models") return Response.json(openaiModels);
      throw new Error(`Unexpected outbound request: ${seen.url}`);
    });
    const verified = await worker.fetch(call(`/api/ai/profiles/${profile.id}/verify`, "POST", {}), keyed());
    expect(verified.status).toBe(200);
    const body = await verified.json();
    expect(body).toMatchObject({ verification: { ok: true, profileId: profile.id, modelAvailable: true } });
    expect(JSON.stringify(body)).not.toContain(KEY_SENTINEL);
    expect(JSON.stringify(body)).not.toContain(MODEL_SENTINEL);
    // Verify-with-key sends the key (unlike the keyless reachability probe).
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "https://api.openai.com/v1/models", method: "GET" });
    expect(calls[0]?.headers["authorization"]).toBe(`Bearer ${KEY_SENTINEL}`);
    // A profile whose model the vendor does not list verifies unavailable.
    const absent = await createProfile(connection.id, { enabledForChat: false, modelId: "gpt-zzz-absent" }, "absent");
    const missing = await worker.fetch(call(`/api/ai/profiles/${absent.id}/verify`, "POST", {}), keyed());
    expect(await missing.json()).toMatchObject({ verification: { ok: true, modelAvailable: false } });
  });

  it("maps every vendor failure to a fixed-detail AI_VERIFY_FAILED", async () => {
    const connection = await createConnection(OPENAI_INTEGRATION_ID);
    const profile = await createProfile(connection.id);
    const cases: [string, VendorHandler][] = [
      ["rejected credential", () => new Response(null, { status: 401 })],
      ["forbidden", () => new Response(null, { status: 403 })],
      ["rate limited", () => new Response(null, { status: 429 })],
      ["vendor down", () => new Response(null, { status: 503 })],
      ["redirect", () => new Response(null, { status: 302 })],
      ["non-JSON", () => new Response("not json", { status: 200 })],
      ["unknown shape", () => Response.json({ models: "gpt-4o" })],
      ["over cap", () => Response.json({ data: [{ id: "x".repeat(70000) }] })],
      [
        "network throw",
        () => {
          throw new Error("socket reset");
        },
      ],
    ];
    for (const [name, handler] of cases) {
      const calls = remockVendor(handler);
      const failed = await worker.fetch(call(`/api/ai/profiles/${profile.id}/verify`, "POST", {}), keyed());
      expect(failed.status, name).toBe(502);
      const body = await failed.json();
      expect(body, name).toMatchObject({ verification: { ok: false, code: "AI_VERIFY_FAILED" } });
      expect(JSON.stringify(body), name).not.toContain(KEY_SENTINEL);
      // Each failure still ran exactly one bounded probe (presence-checked).
      expect(calls, name).toHaveLength(1);
    }
  });

  it("404s foreign profiles and disabled or unsafe Connections", async () => {
    const connection = await createConnection(OPENAI_INTEGRATION_ID);
    const profile = await createProfile(connection.id);
    const foreign = { ...bindings, LAB_ORG_ID: OTHER_ORG, LAB_USER_ID: OTHER_USER, OPENAI_API_KEY: KEY_SENTINEL };
    expect((await worker.fetch(call(`/api/ai/profiles/${profile.id}/verify`, "POST", {}), foreign)).status).toBe(404);
    await worker.fetch(call(`/api/connections/${OPENAI_INTEGRATION_ID}`, "PUT", { enabled: false }), bindings);
    const gated = await worker.fetch(call(`/api/ai/profiles/${profile.id}/verify`, "POST", {}), keyed());
    expect(gated.status).toBe(404);
    expect(await gated.json()).toMatchObject({ error: { code: "CONNECTION_DISABLED" } });
    await worker.fetch(call(`/api/connections/${OPENAI_INTEGRATION_ID}`, "PUT", { enabled: true }), bindings);
    // A row rewritten outside validation fails closed as invalid config.
    await bindings.DB.prepare("UPDATE connections SET endpoint=? WHERE id=?")
      .bind("http://127.0.0.1:8788/echo", connection.id)
      .run();
    const unsafe = await worker.fetch(call(`/api/ai/profiles/${profile.id}/verify`, "POST", {}), keyed());
    expect(unsafe.status).toBe(502);
    expect(await unsafe.json()).toMatchObject({ verification: { ok: false, code: "INVALID_CONNECTION" } });
    // Profiles written outside validation against a cross-org or non-AI
    // Connection fail the ownership/kind checks before any vendor contact.
    const echo = await createConnection(ECHO_INTEGRATION_ID, "http://127.0.0.1:8788/echo");
    const stranger = { ...bindings, LAB_ORG_ID: OTHER_ORG, LAB_USER_ID: OTHER_USER };
    await worker.fetch(
      call("/api/connections", "POST", { integrationId: OPENAI_INTEGRATION_ID, config: {} }),
      stranger,
    );
    const foreignRow = await bindings.DB.prepare("SELECT id FROM connections WHERE org_id=?")
      .bind(OTHER_ORG)
      .first<{ id: string }>();
    if (!foreignRow) throw new Error("missing foreign connection");
    const stamp = new Date().toISOString();
    for (const [id, connectionId, name, code, status] of [
      ["00000000-0000-4000-8000-000000000901", foreignRow.id, "ghost", "CONNECTION_NOT_FOUND", 404],
      ["00000000-0000-4000-8000-000000000902", echo.id, "wrong-kind", "AI_INVALID_PROFILE", 400],
    ] as [string, string, string, string, number][]) {
      await bindings.DB.prepare(
        "INSERT INTO ai_model_profiles(id,org_id,connection_id,name,model_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
      )
        .bind(id, ORG, connectionId, name, "ghost-model", stamp, stamp)
        .run();
      const refused = await worker.fetch(call(`/api/ai/profiles/${id}/verify`, "POST", {}), keyed());
      expect(refused.status).toBe(status);
      expect(await refused.json()).toMatchObject({ error: { code } });
    }
  });

  it("aborts a hanging vendor and maps transport throws, direct", async () => {
    expect(AI_VENDOR_TIMEOUT_MS).toBe(5000);
    const connection = await createConnection(OPENAI_INTEGRATION_ID);
    const profile = await createProfile(connection.id);
    const hanging = (async (_input: unknown, init?: { signal?: AbortSignal }) => {
      await new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const timedOut = await verifyProfile(
      bindings.DB,
      caller,
      profile.id,
      { OPENAI_API_KEY: KEY_SENTINEL },
      {
        fetchImpl: hanging,
        timeoutMs: 20,
      },
    );
    expect(timedOut).toMatchObject({ ok: false, code: "AI_VERIFY_FAILED" });
    const throwing = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const failed = await verifyProfile(
      bindings.DB,
      caller,
      profile.id,
      { OPENAI_API_KEY: KEY_SENTINEL },
      {
        fetchImpl: throwing,
      },
    );
    expect(failed).toMatchObject({ ok: false, code: "AI_VERIFY_FAILED" });
    const discovered = await discoverModels(
      bindings.DB,
      caller,
      OPENAI_INTEGRATION_ID,
      { OPENAI_API_KEY: KEY_SENTINEL },
      {
        fetchImpl: hanging,
        timeoutMs: 20,
      },
    );
    expect(discovered).toMatchObject({ ok: false, code: "AI_DISCOVERY_FAILED" });
  });

  it("speaks each provider's list target: path, auth, and shape", async () => {
    // Anthropic: Bearer-less x-api-key plus the version header.
    const anthropic = await createConnection(ANTHROPIC_INTEGRATION_ID);
    const claude = await createProfile(anthropic.id, { modelId: "claude-opus-4-6" }, "claude");
    const seenAnthropic = remockVendor((seen) => {
      if (seen.url === "https://api.anthropic.com/v1/models")
        return Response.json({ data: [{ id: "claude-opus-4-6" }] });
      throw new Error(`Unexpected outbound request: ${seen.url}`);
    });
    const verifiedAnthropic = await worker.fetch(call(`/api/ai/profiles/${claude.id}/verify`, "POST", {}), {
      ...bindings,
      ANTHROPIC_API_KEY: KEY_SENTINEL,
    });
    expect(await verifiedAnthropic.json()).toMatchObject({ verification: { ok: true, modelAvailable: true } });
    expect(seenAnthropic[0]?.headers["x-api-key"]).toBe(KEY_SENTINEL);
    expect(seenAnthropic[0]?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(seenAnthropic[0]?.headers["authorization"]).toBeUndefined();
    // Google: header key (never query) plus the models/name shape.
    const google = await createConnection(GOOGLE_INTEGRATION_ID);
    const gemini = await createProfile(google.id, { modelId: "gemini-2-5-pro" }, "gemini");
    const seenGoogle = remockVendor((seen) => {
      if (seen.url === "https://generativelanguage.googleapis.com/v1beta/models") {
        return Response.json({ models: [{ name: "models/gemini-2-5-pro" }] });
      }
      throw new Error(`Unexpected outbound request: ${seen.url}`);
    });
    const verifiedGoogle = await worker.fetch(call(`/api/ai/profiles/${gemini.id}/verify`, "POST", {}), {
      ...bindings,
      GOOGLE_API_KEY: KEY_SENTINEL,
    });
    expect(await verifiedGoogle.json()).toMatchObject({ verification: { ok: true, modelAvailable: true } });
    expect(seenGoogle[0]?.headers["x-goog-api-key"]).toBe(KEY_SENTINEL);
    expect(seenGoogle[0]?.url).not.toContain(KEY_SENTINEL);
    // OpenRouter: gateway subpath with Bearer [REDACTED]
    const openrouter = await createConnection(OPENROUTER_INTEGRATION_ID);
    const routed = await createProfile(openrouter.id, { modelId: "meta-llama/llama-4" }, "routed");
    const seenRouter = remockVendor((seen) => {
      if (seen.url === "https://openrouter.ai/api/v1/models") {
        return Response.json({ data: [{ id: "meta-llama/llama-4" }] });
      }
      throw new Error(`Unexpected outbound request: ${seen.url}`);
    });
    const verifiedRouter = await worker.fetch(call(`/api/ai/profiles/${routed.id}/verify`, "POST", {}), {
      ...bindings,
      OPENROUTER_API_KEY: KEY_SENTINEL,
    });
    expect(await verifiedRouter.json()).toMatchObject({ verification: { ok: true, modelAvailable: true } });
    expect(seenRouter[0]?.headers["authorization"]).toBe(`Bearer ${KEY_SENTINEL}`);
    // OpenAI-compatible: an endpoint already carrying /v1 is not doubled.
    const compat = await createConnection(OPENAI_COMPATIBLE_INTEGRATION_ID, "https://llm.example.com/v1");
    const local = await createProfile(compat.id, { modelId: "llama-local" }, "local");
    const seenCompat = remockVendor((seen) => {
      if (seen.url === "https://llm.example.com/v1/models") return Response.json({ data: [{ id: "llama-local" }] });
      throw new Error(`Unexpected outbound request: ${seen.url}`);
    });
    const verifiedCompat = await worker.fetch(call(`/api/ai/profiles/${local.id}/verify`, "POST", {}), {
      ...bindings,
      OPENAI_COMPATIBLE_API_KEY: KEY_SENTINEL,
    });
    expect(await verifiedCompat.json()).toMatchObject({ verification: { ok: true, modelAvailable: true } });
    expect(seenCompat).toHaveLength(1);
  });
});

describe("AI model discovery (issue #164)", () => {
  it("answers counts plus per-profile availability, never vendor ids or keys", async () => {
    const connection = await createConnection(OPENAI_INTEGRATION_ID);
    const listed = await createProfile(connection.id);
    const absent = await createProfile(connection.id, { enabledForChat: false, modelId: "gpt-zzz-absent" }, "absent");
    const discovered = await worker.fetch(call(`/api/ai/discover/${OPENAI_INTEGRATION_ID}`), {
      ...bindings,
      OPENAI_API_KEY: KEY_SENTINEL,
    });
    expect(discovered.status).toBe(200);
    const body = await discovered.json();
    expect(body).toMatchObject({
      discovery: {
        ok: true,
        connectionId: connection.id,
        integrationId: OPENAI_INTEGRATION_ID,
        modelCount: 2,
        profiles: [
          { profileId: absent.id, name: "absent", modelAvailable: false },
          { profileId: listed.id, name: "chat", modelAvailable: true },
        ],
      },
    });
    expect(JSON.stringify(body)).not.toContain(KEY_SENTINEL);
    expect(JSON.stringify(body)).not.toContain(MODEL_SENTINEL);
    expect(JSON.stringify(body)).not.toContain("gpt-4o");
  });

  it("requires the deployment key and maps vendor failures", async () => {
    const connection = await createConnection(OPENAI_INTEGRATION_ID);
    await createProfile(connection.id);
    const refused = await worker.fetch(call(`/api/ai/discover/${OPENAI_INTEGRATION_ID}`), bindings);
    expect(refused.status).toBe(502);
    expect(await refused.json()).toMatchObject({ discovery: { ok: false, code: "SECRET_NOT_CONFIGURED" } });
    expect(vendorCalls).toHaveLength(0);
    remockVendor(() => new Response(null, { status: 500 }));
    const down = await worker.fetch(call(`/api/ai/discover/${OPENAI_INTEGRATION_ID}`), {
      ...bindings,
      OPENAI_API_KEY: KEY_SENTINEL,
    });
    expect(down.status).toBe(502);
    expect(await down.json()).toMatchObject({ discovery: { ok: false, code: "AI_DISCOVERY_FAILED" } });
  });

  it("404s unknown, non-AI, missing, disabled, and unsafe Connections", async () => {
    await createConnection(OPENAI_INTEGRATION_ID);
    const keyed = { ...bindings, OPENAI_API_KEY: KEY_SENTINEL };
    for (const integrationId of ["00000000-0000-4000-8000-000000000099", ECHO_INTEGRATION_ID]) {
      const unknown = await worker.fetch(call(`/api/ai/discover/${integrationId}`), keyed);
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toMatchObject({ error: { code: "UNKNOWN_INTEGRATION" } });
    }
    const missing = await worker.fetch(call(`/api/ai/discover/${ANTHROPIC_INTEGRATION_ID}`), {
      ...bindings,
      ANTHROPIC_API_KEY: KEY_SENTINEL,
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "CONNECTION_NOT_FOUND" } });
    await worker.fetch(call(`/api/connections/${OPENAI_INTEGRATION_ID}`, "PUT", { enabled: false }), bindings);
    const gated = await worker.fetch(call(`/api/ai/discover/${OPENAI_INTEGRATION_ID}`), keyed);
    expect(gated.status).toBe(404);
    expect(await gated.json()).toMatchObject({ error: { code: "CONNECTION_DISABLED" } });
    await worker.fetch(call(`/api/connections/${OPENAI_INTEGRATION_ID}`, "PUT", { enabled: true }), bindings);
    await bindings.DB.prepare("UPDATE connections SET endpoint=? WHERE org_id=? AND integration_id=?")
      .bind("https://10.0.0.5/v1", ORG, OPENAI_INTEGRATION_ID)
      .run();
    const unsafe = await worker.fetch(call(`/api/ai/discover/${OPENAI_INTEGRATION_ID}`), keyed);
    expect(unsafe.status).toBe(502);
    expect(await unsafe.json()).toMatchObject({ discovery: { ok: false, code: "INVALID_CONNECTION" } });
  });
});

describe("AI domain hardening (issue #164)", () => {
  it("404s malformed ids without touching vendor state, direct", async () => {
    await expect(getProfile(bindings.DB, caller, "nope")).rejects.toMatchObject({ code: "AI_PROFILE_NOT_FOUND" });
    await expect(updateProfile(bindings.DB, caller, "nope", {})).rejects.toMatchObject({
      code: "AI_PROFILE_NOT_FOUND",
    });
    await expect(deleteProfile(bindings.DB, caller, "nope")).rejects.toMatchObject({ code: "AI_PROFILE_NOT_FOUND" });
    await expect(discoverModels(bindings.DB, caller, "nope", {}, {})).rejects.toMatchObject({
      code: "UNKNOWN_INTEGRATION",
    });
    expect(vendorCalls).toHaveLength(0);
  });
});

describe("AI vendor list primitives (issue #164)", () => {
  it("pins the per-provider targets and rejects unknown providers", () => {
    expect(vendorTarget("openai")).toMatchObject({ modelsPath: "/v1/models" });
    expect(vendorTarget("openai-compatible")).toMatchObject({ modelsPath: "/v1/models" });
    expect(vendorTarget("openrouter")).toMatchObject({ modelsPath: "/api/v1/models" });
    expect(vendorTarget("anthropic")).toMatchObject({ modelsPath: "/v1/models" });
    expect(vendorTarget("google")).toMatchObject({ modelsPath: "/v1beta/models" });
    expect(vendorTarget("openai").headers("k")).toEqual({ Accept: "application/json", Authorization: "Bearer k" });
    expect(() => vendorTarget("echo")).toThrow("No vendor model-list target");
  });

  it("joins list paths without doubling version prefixes or dropping subpaths", () => {
    expect(joinVendorListPath("https://api.openai.com", "/v1/models")).toBe("https://api.openai.com/v1/models");
    expect(joinVendorListPath("https://api.openai.com/", "/v1/models")).toBe("https://api.openai.com/v1/models");
    expect(joinVendorListPath("https://llm.example.com/v1", "/v1/models")).toBe("https://llm.example.com/v1/models");
    expect(joinVendorListPath("https://gw.example.com/api/v1/", "/api/v1/models")).toBe(
      "https://gw.example.com/api/v1/models",
    );
    expect(joinVendorListPath("https://g.example.com/v1beta", "/v1beta/models")).toBe(
      "https://g.example.com/v1beta/models",
    );
    expect(joinVendorListPath("https://tenant.example.com/openai", "/v1/models")).toBe(
      "https://tenant.example.com/openai/v1/models",
    );
    expect(joinVendorListPath("https://custom.example.com/models", "/v1/models")).toBe(
      "https://custom.example.com/models",
    );
  });

  it("collects OpenAI- and Google-shaped ids and fails closed on unknown shapes", () => {
    expect(collectVendorModelIds(null)).toBeNull();
    expect(collectVendorModelIds([])).toBeNull();
    expect(collectVendorModelIds("gpt-4o")).toBeNull();
    expect(collectVendorModelIds({})).toBeNull();
    expect(collectVendorModelIds({ data: "gpt-4o" })).toBeNull();
    expect(collectVendorModelIds({ data: [{ id: "a" }, null, 42, { id: "" }, { name: "models/b" }] })).toEqual([
      "a",
      "models/b",
      "b",
    ]);
    expect(collectVendorModelIds({ models: [{ name: "models/gemini-x" }] })).toEqual(["models/gemini-x", "gemini-x"]);
    const many = Array.from({ length: 1005 }, (_, i) => ({ id: `model-${i}` }));
    const collected = collectVendorModelIds({ data: many });
    expect(collected).not.toBeNull();
    expect(collected?.length).toBeLessThanOrEqual(1001);
    expect(collected?.slice(0, 2)).toEqual(["model-0", "model-1"]);
  });
});

describe("AI secret redaction and SDK contract (issue #164)", () => {
  it("keeps the deployment key out of every AI response and fault", async () => {
    const connection = await createConnection(OPENAI_INTEGRATION_ID);
    const profile = await createProfile(connection.id);
    const keyed = { ...bindings, OPENAI_API_KEY: KEY_SENTINEL };
    remockVendor(() => new Response(`keyed detail ${KEY_SENTINEL}`, { status: 401 }));
    const texts: string[] = [];
    for (const [path, method, body] of [
      ["/api/ai/profiles", "GET", undefined],
      [`/api/ai/profiles/${profile.id}`, "GET", undefined],
      [`/api/ai/profiles/${profile.id}`, "PUT", { name: "renamed" }],
      [`/api/ai/profiles/${profile.id}/verify`, "POST", {}],
      [`/api/ai/discover/${OPENAI_INTEGRATION_ID}`, "GET", undefined],
      ["/api/ai/assignments", "GET", undefined],
      ["/api/ai/resolve/primary", "GET", undefined],
      ["/api/ai/embedding", "GET", undefined],
      ["/api/ai/behavior", "GET", undefined],
      ["/api/ai/profiles", "POST", { name: "CHAT", connectionId: connection.id, modelId: "x" }],
      ["/api/ai/assignments/bogus", "PUT", { profileId: profile.id }],
      ["/api/ai/resolve/bogus", "GET", undefined],
      [`/api/ai/profiles/${profile.id}`, "DELETE", undefined],
    ] as [string, string, unknown][]) {
      const response = await worker.fetch(call(path, method, body), keyed);
      texts.push(JSON.stringify(await response.json()));
    }
    // A vendor body echoing the key still cannot ride the outcome: details
    // are fixed strings, and the route scrubs regardless.
    for (const text of texts) {
      expect(text).not.toContain(KEY_SENTINEL);
    }
    expect(texts.length).toBeGreaterThan(0);
  });

  it("keeps the SDK contract covering every AI route and code", () => {
    const descriptor = describeContract();
    expect(descriptor.capabilities.find((entry) => entry.name === "ai-model-profiles")?.status).toBe("supported");
    expect(descriptor.routes.map((route) => `${route.method} ${route.path}`)).toEqual(
      expect.arrayContaining([
        "GET /api/ai/profiles",
        "POST /api/ai/profiles",
        "GET /api/ai/profiles/:id",
        "PUT /api/ai/profiles/:id",
        "DELETE /api/ai/profiles/:id",
        "POST /api/ai/profiles/merge",
        "POST /api/ai/profiles/:id/verify",
        "GET /api/ai/discover/:integrationId",
        "GET /api/ai/assignments",
        "PUT /api/ai/assignments/:key",
        "GET /api/ai/resolve/:key",
        "GET /api/ai/embedding",
        "PUT /api/ai/embedding",
        "GET /api/ai/behavior",
        "PUT /api/ai/behavior",
      ]),
    );
    for (const code of [
      "AI_FORBIDDEN",
      "AI_INVALID_PROFILE",
      "AI_PROFILE_NOT_FOUND",
      "AI_PROFILE_EXISTS",
      "AI_PROFILE_REFERENCED",
      "AI_PROFILE_NOT_CHAT",
      "AI_CHAT_DEFAULT_HELD",
      "AI_INVALID_ASSIGNMENT",
      "AI_ASSIGNMENT_REQUIRED",
      "AI_ASSIGNMENT_UNRESOLVED",
      "AI_INVALID_MERGE",
      "AI_INVALID_EMBEDDING",
      "AI_INVALID_BEHAVIOR",
      "AI_VERIFY_FAILED",
      "AI_DISCOVERY_FAILED",
    ]) {
      expect(SDK_ERROR_CODES).toContain(code);
    }
  });
});
