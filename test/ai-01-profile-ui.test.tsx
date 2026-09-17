// SPDX-License-Identifier: AGPL-3.0
// AI profiles UI (AI-01, issue #164): identities-only list/detail render
// from mocked /api/ai/* payloads. Provider model ids and deployment keys
// never appear in any payload or render — the server excludes them, and the
// page has no field that could show them.
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import {
  getAiBehavior,
  getAiEmbedding,
  listAiAssignments,
  listAiProfiles,
  resolveAiAssignment,
  setAiAssignment,
} from "../client/src/lib/api-client";
import type {
  AiAssignmentsResponse,
  AiBehaviorResponse,
  AiEmbeddingResponse,
  AiProfilesResponse,
} from "../client/src/lib/client-types";
import { AiProfilesList } from "../client/src/pages/AiProfiles";
import { OPENAI_INTEGRATION_ID } from "../src/domain";

const PROFILE_ID = "00000000-0000-4000-8000-000000000901";
const CONNECTION_ID = "00000000-0000-4000-8000-000000000801";

const profilesPayload: AiProfilesResponse = {
  profiles: [
    {
      id: PROFILE_ID,
      name: "Everyday",
      connectionId: CONNECTION_ID,
      integrationId: OPENAI_INTEGRATION_ID,
      integrationName: "openai",
      enabledForChat: true,
      capabilities: { vision: true },
      capabilityState: "supported",
      openaiTransport: null,
      createdAt: "2026-09-17T00:00:00.000Z",
      updatedAt: "2026-09-17T00:00:00.000Z",
    },
    {
      id: "00000000-0000-4000-8000-000000000902",
      name: "Quiet",
      connectionId: CONNECTION_ID,
      integrationId: OPENAI_INTEGRATION_ID,
      integrationName: "openai",
      enabledForChat: false,
      capabilities: {},
      capabilityState: "unknown",
      openaiTransport: "responses",
      createdAt: "2026-09-17T00:00:00.000Z",
      updatedAt: "2026-09-17T00:00:00.000Z",
    },
  ],
};

const assignmentsPayload: AiAssignmentsResponse = {
  assignments: [
    { key: "primary", profile: profilesPayload.profiles[0] ?? null, updatedAt: "2026-09-17T00:00:00.000Z" },
    { key: "tuning", profile: null, updatedAt: null },
  ],
};

const embeddingPayload: AiEmbeddingResponse = {
  embedding: {
    connectionId: CONNECTION_ID,
    integrationId: OPENAI_INTEGRATION_ID,
    integrationName: "openai",
    dimensions: 1536,
    updatedAt: "2026-09-17T00:00:00.000Z",
  },
};

const behaviorPayload: AiBehaviorResponse = {
  behavior: { defaultSystemPrompt: "You are a helpful operator assistant.", updatedAt: "2026-09-17T00:00:00.000Z" },
};

afterEach(() => {
  vi.restoreAllMocks();
});

it("renders profile identities, assignments, and singletons without model ids or keys", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ profiles: profilesPayload.profiles }))
    .mockResolvedValueOnce(Response.json({ assignments: assignmentsPayload.assignments }))
    .mockResolvedValueOnce(Response.json({ embedding: embeddingPayload.embedding }))
    .mockResolvedValueOnce(Response.json({ behavior: behaviorPayload.behavior }));
  const profiles = await listAiProfiles();
  expect(profiles.profiles).toHaveLength(2);
  const assignments = await listAiAssignments();
  expect(assignments.assignments).toHaveLength(2);
  const embedding = await getAiEmbedding();
  expect(embedding.embedding?.dimensions).toBe(1536);
  const behavior = await getAiBehavior();
  expect(behavior.behavior?.defaultSystemPrompt).toContain("helpful operator");

  const html = renderToStaticMarkup(
    <MemoryRouter>
      <AiProfilesList initial={{ profiles, assignments, embedding, behavior }} />
    </MemoryRouter>,
  );
  expect(html).toContain("Everyday");
  expect(html).toContain("Quiet");
  expect(html).toContain("primary");
  expect(html).toContain("unmapped");
  expect(html).toContain("1536 dimensions");
  expect(html).toContain("helpful operator");
  expect(html).toContain("never shown here");
  // Identities only: no provider model id, no key material, no key-shaped
  // field names anywhere in the payloads or the render.
  for (const text of [JSON.stringify(profiles), JSON.stringify(assignments), JSON.stringify(embedding), html]) {
    expect(text).not.toMatch(/gpt-|claude|gemini|api[_-]?key|MODEL_SENTINEL/i);
    expect(text).not.toContain("modelId");
    expect(text).not.toContain("model_id");
  }
});

it("resolves assignments and guards malformed AI payloads", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ resolution: { key: "primary", profile: profilesPayload.profiles[0] } }))
    .mockResolvedValueOnce(
      Response.json({ assignment: { key: "tuning", profile: profilesPayload.profiles[1], updatedAt: "now" } }),
    );
  const resolved = await resolveAiAssignment("primary");
  expect(resolved.resolution.profile.name).toBe("Everyday");
  const assigned = await setAiAssignment("tuning", "00000000-0000-4000-8000-000000000902");
  expect(assigned.assignment.key).toBe("tuning");
  await expect(resolveAiAssignment("bogus")).rejects.toThrow("assignment key");
  await expect(setAiAssignment("bogus", null)).rejects.toThrow("assignment key");
  await expect(setAiAssignment("tuning", "not-a-uuid")).rejects.toThrow("profile ID");
  vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ profiles: [{ id: 42 }] }));
  await expect(listAiProfiles()).rejects.toThrow("profiles response shape");
  vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ assignments: [{ key: 42 }] }));
  await expect(listAiAssignments()).rejects.toThrow("assignments response shape");
  vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ embedding: { dimensions: "many" } }));
  await expect(getAiEmbedding()).rejects.toThrow("embedding response shape");
  vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ behavior: { defaultSystemPrompt: 42 } }));
  await expect(getAiBehavior()).rejects.toThrow("behavior response shape");
});
