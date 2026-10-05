// SPDX-License-Identifier: AGPL-3.0
// Branding + own-profile UI (UX-01 slice 1, issue #176): settings pages
// render from mocked /api/* payloads, uploads ride the authorized image
// routes, the public branding read sends no token, and the shell header
// applies loaded branding with a static fallback. Server routes stay proven
// by test/branding-profile.test.ts against real local D1/R2.
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import {
  deleteAvatar,
  deleteLogo,
  downloadAvatar,
  fetchBranding,
  fetchCaller,
  fetchProfile,
  fetchPublicBranding,
  resetBranding,
  updateBranding,
  updateProfile,
  uploadAvatar,
  uploadLogo,
} from "../client/src/lib/api-client";
import { ApiError, getErrorMessage } from "../client/src/lib/api-error";
import type { BrandingResponse, CallerResponse, ProfileResponse } from "../client/src/lib/client-types";
import { Nav } from "../client/src/components/Nav";
import {
  applyBrandingToDocument,
  BRAND_CONTRAST_FLOOR,
  brandContrastChecks,
  contrastRatioHex,
  DEFAULT_DOCUMENT_TITLE,
  formatContrastRatio,
  parseBrandHex,
} from "../client/src/lib/brand-contrast";
import { BrandingAdmin, LOGO_MAX_BYTES, LOGO_MIME_ALLOWLIST, publicLogoUrl } from "../client/src/pages/Branding";
import { applyTheme, AVATAR_MAX_BYTES, AVATAR_MIME_ALLOWLIST, OwnProfile } from "../client/src/pages/Profile";

const ORG = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000002";

const brandingPayload: BrandingResponse = {
  branding: {
    orgId: ORG,
    appName: "Acme Realm",
    primaryColor: "#112233",
    accentColor: "#445566",
    logo: { contentType: "image/png", sizeBytes: 41, sha256: "d".repeat(64) },
    updatedAt: "2026-09-17T00:00:00.000Z",
  },
};

const plainBranding: BrandingResponse = {
  branding: {
    orgId: ORG,
    appName: "Wrangnarok",
    primaryColor: "#F45D0B",
    accentColor: "#F59E0B",
    logo: null,
    updatedAt: null,
  },
};

const profilePayload: ProfileResponse = {
  profile: {
    orgId: ORG,
    userId: USER,
    displayName: "Ada Lovelace",
    theme: "dark",
    avatar: { contentType: "image/png", sizeBytes: 41, sha256: "e".repeat(64) },
    updatedAt: "2026-09-17T00:00:00.000Z",
  },
};

const callerPayload: CallerResponse = {
  caller: { userId: USER, orgId: ORG, credentialClass: "fixture", viaAccess: false, fixture: true },
  role: "admin",
  kind: "ordinary",
};

afterEach(() => {
  vi.restoreAllMocks();
});

it("calls the branding routes with shaped payloads", async () => {
  const seen: { url: string; method: string; contentType: string | null; auth: boolean }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const headers = new Headers(init?.headers);
    seen.push({
      url: String(input),
      method: init?.method ?? "GET",
      contentType: headers.get("Content-Type"),
      auth: headers.has("Authorization"),
    });
    return Response.json(brandingPayload);
  });
  expect(await fetchBranding()).toEqual(brandingPayload);
  expect(await updateBranding({ appName: "Acme Realm" })).toEqual(brandingPayload);
  expect(await resetBranding()).toEqual(brandingPayload);
  expect(await uploadLogo(new Uint8Array([1, 2, 3]), "image/png")).toEqual(brandingPayload);
  expect(await deleteLogo()).toEqual(brandingPayload);
  expect(seen.map((call) => `${call.method} ${call.url}`)).toEqual([
    "GET /api/branding",
    "PUT /api/branding",
    "POST /api/branding/reset",
    "PUT /api/branding/logo",
    "DELETE /api/branding/logo",
  ]);
  expect(seen[3]?.contentType).toBe("image/png");
});

it("calls the profile routes with shaped payloads", async () => {
  const seen: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    seen.push(`${method} ${url}`);
    if (url.endsWith("/api/profile/avatar") && method === "GET") {
      return new Response(new Uint8Array([9, 9]), { headers: { "Content-Type": "image/png" } });
    }
    return Response.json(profilePayload);
  });
  expect(await fetchProfile()).toEqual(profilePayload);
  expect(await updateProfile({ theme: "dark" })).toEqual(profilePayload);
  expect(await uploadAvatar(new Uint8Array([1, 2, 3]), "image/png")).toEqual(profilePayload);
  expect(await deleteAvatar()).toEqual(profilePayload);
  expect(await (await downloadAvatar()).arrayBuffer()).toEqual(new Uint8Array([9, 9]).buffer);
  expect(seen).toEqual([
    "GET /api/profile",
    "PUT /api/profile",
    "PUT /api/profile/avatar",
    "DELETE /api/profile/avatar",
    "GET /api/profile/avatar",
  ]);
});

it("reads public branding without sending a credential", async () => {
  let authSent = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    authSent = new Headers(init?.headers).has("Authorization");
    expect(String(input)).toBe(`/api/branding/public/${ORG}`);
    return Response.json(brandingPayload);
  });
  expect(await fetchPublicBranding(ORG)).toEqual(brandingPayload);
  expect(authSent).toBe(false);
  await expect(fetchPublicBranding("not-a-uuid")).rejects.toThrow("Unexpected Organization ID shape.");
});

it("fetches the caller identity for the admin affordance cue", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(callerPayload));
  expect(await fetchCaller()).toEqual(callerPayload);
});

it("rejects malformed branding/profile/caller payloads", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ branding: { appName: 42 } }));
  await expect(fetchBranding()).rejects.toThrow("Unexpected branding response shape.");
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ profile: { theme: "neon" } }));
  await expect(fetchProfile()).rejects.toThrow("Unexpected profile response shape.");
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ caller: null, role: "super" }));
  await expect(fetchCaller()).rejects.toThrow("Unexpected caller response shape.");
});

it("surfaces server error codes through the settings error path", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ error: { code: "ADMIN_ONLY", message: "Organization admin only." } }, { status: 403 }),
  );
  const failure = await updateBranding({ appName: "Nope" }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ApiError);
  expect((failure as ApiError).code).toBe("ADMIN_ONLY");
  expect(getErrorMessage(failure, "Could not save branding.")).toBe("Organization admin only.");
  expect(getErrorMessage(new Error("boom"), "fallback")).toBe("boom");
  expect(getErrorMessage(42, "fallback")).toBe("fallback");
});

it("renders the profile read view with linked labels and an avatar affordance", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <OwnProfile initial={profilePayload} />
    </MemoryRouter>,
  );
  expect(html).toContain("Profile");
  expect(html).toContain("Ada Lovelace");
  // Keyboard-honest: every control carries a label bound by for/id.
  for (const id of ["profile-display-name", "profile-theme", "profile-avatar"]) {
    expect(html).toContain(`for="${id}"`);
    expect(html).toContain(`id="${id}"`);
  }
  expect(html).toContain("Save profile");
  expect(html).toContain("Remove avatar");
  expect(html).toContain("identity provider");
  // No password/security settings surface may grow on this page (the token
  // field's type="password" is the standard fixture input, not a store).
  for (const phrase of ["Change password", "New password", "Current password", "Passkey", "MFA"]) {
    expect(html).not.toContain(phrase);
  }
});

it("renders the profile loading state before the payload arrives", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <OwnProfile />
    </MemoryRouter>,
  );
  expect(html).toContain("Loading your profile…");
  expect(html).not.toContain("Save profile");
});

it("renders the branding read view, preview, and public logo URL for admins", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <BrandingAdmin initial={brandingPayload} initialRole="admin" />
    </MemoryRouter>,
  );
  expect(html).toContain("Acme Realm");
  expect(html).toContain("#112233");
  expect(html).toContain("#445566");
  expect(html).toContain("Preview");
  expect(html).toContain(publicLogoUrl(ORG));
  expect(publicLogoUrl(ORG)).toBe(`/api/branding/public/${ORG}/logo`);
  for (const id of ["branding-app-name", "branding-primary", "branding-accent", "branding-logo"]) {
    expect(html).toContain(`for="${id}"`);
    expect(html).toContain(`id="${id}"`);
  }
  expect(html).toContain("Save branding");
  expect(html).toContain("Reset to defaults");
  expect(html).toContain("Remove logo");
});

it("renders branding read-only for ordinary members, without the admin form", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <BrandingAdmin initial={brandingPayload} initialRole="member" />
    </MemoryRouter>,
  );
  expect(html).toContain("Acme Realm");
  expect(html).toContain("need an Organization admin");
  expect(html).not.toContain("Save branding");
  expect(html).not.toContain("Reset to defaults");
  expect(html).not.toContain('id="branding-app-name"');
});

it("renders the unset-logo empty state and the branding loading state", () => {
  const empty = renderToStaticMarkup(
    <MemoryRouter>
      <BrandingAdmin initial={plainBranding} initialRole="admin" />
    </MemoryRouter>,
  );
  expect(empty).toContain("No custom logo");
  expect(empty).not.toContain("Remove logo");
  const loading = renderToStaticMarkup(
    <MemoryRouter>
      <BrandingAdmin />
    </MemoryRouter>,
  );
  expect(loading).toContain("Loading branding…");
  expect(loading).not.toContain("Save branding");
});

it("pins the client-side upload bounds to the server caps", () => {
  expect(AVATAR_MAX_BYTES).toBe(2 * 1024 * 1024);
  expect(LOGO_MAX_BYTES).toBe(5 * 1024 * 1024);
});

it("admits sanitized SVG uploads client-side and surfaces SVG rejections", async () => {
  // Allowlist (and the file-input accept lists that mirror it) admits SVG —
  // the server validator, proven in test/branding-profile.test.ts, still
  // fences active markup with UNSUPPORTED_LOGO / UNSUPPORTED_AVATAR.
  expect([...LOGO_MIME_ALLOWLIST]).toEqual(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"]);
  expect([...AVATAR_MIME_ALLOWLIST]).toEqual(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"]);
  const seen: { url: string; contentType: string | null }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    seen.push({ url: String(input), contentType: new Headers(init?.headers).get("Content-Type") });
    return Response.json(brandingPayload);
  });
  const svg = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`);
  expect(await uploadLogo(svg, "image/svg+xml")).toEqual(brandingPayload);
  expect(seen[0]).toEqual({ url: "/api/branding/logo", contentType: "image/svg+xml" });
  // A scripted SVG that clears the client precheck still fails loudly at the
  // server fence, and the settings error path renders the server message.
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json(
      { error: { code: "UNSUPPORTED_LOGO", message: "SVG images must be self-contained." } },
      { status: 415 },
    ),
  );
  const failure = await uploadLogo(svg, "image/svg+xml").catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ApiError);
  expect((failure as ApiError).code).toBe("UNSUPPORTED_LOGO");
  expect(getErrorMessage(failure, "Could not upload the logo.")).toBe("SVG images must be self-contained.");
});

it("applies loaded branding to the shell header with a static fallback", () => {
  const branded = renderToStaticMarkup(
    <MemoryRouter>
      <Nav branding={brandingPayload.branding} />
    </MemoryRouter>,
  );
  expect(branded).toContain("Acme Realm");
  expect(branded).toContain(`/api/branding/public/${ORG}/logo`);
  expect(branded).toContain("--wrangnarok-sunrise:#112233");
  expect(branded).toContain("--wrangnarok-amber:#445566");
  const fallback = renderToStaticMarkup(
    <MemoryRouter>
      <Nav branding={null} />
    </MemoryRouter>,
  );
  expect(fallback).toContain("Wrangnarök");
  expect(fallback).toContain("brand-mark");
  expect(fallback).not.toContain("--wrangnarok-sunrise:");
  const implicit = renderToStaticMarkup(
    <MemoryRouter>
      <Nav />
    </MemoryRouter>,
  );
  expect(implicit).toContain("Wrangnarök");
});

it("writes the theme preference to the document shell", () => {
  const dataset: Record<string, string> = {};
  const stub = { documentElement: { dataset } };
  const prior = (globalThis as Record<string, unknown>)["document"];
  (globalThis as Record<string, unknown>)["document"] = stub;
  try {
    applyTheme("dark");
    expect(dataset["theme"]).toBe("dark");
    applyTheme("light");
    expect(dataset["theme"]).toBe("light");
  } finally {
    if (prior === undefined) delete (globalThis as Record<string, unknown>)["document"];
    else (globalThis as Record<string, unknown>)["document"] = prior;
  }
});

it("pins the WCAG contrast math to known anchors", () => {
  expect(BRAND_CONTRAST_FLOOR).toBe(3);
  expect(contrastRatioHex("#000000", "#ffffff")).toBeCloseTo(21, 10);
  expect(contrastRatioHex("#ffffff", "#ffffff")).toBe(1);
  expect(formatContrastRatio(3.266)).toBe("3.3:1");
  // #rgb expands to #rrggbb.
  expect(contrastRatioHex("#abc", "#ffffff")).toBe(contrastRatioHex("#aabbcc", "#ffffff"));
  // Case and surrounding whitespace are tolerated.
  expect(contrastRatioHex("  #ABCDEF  ", "#ffffff")).toBe(contrastRatioHex("#abcdef", "#ffffff"));
  // Unparseable endpoints answer null, never throw.
  expect(contrastRatioHex("red", "#ffffff")).toBeNull();
  expect(contrastRatioHex("#12345", "#ffffff")).toBeNull();
  expect(parseBrandHex("not-a-color")).toBeNull();
  // Alpha resolves against the paint surface: fully transparent white over
  // black reads as black (1:1), while translucent black over white lightens
  // toward the page.
  expect(contrastRatioHex("#ffffff00", "#000000")).toBe(1);
  const translucent = contrastRatioHex("#00000080", "#ffffff");
  expect(translucent).not.toBeNull();
  expect(translucent as number).toBeGreaterThan(1);
  expect(translucent as number).toBeLessThan(contrastRatioHex("#000000", "#ffffff") as number);
});

it("passes the shipped brand and fails each low-contrast surface honestly", () => {
  const shipped = brandContrastChecks({ primaryColor: "#F45D0B", accentColor: "#F59E0B" });
  expect(shipped.map((entry) => entry.id)).toEqual(["primary-button-text", "primary-on-header", "accent-on-body"]);
  for (const entry of shipped) {
    expect(entry.ratio).not.toBeNull();
    expect(entry.passes).toBe(true);
  }
  // Near-white primary: white button text vanishes, header accents stay fine.
  const washed = brandContrastChecks({ primaryColor: "#f7f7f4", accentColor: "#F59E0B" });
  expect(washed.find((entry) => entry.id === "primary-button-text")?.passes).toBe(false);
  expect(washed.find((entry) => entry.id === "primary-on-header")?.passes).toBe(true);
  // Header-colored primary: header accents vanish, button text stays fine.
  const dark = brandContrastChecks({ primaryColor: "#0b0f14", accentColor: "#F59E0B" });
  expect(dark.find((entry) => entry.id === "primary-on-header")?.passes).toBe(false);
  expect(dark.find((entry) => entry.id === "primary-button-text")?.passes).toBe(true);
});

it("renders the contrast safeguards with ratios and warn-only failures", () => {
  // The shipped brand passes every check; the existing #112233/#445566
  // fixture payload honestly does not, so the ok-case uses shipped colors.
  const shipped: BrandingResponse = {
    branding: { ...brandingPayload.branding, primaryColor: "#F45D0B", accentColor: "#F59E0B" },
  };
  const ok = renderToStaticMarkup(
    <MemoryRouter>
      <BrandingAdmin initial={shipped} initialRole="admin" />
    </MemoryRouter>,
  );
  expect(ok).toContain("Contrast safeguards");
  expect(ok).toContain("Advisory only");
  expect(ok).toContain("(ok)");
  expect(ok).not.toContain("— below the 3:1 floor");
  const washed: BrandingResponse = {
    branding: { ...brandingPayload.branding, primaryColor: "#f7f7f4" },
  };
  const warned = renderToStaticMarkup(
    <MemoryRouter>
      <BrandingAdmin initial={washed} initialRole="admin" />
    </MemoryRouter>,
  );
  expect(warned).toContain("Contrast safeguards");
  expect(warned).toContain("— below the 3:1 floor");
  expect(warned).toContain("contrast-warning");
  // Members see the read view including the safeguards, never the admin form.
  const member = renderToStaticMarkup(
    <MemoryRouter>
      <BrandingAdmin initial={washed} initialRole="member" />
    </MemoryRouter>,
  );
  expect(member).toContain("— below the 3:1 floor");
  expect(member).not.toContain("Save branding");
});

it("applies branding to the document shell and restores defaults", () => {
  const appended: unknown[] = [];
  let content: string | null = null;
  let removed = false;
  const meta = {
    setAttribute: (key: string, value: string) => {
      if (key === "content") content = value;
    },
    remove: () => {
      removed = true;
    },
  };
  let existing: unknown = null;
  const stub = {
    title: "before",
    head: { appendChild: (node: unknown) => void appended.push(node) },
    querySelector: () => existing,
    createElement: () => meta,
  };
  const prior = (globalThis as Record<string, unknown>)["document"];
  (globalThis as Record<string, unknown>)["document"] = stub;
  try {
    // No theme-color meta yet: one is created carrying the primary color.
    applyBrandingToDocument({ appName: "Acme Realm", primaryColor: "#112233" });
    expect(stub.title).toBe("Acme Realm");
    expect(content).toBe("#112233");
    expect(appended).toHaveLength(1);
    // An existing meta is reused, never duplicated.
    existing = meta;
    content = null;
    applyBrandingToDocument({ appName: "Acme Realm", primaryColor: "#445566" });
    expect(content).toBe("#445566");
    expect(appended).toHaveLength(1);
    // Null branding restores the static title and drops the meta.
    applyBrandingToDocument(null);
    expect(stub.title).toBe(DEFAULT_DOCUMENT_TITLE);
    expect(DEFAULT_DOCUMENT_TITLE).toBe("Wrangnarök");
    expect(removed).toBe(true);
  } finally {
    if (prior === undefined) delete (globalThis as Record<string, unknown>)["document"];
    else (globalThis as Record<string, unknown>)["document"] = prior;
  }
});
