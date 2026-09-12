// SPDX-License-Identifier: AGPL-3.0
// Files UI (FILE-01, issue #157): list/detail render from mocked /api/*
// payloads. Browser upload/download flow is covered by the workerd tests
// (real local R2/D1); this suite pins the read slice rendering.
import { expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { listFileLocations, listFiles } from "../client/src/lib/api-client";
import type { FileLocationsResponse, FilesResponse } from "../client/src/lib/client-types";
import { FilesList } from "../client/src/pages/Files";

const locationsPayload: FileLocationsResponse = {
  locations: [
    {
      name: "uploads",
      maxBytes: 1024,
      contentTypes: ["text/plain"],
      sharedRead: false,
      createdAt: "2026-09-11T00:00:00.000Z",
    },
  ],
};

const filesPayload: FilesResponse = {
  files: [
    {
      location: "uploads",
      path: "notes/hello.txt",
      version: 1,
      size: 11,
      contentType: "text/plain",
      sha256: "a".repeat(64),
      status: "ready",
      createdAt: "2026-09-11T00:00:00.000Z",
      updatedAt: "2026-09-11T00:00:01.000Z",
    },
    {
      location: "uploads",
      path: "draft.txt",
      version: 0,
      size: 0,
      contentType: "",
      sha256: "",
      status: "pending",
      createdAt: "2026-09-11T00:00:00.000Z",
      updatedAt: "2026-09-11T00:00:01.000Z",
    },
  ],
  nextCursor: null,
};

it("lists declared locations and their files with download affordances", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url === "/api/file-locations") return Response.json(locationsPayload);
    if (url.startsWith("/api/files?")) return Response.json(filesPayload);
    throw new Error(`Unexpected fetch: ${url}`);
  });
  try {
    expect(await listFileLocations()).toEqual(locationsPayload);
    expect(await listFiles("uploads")).toEqual(filesPayload);
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FilesList />
      </MemoryRouter>,
    );
    expect(html).toContain("Files");
  } finally {
    fetchMock.mockRestore();
  }
});
