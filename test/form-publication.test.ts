// SPDX-License-Identifier: AGPL-3.0
// Anonymous public forms (EMBED-01 slice 2, issue #156): publication and
// blocking, anonymous startup/submit bound to FORM-02 sessions,
// confirmation-only receipts with no execution/history disclosure, the
// honeypot spam trap with the single-use startup handle as the submission
// nonce, session-ownership file refusal, capability-changing republish
// review, and cross-tenant denial — end to end on the real local runtime
// (workerd D1 + Workflow bindings; the hello Saga needs no vendor fetch,
// and a fetch guard proves anonymous dispatch never reaches one). Applies
// the shared harness migrations plus 0035 (signed-grant confusion cases)
// and 0036.
//
// Covers the slice acceptance: honeypot/submission nonce, upload
// ownership, republish review, blocked publication, replay/stale startup in
// every direction (operator and signed-grant handles on the anonymous
// route, anonymous handles on the operator and signed routes),
// confirmation-only disclosure (the receipt never names an execution while
// the Execution row still admits through the shared core), and external
// caller traversal denial (Tables deny by absence, file refs refused,
// publications bound to one org/form/Saga).
import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { echoSaga, helloSaga } from "../src/domain";
import { anonPubIdFromUser, assertNoPublicFileRefs, parseHoneypotField } from "../src/public-forms";
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

/** Anonymous bootstrap: no session, no secret — the publication ID is the
 * whole address. */
function publicStartup(pubId: string, body: unknown = {}) {
  return worker.fetch(
    new Request(`https://local.test/api/public/${pubId}/startup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify(body),
    }),
    bindings,
  );
}

/** Anonymous submit: handle + caller key, no session. */
function publicSubmit(body: unknown, key: string) {
  return worker.fetch(
    new Request("https://local.test/api/public/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key, Origin: ORIGIN },
      body: JSON.stringify(body),
    }),
    bindings,
  );
}

const keyFor = (name: string): string => `public-test-key-${name}`;

const HELLO_FIELDS = [{ name: "name", type: "text", required: true }];

async function createForm(
  name = "contact",
  fields: unknown[] = HELLO_FIELDS,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const response = await call("/api/forms", "POST", { name, sagaId: helloSaga.id, fields, ...extra });
  expect(response.status).toBe(201);
}

interface PublicationReceipt {
  id: string;
  honeypotField: string;
  fingerprint: string;
  enabled: boolean;
  stale: boolean;
}

async function publish(
  formName: string,
  body: unknown = {},
  orgId = ORG,
  expectedStatus = 201,
): Promise<PublicationReceipt> {
  const response = await call(`/api/forms/${formName}/publication`, "POST", body, orgId);
  expect(response.status).toBe(expectedStatus);
  return ((await response.json()) as { publication: PublicationReceipt }).publication;
}

interface PublicBootstrapReceipt {
  handle: string;
  expiresAt: string;
  snapshot: Record<string, unknown>;
  options: Record<string, string[]>;
  declaration: { fields: { name: string }[] };
  fingerprint: string;
  honeypotField: string;
}

async function startupOk(pubId: string): Promise<PublicBootstrapReceipt> {
  const response = await publicStartup(pubId);
  expect(response.status).toBe(201);
  return (await response.json()) as PublicBootstrapReceipt;
}

async function executionCount(): Promise<number> {
  const row = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM executions").first<{ n: number }>();
  return row?.n ?? -1;
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
  // Anonymous dispatch runs the hello Saga: any vendor fetch is a traversal bug.
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("public dispatch must not fetch");
  });
});

it("publishes with a default honeypot, reads the summary, and blocks on delete", async () => {
  await createForm();
  const published = await publish("contact");
  expect(published.honeypotField).toBe("wrangnarok_hp");
  expect(published.enabled).toBe(true);
  expect(published.stale).toBe(false);
  expect(published.fingerprint).toMatch(/^[a-f0-9]{64}$/);

  // Re-publishing the unchanged form heals nothing and changes nothing: 200.
  const republished = await publish("contact", {}, ORG, 200);
  expect(republished.id).toBe(published.id);
  expect(republished.fingerprint).toBe(published.fingerprint);

  const fetched = await call("/api/forms/contact/publication", "GET");
  expect(fetched.status).toBe(200);
  expect(((await fetched.json()) as { publication: PublicationReceipt }).publication).toMatchObject({
    id: published.id,
    stale: false,
  });

  // A custom honeypot field is honored; colliding or misshapen names fail
  // closed at publish time, never at submit time.
  const custom = await publish("contact", { honeypotField: "website_url" }, ORG, 200);
  expect(custom.honeypotField).toBe("website_url");
  for (const honeypotField of ["name", "9lives", "has space", "x".repeat(65)]) {
    const denied = await call("/api/forms/contact/publication", "POST", { honeypotField });
    expect(denied.status).toBe(400);
    expect(await denied.json()).toMatchObject({ error: { code: "INVALID_PUBLICATION" } });
  }

  // Never-published forms read null; unknown or foreign forms 404.
  expect((await call("/api/forms/missing/publication", "GET")).status).toBe(404);
  expect((await call("/api/forms/contact/publication", "GET", undefined, ORG, MEMBER)).status).toBe(403);
  const memberPublish = await call("/api/forms/contact/publication", "POST", {}, ORG, MEMBER);
  expect(memberPublish.status).toBe(403);
  expect(await memberPublish.json()).toMatchObject({ error: { code: "ADMIN_ONLY" } });
});

it("submits confirmation-only: dispatch admits, the receipt discloses nothing", async () => {
  await createForm();
  const pub = await publish("contact");
  const started = await startupOk(pub.id);
  expect(started.honeypotField).toBe("wrangnarok_hp");
  expect(started.fingerprint).toBe(pub.fingerprint);

  const before = await executionCount();
  const first = await publicSubmit({ handle: started.handle, values: { name: "Ada" } }, keyFor("confirm-once"));
  expect(first.status).toBe(202);
  const receipt = (await first.json()) as Record<string, unknown>;
  // Confirmation-only: the receipt names the form and nothing else — no
  // execution ID, no status URL, no replay flag, no history.
  expect(receipt).toEqual({ form: "contact", received: true });
  expect(first.headers.get("Location")).toBeNull();
  // ... while the Execution row still admitted through the shared core
  // (one execution path, minimal disclosure).
  expect(await executionCount()).toBe(before + 1);
  const admitted = await bindings.DB.prepare(
    "SELECT org_id, saga_id FROM executions WHERE org_id=? ORDER BY rowid DESC LIMIT 1",
  )
    .bind(ORG)
    .first<{ org_id: string; saga_id: string }>();
  expect(admitted?.saga_id).toBe(helloSaga.id);

  // Same-key same-input replay is idempotent and still confirmation-only.
  const replay = await publicSubmit({ handle: started.handle, values: { name: "Ada" } }, keyFor("confirm-once"));
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual({ form: "contact", received: true });
  expect(await executionCount()).toBe(before + 1);
});

it("traps honeypot fills with an identical confirmation and no dispatch", async () => {
  await createForm();
  const pub = await publish("contact");
  const before = await executionCount();
  const trapped = await startupOk(pub.id);
  const response = await publicSubmit(
    { handle: trapped.handle, values: { name: "Ada", wrangnarok_hp: "buy-cheap-watches.example" } },
    keyFor("trap-once"),
  );
  expect(response.status).toBe(202);
  // Identical shape to a genuine confirmation: the trap teaches bots nothing.
  expect(await response.json()).toEqual({ form: "contact", received: true });
  expect(await executionCount()).toBe(before);
  // The trap does not consume the session (same posture as a validation
  // failure): a corrected retry still dispatches.
  const retry = await publicSubmit({ handle: trapped.handle, values: { name: "Ada" } }, keyFor("trap-retry"));
  expect(retry.status).toBe(202);
  expect(await executionCount()).toBe(before + 1);
  // Non-object values are the validator's to reject — never spam, and the
  // trap does not misclassify them.
  const oddSession = await startupOk(pub.id);
  const odd = await publicSubmit({ handle: oddSession.handle, values: "not-an-object" }, keyFor("trap-odd"));
  expect(odd.status).toBe(422);
  expect(await executionCount()).toBe(before + 1);
});

it("answers replayed and foreign handles stale, in every direction", async () => {
  await createForm();
  const pub = await publish("contact");
  // Unknown and malformed handles, and bodies without handles, answer
  // STALE (the route cannot bind a session without one).
  for (const body of [
    { handle: "0".repeat(64), values: {} },
    { handle: "not-a-handle", values: {} },
    { values: {} },
    null,
    [1, 2, 3],
  ]) {
    const denied = await publicSubmit(body, keyFor(`stale-${String(body === null)}`));
    expect(denied.status).toBe(422);
    expect(await denied.json()).toMatchObject({ error: { code: "STALE_FORM_HANDLE" } });
  }
  // The startup handle is the submission nonce: it spends on first use, so
  // a fresh key replaying it answers STALE.
  const once = await startupOk(pub.id);
  expect((await publicSubmit({ handle: once.handle, values: { name: "Ada" } }, keyFor("nonce-once"))).status).toBe(202);
  const replay = await publicSubmit({ handle: once.handle, values: { name: "Ada" } }, keyFor("nonce-twice"));
  expect(replay.status).toBe(422);
  expect(await replay.json()).toMatchObject({ error: { code: "STALE_FORM_HANDLE" } });
  // An operator session is foreign here: STALE, never dispatch.
  const operatorStart = await call("/api/forms/contact/startup", "POST", {});
  expect(operatorStart.status).toBe(201);
  const operatorHandle = ((await operatorStart.json()) as { handle: string }).handle;
  const operatorHere = await publicSubmit({ handle: operatorHandle, values: { name: "Ada" } }, keyFor("op-here"));
  expect(operatorHere.status).toBe(422);
  // A signed-grant session is foreign here too: STALE, never dispatch.
  const signed = await call("/api/forms/contact/embeds", "POST", { allowedOrigins: [ORIGIN] });
  expect(signed.status).toBe(201);
  const signedBody = (await signed.json()) as { grant: { id: string }; secret: string };
  const signedStart = await worker.fetch(
    new Request(`https://local.test/api/embeds/${signedBody.grant.id}/startup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Embed-Secret": signedBody.secret, Origin: ORIGIN },
      body: JSON.stringify({}),
    }),
    bindings,
  );
  expect(signedStart.status).toBe(201);
  const signedHandle = ((await signedStart.json()) as { handle: string }).handle;
  const signedHere = await publicSubmit({ handle: signedHandle, values: { name: "Ada" } }, keyFor("signed-here"));
  expect(signedHere.status).toBe(422);
  // And an anonymous session is foreign on the operator route: STALE there
  // too. (The operator submit needs an Idempotency-Key; without one it
  // answers 400 before the handle is even read, so the stale is proven
  // keyed.)
  const there = await startupOk(pub.id);
  const keyed = new Request("https://local.test/api/forms/contact/submit", {
    method: "POST",
    headers: headers({ "Idempotency-Key": keyFor("anon-there") }),
    body: JSON.stringify({ handle: there.handle, values: { name: "Ada" } }),
  });
  const keyedResponse = await worker.fetch(keyed, { ...bindings, LAB_ORG_ID: ORG, LAB_FIXTURE_USER_ID: OWNER });
  expect(keyedResponse.status).toBe(422);
  expect(await keyedResponse.json()).toMatchObject({ error: { code: "STALE_FORM_HANDLE" } });
});

it("refuses caller file references: no anonymous upload path, no ownership proof", async () => {
  await createForm("papers", [
    { name: "name", type: "text", required: true },
    { name: "doc", type: "file", required: false, file: { location: "briefs" } },
  ]);
  const pub = await publish("papers");
  const started = await startupOk(pub.id);
  // Any presented file reference fails closed: this slice ships no
  // anonymous upload path, so no reference can prove session ownership.
  const refused = await publicSubmit(
    { handle: started.handle, values: { name: "Ada", doc: { location: "briefs", path: "a/b.pdf" } } },
    keyFor("file-refused"),
  );
  expect(refused.status).toBe(422);
  expect(await refused.json()).toMatchObject({
    error: { code: "FORM_VALIDATION_FAILED", details: [{ field: "doc", code: "FILE_NOT_SESSION_OWNED" }] },
  });
  // Explicitly cleared file fields pass the refusal (a gap, not a ref) and
  // stay confirmation-only.
  const clearedSession = await startupOk(pub.id);
  const cleared = await publicSubmit(
    { handle: clearedSession.handle, values: { name: "Ada", doc: null } },
    keyFor("file-cleared"),
  );
  expect(cleared.status).toBe(202);
  expect(await cleared.json()).toEqual({ form: "papers", received: true });
});

it("fails closed on capability drift until the admin reviews, and blocks on disable", async () => {
  await createForm("contact", HELLO_FIELDS, { title: "Hello" });
  const pub = await publish("contact");
  await startupOk(pub.id);

  // A field edit changes the fingerprint: bootstrap answers 409
  // PUBLICATION_STALE, and outstanding sessions answer STALE at submit.
  const edited = await call("/api/forms/contact", "PUT", {
    sagaId: helloSaga.id,
    title: "Hello",
    fields: [...HELLO_FIELDS, { name: "nick", type: "text", required: false }],
  });
  expect(edited.status).toBe(200);
  const changed = await publicStartup(pub.id);
  expect(changed.status).toBe(409);
  expect(await changed.json()).toMatchObject({ error: { code: "PUBLICATION_STALE" } });
  const fetched = await call("/api/forms/contact/publication", "GET");
  expect(((await fetched.json()) as { publication: PublicationReceipt }).publication.stale).toBe(true);

  // Review without the deliberate bit never rebinds.
  const sloppy = await call("/api/forms/contact/publication/review", "POST", { approve: false });
  expect(sloppy.status).toBe(400);
  expect((await publicStartup(pub.id)).status).toBe(409);
  // Reviewing re-fingerprints against the live declaration: bootstrap heals
  // and the stored fingerprint visibly advances.
  const reviewed = await call("/api/forms/contact/publication/review", "POST", { approve: true });
  expect(reviewed.status).toBe(200);
  const reviewedBody = ((await reviewed.json()) as { publication: PublicationReceipt }).publication;
  expect(reviewedBody.fingerprint).not.toBe(pub.fingerprint);
  expect(reviewedBody.stale).toBe(false);
  expect((await publicStartup(pub.id)).status).toBe(201);

  // A Saga rebind is a capability change too (the fingerprint binds the
  // Saga id, not just the declaration bytes).
  expect(
    (
      await call("/api/forms/contact", "PUT", {
        sagaId: echoSaga.id,
        title: "Hello",
        fields: [...HELLO_FIELDS, { name: "nick", type: "text", required: false }],
      })
    ).status,
  ).toBe(200);
  expect((await publicStartup(pub.id)).status).toBe(409);
  expect((await call("/api/forms/contact/publication/review", "POST", { approve: true })).status).toBe(200);
  expect((await publicStartup(pub.id)).status).toBe(201);

  // Disabling blocks the publication: bootstrap answers 404
  // FORM_NOT_PUBLISHED (blocked means gone to the outside world).
  expect((await call("/api/forms/contact/publication", "DELETE", {})).status).toBe(200);
  const blocked = await publicStartup(pub.id);
  expect(blocked.status).toBe(404);
  expect(await blocked.json()).toMatchObject({ error: { code: "FORM_NOT_PUBLISHED" } });
  // Unknown publication IDs answer bare 404, never a capability signal —
  // and malformed IDs answer 404 before any lookup.
  expect((await publicStartup("00000000-0000-4000-8000-000000000000")).status).toBe(404);
  expect((await publicStartup("0".repeat(36))).status).toBe(404);
  // Disabling a form with no publication is idempotent null, not an error.
  await createForm("never-pub");
  const neverBlocked = await call("/api/forms/never-pub/publication", "DELETE", {});
  expect(neverBlocked.status).toBe(200);
  expect(((await neverBlocked.json()) as { publication: null }).publication).toBeNull();
  // Re-publishing re-enables the same public link.
  expect((await publish("contact", {}, ORG, 200)).id).toBe(pub.id);
  expect((await publicStartup(pub.id)).status).toBe(201);
  // Reviewing a form with no publication answers 404 FORM_NOT_PUBLISHED.
  await createForm("unpublished");
  const reviewMissing = await call("/api/forms/unpublished/publication/review", "POST", { approve: true });
  expect(reviewMissing.status).toBe(404);
});

it("review never revives a pre-change startup handle", async () => {
  await createForm("contact");
  const pub = await publish("contact");
  const started = await startupOk(pub.id);

  // A field edit changes the fingerprint: the pre-change handle answers
  // STALE at submit while the publication still names the old declaration.
  expect(
    (
      await call("/api/forms/contact", "PUT", {
        sagaId: helloSaga.id,
        title: "Hello",
        fields: [...HELLO_FIELDS, { name: "nick", type: "text", required: false }],
      })
    ).status,
  ).toBe(200);
  const stale = await publicSubmit({ handle: started.handle, values: { name: "Ada" } }, keyFor("revive-before"));
  expect(stale.status).toBe(422);
  expect(await stale.json()).toMatchObject({ error: { code: "STALE_FORM_HANDLE" } });

  // Review heals the publication for new startups ...
  expect((await call("/api/forms/contact/publication/review", "POST", { approve: true })).status).toBe(200);

  // ... but the same pre-change handle stays stale instead of being
  // revived by the re-bind (EMBED-01 hardening, issue #156).
  const revived = await publicSubmit({ handle: started.handle, values: { name: "Ada" } }, keyFor("revive-after"));
  expect(revived.status).toBe(422);
  expect(await revived.json()).toMatchObject({ error: { code: "STALE_FORM_HANDLE" } });

  // A fresh bootstrap after review submits the new declaration with the
  // confirmation-only receipt (no execution disclosure).
  const fresh = await startupOk(pub.id);
  const submitted = await publicSubmit({ handle: fresh.handle, values: { name: "Ada" } }, keyFor("revive-fresh"));
  expect(submitted.status).toBe(202);
  expect(await submitted.json()).toEqual({ form: "contact", received: true });
});

it("kills outstanding sessions when the publication or form dies after startup", async () => {
  await createForm("volatile");
  const pub = await publish("volatile");
  const started = await startupOk(pub.id);
  // Disabling after startup kills the outstanding session at submit: STALE.
  expect((await call("/api/forms/volatile/publication", "DELETE", {})).status).toBe(200);
  const dead = await publicSubmit({ handle: started.handle, values: { name: "Ada" } }, keyFor("dead-pub"));
  expect(dead.status).toBe(422);
  expect(await dead.json()).toMatchObject({ error: { code: "STALE_FORM_HANDLE" } });

  // Deleting the form does the same (the publication dangles until the
  // admin re-publishes or it stays blocked).
  await createForm("doomed");
  const doomed = await publish("doomed");
  const doomedSession = await startupOk(doomed.id);
  expect((await call("/api/forms/doomed", "DELETE")).status).toBe(200);
  const gone = await publicSubmit({ handle: doomedSession.handle, values: { name: "Ada" } }, keyFor("dead-form"));
  expect(gone.status).toBe(422);
});

it("denies external callers any dependency traversal", async () => {
  // A table-backed select exists with live rows, readable by operators.
  expect((await call("/api/tables", "POST", { name: "teams" })).status).toBe(201);
  expect((await call("/api/tables/teams/rows/t1", "PUT", { data: { team: "red" } })).status).toBe(201);
  await createForm("scoped", [
    { name: "name", type: "text", required: true },
    { name: "pick", type: "select", required: false, provider: { kind: "table", table: "teams", valueField: "team" } },
  ]);
  const pub = await publish("scoped");
  // The anonymous principal holds no Table grant: options resolve empty
  // with no leak, and submitting a traversed value fails option membership.
  const started = await startupOk(pub.id);
  expect(started.options["pick"]).toEqual([]);
  const traversed = await publicSubmit(
    { handle: started.handle, values: { name: "Ada", pick: "red" } },
    keyFor("traverse-table"),
  );
  expect(traversed.status).toBe(422);
  // ... while the operator path on the same form resolves the table.
  const operatorStart = await call("/api/forms/scoped/startup", "POST", {});
  expect(operatorStart.status).toBe(201);
  expect(((await operatorStart.json()) as { options: Record<string, string[]> }).options["pick"]).toEqual(["red"]);
});

it("scopes publications to one tenant: foreign admins see nothing, submits bind home", async () => {
  await createForm();
  const pub = await publish("contact");
  // The same form name in ORG_B has no publication: null, not org A's row.
  const otherForm = await call(
    "/api/forms",
    "POST",
    { name: "contact", sagaId: helloSaga.id, fields: HELLO_FIELDS },
    ORG_B,
  );
  expect(otherForm.status).toBe(201);
  const moved = await call("/api/forms/contact/publication", "GET", undefined, ORG_B);
  expect(moved.status).toBe(200);
  expect(((await moved.json()) as { publication: null }).publication).toBeNull();
  // OWNER admins ORG_B: publishing org B's own same-named form creates a
  // distinct tenant-scoped row, never touching org A's publication.
  const otherPub = await publish("contact", {}, ORG_B, 201);
  expect(otherPub.id).not.toBe(pub.id);
  const refetched = await call("/api/forms/contact/publication", "GET");
  expect(((await refetched.json()) as { publication: PublicationReceipt }).publication.id).toBe(pub.id);
  // Anonymous submissions bind the publication's home org and Saga: a
  // stranger's tenant gains nothing observable.
  const started = await startupOk(pub.id);
  const before = await executionCount();
  expect((await publicSubmit({ handle: started.handle, values: { name: "Ada" } }, keyFor("tenant-bind"))).status).toBe(
    202,
  );
  expect(await executionCount()).toBe(before + 1);
  const admitted = await bindings.DB.prepare(
    "SELECT org_id, saga_id FROM executions WHERE org_id=? ORDER BY rowid DESC LIMIT 1",
  )
    .bind(ORG)
    .first<{ org_id: string; saga_id: string }>();
  expect(admitted).toMatchObject({ org_id: ORG, saga_id: helloSaga.id });
});

it("keeps the anonymous class distinct at the helper layer", () => {
  const pubId = crypto.randomUUID().toLowerCase();
  // Principal parsing never cross-accepts signed or operator subjects.
  expect(anonPubIdFromUser(`anon:${pubId}`)).toBe(pubId);
  expect(anonPubIdFromUser(`embed:${pubId}`)).toBeNull();
  expect(anonPubIdFromUser(`appembed:${pubId}`)).toBeNull();
  expect(anonPubIdFromUser("anon:not-a-uuid")).toBeNull();
  expect(anonPubIdFromUser(OWNER)).toBeNull();
  // Honeypot names default, validate shape, and never collide with fields.
  expect(parseHoneypotField(undefined, ["name"])).toBe("wrangnarok_hp");
  expect(parseHoneypotField("website_url", ["name"])).toBe("website_url");
  expect(() => parseHoneypotField("name", ["name"])).toThrow("collides");
  expect(() => parseHoneypotField("9lives", ["name"])).toThrow("field-shaped");
  expect(() => parseHoneypotField(undefined, ["name", "wrangnarok_hp"])).toThrow("collides");
  // The file posture refuses presented refs and passes gaps.
  const fields = [{ name: "doc", type: "file" }];
  try {
    assertNoPublicFileRefs(fields, { doc: { location: "briefs", path: "a/b.pdf" } });
    expect.unreachable("presented file refs must fail closed");
  } catch (error) {
    expect((error as { code: string }).code).toBe("FORM_VALIDATION_FAILED");
    expect((error as { details: { code: string }[] }).details[0]?.code).toBe("FILE_NOT_SESSION_OWNED");
  }
  expect(assertNoPublicFileRefs(fields, { doc: null })).toBeUndefined();
  expect(assertNoPublicFileRefs(fields, null)).toBeUndefined();
});

it("keeps anonymous routes on the shared JSON, query, and CORS gates", async () => {
  await createForm();
  const pub = await publish("contact");
  // Query strings stay deny-by-default on anonymous routes.
  expect(
    (
      await worker.fetch(
        new Request(`https://local.test/api/public/${pub.id}/startup?x=1`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
        bindings,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await worker.fetch(
        new Request("https://local.test/api/public/submit?x=1", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": keyFor("q"), Origin: ORIGIN },
          body: "{}",
        }),
        bindings,
      )
    ).status,
  ).toBe(400);
  // Unencoded bodies reject (the JSON-write gate).
  const unencoded = await worker.fetch(
    new Request(`https://local.test/api/public/${pub.id}/startup`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", Origin: ORIGIN },
      body: "{}",
    }),
    bindings,
  );
  expect(unencoded.status).toBe(415);
  // CORS preflights answer 204 without touching the publication, and
  // receipts carry Allow-Origin + Vary so browsers can read confirmations.
  const preflight = await worker.fetch(
    new Request("https://local.test/api/public/submit", { method: "OPTIONS", headers: { Origin: ORIGIN } }),
    bindings,
  );
  expect(preflight.status).toBe(204);
  const started = await startupOk(pub.id);
  const submitted = await publicSubmit({ handle: started.handle, values: { name: "Ada" } }, keyFor("cors-read"));
  expect(submitted.status).toBe(202);
  expect(submitted.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
});
