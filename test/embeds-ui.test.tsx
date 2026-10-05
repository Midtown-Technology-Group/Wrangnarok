// SPDX-License-Identifier: AGPL-3.0
// Signed form-embed grants UI (EMBED-01 slice 1, issue #156): the admin
// section calls the shaped /api/forms/:name/embeds routes, renders the
// inventory without secret material, and renders an issued secret exactly
// once with the plant-it warning. Server routes stay proven by
// test/embeds.test.ts against real local D1.
import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createFormEmbed, listFormEmbeds, rotateFormEmbed, revokeFormEmbed } from "../client/src/lib/api-client";
import type { EmbedGrantsResponse } from "../client/src/lib/client-types";
import { FormEmbedsSection, parseOriginsInput } from "../client/src/components/FormEmbeds";

const GRANT = "aaaaaaaa-0000-4000-8000-000000000001";
const REVOKED = "bbbbbbbb-0000-4000-8000-000000000002";
const SECRET = "c".repeat(64);

const grantsPayload: EmbedGrantsResponse = {
  embeds: [
    {
      id: GRANT,
      formName: "contact",
      allowedOrigins: ["https://portal.example.com"],
      fingerprint: "f".repeat(64),
      enabled: true,
      expiresAt: null,
      createdAt: "2026-09-17T00:00:00.000Z",
      rotatedAt: null,
      lastUsedAt: "2026-09-17T01:00:00.000Z",
    },
    {
      id: REVOKED,
      formName: "contact",
      allowedOrigins: ["https://old.example.com"],
      fingerprint: "e".repeat(64),
      enabled: false,
      expiresAt: "2027-01-01T00:00:00.000Z",
      createdAt: "2026-09-16T00:00:00.000Z",
      rotatedAt: "2026-09-16T01:00:00.000Z",
      lastUsedAt: null,
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

it("calls the embed admin routes with shaped payloads", async () => {
  const seen: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    seen.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "/api/forms/contact/embeds" && (init?.method ?? "GET") === "GET") {
      return Response.json(grantsPayload);
    }
    return Response.json({ grant: grantsPayload.embeds[0], secret: SECRET });
  });
  expect(await listFormEmbeds("contact")).toEqual(grantsPayload);
  expect(await createFormEmbed("contact", { allowedOrigins: ["https://portal.example.com"] })).toEqual({
    grant: grantsPayload.embeds[0],
    secret: SECRET,
  });
  expect(await rotateFormEmbed("contact", GRANT)).toEqual({ grant: grantsPayload.embeds[0], secret: SECRET });
  expect(await revokeFormEmbed("contact", GRANT)).toEqual({ grant: grantsPayload.embeds[0] });
  expect(seen).toEqual([
    "GET /api/forms/contact/embeds",
    "POST /api/forms/contact/embeds",
    `POST /api/forms/contact/embeds/${GRANT}/rotate`,
    `POST /api/forms/contact/embeds/${GRANT}/revoke`,
  ]);
});

it("rejects malformed embed payloads and IDs", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ embeds: [{ id: 42 }] }));
  await expect(listFormEmbeds("contact")).rejects.toThrow("Unexpected embed grants response shape.");
  await expect(listFormEmbeds("NOT A NAME")).rejects.toThrow("Unexpected form name shape.");
  await expect(rotateFormEmbed("contact", "not-a-uuid")).rejects.toThrow("Unexpected embed grant ID shape.");
});

it("renders the grant inventory without secret material", () => {
  const html = renderToStaticMarkup(<FormEmbedsSection formName="contact" initial={grantsPayload} />);
  expect(html).toContain("https://portal.example.com");
  expect(html).toContain("f".repeat(12));
  expect(html).toContain("Active");
  expect(html).toContain("Revoked");
  // Actions exist only for the live grant; the revoked row names no action.
  expect(html.match(/>Rotate</g)?.length ?? 0).toBe(1);
  expect(html.match(/>Revoke</g)?.length ?? 0).toBe(1);
  // No issued secret, no show-once block: summaries never carry secrets.
  expect(html).not.toContain(SECRET);
  expect(html).not.toContain("will not be shown again");
});

it("renders an issued secret exactly once with the plant-it warning", () => {
  const html = renderToStaticMarkup(
    <FormEmbedsSection formName="contact" initial={grantsPayload} initialIssued={{ grantId: GRANT, secret: SECRET }} />,
  );
  expect(html).toContain(SECRET);
  expect(html).toContain("will not be shown again");
  expect(html).toContain("Dismiss");
});

it("renders loading and empty states", () => {
  const loading = renderToStaticMarkup(<FormEmbedsSection formName="contact" />);
  expect(loading).toContain("Loading embed grants…");
  const empty = renderToStaticMarkup(<FormEmbedsSection formName="contact" initial={{ embeds: [] }} />);
  expect(empty).toContain("No embed grants yet.");
});

it("parses origins input on commas, spaces, and newlines", () => {
  expect(parseOriginsInput("")).toEqual([]);
  expect(parseOriginsInput("  ,\n ")).toEqual([]);
  expect(parseOriginsInput("https://a.example.com")).toEqual(["https://a.example.com"]);
  expect(parseOriginsInput("https://a.example.com, https://b.example.com\nhttp://localhost:3000")).toEqual([
    "https://a.example.com",
    "https://b.example.com",
    "http://localhost:3000",
  ]);
});
