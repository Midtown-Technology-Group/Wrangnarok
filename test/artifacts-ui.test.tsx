// SPDX-License-Identifier: AGPL-3.0
// Artifacts UI (FILE-02, issue #158): list/detail render from mocked
// /api/* payloads. Summaries carry no bytes; detail shows versions and
// attachment bindings. No byte content leaks into list rows.
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { fetchArtifactDetail, listArtifacts } from "../client/src/lib/api-client";
import type { ArtifactDetail, ArtifactsResponse } from "../client/src/lib/client-types";
import { ArtifactDetailView, ArtifactsList } from "../client/src/pages/Artifacts";

const ARTIFACT_ID = "11111111-1111-4111-8111-111111111111";

const listPayload: ArtifactsResponse = {
  artifacts: [
    {
      id: ARTIFACT_ID,
      name: "notes.md",
      mime: "text/markdown",
      sizeBytes: 4,
      version: 2,
      status: "active",
      createdAt: "2026-09-11T00:00:00.000Z",
      updatedAt: "2026-09-11T00:00:00.000Z",
    },
  ],
  hasMore: false,
};

const detailPayload: ArtifactDetail = {
  ...listPayload.artifacts[0]!,
  orgId: "00000000-0000-4000-8000-000000000001",
  creatorUserId: "00000000-0000-4000-8000-000000000002",
  deletedAt: null,
  versions: [
    { version: 1, mime: "text/markdown", sizeBytes: 4, createdAt: "2026-09-11T00:00:00.000Z" },
    { version: 2, mime: "text/markdown", sizeBytes: 4, createdAt: "2026-09-11T00:00:01.000Z" },
  ],
  bindings: [{ scope: "conversation", refId: "conv-1" }],
};

afterEach(() => {
  vi.restoreAllMocks();
});

it("renders Artifact rows with version and status, linking each detail", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ artifacts: listPayload.artifacts, hasMore: false }));
  const data = await listArtifacts();
  expect(data.artifacts).toHaveLength(1);
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <ArtifactsList initial={listPayload} />
    </MemoryRouter>,
  );
  expect(html).toContain("notes.md");
  expect(html).toContain("v2");
  expect(html).toContain(`/artifacts/${ARTIFACT_ID}`);
  expect(html).not.toContain("# v2");
});

it("renders Artifact detail with versions and attachment bindings", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ artifact: detailPayload }));
  const data = await fetchArtifactDetail(ARTIFACT_ID);
  expect(data.versions).toHaveLength(2);
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/artifacts/${ARTIFACT_ID}`]}>
      <Routes>
        <Route path="/artifacts/:id" element={<ArtifactDetailView initial={data} />} />
      </Routes>
    </MemoryRouter>,
  );
  expect(html).toContain("notes.md");
  expect(html).toContain("conversation:conv-1");
  expect(html).not.toContain("Loading artifact.");
});
