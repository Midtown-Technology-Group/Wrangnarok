// SPDX-License-Identifier: AGPL-3.0
// Signed form embeds (EMBED-01 slice 1, issue #156): per-org/form secrets,
// exact-match origins, fingerprint rotation, FORM-02 startup/submit binding,
// revocation, and the admin inventory with no secret readback — end to end
// on the real local runtime (workerd D1 + Workflow bindings; the hello Saga
// needs no vendor fetch, and a fetch guard proves embed dispatch never
// reaches one). Applies the shared harness migrations plus 0035.
//
// Covers the slice acceptance: secret rotation/revocation, changed form
// capabilities (edit, Saga rebind, delete/recreate), unknown origin,
// replay/stale startup in both directions (embed handle on the operator
// route, operator handle on the embed route), blocked publication (unknown
// or deleted forms), and external-caller dependency traversal (Tables deny
// by absence, file refs refused, grants bound to one org/form/Saga).
import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { echoSaga, hash, helloSaga } from "../src/domain";
import { assertNoEmbedFileRefs, embedGrantIdFromUser } from "../src/embeds";
import { useWorkflowHarness } from "./helpers/workflow-harness";
import migration35 from "../migrations/0035_embeds.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const ORG = "00000000-0000-4000-8000-000000000001";
const OWNER = "00000000-0000-4000-8000-000000000002";
const MEMBER = "00000000-0000-4000-8000-000000000003";
const STRANGER = "00000000-0000-4000-8000-000000000007";
const ORG_B = "00000000-0000-4000-8000-000000000009";
const ORIGIN = "https://portal.example.com";
const OTHER_ORIGIN = "https://evil.example.net";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...extra };
}

/** Authenticated operator call. The LAB fixture identity bootstraps to admin
 * of ORG; MEMBER holds an ordinary membership; STRANGER holds none. */
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

/** Pre-gate embed bootstrap: secret + Origin, never an operator session. */
function bootstrap(grantId: string, secret: string | null, origin: string | null, body: unknown = {}) {
  const heads: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) heads["X-Embed-Secret"] = secret;
  if (origin !== null) heads["Origin"] = origin;
  return worker.fetch(
    new Request(`https://local.test/api/embeds/${grantId}/startup`, {
      method: "POST",
      headers: heads,
      body: JSON.stringify(body),
    }),
    bindings,
  );
}

/** CORS preflight for one embed route. */
function preflight(path: string, origin: string | null) {
  const heads: Record<string, string> = {};
  if (origin !== null) heads["Origin"] = origin;
  return worker.fetch(new Request(`https://local.test${path}`, { method: "OPTIONS", headers: heads }), bindings);
}

/** Pre-gate embed submit: handle + Origin + caller key, no session. */
function embedSubmit(body: unknown, origin: string | null, key: string) {
  const heads: Record<string, string> = { "Content-Type": "application/json", "Idempotency-Key": key };
  if (origin !== null) heads["Origin"] = origin;
  return worker.fetch(
    new Request("https://local.test/api/embeds/submit", { method: "POST", headers: heads, body: JSON.stringify(body) }),
    bindings,
  );
}

const keyFor = (name: string): string => `embed-test-key-${name}`;

const HELLO_FIELDS = [{ name: "name", type: "text", required: true }];

async function createForm(
  name = "contact",
  fields: unknown[] = HELLO_FIELDS,
  extra: Record<string, unknown> = {},
): Promise<{ id: string }> {
  const response = await call("/api/forms", "POST", { name, sagaId: helloSaga.id, fields, ...extra });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { form: { id: string; name: string } };
  expect(body.form.name).toBe(name);
  return { id: body.form.id };
}

interface GrantReceipt {
  id: string;
  secret: string;
  fingerprint: string;
}

async function createGrant(
  formName: string,
  allowedOrigins: unknown = [ORIGIN],
  extra: Record<string, unknown> = {},
  orgId = ORG,
): Promise<GrantReceipt> {
  const response = await call(`/api/forms/${formName}/embeds`, "POST", { allowedOrigins, ...extra }, orgId);
  expect(response.status).toBe(201);
  const body = (await response.json()) as {
    grant: { id: string; fingerprint: string };
    secret: string;
  };
  expect(typeof body.secret).toBe("string");
  expect(body.secret).toMatch(/^[a-f0-9]{64}$/);
  return { id: body.grant.id, secret: body.secret, fingerprint: body.grant.fingerprint };
}

interface BootstrapReceipt {
  handle: string;
  expiresAt: string;
  snapshot: Record<string, unknown>;
  options: Record<string, string[]>;
  declaration: { fields: { name: string }[] };
  fingerprint: string;
}

async function bootstrapOk(grant: GrantReceipt, origin: string | null = ORIGIN): Promise<BootstrapReceipt> {
  const response = await bootstrap(grant.id, grant.secret, origin);
  expect(response.status).toBe(201);
  return (await response.json()) as BootstrapReceipt;
}

/** Craft a form_startups row directly (revocation/expiry/confusion cases the
 * API cannot produce: grants are never deleted and secrets never leak). */
async function craftStartupRow(row: {
  handle: string;
  orgId: string;
  userId: string;
  formId: string;
  formName: string;
}): Promise<void> {
  const now = new Date();
  await bindings.DB.prepare(
    "INSERT INTO form_startups(handle_hash,org_id,user_id,form_id,form_name,prefill_json,options_json,expires_at,used_at,created_at) VALUES (?,?,?,?,?,?,?,?,NULL,?)",
  )
    .bind(
      await hash(row.handle),
      row.orgId,
      row.userId,
      row.formId,
      row.formName,
      "{}",
      "{}",
      new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
      now.toISOString(),
    )
    .run();
}

/** Seed a grant row directly (expired, corrupt, or confusion cases). */
async function seedGrantRow(row: {
  id?: string;
  orgId?: string;
  formId: string;
  formName: string;
  secret?: string;
  secretHash?: string;
  origins?: unknown;
  fingerprint?: string;
  enabled?: number;
  expiresAt?: string | null;
}): Promise<{ id: string; secret: string }> {
  const id = row.id ?? crypto.randomUUID().toLowerCase();
  const secret = row.secret ?? `seed-secret-${id.slice(0, 8)}`;
  await bindings.DB.prepare(
    "INSERT INTO form_embeds(id,org_id,form_id,form_name,secret_hash,allowed_origins_json,capability_fingerprint,enabled,expires_at,created_at,rotated_at,last_used_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL)",
  )
    .bind(
      id,
      row.orgId ?? ORG,
      row.formId,
      row.formName,
      row.secretHash ?? (await hash(secret)),
      typeof row.origins === "string" ? row.origins : JSON.stringify(row.origins ?? [ORIGIN]),
      row.fingerprint ?? "0".repeat(64),
      row.enabled ?? 1,
      row.expiresAt ?? null,
      new Date().toISOString(),
    )
    .run();
  return { id, secret };
}

useWorkflowHarness(bindings.DB);

beforeEach(async () => {
  await bindings.DB.exec(migration35);
  // MEMBER holds an ordinary membership in ORG; OWNER also admins ORG_B for
  // the cross-tenant tests; STRANGER holds nothing anywhere.
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
  // Embed dispatch runs the hello Saga: any vendor fetch is a traversal bug.
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("embed dispatch must not fetch");
  });
});

it("creates grants with a show-once secret and lists summaries without readback", async () => {
  await createForm();
  const first = await createGrant("contact");
  const second = await createGrant(
    "contact",
    ["https://other.example.com", "http://localhost:3000", "http://[::1]:3000"],
    {
      expiresAt: "2036-01-01T00:00:00.000Z",
    },
  );
  expect(second.secret).not.toBe(first.secret);

  const listed = await call("/api/forms/contact/embeds", "GET");
  expect(listed.status).toBe(200);
  const body = (await listed.json()) as {
    embeds: {
      id: string;
      formName: string;
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
    formName: "contact",
    allowedOrigins: [ORIGIN],
    fingerprint: first.fingerprint,
    enabled: true,
    expiresAt: null,
    rotatedAt: null,
    lastUsedAt: null,
  });
  expect(body.embeds[1]).toMatchObject({
    id: second.id,
    allowedOrigins: ["https://other.example.com", "http://localhost:3000", "http://[::1]:3000"],
    expiresAt: "2036-01-01T00:00:00.000Z",
  });
  // No readback: summaries carry digests and policy, never secret material.
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain(first.secret);
  expect(serialized).not.toContain(second.secret);
  expect(serialized).not.toContain("secret_hash");
  expect(serialized).not.toContain("secretHash");
});

it("rejects malformed grant requests without issuing anything", async () => {
  await createForm();
  const bad: [unknown, string][] = [
    [undefined, "INVALID_EMBED"],
    ["https://portal.example.com", "INVALID_EMBED"],
    [[], "INVALID_EMBED"],
    [Array.from({ length: 11 }, (_, i) => `https://host${i}.example.com`), "INVALID_EMBED"],
    [[123], "INVALID_EMBED"],
    [[ORIGIN, ORIGIN], "INVALID_EMBED"],
    [["https://*.example.com"], "INVALID_EMBED"],
    [["*"], "INVALID_EMBED"],
    [["HTTPS://portal.example.com"], "INVALID_EMBED"],
    [["https://portal.example.com/"], "INVALID_EMBED"],
    [["https://portal.example.com/path"], "INVALID_EMBED"],
    [["https://portal.example.com?x=1"], "INVALID_EMBED"],
    [["https://user@portal.example.com"], "INVALID_EMBED"],
    [["ftp://portal.example.com"], "INVALID_EMBED"],
    [["notaurl"], "INVALID_EMBED"],
    [["https://-bad.example.com"], "INVALID_EMBED"],
    [["https://bad-.example.com"], "INVALID_EMBED"],
    [["https://a..example.com"], "INVALID_EMBED"],
    [[`https://${"l".repeat(64)}.com`], "INVALID_EMBED"],
    [["https://portal.example.com:0"], "INVALID_EMBED"],
    [["https://portal.example.com:99999"], "INVALID_EMBED"],
    [[`https://${"h".repeat(300)}.com`], "INVALID_EMBED"],
  ];
  for (const [allowedOrigins, code] of bad) {
    const response = await call("/api/forms/contact/embeds", "POST", { allowedOrigins });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code } });
  }
  for (const expiresAt of ["not-a-date", "2001-01-01T00:00:00.000Z", 123]) {
    const response = await call("/api/forms/contact/embeds", "POST", { allowedOrigins: [ORIGIN], expiresAt });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_EMBED" } });
  }
  const empty = await call("/api/forms/contact/embeds", "POST", null);
  expect(empty.status).toBe(400);
  const listed = await call("/api/forms/contact/embeds", "GET");
  expect(await listed.json()).toMatchObject({ embeds: [] });
});

it("keeps grant administration admin-only and org-scoped", async () => {
  await createForm();
  await createGrant("contact");
  // Ordinary members neither list nor mint (403 ADMIN_ONLY).
  for (const [path, method, reqBody] of [
    ["/api/forms/contact/embeds", "GET", undefined],
    ["/api/forms/contact/embeds", "POST", { allowedOrigins: [ORIGIN] }],
  ] as const) {
    const denied = await call(path, method, reqBody, ORG, MEMBER);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "ADMIN_ONLY" } });
  }
  // Strangers never reach the inventory: the membership gate answers 404.
  const stranger = await call("/api/forms/contact/embeds", "GET", undefined, ORG, STRANGER);
  expect(stranger.status).toBe(404);
  // Unknown forms answer 404 FORM_NOT_FOUND, never an empty list oracle.
  const missing = await call("/api/forms/nope/embeds", "GET");
  expect(missing.status).toBe(404);
  expect(await missing.json()).toMatchObject({ error: { code: "FORM_NOT_FOUND" } });
  const missingCreate = await call("/api/forms/nope/embeds", "POST", { allowedOrigins: [ORIGIN] });
  expect(missingCreate.status).toBe(404);
  // Cross-tenant: the same form name recreated in ORG_B lists empty — org
  // A's grants are invisible there (404-on-foreign reads, never a leak).
  const createdB = await call(
    "/api/forms",
    "POST",
    { name: "contact", sagaId: helloSaga.id, fields: HELLO_FIELDS },
    ORG_B,
  );
  expect(createdB.status).toBe(201);
  const foreign = await call("/api/forms/contact/embeds", "GET", undefined, ORG_B);
  expect(foreign.status).toBe(200);
  expect(await foreign.json()).toMatchObject({ embeds: [] });
});

it("rotates secrets and fingerprints while the old secret dies", async () => {
  await createForm();
  const grant = await createGrant("contact");
  const before = await bootstrapOk(grant);

  const rotated = await call(`/api/forms/contact/embeds/${grant.id}/rotate`, "POST", {});
  expect(rotated.status).toBe(200);
  const rotatedBody = (await rotated.json()) as { grant: { fingerprint: string; rotatedAt: string }; secret: string };
  expect(rotatedBody.secret).toMatch(/^[a-f0-9]{64}$/);
  expect(rotatedBody.secret).not.toBe(grant.secret);
  expect(typeof rotatedBody.grant.rotatedAt).toBe("string");
  // Same declaration, so the fingerprint survives a pure secret rotation.
  expect(rotatedBody.grant.fingerprint).toBe(grant.fingerprint);

  // Old secret stops verifying; new secret bootstraps.
  const stale = await bootstrap(grant.id, grant.secret, ORIGIN);
  expect(stale.status).toBe(401);
  expect(await stale.json()).toMatchObject({ error: { code: "EMBED_UNAUTHORIZED" } });
  const fresh = await bootstrap(grant.id, rotatedBody.secret, ORIGIN);
  expect(fresh.status).toBe(201);

  // The pre-rotation session still submits: rotation kills secrets, not
  // outstanding sessions (revocation owns session death, tested below).
  const submitted = await embedSubmit(
    { handle: before.handle, values: { name: "Ada" } },
    ORIGIN,
    keyFor("rotate-live"),
  );
  expect(submitted.status).toBe(202);

  // Unknown grants, foreign grants, and cross-form IDs answer 404.
  const unknownId = crypto.randomUUID().toLowerCase();
  const unknown = await call(`/api/forms/contact/embeds/${unknownId}/rotate`, "POST", {});
  expect(unknown.status).toBe(404);
  await createForm("other");
  const crossForm = await call(`/api/forms/other/embeds/${grant.id}/rotate`, "POST", {});
  expect(crossForm.status).toBe(404);
  const badShape = await call(`/api/forms/contact/embeds/${"-".repeat(36)}/rotate`, "POST", {});
  expect(badShape.status).toBe(404);
});

it("revokes terminally: bootstrap 410s and outstanding sessions go stale", async () => {
  await createForm();
  const grant = await createGrant("contact");
  const live = await bootstrapOk(grant);

  const revoked = await call(`/api/forms/contact/embeds/${grant.id}/revoke`, "POST", {});
  expect(revoked.status).toBe(200);
  expect(await revoked.json()).toMatchObject({ grant: { id: grant.id, enabled: false } });

  // Revoke is idempotent: revoking twice answers the same revoked summary.
  const again = await call(`/api/forms/contact/embeds/${grant.id}/revoke`, "POST", {});
  expect(again.status).toBe(200);
  expect(await again.json()).toMatchObject({ grant: { enabled: false } });

  // And terminal: rotating a revoked grant answers 410, never a new secret.
  const rotated = await call(`/api/forms/contact/embeds/${grant.id}/rotate`, "POST", {});
  expect(rotated.status).toBe(410);
  expect(await rotated.json()).toMatchObject({ error: { code: "EMBED_REVOKED" } });

  // Bootstrap denies revoked grants with 410 ...
  const denied = await bootstrap(grant.id, grant.secret, ORIGIN);
  expect(denied.status).toBe(410);
  expect(await denied.json()).toMatchObject({ error: { code: "EMBED_REVOKED" } });

  // ... and the outstanding session dies at submit with STALE (no TTL
  // grace — revocation deletes outstanding tokens, the FILE-01 posture).
  const submitted = await embedSubmit({ handle: live.handle, values: { name: "Ada" } }, ORIGIN, keyFor("revoke-live"));
  expect(submitted.status).toBe(422);
  expect(await submitted.json()).toMatchObject({ error: { code: "STALE_FORM_HANDLE" } });

  const unknown = await call(`/api/forms/contact/embeds/${crypto.randomUUID().toLowerCase()}/revoke`, "POST", {});
  expect(unknown.status).toBe(404);
});

it("bootstraps sessions for the grant secret plus an exact-match origin", async () => {
  await createForm();
  const grant = await createGrant("contact");
  const started = await bootstrapOk(grant);
  expect(started.handle).toMatch(/^[a-f0-9]{64}$/);
  expect(typeof started.expiresAt).toBe("string");
  expect(started.fingerprint).toBe(grant.fingerprint);
  // The host cannot call the authed designer routes, so bootstrap carries
  // the server-authoritative declaration alongside the session.
  expect(started.declaration.fields).toMatchObject([{ name: "name" }]);
  // Successful bootstrap records last use for stale-grant review.
  const listed = await call("/api/forms/contact/embeds", "GET");
  const body = (await listed.json()) as { embeds: { id: string; lastUsedAt: string | null }[] };
  expect(body.embeds.find((entry) => entry.id === grant.id)?.lastUsedAt).not.toBeNull();
});

it("runs the shared startup gates for embeds: prefill opt-in and defaults", async () => {
  await createForm("prefilled", [{ name: "name", type: "text", required: false, default: "Bo" }], {
    allowPrefill: true,
  });
  const grant = await createGrant("prefilled");
  // Opt-in prefill merges over defaults through the same per-field gate.
  const prefilled = await bootstrap(grant.id, grant.secret, ORIGIN, { prefill: { name: "Al" } });
  expect(prefilled.status).toBe(201);
  expect(((await prefilled.json()) as BootstrapReceipt).snapshot).toMatchObject({ name: "Al" });
  const badPrefill = await bootstrap(grant.id, grant.secret, ORIGIN, { prefill: { nope: "x" } });
  expect(badPrefill.status).toBe(422);
  // Without the declaration opt-in, prefill answers 403 like the operator path.
  await createForm("closed");
  const closed = await createGrant("closed");
  const refused = await bootstrap(closed.id, closed.secret, ORIGIN, { prefill: { name: "Al" } });
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ error: { code: "PREFILL_NOT_ALLOWED" } });
});

it("denies bootstrap for unknown grants, bad secrets, and foreign origins", async () => {
  await createForm();
  const grant = await createGrant("contact");
  // Unknown grant IDs answer 404, never a leak; malformed IDs too.
  const unknown = await bootstrap(crypto.randomUUID().toLowerCase(), grant.secret, ORIGIN);
  expect(unknown.status).toBe(404);
  const malformed = await bootstrap("-".repeat(36), grant.secret, ORIGIN);
  expect(malformed.status).toBe(404);
  // Wrong, missing, and overlong secrets answer 401.
  for (const secret of ["0".repeat(64), null, "x".repeat(300)]) {
    const denied = await bootstrap(grant.id, secret, ORIGIN);
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ error: { code: "EMBED_UNAUTHORIZED" } });
  }
  // Unknown and missing origins answer 403 without naming the allowlist.
  for (const origin of [OTHER_ORIGIN, "https://portal.example.com.evil.com", null]) {
    const denied = await bootstrap(grant.id, grant.secret, origin);
    expect(denied.status).toBe(403);
    const deniedBody = (await denied.json()) as { error: { code: string; message: string } };
    expect(deniedBody.error.code).toBe("EMBED_ORIGIN_DENIED");
    expect(deniedBody.error.message).not.toContain(ORIGIN);
  }
  // Expired grants answer 401 even before the secret compares.
  const { id: formId } = await createForm("aged");
  const expired = await seedGrantRow({
    formId,
    formName: "aged",
    secret: "expired-secret-for-tests",
    expiresAt: "2001-01-01T00:00:00.000Z",
  });
  const stale = await bootstrap(expired.id, "wrong-secret-also-expired", ORIGIN);
  expect(stale.status).toBe(401);
  expect(await stale.json()).toMatchObject({ error: { code: "EMBED_SECRET_EXPIRED" } });
  // A corrupt stored digest fails closed to 401, never a match.
  const corrupt = await seedGrantRow({ formId, formName: "aged", secretHash: "a".repeat(63) });
  const corruptDenied = await bootstrap(corrupt.id, "a".repeat(64), ORIGIN);
  expect(corruptDenied.status).toBe(401);
  // A corrupt allowlist is a server defect (500), never caller input —
  // whether the bytes are not JSON at all or JSON of the wrong shape.
  const broken = await seedGrantRow({
    formId,
    formName: "aged",
    secret: "broken-allowlist-secret",
    origins: "not-json",
  });
  const brokenDenied = await bootstrap(broken.id, broken.secret, ORIGIN);
  expect(brokenDenied.status).toBe(500);
  const misshapen = await seedGrantRow({
    formId,
    formName: "aged",
    secret: "misshapen-allowlist-secret",
    origins: '{"origins":[]}',
  });
  const misshapenDenied = await bootstrap(misshapen.id, misshapen.secret, ORIGIN);
  expect(misshapenDenied.status).toBe(500);
});

it("fails bootstrap closed when the form changes until rotation re-binds it", async () => {
  await createForm("contact", HELLO_FIELDS, { title: "Hello" });
  const grant = await createGrant("contact");
  await bootstrapOk(grant);

  // A field edit changes the fingerprint: bootstrap answers 409.
  const edited = await call("/api/forms/contact", "PUT", {
    sagaId: helloSaga.id,
    title: "Hello",
    fields: [...HELLO_FIELDS, { name: "nick", type: "text", required: false }],
  });
  expect(edited.status).toBe(200);
  const changed = await bootstrap(grant.id, grant.secret, ORIGIN);
  expect(changed.status).toBe(409);
  expect(await changed.json()).toMatchObject({ error: { code: "EMBED_CAPABILITY_CHANGED" } });

  // Rotating re-fingerprints against the live declaration: bootstrap heals
  // and the stored fingerprint visibly advances.
  const rotated = await call(`/api/forms/contact/embeds/${grant.id}/rotate`, "POST", {});
  expect(rotated.status).toBe(200);
  const rotatedBody = (await rotated.json()) as { grant: { fingerprint: string }; secret: string };
  expect(rotatedBody.grant.fingerprint).not.toBe(grant.fingerprint);
  const healed = await bootstrap(grant.id, rotatedBody.secret, ORIGIN);
  expect(healed.status).toBe(201);
  expect(((await healed.json()) as BootstrapReceipt).fingerprint).toBe(rotatedBody.grant.fingerprint);

  // A Saga rebind is a capability change too (the fingerprint binds the
  // Saga id, not just the declaration bytes).
  const rebound = await call("/api/forms/contact", "PUT", {
    sagaId: echoSaga.id,
    title: "Hello",
    fields: [...HELLO_FIELDS, { name: "nick", type: "text", required: false }],
  });
  expect(rebound.status).toBe(200);
  const reboundDenied = await bootstrap(grant.id, rotatedBody.secret, ORIGIN);
  expect(reboundDenied.status).toBe(409);
  const reboundRotate = await call(`/api/forms/contact/embeds/${grant.id}/rotate`, "POST", {});
  expect(reboundRotate.status).toBe(200);
  const reboundSecret = ((await reboundRotate.json()) as { secret: string }).secret;
  expect((await bootstrap(grant.id, reboundSecret, ORIGIN)).status).toBe(201);

  // Delete/recreate under the same name changes the form id: 409, and
  // rotation re-binds to the new identity.
  expect((await call("/api/forms/contact", "DELETE")).status).toBe(200);
  await createForm("contact");
  const recreated = await bootstrap(grant.id, reboundSecret, ORIGIN);
  expect(recreated.status).toBe(409);
  const recreateRotate = await call(`/api/forms/contact/embeds/${grant.id}/rotate`, "POST", {});
  expect(recreateRotate.status).toBe(200);
  const recreateBody = (await recreateRotate.json()) as { secret: string };
  expect((await bootstrap(grant.id, recreateBody.secret, ORIGIN)).status).toBe(201);

  // A deleted form blocks the embed entirely (blocked publication): the
  // grant dangles and bootstrap answers 404 FORM_NOT_FOUND.
  expect((await call("/api/forms/contact", "DELETE")).status).toBe(200);
  const gone = await bootstrap(grant.id, recreateBody.secret, ORIGIN);
  expect(gone.status).toBe(404);
  expect(await gone.json()).toMatchObject({ error: { code: "FORM_NOT_FOUND" } });
});

it("rotation never revives a pre-change startup handle", async () => {
  await createForm("contact");
  const grant = await createGrant("contact");
  const started = await bootstrapOk(grant);

  // A field edit changes the fingerprint: the pre-change handle answers
  // STALE at submit while the grant still names the old declaration.
  expect(
    (
      await call("/api/forms/contact", "PUT", {
        sagaId: helloSaga.id,
        title: "Hello",
        fields: [...HELLO_FIELDS, { name: "nick", type: "text", required: false }],
      })
    ).status,
  ).toBe(200);
  const stale = await embedSubmit({ handle: started.handle, values: { name: "Ada" } }, ORIGIN, keyFor("revive-before"));
  expect(stale.status).toBe(422);
  expect(await stale.json()).toMatchObject({ error: { code: "STALE_FORM_HANDLE" } });

  // Rotation heals the grant for new startups ...
  const rotated = await call(`/api/forms/contact/embeds/${grant.id}/rotate`, "POST", {});
  expect(rotated.status).toBe(200);
  const secret = ((await rotated.json()) as { secret: string }).secret;

  // ... but the same pre-change handle stays stale instead of being
  // revived by the re-bind (EMBED-01 hardening, issue #156).
  const revived = await embedSubmit(
    { handle: started.handle, values: { name: "Ada" } },
    ORIGIN,
    keyFor("revive-after"),
  );
  expect(revived.status).toBe(422);
  expect(await revived.json()).toMatchObject({ error: { code: "STALE_FORM_HANDLE" } });

  // A fresh bootstrap with the rotated secret submits the new declaration.
  const fresh = await bootstrap(grant.id, secret, ORIGIN);
  expect(fresh.status).toBe(201);
  const submitted = await embedSubmit(
    { handle: ((await fresh.json()) as BootstrapReceipt).handle, values: { name: "Ada" } },
    ORIGIN,
    keyFor("revive-fresh"),
  );
  expect(submitted.status).toBe(202);
});

it("submits through the shared core: receipt, replay, conflict, schedule", async () => {
  await createForm();
  const grant = await createGrant("contact");
  const started = await bootstrapOk(grant);

  const first = await embedSubmit({ handle: started.handle, values: { name: "Ada" } }, ORIGIN, keyFor("submit-happy"));
  expect(first.status).toBe(202);
  const receipt = (await first.json()) as {
    form: string;
    executionId: string;
    replayed: boolean;
    statusUrl: string;
  };
  expect(receipt.form).toBe("contact");
  expect(receipt.replayed).toBe(false);
  expect(receipt.statusUrl).toBe(`/api/executions/${receipt.executionId}`);
  // The grant dispatches only its bound Saga, attributed to the embed
  // principal — never an unrelated Saga, never another identity.
  const row = await bindings.DB.prepare("SELECT saga_id,org_id,user_id FROM executions WHERE id=?")
    .bind(receipt.executionId)
    .first<{ saga_id: string; org_id: string; user_id: string }>();
  expect(row).toMatchObject({ saga_id: helloSaga.id, org_id: ORG, user_id: `embed:${grant.id}` });

  // Same-key same-input replay converges (200 + replayed:true) through a
  // fresh session; a mismatched duplicate answers 409.
  const replayed = await bootstrapOk(grant);
  const replay = await embedSubmit(
    { handle: replayed.handle, values: { name: "Ada" } },
    ORIGIN,
    keyFor("submit-happy"),
  );
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ replayed: true, executionId: receipt.executionId });
  const conflictSession = await bootstrapOk(grant);
  const conflict = await embedSubmit(
    { handle: conflictSession.handle, values: { name: "Grace" } },
    ORIGIN,
    keyFor("submit-happy"),
  );
  expect(conflict.status).toBe(409);

  // Scheduled submission defers dispatch with the inspectable linkage.
  const deferred = await bootstrapOk(grant);
  const scheduleAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const scheduled = await embedSubmit(
    { handle: deferred.handle, values: { name: "Ada" }, scheduleAt },
    ORIGIN,
    keyFor("submit-scheduled"),
  );
  expect(scheduled.status).toBe(202);
  expect(await scheduled.json()).toMatchObject({ scheduled: true, scheduleAt });
});

it("answers stale handles on the embed path and never accepts operator sessions", async () => {
  await createForm();
  const grant = await createGrant("contact");
  // Unknown and malformed handles, and bodies without handles, answer
  // STALE (the route cannot bind a session without one).
  for (const body of [
    { handle: "0".repeat(64), values: {} },
    { handle: "not-a-handle", values: {} },
    { values: {} },
    null,
    [1, 2, 3],
  ]) {
    const denied = await embedSubmit(body, ORIGIN, keyFor(`stale-${String(body === null)}`));
    expect(denied.status).toBe(422);
    expect(await denied.json()).toMatchObject({ error: { code: "STALE_FORM_HANDLE" } });
  }
  // Replayed sessions answer STALE under a fresh key.
  const once = await bootstrapOk(grant);
  const first = await embedSubmit({ handle: once.handle, values: { name: "Ada" } }, ORIGIN, keyFor("replay-once"));
  expect(first.status).toBe(202);
  const replay = await embedSubmit({ handle: once.handle, values: { name: "Ada" } }, ORIGIN, keyFor("replay-twice"));
  expect(replay.status).toBe(422);
  expect(await replay.json()).toMatchObject({ error: { code: "STALE_FORM_HANDLE" } });
  // An operator session is foreign here: STALE, never dispatch.
  const operatorStart = await call("/api/forms/contact/startup", "POST", {});
  expect(operatorStart.status).toBe(201);
  const operatorHandle = ((await operatorStart.json()) as { handle: string }).handle;
  const operatorHere = await embedSubmit(
    { handle: operatorHandle, values: { name: "Ada" } },
    ORIGIN,
    keyFor("op-here"),
  );
  expect(operatorHere.status).toBe(422);
  expect(await operatorHere.json()).toMatchObject({ error: { code: "STALE_FORM_HANDLE" } });
  // And an embed session is foreign on the operator route: STALE there too.
  // (The operator submit needs an Idempotency-Key; without one it answers
  // 400 before the handle is even read, so the stale is proven keyed.)
  const there = await bootstrapOk(grant);
  const keyed = new Request("https://local.test/api/forms/contact/submit", {
    method: "POST",
    headers: headers({ "Idempotency-Key": keyFor("embed-there") }),
    body: JSON.stringify({ handle: there.handle, values: { name: "Ada" } }),
  });
  const keyedResponse = await worker.fetch(keyed, { ...bindings, LAB_ORG_ID: ORG, LAB_FIXTURE_USER_ID: OWNER });
  expect(keyedResponse.status).toBe(422);
  expect(await keyedResponse.json()).toMatchObject({ error: { code: "STALE_FORM_HANDLE" } });
});

it("kills outstanding sessions when the grant or form dies after startup", async () => {
  await createForm("volatile");
  const grant = await createGrant("volatile");
  const { id: formId } = await createForm("craft");
  const craftGrant = await createGrant("craft");
  // One real bootstrap first: form_startups is created on demand, and the
  // crafted rows below need the table to exist.
  await bootstrapOk(craftGrant);

  // Revocation between startup and submit answers STALE (tested in the
  // revoke test above for the direct path; expiry behaves the same).
  const expired = await seedGrantRow({
    formId,
    formName: "craft",
    secret: "submit-expired-secret",
    fingerprint: craftGrant.fingerprint,
    expiresAt: "2001-01-01T00:00:00.000Z",
  });
  const expiredHandle = "e".repeat(64);
  await craftStartupRow({
    handle: expiredHandle,
    orgId: ORG,
    userId: `embed:${expired.id}`,
    formId,
    formName: "craft",
  });
  const expiredSubmit = await embedSubmit(
    { handle: expiredHandle, values: { name: "Ada" } },
    ORIGIN,
    keyFor("exp-sub"),
  );
  expect(expiredSubmit.status).toBe(422);
  expect(await expiredSubmit.json()).toMatchObject({ error: { code: "STALE_FORM_HANDLE" } });

  // A session naming an unknown grant, a grant from another org, a grant
  // for another form, or a non-UUID embed subject answers STALE.
  const unknownHandle = "f".repeat(64);
  await craftStartupRow({
    handle: unknownHandle,
    orgId: ORG,
    userId: `embed:${crypto.randomUUID().toLowerCase()}`,
    formId,
    formName: "craft",
  });
  const unknownGrant = await embedSubmit({ handle: unknownHandle, values: {} }, ORIGIN, keyFor("unknown-grant"));
  expect(unknownGrant.status).toBe(422);

  const otherOrgGrant = await seedGrantRow({ id: crypto.randomUUID().toLowerCase(), formId, formName: "craft" });
  const orgHandle = "a".repeat(64);
  await bindings.DB.prepare("UPDATE form_embeds SET org_id=? WHERE id=?").bind(ORG_B, otherOrgGrant.id).run();
  await craftStartupRow({
    handle: orgHandle,
    orgId: ORG,
    userId: `embed:${otherOrgGrant.id}`,
    formId,
    formName: "craft",
  });
  const orgConfused = await embedSubmit({ handle: orgHandle, values: {} }, ORIGIN, keyFor("org-confusion"));
  expect(orgConfused.status).toBe(422);

  const formHandle = "b".repeat(64);
  await craftStartupRow({
    handle: formHandle,
    orgId: ORG,
    userId: `embed:${craftGrant.id}`,
    formId,
    formName: "volatile",
  });
  const formConfused = await embedSubmit({ handle: formHandle, values: {} }, ORIGIN, keyFor("form-confusion"));
  expect(formConfused.status).toBe(422);

  const subjectHandle = "c".repeat(64);
  await craftStartupRow({ handle: subjectHandle, orgId: ORG, userId: "embed:not-a-uuid", formId, formName: "craft" });
  const subjectConfused = await embedSubmit({ handle: subjectHandle, values: {} }, ORIGIN, keyFor("subject-confusion"));
  expect(subjectConfused.status).toBe(422);

  // A form deleted or edited after startup answers STALE at submit (the
  // FORM-02 definition-mismatch contract; 409 exists only at bootstrap).
  const doomed = await bootstrapOk(grant);
  expect((await call("/api/forms/volatile", "DELETE")).status).toBe(200);
  const deletedSubmit = await embedSubmit(
    { handle: doomed.handle, values: { name: "Ada" } },
    ORIGIN,
    keyFor("del-sub"),
  );
  expect(deletedSubmit.status).toBe(422);
  expect(await deletedSubmit.json()).toMatchObject({ error: { code: "STALE_FORM_HANDLE" } });

  await createForm("shifting");
  const shifting = await createGrant("shifting");
  const shiftingSession = await bootstrapOk(shifting);
  const shiftEdit = await call("/api/forms/shifting", "PUT", {
    sagaId: helloSaga.id,
    fields: [...HELLO_FIELDS, { name: "nick", type: "text", required: false }],
  });
  expect(shiftEdit.status).toBe(200);
  const shiftedSubmit = await embedSubmit(
    { handle: shiftingSession.handle, values: { name: "Ada" } },
    ORIGIN,
    keyFor("shift-sub"),
  );
  expect(shiftedSubmit.status).toBe(422);
  expect(await shiftedSubmit.json()).toMatchObject({ error: { code: "STALE_FORM_HANDLE" } });

  // The browser Origin re-verifies at submit: a session bootstrapped for
  // an allowed origin cannot submit from a foreign page. (The edit above
  // staled the grant, so rotate back to a fresh binding first.)
  const fencedRotate = await call(`/api/forms/shifting/embeds/${shifting.id}/rotate`, "POST", {});
  expect(fencedRotate.status).toBe(200);
  const fencedGrant: GrantReceipt = {
    id: shifting.id,
    secret: ((await fencedRotate.json()) as { secret: string }).secret,
    fingerprint: shifting.fingerprint,
  };
  const fenced = await bootstrapOk(fencedGrant);
  const foreignSubmit = await embedSubmit(
    { handle: fenced.handle, values: { name: "Ada" } },
    OTHER_ORIGIN,
    keyFor("fenced-sub"),
  );
  expect(foreignSubmit.status).toBe(403);
  expect(await foreignSubmit.json()).toMatchObject({ error: { code: "EMBED_ORIGIN_DENIED" } });
  const missingOrigin = await embedSubmit(
    { handle: fenced.handle, values: { name: "Ada" } },
    null,
    keyFor("no-origin"),
  );
  expect(missingOrigin.status).toBe(403);
});

it("denies external callers any dependency traversal", async () => {
  // A table-backed select exists with live rows, readable by operators.
  expect((await call("/api/tables", "POST", { name: "teams" })).status).toBe(201);
  expect((await call("/api/tables/teams/rows/t1", "PUT", { data: { team: "red" } })).status).toBe(201);
  await createForm("scoped", [
    { name: "name", type: "text", required: true },
    { name: "pick", type: "select", required: false, provider: { kind: "table", table: "teams", valueField: "team" } },
  ]);
  const grant = await createGrant("scoped");
  // The embed principal holds no Table grant: options resolve empty with
  // no leak, and submitting a traversed value fails option membership.
  const started = await bootstrapOk(grant);
  expect(started.options["pick"]).toEqual([]);
  const traversed = await embedSubmit(
    { handle: started.handle, values: { name: "Ada", pick: "red" } },
    ORIGIN,
    keyFor("traverse-table"),
  );
  expect(traversed.status).toBe(422);
  // ... while the operator path on the same form resolves the table.
  const operatorStart = await call("/api/forms/scoped/startup", "POST", {});
  expect(operatorStart.status).toBe(201);
  expect(((await operatorStart.json()) as BootstrapReceipt).options["pick"]).toEqual(["red"]);
});

it("refuses caller file references while author defaults stay live-validated", async () => {
  await createForm("papers", [
    { name: "name", type: "text", required: true },
    { name: "doc", type: "file", required: false, file: { location: "briefs" } },
  ]);
  const grant = await createGrant("papers");
  const started = await bootstrapOk(grant);
  // Any presented file reference fails closed: slice 1 ships no embed
  // upload path, so no reference can prove session ownership.
  const refused = await embedSubmit(
    { handle: started.handle, values: { name: "Ada", doc: { location: "briefs", path: "a/b.pdf" } } },
    ORIGIN,
    keyFor("file-refused"),
  );
  expect(refused.status).toBe(422);
  expect(await refused.json()).toMatchObject({
    error: { code: "FORM_VALIDATION_FAILED", details: [{ field: "doc", code: "FILE_NOT_SESSION_OWNED" }] },
  });
  // Explicitly cleared file fields pass the refusal (a gap, not a ref).
  const clearedSession = await bootstrapOk(grant);
  const cleared = await embedSubmit(
    { handle: clearedSession.handle, values: { name: "Ada", doc: null } },
    ORIGIN,
    keyFor("file-cleared"),
  );
  expect(cleared.status).toBe(202);

  // Author-declared defaults still re-validate against the live FILE-01
  // rows on both paths: a stale default answers FILE_NOT_READY.
  await createForm("stale-default", [
    { name: "name", type: "text", required: true },
    {
      name: "doc",
      type: "file",
      required: false,
      file: { location: "briefs" },
      default: { location: "briefs", path: "missing.pdf" },
    },
  ]);
  const staleGrant = await createGrant("stale-default");
  const staleSession = await bootstrapOk(staleGrant);
  const staleSubmit = await embedSubmit(
    { handle: staleSession.handle, values: { name: "Ada" } },
    ORIGIN,
    keyFor("file-stale-default"),
  );
  expect(staleSubmit.status).toBe(422);
  expect(await staleSubmit.json()).toMatchObject({
    error: { code: "FORM_VALIDATION_FAILED", details: [{ field: "doc", code: "FILE_NOT_READY" }] },
  });
});

it("keeps embed routes on the shared JSON and query gates", async () => {
  await createForm();
  const grant = await createGrant("contact");
  // Query strings stay deny-by-default on every embed route.
  const queried = await worker.fetch(
    new Request(`https://local.test/api/embeds/${grant.id}/startup?x=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Embed-Secret": grant.secret, Origin: ORIGIN },
      body: "{}",
    }),
    bindings,
  );
  expect(queried.status).toBe(400);
  const queriedSubmit = await worker.fetch(
    new Request("https://local.test/api/embeds/submit?x=1", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, "Idempotency-Key": keyFor("query-submit") },
      body: "{}",
    }),
    bindings,
  );
  expect(queriedSubmit.status).toBe(400);
  const queriedList = await call("/api/forms/contact/embeds?x=1", "GET");
  expect(queriedList.status).toBe(400);
  // State changes share the JSON-write gate (no unencoded form posts).
  const formPost = await worker.fetch(
    new Request(`https://local.test/api/embeds/${grant.id}/startup`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "X-Embed-Secret": grant.secret, Origin: ORIGIN },
      body: "{}",
    }),
    bindings,
  );
  expect(formPost.status).toBe(415);
});

it("serves CORS preflights and marks embed responses readable", async () => {
  await createForm();
  const grant = await createGrant("contact");
  // Preflights reflect the request Origin with the route's methods and
  // headers, cached 10 minutes. Neither touches D1: unknown and malformed
  // grant IDs still answer 204, and the POST enforces everything.
  const startupFlight = await preflight(`/api/embeds/${grant.id}/startup`, ORIGIN);
  expect(startupFlight.status).toBe(204);
  expect(startupFlight.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  expect(startupFlight.headers.get("Vary")).toBe("Origin");
  expect(startupFlight.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
  expect(startupFlight.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type, Origin, X-Embed-Secret");
  expect(startupFlight.headers.get("Access-Control-Max-Age")).toBe("600");
  const submitFlight = await preflight("/api/embeds/submit", ORIGIN);
  expect(submitFlight.status).toBe(204);
  expect(submitFlight.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type, Idempotency-Key, Origin");
  const unknownFlight = await preflight(`/api/embeds/${crypto.randomUUID().toLowerCase()}/startup`, ORIGIN);
  expect(unknownFlight.status).toBe(204);
  const malformedFlight = await preflight(`/api/embeds/${"-".repeat(36)}/startup`, ORIGIN);
  expect(malformedFlight.status).toBe(204);
  const noOriginFlight = await preflight("/api/embeds/submit", null);
  expect(noOriginFlight.status).toBe(204);
  expect(noOriginFlight.headers.get("Access-Control-Allow-Origin")).toBeNull();
  expect(noOriginFlight.headers.get("Vary")).toBe("Origin");
  const queriedFlight = await worker.fetch(
    new Request(`https://local.test/api/embeds/${grant.id}/startup?x=1`, {
      method: "OPTIONS",
      headers: { Origin: ORIGIN },
    }),
    bindings,
  );
  expect(queriedFlight.status).toBe(400);

  // POST receipts and POST failures both carry CORS so browsers can read
  // them: success, origin denial (reflection authorizes nothing — the
  // body still answers 403), stale sessions, and missing keys.
  const ok = await bootstrap(grant.id, grant.secret, ORIGIN);
  expect(ok.status).toBe(201);
  expect(ok.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  expect(ok.headers.get("Vary")).toBe("Origin");
  const denied = await bootstrap(grant.id, grant.secret, OTHER_ORIGIN);
  expect(denied.status).toBe(403);
  expect(denied.headers.get("Access-Control-Allow-Origin")).toBe(OTHER_ORIGIN);
  const started = await bootstrapOk(grant);
  const submitted = await embedSubmit({ handle: started.handle, values: { name: "Ada" } }, ORIGIN, keyFor("cors-ok"));
  expect(submitted.status).toBe(202);
  expect(submitted.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  const replayed = await embedSubmit({ handle: started.handle, values: { name: "Ada" } }, ORIGIN, keyFor("cors-stale"));
  expect(replayed.status).toBe(422);
  expect(replayed.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  const keyless = await worker.fetch(
    new Request("https://local.test/api/embeds/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ handle: started.handle, values: {} }),
    }),
    bindings,
  );
  expect(keyless.status).toBe(400);
  expect(keyless.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
});

it("parses embed subjects and file posture as pure helpers", () => {
  const id = crypto.randomUUID().toLowerCase();
  expect(embedGrantIdFromUser(`embed:${id}`)).toBe(id);
  expect(embedGrantIdFromUser(`embed:${id.toUpperCase()}`)).toBe(id);
  expect(embedGrantIdFromUser(OWNER)).toBeNull();
  expect(embedGrantIdFromUser("endpoint:abc")).toBeNull();
  expect(embedGrantIdFromUser("embed:not-a-uuid")).toBeNull();
  expect(embedGrantIdFromUser("")).toBeNull();
  const fields = [{ name: "doc", type: "file" }];
  // Unknown shapes are the declaration validator's to reject, never a crash.
  expect(() => assertNoEmbedFileRefs(fields, null)).not.toThrow();
  expect(() => assertNoEmbedFileRefs(fields, [1])).not.toThrow();
  expect(() => assertNoEmbedFileRefs(fields, {})).not.toThrow();
  expect(() => assertNoEmbedFileRefs(fields, { doc: null })).not.toThrow();
  expect(() => assertNoEmbedFileRefs([{ name: "name", type: "text" }], { name: "Ada" })).not.toThrow();
  expect(() => assertNoEmbedFileRefs(fields, { doc: { location: "l", path: "p" } })).toThrowError(
    expect.objectContaining({ code: "FORM_VALIDATION_FAILED" }),
  );
});
