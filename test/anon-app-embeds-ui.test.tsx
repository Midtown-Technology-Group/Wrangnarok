// SPDX-License-Identifier: AGPL-3.0
// Slice-2 admin UX (EMBED-01 slice 2, issue #156): the app-embed section
// calls the shaped /api/apps/:id/embeds routes, renders the inventory
// without secret material, and renders an issued secret exactly once with
// the plant-it warning; the publication section calls the shaped
// /api/forms/:name/publication routes and renders the staleness-gated
// review action. Server routes stay proven by test/app-embeds.test.ts and
// test/form-publication.test.ts against real local D1.
import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createAppEmbed,
  getFormPublication,
  listAppEmbeds,
  publishForm,
  reviewPublication,
  revokeAppEmbed,
  rotateAppEmbed,
  unpublishForm,
} from "../client/src/lib/api-client";
import type { AppEmbedGrantsResponse, FormPublicationResponse } from "../client/src/lib/client-types";
import { AppEmbedsSection } from "../client/src/components/AppEmbeds";
import { FormPublicationSection } from "../client/src/components/FormPublication";

const APP_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const GRANT = "bbbbbbbb-0000-4000-8000-000000000002";
const SECRET = "c".repeat(64);

const appGrants: AppEmbedGrantsResponse = {
  embeds: [
    {
      id: GRANT,
      appSlug: "hello-app",
      allowedOrigins: ["https://portal.example.com"],
      fingerprint: "f".repeat(64),
      enabled: true,
      expiresAt: null,
      createdAt: "2026-09-17T00:00:00.000Z",
      rotatedAt: null,
      lastUsedAt: null,
    },
  ],
};

const PUB_ID = "cccccccc-0000-4000-8000-000000000003";

const livePublication: FormPublicationResponse = {
  publication: {
    id: PUB_ID,
    formName: "contact",
    honeypotField: "wrangnarok_hp",
    fingerprint: "f".repeat(64),
    enabled: true,
    stale: false,
    createdAt: "2026-09-17T00:00:00.000Z",
    reviewedAt: null,
    lastUsedAt: null,
  },
};

const stalePublication: FormPublicationResponse = {
  publication: {
    ...livePublication.publication!,
    stale: true,
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

it("calls the app-embed admin routes with shaped payloads", async () => {
  const seen: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    seen.push(`${init?.method ?? "GET"} ${url}`);
    if (url === `/api/apps/${APP_ID}/embeds` && (init?.method ?? "GET") === "GET") {
      return Response.json(appGrants);
    }
    return Response.json({ grant: appGrants.embeds[0], secret: SECRET });
  });
  expect(await listAppEmbeds(APP_ID)).toEqual(appGrants);
  expect(await createAppEmbed(APP_ID, { allowedOrigins: ["https://portal.example.com"] })).toEqual({
    grant: appGrants.embeds[0],
    secret: SECRET,
  });
  expect(await rotateAppEmbed(APP_ID, GRANT)).toEqual({ grant: appGrants.embeds[0], secret: SECRET });
  expect(await revokeAppEmbed(APP_ID, GRANT)).toEqual({ grant: appGrants.embeds[0] });
  expect(seen).toEqual([
    `GET /api/apps/${APP_ID}/embeds`,
    `POST /api/apps/${APP_ID}/embeds`,
    `POST /api/apps/${APP_ID}/embeds/${GRANT}/rotate`,
    `POST /api/apps/${APP_ID}/embeds/${GRANT}/revoke`,
  ]);
});

it("rejects malformed app-embed payloads and IDs", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ embeds: [{ id: 42 }] }));
  await expect(listAppEmbeds(APP_ID)).rejects.toThrow("Unexpected app embed grants response shape.");
  await expect(listAppEmbeds("not-a-uuid")).rejects.toThrow("Unexpected app ID shape.");
  await expect(rotateAppEmbed(APP_ID, "not-a-uuid")).rejects.toThrow("Unexpected embed grant ID shape.");
});

it("renders the app grant inventory without secret material", () => {
  const html = renderToStaticMarkup(<AppEmbedsSection appId={APP_ID} initial={appGrants} />);
  expect(html).toContain("https://portal.example.com");
  expect(html).toContain("f".repeat(12));
  expect(html).toContain("Active");
  expect(html).not.toContain(SECRET);
  expect(html).not.toContain("will not be shown again");
});

it("calls the publication admin routes with shaped payloads", async () => {
  const seen: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    seen.push(`${init?.method ?? "GET"} ${url}`);
    return Response.json(livePublication);
  });
  expect(await getFormPublication("contact")).toEqual(livePublication);
  expect(await publishForm("contact", {})).toEqual(livePublication);
  expect(await reviewPublication("contact")).toEqual(livePublication);
  expect(await unpublishForm("contact")).toEqual(livePublication);
  expect(seen).toEqual([
    "GET /api/forms/contact/publication",
    "POST /api/forms/contact/publication",
    "POST /api/forms/contact/publication/review",
    "DELETE /api/forms/contact/publication",
  ]);
});

it("rejects malformed publication payloads", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ publication: { id: 42 } }));
  await expect(getFormPublication("contact")).rejects.toThrow("Unexpected publication response shape.");
  await expect(getFormPublication("NOT A NAME")).rejects.toThrow("Unexpected form name shape.");
});

it("renders the publication states and gates review on staleness", () => {
  const empty = renderToStaticMarkup(<FormPublicationSection formName="contact" initial={{ publication: null }} />);
  expect(empty).toContain("Not published.");
  const live = renderToStaticMarkup(<FormPublicationSection formName="contact" initial={livePublication} />);
  expect(live).toContain("Live");
  expect(live).toContain("wrangnarok_hp");
  expect(live).not.toContain("Review and re-bind");
  expect(live).toContain("Block publication");
  const stale = renderToStaticMarkup(<FormPublicationSection formName="contact" initial={stalePublication} />);
  expect(stale).toContain("Stale — review required");
  expect(stale).toContain("Review and re-bind");
  const loading = renderToStaticMarkup(<FormPublicationSection formName="contact" />);
  expect(loading).toContain("Loading publication…");
});
