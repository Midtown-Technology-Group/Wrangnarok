// SPDX-License-Identifier: AGPL-3.0
// Anonymous public forms (EMBED-01 slice 2, issue #156).
//
// A public-form publication is an anonymous admission class distinct from
// both signed grants (slice-1 form embeds in src/embeds.ts, slice-2 app
// embeds in src/app-embeds.ts): one row in `form_publications` (migration
// 0036) binding (org, form id, form name) to a capability fingerprint and a
// honeypot field name. There is NO secret material — the publication ID is
// a public identifier (unguessable UUID lookup key, the same posture as the
// public branding org UUID), never a credential. Anyone holding the link
// may bootstrap a FORM-02 startup session and submit; disclosure is
// confirmation-only throughout.
//
// Confirmation-only: anonymous submit dispatches down the standard submit
// protocol (the shared runFormSubmit core — one execution path) but the
// receipt carries `{ form, received: true }` only: no execution ID, no
// status URL, no Location header, no history. Anonymous callers hold no
// session, so the authenticated execution/history routes stay unreachable
// to them. The honeypot spam trap answers the identical confirmation
// without dispatching, so bots learn nothing from the response shape.
//
// Anti-abuse (proportionate, Worker + D1 only, no new primitive): the
// single-use startup handle IS the submission nonce (random 64-hex,
// SHA-256 persisted, 30-minute TTL, peek-then-consume fence with
// claimed_key idempotency — the FORM-02 contract), plus a server-checked
// honeypot field (default `wrangnarok_hp`, admin-overridable at publish,
// must never collide with a declared field name). A Turnstile/CAPTCHA
// binding is deliberately deferred: it needs a new secret binding and a
// vendor round-trip that the Free-tier slice cannot justify while
// honeypot + nonce + confirmation-only (no oracle) close the cheap abuse
// shapes. That deferral is recorded in the slice-2 ADR.
//
// Upload ownership: anonymous submissions carry no caller-supplied file
// references. There is no anonymous upload path in this slice, so no
// reference can prove session ownership — the same fail-closed posture as
// slice-1 embeds (FILE_NOT_SESSION_OWNED), enforced on the raw submitted
// values before the shared core runs.
//
// Republish review: the publication records the declaration fingerprint at
// publish/review time (SHA-256 over the bound Saga id plus the canonical
// declaration bytes — fingerprintFormDef, the slice-1 serializer). A form
// edit, or a delete/recreate that changes the form id under the same name,
// makes the publication stale: anonymous bootstrap answers 409
// PUBLICATION_STALE and outstanding sessions answer STALE_FORM_HANDLE at
// submit. The admin re-approves deliberately through the review route,
// which re-fingerprints against the live declaration. Fail-closed plus
// review is the whole stale-capability story for the anonymous class.
//
// Blocking: disabling a publication answers 404 FORM_NOT_PUBLISHED on the
// anonymous routes (the publication is not a thing to the outside world
// anymore) and outstanding sessions die with STALE_FORM_HANDLE at submit.
// Disable is idempotent; re-publishing re-enables the same public link.
//
// The anonymous principal (`anon:<publicationId>`) is distinct from the
// signed principals (`embed:<grantId>`, `appembed:<grantId>`): the three
// tables never cross-resolve, sessions never cross-accept, and the
// principal holds no membership, no roles, and no grants, so Table
// providers deny by absence and a publication can never traverse to
// Tables, live file bytes, another form, an unrelated Saga, or another
// tenant. The Saga invoked is always the publication's bound form
// declaration — caller input names nothing.
import { Fault, UUID } from "./domain";
import { assertNoEmbedFileRefs, fingerprintFormDef } from "./embeds";
import type { FormDefinition } from "./forms";

/** Default honeypot field: an unlikely-declared name bots still fill. */
export const PUBLIC_HONEYPOT_DEFAULT = "wrangnarok_hp";
/** Honeypot names share the form field-name shape (never a declared name). */
const HONEYPOT_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

export interface PublicationRow {
  id: string;
  org_id: string;
  form_id: string;
  form_name: string;
  honeypot_field: string;
  capability_fingerprint: string;
  enabled: number;
  created_at: string;
  reviewed_at: string | null;
  last_used_at: string | null;
}

export interface PublicationSummary {
  readonly id: string;
  readonly formName: string;
  readonly honeypotField: string;
  readonly fingerprint: string;
  readonly enabled: boolean;
  /** True when the live declaration drifted since publish/review. */
  readonly stale: boolean;
  readonly createdAt: string;
  readonly reviewedAt: string | null;
  readonly lastUsedAt: string | null;
}

function invalid(message: string): Fault {
  return new Fault(400, "INVALID_PUBLICATION", message);
}

/** Validate the honeypot field: shape-checked, never a declared field. The
 * default is validated too — a form declaring `wrangnarok_hp` must pick an
 * explicit alternative at publish time. */
export function parseHoneypotField(value: unknown, declared: readonly string[]): string {
  const name = value === undefined || value === null ? PUBLIC_HONEYPOT_DEFAULT : value;
  if (typeof name !== "string" || !HONEYPOT_RE.test(name)) {
    throw invalid("honeypotField must be a field-shaped name (letter, then letters/digits/underscores, at most 64).");
  }
  if (declared.includes(name)) {
    throw invalid(`honeypotField "${name}" collides with a declared form field.`);
  }
  return name;
}

/** Load one publication by ID across Organizations (pre-gate anonymous
 * routes): the ID is a public lookup key, never a credential. Unknown IDs
 * answer 404. */
export async function loadPublication(db: D1Database, pubId: string): Promise<PublicationRow | null> {
  const row = await db.prepare("SELECT * FROM form_publications WHERE id=?").bind(pubId).first<PublicationRow>();
  return row ?? null;
}

/** Load one publication scoped to its (org, form) admin route: foreign
 * rows resolve to null so the route answers 404, never a cross-tenant
 * signal. */
export async function loadScopedPublication(
  db: D1Database,
  orgId: string,
  formName: string,
): Promise<PublicationRow | null> {
  const row = await db
    .prepare("SELECT * FROM form_publications WHERE org_id=? AND form_name=?")
    .bind(orgId, formName)
    .first<PublicationRow>();
  return row ?? null;
}

/** Parse a publication ID from the route. Unknown shapes answer 404. */
export function parsePublicationId(value: string): string {
  if (!UUID.test(value)) throw new Fault(404, "NOT_FOUND", "Not found.");
  return value.toLowerCase();
}

/** Operator-facing summary. There is no secret material in this class, so
 * the summary carries everything the admin needs, including the live
 * staleness bit the review UX keys on. */
export function publicationSummary(
  row: PublicationRow,
  live: { formId: string; fingerprint: string } | null,
): PublicationSummary {
  const stale = live === null || row.form_id !== live.formId || row.capability_fingerprint !== live.fingerprint;
  return {
    id: row.id,
    formName: row.form_name,
    honeypotField: row.honeypot_field,
    fingerprint: row.capability_fingerprint,
    enabled: row.enabled === 1,
    stale,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    lastUsedAt: row.last_used_at,
  };
}

/** Publish (or re-publish) one loaded form definition: validate the
 * honeypot field, fingerprint the live declaration, and upsert the
 * (org, form) row — the public link (publication ID) stays stable across
 * disable/re-publish cycles. Re-publishing a stale publication heals it
 * (same effect as review). */
export async function publishForm(
  db: D1Database,
  def: FormDefinition,
  input: { honeypotField?: unknown },
): Promise<PublicationRow> {
  const declared = def.fields.map((field) => field.name);
  const honeypot = parseHoneypotField(input.honeypotField, declared);
  const fingerprint = await fingerprintFormDef(def);
  const existing = await loadScopedPublication(db, def.orgId, def.name);
  const now = new Date().toISOString();
  if (!existing) {
    const id = crypto.randomUUID().toLowerCase();
    await db
      .prepare(
        "INSERT INTO form_publications(id,org_id,form_id,form_name,honeypot_field,capability_fingerprint,enabled,created_at,reviewed_at,last_used_at) VALUES (?,?,?,?,?,?,1,?,NULL,NULL)",
      )
      .bind(id, def.orgId, def.id, def.name, honeypot, fingerprint, now)
      .run();
    return {
      id,
      org_id: def.orgId,
      form_id: def.id,
      form_name: def.name,
      honeypot_field: honeypot,
      capability_fingerprint: fingerprint,
      enabled: 1,
      created_at: now,
      reviewed_at: null,
      last_used_at: null,
    };
  }
  await db
    .prepare(
      "UPDATE form_publications SET form_id=?,honeypot_field=?,capability_fingerprint=?,enabled=1,reviewed_at=? WHERE id=?",
    )
    .bind(def.id, honeypot, fingerprint, now, existing.id)
    .run();
  return {
    ...existing,
    form_id: def.id,
    honeypot_field: honeypot,
    capability_fingerprint: fingerprint,
    enabled: 1,
    reviewed_at: now,
  };
}

/** Block a publication: anonymous bootstrap answers 404 and outstanding
 * sessions die with STALE at submit. Idempotent. Unknown or foreign forms
 * answer 404 (the route loads the form first). */
export async function disablePublication(
  db: D1Database,
  orgId: string,
  formName: string,
): Promise<PublicationRow | null> {
  const existing = await loadScopedPublication(db, orgId, formName);
  if (!existing) return null;
  await db.prepare("UPDATE form_publications SET enabled=0 WHERE id=?").bind(existing.id).run();
  return { ...existing, enabled: 0 };
}

/** Review a capability change: re-fingerprint against the live declaration
 * so anonymous bootstrap/submit admit again. The body must carry
 * { approve: true } — the route enforces the deliberate bit; this
 * function binds the live declaration. */
export async function reviewPublication(db: D1Database, def: FormDefinition): Promise<PublicationRow | null> {
  const existing = await loadScopedPublication(db, def.orgId, def.name);
  if (!existing) return null;
  const fingerprint = await fingerprintFormDef(def);
  const now = new Date().toISOString();
  await db
    .prepare("UPDATE form_publications SET form_id=?,capability_fingerprint=?,reviewed_at=? WHERE id=?")
    .bind(def.id, fingerprint, now, existing.id)
    .run();
  return { ...existing, form_id: def.id, capability_fingerprint: fingerprint, reviewed_at: now };
}

/** Enforce the capability binding on the anonymous path: a form edit, or a
 * delete/recreate that changes the form id under the same name, answers
 * 409 PUBLICATION_STALE at bootstrap (submit answers STALE_FORM_HANDLE —
 * the FORM-02 definition-mismatch contract — since a session exists). */
export function checkPublicationBinding(pub: PublicationRow, live: { formId: string; fingerprint: string }): void {
  if (pub.form_id !== live.formId || pub.capability_fingerprint !== live.fingerprint) {
    throw new Fault(
      409,
      "PUBLICATION_STALE",
      "This form changed since publication. The owner must review the publication before new submissions.",
    );
  }
}

/** Honeypot verdict over the raw submitted values: a non-empty honeypot
 * field marks the submission as automated. Non-objects are the validator's
 * to reject — never spam here. */
export function isHoneypotFilled(values: unknown, honeypotField: string): boolean {
  if (values === null || typeof values !== "object" || Array.isArray(values)) return false;
  const presented = (values as Record<string, unknown>)[honeypotField];
  return presented !== undefined && presented !== null && presented !== "";
}

/** Anonymous file posture: refuse any caller-supplied file reference (no
 * anonymous upload path exists, so no reference can prove session
 * ownership). Author-declared defaults merge server-side and are out of
 * scope here. */
export function assertNoPublicFileRefs(
  fields: readonly { readonly name: string; readonly type: string }[],
  values: unknown,
): void {
  assertNoEmbedFileRefs(fields, values);
}

/** Record a successful anonymous bootstrap for admin hygiene. */
export async function touchPublicationUse(db: D1Database, pubId: string): Promise<void> {
  await db
    .prepare("UPDATE form_publications SET last_used_at=? WHERE id=?")
    .bind(new Date().toISOString(), pubId)
    .run();
}

/** The anonymous principal for one publication. Distinct from the signed
 * `embed:*` / `appembed:*` classes and from every operator subject. */
export function anonPrincipal(orgId: string, pubId: string): { orgId: string; userId: string } {
  return { orgId, userId: `anon:${pubId}` };
}

/** Parse an anonymous session principal back to its publication ID.
 * Signed-grant, operator, and service subjects answer null — the three
 * external classes never accept each other's sessions. */
export function anonPubIdFromUser(userId: string): string | null {
  if (!userId.startsWith("anon:")) return null;
  const pubId = userId.slice("anon:".length);
  return UUID.test(pubId) ? pubId.toLowerCase() : null;
}
