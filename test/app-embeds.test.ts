// SPDX-License-Identifier: AGPL-3.0
// Signed app embeds (EMBED-01 slice 2, issue #156): per-org/per-app secrets,
// exact-match origins, deployment-fingerprint rotation, pre-gate asset reads
// bound to the ACTIVE deployment, terminal revocation, and the admin
// inventory with no secret readback — end to end on the real local runtime
// (workerd D1; asset reads dispatch nothing, and a fetch guard proves it).
// Applies the shared harness migrations plus 0036.
//
// Covers the slice acceptance: secret rotation/revocation, changed app
// capabilities (redeploy drift), unknown origin, revoked/expired secrets,
// blocked reads, cross-tenant denial, and grant repurposing across the two
// signed classes (form grants never resolve on the app surface and vice
// versa — each table answers 404 for the other's IDs).
import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { appEmbedGrantIdFromUser } from "../src/app-embeds";
import { hash, helloSaga } from "../src/domain";
import { useWorkflowHarness } from "./helpers/workflow-harness";
import migration35 from "../migrations/0035_embeds.sql?raw";
import migration36 from "../migrations/0036_anon_app_embeds.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const ORG = "00000000-0000-4000-8000-000000000001";
const OWNER = "00000000-0000-4000-8000-000000000002";
const MEMBER = "00000000-0000-4000-8000-000000000003";
const ORG_B = "00000000-0000-4000-8000-000000000009";
const ORIGIN = "https://portal.example.com";
const OTHER_ORIGIN = "https://evil.example.net";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...extra };
}

/** Authenticated operator call. The LAB fixture identity bootstraps to admin
 * of ORG; MEMBER holds an ordinary membership; OWNER also admins ORG_B. */
function call(path: string, method = "GET", body?: unknown, orgId = ORG, userId?: string) {
  return worker.fetch(
    new Request(`https://local.test${path}`, {
      method,
      headers: headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    {
      ...bindings,
      LAB_ORG_ID: orgId,
      LAB_FIXTURE_USER_ID: OWNER,
      ...(userId ? { LAB_USER_ID: userId } : {}),
    },
  );
}

/** Pre-gate app-asset read: secret + Origin, never an operator session. */
function readAsset(grantId: string, assetPath: string, secret: string | null, origin: string | null) {
  const heads: Record<string, string> = {};
  if (secret !== null) heads["X-Embed-Secret"] = secret;
  if (origin !== null) heads["Origin"] = origin;
  return worker.fetch(
    new Request(`https://local.test/api/app-embeds/${grantId}/assets/${assetPath}`, { headers: heads }),
    bindings,
  );
}

const GOOD_SOURCE = {
  files: [{ path: "index.html", content: "<h1>hello</h1>" }],
  dependencies: [{ name: "wrangnarok-ui", version: "1.0.0" }],
};

async function createLiveApp(name = "hello-app", slug = "hello-app", source = GOOD_SOURCE): Promise<string> {
  const created = await call("/api/apps", "POST", { name, slug });
  expect(created.status).toBe(201);
  const id = ((await created.json()) as { app: { id: string } }).app.id;
  const edited = await call(`/api/apps/${id}/source`, "PUT", source);
  expect(edited.status).toBe(200);
  const built = await call(`/api/apps/${id}/builds`, "POST");
  expect(built.status).toBe(202);
  expect(((await built.json()) as { job: { status: string } }).job.status).toBe("succeeded");
  return id;
}

interface GrantReceipt {
  id: string;
  secret: string;
  fingerprint: string;
}

async function createGrant(
  appId: string,
  allowedOrigins: unknown = [ORIGIN],
  extra: Record<string, unknown> = {},
  orgId = ORG,
): Promise<GrantReceipt> {
  const response = await call(`/api/apps/${appId}/embeds`, "POST", { allowedOrigins, ...extra }, orgId);
  expect(response.status).toBe(201);
  const body = (await response.json()) as {
    grant: { id: string; fingerprint: string };
    secret: string;
  };
  expect(typeof body.secret).toBe("string");
  expect(body.secret).toMatch(/^[a-f0-9]{64}$/);
  return { id: body.grant.id, secret: body.secret, fingerprint: body.grant.fingerprint };
}

useWorkflowHarness(bindings.DB);

beforeEach(async () => {
  await bindings.DB.exec(migration35);
  await bindings.DB.exec(migration36);
  // MEMBER holds an ordinary membership in ORG; OWNER also admins ORG_B for
  // the cross-tenant tests.
  const stamp = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?) ON CONFLICT(id) DO NOTHING")
    .bind(ORG_B, "Org B")
    .run();
  for (const userId of [MEMBER, OWNER]) {
    await bindings.DB.prepare(
      "INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?) ON CONFLICT DO NOTHING",
    )
      .bind(userId, stamp)
      .run();
  }
  await bindings.DB.prepare(
    "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
  )
    .bind(ORG, MEMBER, "member", "active", "ordinary", stamp, stamp)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
  )
    .bind(ORG_B, OWNER, "admin", "active", "ordinary", stamp, stamp)
    .run();
  // Asset reads dispatch nothing: any vendor fetch is a defect.
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("app-embed reads must not fetch");
  });
});

it("issues grants with a show-once secret and lists summaries without readback", async () => {
  const id = await createLiveApp();
  const first = await createGrant(id);
  const second = await createGrant(id, ["https://other.example.com"], { expiresAt: "2036-01-01T00:00:00.000Z" });
  expect(second.secret).not.toBe(first.secret);

  const listed = await call(`/api/apps/${id}/embeds`, "GET");
  expect(listed.status).toBe(200);
  const body = (await listed.json()) as {
    embeds: {
      id: string;
      appSlug: string;
      allowedOrigins: string[];
      fingerprint: string;
      enabled: boolean;
      expiresAt: string | null;
      createdAt: string;
      rotatedAt: string | null;
      lastUsedAt: string | null;
    }[];
  };
  expect(body.embeds).toHaveLength(2);
  expect(body.embeds[0]).toMatchObject({
    id: first.id,
    appSlug: "hello-app",
    allowedOrigins: [ORIGIN],
    fingerprint: first.fingerprint,
    enabled: true,
    expiresAt: null,
    rotatedAt: null,
    lastUsedAt: null,
  });
  expect(body.embeds[1]).toMatchObject({
    id: second.id,
    allowedOrigins: ["https://other.example.com"],
    expiresAt: "2036-01-01T00:00:00.000Z",
  });
  // No readback: summaries carry digests and policy, never secret material.
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain(first.secret);
  expect(serialized).not.toContain(second.secret);
});

it("refuses grants for unknown, foreign, or undeployed apps and for non-admins", async () => {
  const id = await createLiveApp();
  // Unknown app UUID.
  expect(
    (await call(`/api/apps/00000000-0000-4000-8000-ffffffffffff/embeds`, "POST", { allowedOrigins: [ORIGIN] })).status,
  ).toBe(404);
  // Foreign app (org B's app through org A's scope).
  const foreignId = await createLiveApp("foreign-app", "foreign-app");
  await bindings.DB.prepare("UPDATE apps SET org_id=? WHERE id=?").bind(ORG_B, foreignId).run();
  expect((await call(`/api/apps/${foreignId}/embeds`, "POST", { allowedOrigins: [ORIGIN] })).status).toBe(404);
  expect((await call(`/api/apps/${foreignId}/embeds`, "GET")).status).toBe(404);
  // No active deployment yet: a grant fingerprints the live deployment, so
  // there must be one.
  const draft = await call("/api/apps", "POST", { name: "draft-app", slug: "draft-app" });
  expect(draft.status).toBe(201);
  const draftId = ((await draft.json()) as { app: { id: string } }).app.id;
  expect((await call(`/api/apps/${draftId}/embeds`, "POST", { allowedOrigins: [ORIGIN] })).status).toBe(404);
  // Ordinary members neither list nor mint (403 ADMIN_ONLY).
  const memberList = await call(`/api/apps/${id}/embeds`, "GET", undefined, ORG, MEMBER);
  expect(memberList.status).toBe(403);
  expect(await memberList.json()).toMatchObject({ error: { code: "ADMIN_ONLY" } });
  const memberMint = await call(`/api/apps/${id}/embeds`, "POST", { allowedOrigins: [ORIGIN] }, ORG, MEMBER);
  expect(memberMint.status).toBe(403);
});

it("validates origins and expiry at issue time", async () => {
  const id = await createLiveApp();
  // Origin-shape failures carry the shared slice-1 allowlist code: the
  // exact-match rule is one capability rule across both signed classes.
  for (const allowedOrigins of [
    ["https://*.example.com"],
    ["https://portal.example.com/path"],
    ["HTTPS://PORTAL.EXAMPLE.COM"],
    ["not-an-origin"],
    [],
    Array.from({ length: 11 }, (_, index) => `https://host${index}.example.com`),
    [ORIGIN, ORIGIN],
  ]) {
    const denied = await call(`/api/apps/${id}/embeds`, "POST", { allowedOrigins });
    expect(denied.status).toBe(400);
    expect(await denied.json()).toMatchObject({ error: { code: "INVALID_EMBED" } });
  }
  const past = await call(`/api/apps/${id}/embeds`, "POST", {
    allowedOrigins: [ORIGIN],
    expiresAt: "2020-01-01T00:00:00.000Z",
  });
  expect(past.status).toBe(400);
});

it("serves active-deployment assets to allowed origins with CORS", async () => {
  const id = await createLiveApp();
  const grant = await createGrant(id);
  const read = await readAsset(grant.id, "index.html", grant.secret, ORIGIN);
  expect(read.status).toBe(200);
  expect(await read.text()).toBe("<h1>hello</h1>");
  const detail = await call(`/api/apps/${id}`);
  const deployed = (await detail.json()) as { app: { activeDeployment: { contentHash: string } } };
  expect(read.headers.get("ETag")).toContain(deployed.app.activeDeployment.contentHash);
  expect(read.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  expect(read.headers.get("Vary")).toContain("Origin");
  // Missing assets answer 404, never a leak.
  expect((await readAsset(grant.id, "missing.html", grant.secret, ORIGIN)).status).toBe(404);
  // CORS preflight answers 204 without touching the grant.
  const preflight = await worker.fetch(
    new Request(`https://local.test/api/app-embeds/${grant.id}/assets/index.html`, {
      method: "OPTIONS",
      headers: { Origin: ORIGIN },
    }),
    bindings,
  );
  expect(preflight.status).toBe(204);
});

it("denies reads without a valid secret, for foreign origins, and after expiry", async () => {
  const id = await createLiveApp();
  const grant = await createGrant(id);
  // Unknown grant IDs answer 404.
  expect((await readAsset("00000000-0000-4000-8000-000000000000", "index.html", grant.secret, ORIGIN)).status).toBe(
    404,
  );
  const noSecret = await readAsset(grant.id, "index.html", null, ORIGIN);
  expect(noSecret.status).toBe(401);
  expect(await noSecret.json()).toMatchObject({ error: { code: "APP_EMBED_UNAUTHORIZED" } });
  const wrongSecret = await readAsset(grant.id, "index.html", "0".repeat(64), ORIGIN);
  expect(wrongSecret.status).toBe(401);
  const foreignOrigin = await readAsset(grant.id, "index.html", grant.secret, OTHER_ORIGIN);
  expect(foreignOrigin.status).toBe(403);
  expect(await foreignOrigin.json()).toMatchObject({ error: { code: "APP_EMBED_ORIGIN_DENIED" } });
  const missingOrigin = await readAsset(grant.id, "index.html", grant.secret, null);
  expect(missingOrigin.status).toBe(403);
  // Expired grants answer 401: seed one directly (the API never issues
  // past expiries).
  const expiredId = crypto.randomUUID().toLowerCase();
  await bindings.DB.prepare(
    "INSERT INTO app_embeds(id,org_id,app_id,app_slug,secret_hash,allowed_origins_json,capability_fingerprint,enabled,expires_at,created_at,rotated_at,last_used_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL)",
  )
    .bind(
      expiredId,
      ORG,
      id,
      "hello-app",
      await hash("expired-secret"),
      JSON.stringify([ORIGIN]),
      grant.fingerprint,
      1,
      "2020-01-01T00:00:00.000Z",
      new Date().toISOString(),
    )
    .run();
  const expired = await readAsset(expiredId, "index.html", "expired-secret", ORIGIN);
  expect(expired.status).toBe(401);
  expect(await expired.json()).toMatchObject({ error: { code: "APP_EMBED_SECRET_EXPIRED" } });
});

it("rotates secrets, fails closed on redeploy drift, and revokes terminally", async () => {
  const id = await createLiveApp();
  const grant = await createGrant(id);
  expect((await readAsset(grant.id, "index.html", grant.secret, ORIGIN)).status).toBe(200);
  // Rotation swaps the secret: the old one stops verifying immediately.
  const rotated = await call(`/api/apps/${id}/embeds/${grant.id}/rotate`, "POST", {});
  expect(rotated.status).toBe(200);
  const fresh = ((await rotated.json()) as { grant: { fingerprint: string }; secret: string }).secret;
  expect(fresh).not.toBe(grant.secret);
  expect((await readAsset(grant.id, "index.html", grant.secret, ORIGIN)).status).toBe(401);
  expect((await readAsset(grant.id, "index.html", fresh, ORIGIN)).status).toBe(200);
  // Redeploy changes the deployment fingerprint: reads fail closed until
  // the admin rotates deliberately.
  const edited = await call(`/api/apps/${id}/source`, "PUT", {
    files: [{ path: "index.html", content: "<h1>changed</h1>" }],
    dependencies: [{ name: "wrangnarok-ui", version: "1.0.0" }],
  });
  expect(edited.status).toBe(200);
  expect((await call(`/api/apps/${id}/builds`, "POST")).status).toBe(202);
  const stale = await readAsset(grant.id, "index.html", fresh, ORIGIN);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: { code: "APP_EMBED_CAPABILITY_CHANGED" } });
  const healed = await call(`/api/apps/${id}/embeds/${grant.id}/rotate`, "POST", {});
  expect(healed.status).toBe(200);
  const healedSecret = ((await healed.json()) as { secret: string }).secret;
  const reread = await readAsset(grant.id, "index.html", healedSecret, ORIGIN);
  expect(reread.status).toBe(200);
  expect(await reread.text()).toBe("<h1>changed</h1>");
  // Revocation is terminal with no grace: reads answer 410 at once, and
  // rotating a revoked grant answers 410 (create a new grant instead).
  const revoked = await call(`/api/apps/${id}/embeds/${grant.id}/revoke`, "POST", {});
  expect(revoked.status).toBe(200);
  const denied = await readAsset(grant.id, "index.html", healedSecret, ORIGIN);
  expect(denied.status).toBe(410);
  expect(await denied.json()).toMatchObject({ error: { code: "APP_EMBED_REVOKED" } });
  expect((await call(`/api/apps/${id}/embeds/${grant.id}/rotate`, "POST", {})).status).toBe(410);
  // Revoking twice answers the same revoked summary (idempotent).
  expect((await call(`/api/apps/${id}/embeds/${grant.id}/revoke`, "POST", {})).status).toBe(200);
});

it("denies cross-tenant administration and cross-app grant use", async () => {
  const id = await createLiveApp("shop", "shop");
  const grant = await createGrant(id);
  const otherId = await createLiveApp("other-app", "other-app");
  // OWNER admins ORG_B but holds no admin in ORG's ... — scope check runs
  // against the caller's org: org B sees neither the app nor its grants.
  expect((await call(`/api/apps/${id}/embeds`, "GET", undefined, ORG_B)).status).toBe(404);
  expect((await call(`/api/apps/${id}/embeds`, "POST", { allowedOrigins: [ORIGIN] }, ORG_B)).status).toBe(404);
  // Unknown shapes, foreign grants, and cross-app IDs answer 404.
  const unknown = "00000000-0000-4000-8000-000000000000";
  expect((await call(`/api/apps/${id}/embeds/${unknown}/rotate`, "POST", {})).status).toBe(404);
  expect((await call(`/api/apps/${otherId}/embeds/${grant.id}/rotate`, "POST", {})).status).toBe(404);
  expect((await call(`/api/apps/${otherId}/embeds/${grant.id}/revoke`, "POST", {})).status).toBe(404);
  // A form-embed grant ID never resolves on the app surface (and the app
  // grant never resolves on the form surface — proven in the next test).
  const formCreated = await call("/api/forms", "POST", {
    name: "contact",
    sagaId: helloSaga.id,
    fields: [{ name: "name", type: "text", required: true }],
  });
  expect(formCreated.status).toBe(201);
  const formGrant = await call("/api/forms/contact/embeds", "POST", { allowedOrigins: [ORIGIN] });
  expect(formGrant.status).toBe(201);
  const formGrantId = ((await formGrant.json()) as { grant: { id: string } }).grant.id;
  expect((await readAsset(formGrantId, "index.html", "0".repeat(64), ORIGIN)).status).toBe(404);
});

it("keeps the principal classes distinct and fails corrupt rows closed", async () => {
  const id = await createLiveApp();
  const grant = await createGrant(id);
  // Principal parsing never cross-accepts: form, anonymous, operator, and
  // malformed subjects answer null on the app surface.
  expect(appEmbedGrantIdFromUser(`appembed:${grant.id}`)).toBe(grant.id);
  expect(appEmbedGrantIdFromUser(`embed:${grant.id}`)).toBeNull();
  expect(appEmbedGrantIdFromUser(`anon:${grant.id}`)).toBeNull();
  expect(appEmbedGrantIdFromUser("appembed:not-a-uuid")).toBeNull();
  expect(appEmbedGrantIdFromUser(OWNER)).toBeNull();
  // A corrupt allowlist is a server defect (500), never caller input.
  const corruptId = crypto.randomUUID().toLowerCase();
  await bindings.DB.prepare(
    "INSERT INTO app_embeds(id,org_id,app_id,app_slug,secret_hash,allowed_origins_json,capability_fingerprint,enabled,expires_at,created_at,rotated_at,last_used_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL)",
  )
    .bind(
      corruptId,
      ORG,
      id,
      "hello-app",
      await hash("corrupt-secret"),
      "not-json",
      grant.fingerprint,
      1,
      null,
      new Date().toISOString(),
    )
    .run();
  const corrupt = await readAsset(corruptId, "index.html", "corrupt-secret", ORIGIN);
  expect(corrupt.status).toBe(500);
  expect(await corrupt.json()).toMatchObject({ error: { code: "APP_EMBED_MISCONFIGURED" } });
  // A corrupt digest fails closed as unauthorized, never a match.
  await bindings.DB.prepare("UPDATE app_embeds SET secret_hash=? WHERE id=?").bind("short", grant.id).run();
  expect((await readAsset(grant.id, "index.html", grant.secret, ORIGIN)).status).toBe(401);
  // A slug drift under the same app id fails closed until rotation.
  await bindings.DB.prepare("UPDATE app_embeds SET secret_hash=?,app_slug=? WHERE id=?")
    .bind(await hash(grant.secret), "renamed", grant.id)
    .run();
  const drifted = await readAsset(grant.id, "index.html", grant.secret, ORIGIN);
  expect(drifted.status).toBe(409);
  expect(await drifted.json()).toMatchObject({ error: { code: "APP_EMBED_CAPABILITY_CHANGED" } });
});

it("never accepts app grants on the form-embed routes", async () => {
  const id = await createLiveApp();
  const grant = await createGrant(id);
  // The app grant ID is unknown to the form-embed table: 404, never a
  // cross-surface signal.
  const bootstrapped = await worker.fetch(
    new Request(`https://local.test/api/embeds/${grant.id}/startup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Embed-Secret": grant.secret, Origin: ORIGIN },
      body: JSON.stringify({}),
    }),
    bindings,
  );
  expect(bootstrapped.status).toBe(404);
});
