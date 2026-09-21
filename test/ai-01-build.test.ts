// SPDX-License-Identifier: AGPL-3.0
// AI-01 build slice (issue #164, ADR 032): five provider registry
// definitions plus migration 0028 DDL. Runs in real workerd with a real D1
// binding (migrations 0001-0002 plus 0028); no vendor HTTP on this path.
// Pins: registry identities/defaults/secrets, endpoint policy arms, DDL
// shape (profiles, assignments, embedding, behavior), and the Connection
// reachability probe for AI providers.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/bindings";
import {
  ANTHROPIC_INTEGRATION_ID,
  GOOGLE_INTEGRATION_ID,
  OPENAI_COMPATIBLE_INTEGRATION_ID,
  OPENAI_INTEGRATION_ID,
  OPENROUTER_INTEGRATION_ID,
} from "../src/domain";
import {
  INTEGRATION_DEFINITIONS,
  anthropicIntegrationDef,
  googleIntegrationDef,
  integrationById,
  integrationByName,
  openaiCompatibleIntegrationDef,
  openaiIntegrationDef,
  openrouterIntegrationDef,
  validateConnectionConfig,
} from "../src/integrations";
import { testConnection } from "../src/connections";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration4 from "../migrations/0004_solutions_install.sql?raw";
import migration7 from "../migrations/0007_org_membership.sql?raw";
import migration11 from "../migrations/0011_connection_admin.sql?raw";
import migration28 from "../migrations/0028_ai_profiles.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const ORG = "00000000-0000-4000-8000-000000000001";
const CALLER = { orgId: ORG, userId: "00000000-0000-4000-8000-000000000002" };

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(seed);
  await bindings.DB.exec(migration4);
  await bindings.DB.exec(migration7);
  await bindings.DB.exec(migration11);
  await bindings.DB.exec(migration28);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

async function createAiConnection(integrationId: string, endpoint: string): Promise<string> {
  const id = crypto.randomUUID().toLowerCase();
  await bindings.DB.prepare("INSERT INTO connections(id,org_id,integration_id,endpoint) VALUES (?,?,?,?)")
    .bind(id, ORG, integrationId, endpoint)
    .run();
  return id;
}

describe("AI-01 provider registry (issue #164)", () => {
  it("registers five provider definitions with stable identities", () => {
    expect(INTEGRATION_DEFINITIONS).toHaveLength(9);
    expect(integrationById(OPENAI_INTEGRATION_ID)).toBe(openaiIntegrationDef);
    expect(integrationById(ANTHROPIC_INTEGRATION_ID)).toBe(anthropicIntegrationDef);
    expect(integrationById(GOOGLE_INTEGRATION_ID)).toBe(googleIntegrationDef);
    expect(integrationById(OPENROUTER_INTEGRATION_ID)).toBe(openrouterIntegrationDef);
    expect(integrationById(OPENAI_COMPATIBLE_INTEGRATION_ID)).toBe(openaiCompatibleIntegrationDef);
    expect(integrationByName("openai")).toBe(openaiIntegrationDef);
    expect(integrationByName("OPENAI-COMPATIBLE")).toBe(openaiCompatibleIntegrationDef);
  });

  it("declares deployment-global apiKey secrets with provider env vars", () => {
    for (const def of [
      openaiIntegrationDef,
      anthropicIntegrationDef,
      googleIntegrationDef,
      openrouterIntegrationDef,
      openaiCompatibleIntegrationDef,
    ]) {
      expect(def.secretFields).toEqual(["apiKey"]);
      expect(def.requiredSecrets).toEqual(["apiKey"]);
      expect(Object.keys(def.secretEnvVars)).toEqual(["apiKey"]);
      expect(def.secretEnvVars.apiKey).toMatch(/_API_KEY$/);
    }
    expect(openaiIntegrationDef.secretEnvVars.apiKey).toBe("OPENAI_API_KEY");
    expect(openaiCompatibleIntegrationDef.secretEnvVars.apiKey).toBe("OPENAI_COMPATIBLE_API_KEY");
  });

  it("applies per-provider default endpoints except openai-compatible", () => {
    expect(validateConnectionConfig(openaiIntegrationDef, {})).toMatchObject({
      endpoint: "https://api.openai.com",
    });
    expect(validateConnectionConfig(anthropicIntegrationDef, {})).toMatchObject({
      endpoint: "https://api.anthropic.com",
    });
    expect(validateConnectionConfig(googleIntegrationDef, {})).toMatchObject({
      endpoint: "https://generativelanguage.googleapis.com",
    });
    expect(validateConnectionConfig(openrouterIntegrationDef, {})).toMatchObject({
      endpoint: "https://openrouter.ai",
    });
    // openai-compatible has no default: an explicit origin is required.
    expect(() => validateConnectionConfig(openaiCompatibleIntegrationDef, {})).toThrow();
    expect(
      validateConnectionConfig(openaiCompatibleIntegrationDef, { endpoint: "https://llm.example.com/v1" }),
    ).toMatchObject({ endpoint: "https://llm.example.com/v1" });
  });

  it("rejects non-https and loopback provider endpoints", () => {
    expect(() => validateConnectionConfig(openaiIntegrationDef, { endpoint: "http://api.openai.com" })).toThrow();
    expect(() => validateConnectionConfig(openaiIntegrationDef, { endpoint: "http://127.0.0.1:8788/echo" })).toThrow();
    expect(() =>
      validateConnectionConfig(openaiCompatibleIntegrationDef, { endpoint: "https://10.0.0.5/v1" }),
    ).toThrow();
  });

  it("pins standard providers to their canonical credential hosts", () => {
    expect(() =>
      validateConnectionConfig(openaiIntegrationDef, { endpoint: "https://attacker.example/collect" }),
    ).toThrow();
    expect(() =>
      validateConnectionConfig(openaiIntegrationDef, { endpoint: "https://evil-api.openai.com/v1" }),
    ).toThrow();
    expect(validateConnectionConfig(openaiIntegrationDef, { endpoint: "https://api.openai.com/v1" })).toMatchObject({
      endpoint: "https://api.openai.com/v1",
    });
  });
});

describe("AI-01 migration 0028 DDL (issue #164)", () => {
  it("creates profiles, assignments, embedding, and behavior tables", async () => {
    const tables = await bindings.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ai_model_profiles','ai_assignments','ai_embedding_config','ai_behavior') ORDER BY name",
    ).all<{ name: string }>();
    expect(tables.results.map((row) => row.name)).toEqual([
      "ai_assignments",
      "ai_behavior",
      "ai_embedding_config",
      "ai_model_profiles",
    ]);
    // DDL shape pins the upstream lifecycle guards: RESTRICT deletes on
    // profile/assignment references (D1 does not enforce FKs, so the build
    // slice owns the guards in code) and the six-key CHECK on assignments.
    const ddl = await bindings.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name IN ('ai_model_profiles','ai_assignments') ORDER BY name",
    ).all<{ sql: string }>();
    const dumped = ddl.results.map((row) => row.sql).join("\n");
    expect(dumped).toContain("ON DELETE RESTRICT");
    expect(dumped).toContain("UNIQUE(org_id, name)");
    for (const key of ["primary", "summarization", "tuning", "image_generation", "video_generation", "chat_default"]) {
      expect(dumped).toContain(`'${key}'`);
    }
  });

  it("enforces the six assignment keys and per-org profile names", async () => {
    const stamp = new Date().toISOString();
    const connectionId = await createAiConnection(OPENAI_INTEGRATION_ID, "https://api.openai.com");
    const profileId = "00000000-0000-4000-8000-000000000902";
    await bindings.DB.prepare(
      "INSERT INTO ai_model_profiles(id,org_id,connection_id,name,model_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    )
      .bind(profileId, ORG, connectionId, "chat", "gpt-4o", stamp, stamp)
      .run();
    // UNIQUE(org_id, name) with NOCASE rejects the duplicate (D1-enforced,
    // upstream CI-unique).
    await expect(
      bindings.DB.prepare(
        "INSERT INTO ai_model_profiles(id,org_id,connection_id,name,model_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
      )
        .bind("00000000-0000-4000-8000-000000000903", ORG, connectionId, "CHAT", "gpt-4o-mini", stamp, stamp)
        .run(),
    ).rejects.toThrow();
    // Unknown assignment key rejects at the CHECK (D1-enforced).
    await expect(
      bindings.DB.prepare("INSERT INTO ai_assignments(org_id,assignment_key,profile_id,updated_at) VALUES (?,?,?,?)")
        .bind(ORG, "nonsense", profileId, stamp)
        .run(),
    ).rejects.toThrow();
    // Known keys persist; the same key twice rejects on the PK.
    await bindings.DB.prepare(
      "INSERT INTO ai_assignments(org_id,assignment_key,profile_id,updated_at) VALUES (?,?,?,?)",
    )
      .bind(ORG, "primary", profileId, stamp)
      .run();
    await expect(
      bindings.DB.prepare("INSERT INTO ai_assignments(org_id,assignment_key,profile_id,updated_at) VALUES (?,?,?,?)")
        .bind(ORG, "primary", profileId, stamp)
        .run(),
    ).rejects.toThrow();
  });

  it("keeps embedding config and behavior rows org-scoped singletons", async () => {
    const stamp = new Date().toISOString();
    const connectionId = await createAiConnection(ANTHROPIC_INTEGRATION_ID, "https://api.anthropic.com");
    await bindings.DB.prepare(
      "INSERT INTO ai_embedding_config(org_id,connection_id,model_id,dimensions,updated_at) VALUES (?,?,?,?,?)",
    )
      .bind(ORG, connectionId, "voyage-3", 1024, stamp)
      .run();
    await bindings.DB.prepare("INSERT INTO ai_behavior(org_id,default_system_prompt,updated_at) VALUES (?,?,?)")
      .bind(ORG, "You are a helpful operator assistant.", stamp)
      .run();
    const embedding = await bindings.DB.prepare("SELECT model_id,dimensions FROM ai_embedding_config WHERE org_id=?")
      .bind(ORG)
      .first<{ model_id: string; dimensions: number }>();
    expect(embedding).toMatchObject({ model_id: "voyage-3", dimensions: 1024 });
    // Second singleton row for the same org rejects on the PK.
    await expect(
      bindings.DB.prepare("INSERT INTO ai_behavior(org_id,default_system_prompt,updated_at) VALUES (?,?,?)")
        .bind(ORG, "Other prompt.", stamp)
        .run(),
    ).rejects.toThrow();
  });
});

describe("AI-01 provider connection probe (issue #164)", () => {
  it("presence-checks the deployment key before any vendor contact", async () => {
    await createAiConnection(OPENAI_INTEGRATION_ID, "https://api.openai.com");
    let calls = 0;
    const probe = (async () => {
      calls += 1;
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const result = await testConnection(bindings.DB, CALLER, OPENAI_INTEGRATION_ID, {}, { fetchImpl: probe });
    expect(result).toMatchObject({ ok: false, code: "SECRET_NOT_CONFIGURED" });
    expect(calls).toBe(0);
  });

  it("proves origin reachability without sending the key", async () => {
    await createAiConnection(OPENROUTER_INTEGRATION_ID, "https://openrouter.ai");
    const seen: string[] = [];
    const probe = (async (input: unknown, init?: unknown) => {
      const url = input instanceof Request ? input.url : String(input);
      const request = input instanceof Request ? input : new Request(url, init as RequestInit);
      seen.push(request.headers.get("Authorization") ?? "");
      return new Response(null, { status: 401 });
    }) as typeof fetch;
    const result = await testConnection(
      bindings.DB,
      CALLER,
      OPENROUTER_INTEGRATION_ID,
      { OPENROUTER_API_KEY: "provider-global-sentinel" },
      { fetchImpl: probe },
    );
    expect(result).toMatchObject({ ok: true });
    // The key never rides the probe: no Authorization header at all.
    expect(seen).toEqual([""]);
  });

  it("fails closed on 5xx provider origins", async () => {
    await createAiConnection(GOOGLE_INTEGRATION_ID, "https://generativelanguage.googleapis.com");
    const down = (async () => new Response(null, { status: 503 })) as typeof fetch;
    const result = await testConnection(
      bindings.DB,
      CALLER,
      GOOGLE_INTEGRATION_ID,
      { GOOGLE_API_KEY: "provider-global-sentinel" },
      { fetchImpl: down },
    );
    expect(result).toMatchObject({ ok: false, code: "CONNECTION_TEST_FAILED" });
  });
});
