// SPDX-License-Identifier: AGPL-3.0
// TRG-02 (issue #138, ADR 018): authenticated webhook and custom HTTP
// execution endpoints.
//
// Upstream inventory (pins at gobifrost/bifrost@3543c7e):
// - `api/src/routers/endpoints.py`: POST /api/endpoints/{workflow_id} with an
//   X-Bifrost-Key API key (per-workflow, hashed, expirable, revocable) runs the
//   workflow in sync mode (queue plus Redis BLPOP wait for the result) or
//   async mode (queue, immediate receipt). Sync/async is a persisted workflow
//   setting, not caller choice.
// - `api/src/routers/workflow_keys.py`: one key per workflow, raw value shown
//   once at creation, SHA-256 stored, expiry plus last-used bookkeeping, admin
//   revoke. No global keys.
// - `api/src/routers/hooks.py`: public /api/hooks/{source_id} receiver keyed
//   by an unguessable UUID path. No bearer auth; security is the UUID path
//   plus adapter validation. Per-source rate limiting before any DB write,
//   then 202 Accepted on delivery (queued, never inline).
// - `api/src/services/webhooks/adapters/generic.py`: optional HMAC-SHA256
//   body signature (configurable header/prefix), vendor challenge answers via
//   ValidationResponse, rejected signatures as 401, accepted payloads delivered
//   as events carrying data plus event type.
//
// Cloudflare mapping (ADR 018): an Endpoint is persisted environment state
// (upstream finding 3, never Saga source metadata): one org-scoped row binding
// a name to a stable Saga UUID plus a kind. `api-key` endpoints verify a
// per-endpoint bearer key (SHA-256 stored, constant-time compare, expiry,
// revocation via disable). `webhook` endpoints verify an HMAC-SHA256 body
// signature against a secret held in the deployment secret store (D1 keeps
// only the SHA-256 confirmation digest), answer an echo-param vendor
// challenge with 200 plaintext (never an Execution), and rate-limit per
// endpoint before any D1 write. Both kinds bound request bodies, map the
// vendor payload to the Saga input through the Saga parse gate, and enter the
// standard submit protocol: redelivery of the same vendor event ID converges
// via deterministic key derivation plus same-key replay, mismatched
// duplicates answer 409 IDEMPOTENCY_CONFLICT, and the synchronous HTTP
// response stays distinct from the asynchronous Execution receipt (202 plus
// statusUrl, never inline results). Organization and run-as identity always
// come from the endpoint row itself, never from caller-supplied org/user
// fields, which are rejected loudly.
import { BODY_LIMIT, Fault, hash, parseKey, parseSubmission, UUID } from "./domain";
import type { Principal, SagaDef } from "./domain";
import { submit } from "./executions";

export const ENDPOINT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SAFE_EVENT_CHAR = /^[a-zA-Z0-9._:-]+$/;
/** Delivery/event IDs come from vendors; cap at 128 chars of safe alphabet. */
export const ENDPOINT_EVENT_MAX = 128;
/** Vendor challenge echo cap: short plaintext handshake only, never a body. */
export const ENDPOINT_CHALLENGE_MAX = 512;
/** Per-endpoint inbound rate-limit window rows retained in D1 (minute buckets). */
export const ENDPOINT_RATE_WINDOW_MS = 60_000;
/** Signature header cap: 512 chars of hex plus the vendor prefix. */
const SIGNATURE_MAX = 512;

export type EndpointKind = "api-key" | "webhook";

export interface EndpointRow {
  id: string;
  org_id: string;
  name: string;
  saga_id: string;
  kind: EndpointKind;
  enabled: number;
  key_hash: string | null;
  key_expires_at: string | null;
  signature_secret_hash: string | null;
  challenge: "none" | "echo-param";
  rate_limit_per_minute: number | null;
  created_at: string;
}

export interface EndpointPrincipal extends Principal {
  readonly endpointId: string;
  readonly endpointName: string;
}

function invalid(code: string, message: string, status = 400): Fault {
  return new Fault(status, code, message);
}

/** Parse an endpoint name from the route. Unknown shapes answer 404, never a leak. */
export function parseEndpointName(name: string): string {
  if (!ENDPOINT_NAME.test(name)) throw new Fault(404, "NOT_FOUND", "Not found.");
  return name;
}

/** Load one endpoint row for exact-org visibility: foreign rows resolve to
 * null so the route answers 404, never a cross-tenant leak. Disabled rows
 * resolve normally here; the caller maps them to 410/404 explicitly. */
export async function loadEndpoint(db: D1Database, orgId: string, name: string): Promise<EndpointRow | null> {
  const row = await db
    .prepare('SELECT * FROM "endpoints" WHERE org_id=? AND name=?')
    .bind(orgId, name)
    .first<EndpointRow>();
  return row ?? null;
}

/** Constant-time string equality over fixed-length hex digests. */
async function timingEqualHex(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([hash(left), hash(right)]);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

/** Verify `api-key` endpoint credentials. Throws 401 on wrong/missing/expired
 * keys and 410 on disabled or revoked endpoints. */
export async function verifyEndpointKey(endpoint: EndpointRow, supplied: string | null): Promise<EndpointPrincipal> {
  if (endpoint.enabled !== 1 || endpoint.key_hash === null) {
    throw new Fault(410, "ENDPOINT_DISABLED", "This endpoint is disabled.");
  }
  if (endpoint.key_expires_at !== null && Date.parse(endpoint.key_expires_at) <= Date.now()) {
    throw new Fault(401, "ENDPOINT_KEY_EXPIRED", "This endpoint key has expired.");
  }
  if (supplied === null || supplied.length === 0 || supplied.length > 256) {
    throw new Fault(401, "ENDPOINT_UNAUTHORIZED", "A valid endpoint key is required.");
  }
  // The stored value is a SHA-256 hex digest of the raw key: digest the
  // supplied key once and compare digests in constant time (never raw
  // secrets, never a double hash of the stored digest).
  const suppliedHash = await hash(supplied);
  if (suppliedHash.length !== 64 || endpoint.key_hash.length !== 64) {
    throw new Fault(401, "ENDPOINT_UNAUTHORIZED", "A valid endpoint key is required.");
  }
  let difference = 0;
  for (let i = 0; i < 64; i++) {
    difference |= suppliedHash.charCodeAt(i) ^ endpoint.key_hash.charCodeAt(i);
  }
  if (difference !== 0) throw new Fault(401, "ENDPOINT_UNAUTHORIZED", "A valid endpoint key is required.");
  return {
    orgId: endpoint.org_id,
    userId: `endpoint:${endpoint.id}`,
    endpointId: endpoint.id,
    endpointName: endpoint.name,
  };
}

/** Parse the deployment secret binding (ENDPOINT_WEBHOOK_SECRETS): a JSON
 * object mapping endpoint ID to its raw HMAC secret. Unparseable bindings
 * fail closed to empty (no webhook can verify) rather than throwing. */
export function parseWebhookSecrets(value: string | undefined): ReadonlyMap<string, string> {
  if (value === undefined || value.length === 0) return new Map();
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    const out = new Map<string, string>();
    for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof entry === "string" && entry.length > 0) out.set(key, entry);
    }
    return out;
  } catch {
    return new Map();
  }
}

/** Verify a `webhook` endpoint HMAC-SHA256 body signature. The raw request
 * bytes are signed with the endpoint secret; D1 holds only the SHA-256
 * confirmation digest of the secret (never the secret itself), and the raw
 * secret arrives via the deployment secret binding (ADR 005 v0:
 * deployment-level secrets). Throws 401 on missing/invalid signatures, 410
 * on disabled endpoints. */
export async function verifyWebhookSignature(
  endpoint: EndpointRow,
  rawBody: Uint8Array,
  signature: string | null,
  secrets: ReadonlyMap<string, string>,
): Promise<EndpointPrincipal> {
  if (endpoint.enabled !== 1 || endpoint.signature_secret_hash === null) {
    throw new Fault(410, "ENDPOINT_DISABLED", "This endpoint is disabled.");
  }
  if (signature === null || signature.length === 0 || signature.length > SIGNATURE_MAX) {
    throw new Fault(401, "ENDPOINT_UNAUTHORIZED", "A valid webhook signature is required.");
  }
  const secret = secrets.get(endpoint.id);
  if (secret === undefined || (await hash(secret)) !== endpoint.signature_secret_hash) {
    throw new Fault(401, "ENDPOINT_UNAUTHORIZED", "A valid webhook signature is required.");
  }
  const prefixed = signature.startsWith("sha256=") ? signature.slice("sha256=".length) : signature;
  if (!/^[a-f0-9]{64}$/i.test(prefixed)) {
    throw new Fault(401, "ENDPOINT_UNAUTHORIZED", "A valid webhook signature is required.");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const computed = hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, rawBody as BufferSource)));
  if (!(await timingEqualHex(computed, prefixed.toLowerCase()))) {
    throw new Fault(401, "ENDPOINT_UNAUTHORIZED", "A valid webhook signature is required.");
  }
  return {
    orgId: endpoint.org_id,
    userId: `endpoint:${endpoint.id}`,
    endpointId: endpoint.id,
    endpointName: endpoint.name,
  };
}

/** Read the raw request body with the shared byte bound. Returns both the raw
 * bytes (for HMAC) and the parsed JSON. Oversized bodies answer 413 before
 * any signature work. */
export async function readWebhookBody(
  body: ReadableStream<Uint8Array> | null,
): Promise<{ raw: Uint8Array; parsed: unknown }> {
  if (body === null) throw new Fault(400, "INVALID_JSON", "A JSON body is required.");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > BODY_LIMIT) {
        await reader.cancel();
        throw new Fault(413, "BODY_TOO_LARGE", `The body exceeds ${BODY_LIMIT} bytes.`);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const raw = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw));
  } catch {
    throw new Fault(400, "INVALID_JSON", "The body must be valid UTF-8 JSON.");
  }
  return { raw, parsed };
}

/** Extract the vendor event/delivery ID: header first, then top-level payload
 * fields. Missing or malformed IDs answer 400 — replay convergence needs a
 * stable key and refuses to invent one. */
export function parseVendorEventId(headers: Headers, payload: unknown): string {
  const candidates: unknown[] = [
    headers.get("X-Endpoint-Event-Id"),
    headers.get("X-Webhook-Delivery"),
    ...(payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? [
          (payload as Record<string, unknown>).event_id,
          (payload as Record<string, unknown>).delivery_id,
          (payload as Record<string, unknown>).id,
        ]
      : []),
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed.length === 0 || trimmed.length > ENDPOINT_EVENT_MAX || !SAFE_EVENT_CHAR.test(trimmed)) continue;
    return trimmed;
  }
  throw invalid(
    "ENDPOINT_EVENT_ID_REQUIRED",
    "A vendor event ID (X-Endpoint-Event-Id header or event_id/delivery_id field) is required.",
  );
}

/** Derive the deterministic submit Idempotency-Key for one vendor event. The
 * 16-128 safe-alphabet rule (parseKey) is satisfied by construction: `wep-`
 * plus 64 hex. Same event converges via same-key replay; callers cannot
 * supply their own key on these routes (parseKey reserves the `wep-`
 * namespace for this derivation, so caller keys can never collide with it). */
export async function endpointIdempotencyKey(endpointId: string, eventId: string): Promise<string> {
  return `wep-${await hash(JSON.stringify(["wrangnarok.endpoint-event.v1", endpointId, eventId]))}`;
}

/** Map the vendor payload to the bound Saga input. Caller-supplied org/user
 * identity fields are rejected loudly — Organization and run-as always come
 * from the endpoint row, never the wire. The Saga parse gate stays
 * authoritative for the surviving fields. */
export function mapEndpointPayload(saga: SagaDef, payload: unknown): { saga: SagaDef; input: unknown } {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw invalid("INVALID_INPUT", "The endpoint payload must be a JSON object.");
  }
  const body = payload as Record<string, unknown>;
  for (const forbidden of ["orgId", "org_id", "organizationId", "userId", "user_id", "runAs"]) {
    if (forbidden in body) {
      throw invalid(
        "ENDPOINT_IDENTITY_FORBIDDEN",
        "Organization and run-as identity come from the endpoint, never the request body.",
      );
    }
  }
  // Vendor envelope convention: `{ "input": {...} }` carries the Saga input;
  // a bare object IS the Saga input. Anything else is a 400.
  const candidate = "input" in body && body.input !== undefined ? body.input : body;
  const { input } = parseSubmission({ sagaId: saga.id, input: candidate });
  return { saga, input };
}

/** Inbound per-endpoint rate limiting (abuse protection, ADR 018): minute
 * buckets in D1, checked before any Execution write. Over-limit answers 429
 * with Retry-After; the check is advisory under concurrency (two racers may
 * both pass) — Execution idempotency, not this counter, owns correctness. */
export async function checkEndpointRateLimit(db: D1Database, endpoint: EndpointRow): Promise<void> {
  const perMinute = endpoint.rate_limit_per_minute;
  if (perMinute === null) return;
  const windowStart = new Date(
    Math.floor(Date.now() / ENDPOINT_RATE_WINDOW_MS) * ENDPOINT_RATE_WINDOW_MS,
  ).toISOString();
  const existing = await db
    .prepare('SELECT hits FROM "endpoint_rate_windows" WHERE endpoint_id=? AND window_start=?')
    .bind(endpoint.id, windowStart)
    .first<{ hits: number }>()
    .catch(() => null);
  const hits = existing?.hits ?? 0;
  if (hits >= perMinute) {
    throw new Fault(429, "ENDPOINT_RATE_LIMITED", "This endpoint is receiving too many requests.");
  }
  await db
    .prepare(
      'INSERT INTO "endpoint_rate_windows"(endpoint_id,window_start,hits) VALUES (?,?,1) ON CONFLICT(endpoint_id,window_start) DO UPDATE SET hits=hits+1',
    )
    .bind(endpoint.id, windowStart)
    .run();
}

/** Answer a vendor challenge handshake (echo-param mode): `?challenge=<token>`
 * returns the token as plaintext with no Execution, no D1 write, and no
 * signature requirement — mirroring upstream ValidationResponse behavior.
 * Returns null when this request is not a challenge. */
export function vendorChallenge(endpoint: EndpointRow, url: URL): string | null {
  if (endpoint.challenge !== "echo-param") return null;
  const token = url.searchParams.get("challenge");
  if (token === null) return null;
  if (token.length === 0 || token.length > ENDPOINT_CHALLENGE_MAX || !SAFE_EVENT_CHAR.test(token)) {
    throw invalid("INVALID_CHALLENGE", "The vendor challenge must be 1 to 512 safe characters.");
  }
  return token;
}

/** Resolve the bound Saga from the static catalog. Unknown saga IDs are a
 * serverMisconfiguration (500 ENDPOINT_MISCONFIGURED): the endpoint row names
 * a Saga the deploy does not ship, and the vendor must not see details. */
export function resolveEndpointSagaId(endpoint: EndpointRow, catalog: readonly { id: string }[]): string {
  const found = catalog.some((entry) => entry.id === endpoint.saga_id);
  if (!found || !UUID.test(endpoint.saga_id)) {
    throw new Fault(500, "ENDPOINT_MISCONFIGURED", "This endpoint is not configured correctly.");
  }
  return endpoint.saga_id;
}

/** Load every endpoint row sharing one public name, in deterministic order.
 * Public delivery routes carry no caller Organization, so resolution is
 * global by name and the credential (key or HMAC secret) disambiguates
 * across Organizations — the same posture as upstream's guessable
 * workflow IDs plus secret keys. Names are not secret; credentials are. */
export async function loadEndpointsByName(db: D1Database, name: string): Promise<EndpointRow[]> {
  const rows = await db
    .prepare('SELECT * FROM "endpoints" WHERE name=? ORDER BY org_id,id')
    .bind(name)
    .all<EndpointRow>();
  return rows.results;
}

/** Authenticate an `api-key` delivery across same-named candidates. The first
 * verifiable key wins; otherwise the most specific failure surfaces (expired
 * before generic unauthorized, disabled only when nothing else explains the
 * rejection). Empty candidates answer 404, never a leak. */
export async function authenticateEndpointKey(
  rows: readonly EndpointRow[],
  supplied: string | null,
): Promise<{ principal: EndpointPrincipal; endpoint: EndpointRow }> {
  if (rows.length === 0) throw new Fault(404, "NOT_FOUND", "Not found.");
  let disabled = false;
  let expired: Fault | null = null;
  for (const endpoint of rows) {
    if (endpoint.enabled !== 1 || endpoint.key_hash === null) {
      disabled = true;
      continue;
    }
    try {
      const principal = await verifyEndpointKey(endpoint, supplied);
      return { principal, endpoint };
    } catch (error) {
      if (error instanceof Fault && error.code === "ENDPOINT_KEY_EXPIRED") expired = error;
      continue;
    }
  }
  if (expired) throw expired;
  if (disabled) throw new Fault(410, "ENDPOINT_DISABLED", "This endpoint is disabled.");
  throw new Fault(401, "ENDPOINT_UNAUTHORIZED", "A valid endpoint key is required.");
}

/** Authenticate a `webhook` delivery across same-named candidates. Empty
 * candidates answer 404; no enabled verifier answers 410; otherwise 401. */
export async function authenticateWebhook(
  rows: readonly EndpointRow[],
  rawBody: Uint8Array,
  signature: string | null,
  secrets: ReadonlyMap<string, string>,
): Promise<{ principal: EndpointPrincipal; endpoint: EndpointRow }> {
  if (rows.length === 0) throw new Fault(404, "NOT_FOUND", "Not found.");
  let disabled = false;
  for (const endpoint of rows) {
    if (endpoint.enabled !== 1 || endpoint.signature_secret_hash === null) {
      disabled = true;
      continue;
    }
    try {
      const principal = await verifyWebhookSignature(endpoint, rawBody, signature, secrets);
      return { principal, endpoint };
    } catch {
      continue;
    }
  }
  if (disabled && rows.every((endpoint) => endpoint.enabled !== 1 || endpoint.signature_secret_hash === null)) {
    throw new Fault(410, "ENDPOINT_DISABLED", "This endpoint is disabled.");
  }
  throw new Fault(401, "ENDPOINT_UNAUTHORIZED", "A valid webhook signature is required.");
}

/** First enabled echo-param candidate for the vendor challenge handshake.
 * Null when no same-named endpoint answers challenges. */
export function findChallengeEndpoint(rows: readonly EndpointRow[]): EndpointRow | null {
  return rows.find((endpoint) => endpoint.enabled === 1 && endpoint.challenge === "echo-param") ?? null;
}

export interface EndpointSummary {
  readonly id: string;
  readonly name: string;
  readonly sagaId: string;
  readonly kind: EndpointKind;
  readonly enabled: boolean;
  readonly keyExpiresAt: string | null;
  readonly challenge: "none" | "echo-param";
  readonly rateLimitPerMinute: number | null;
  readonly createdAt: string;
}

/** Operator-facing summary: identity and policy only. Digests and raw
 * credentials never leave the create/rotate responses. */
export function endpointSummary(row: EndpointRow): EndpointSummary {
  return {
    id: row.id,
    name: row.name,
    sagaId: row.saga_id,
    kind: row.kind,
    enabled: row.enabled === 1,
    keyExpiresAt: row.key_expires_at,
    challenge: row.challenge,
    rateLimitPerMinute: row.rate_limit_per_minute,
    createdAt: row.created_at,
  };
}

/** List this Organization's endpoint summaries, in name order. */
export async function listEndpoints(db: D1Database, orgId: string): Promise<EndpointSummary[]> {
  const rows = await db
    .prepare('SELECT * FROM "endpoints" WHERE org_id=? ORDER BY name')
    .bind(orgId)
    .all<EndpointRow>();
  return rows.results.map(endpointSummary);
}

export interface CreateEndpointInput {
  readonly name: string;
  readonly sagaId: string;
  readonly kind: EndpointKind;
  readonly rateLimitPerMinute?: number | null;
  readonly challenge?: "none" | "echo-param";
  readonly keyExpiresAt?: string | null;
}

export interface CreatedEndpoint {
  readonly row: EndpointRow;
  /** Raw credential, shown once in the create/rotate response and never again. */
  readonly rawCredential: string;
}

function badEndpoint(message: string): Fault {
  return new Fault(400, "INVALID_ENDPOINT", message);
}

function parseRateLimit(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 100_000) {
    throw badEndpoint("rateLimitPerMinute must be an integer from 1 to 100000, or null.");
  }
  return value as number;
}

function parseExpiry(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw badEndpoint("keyExpiresAt must be an ISO 8601 date-time, or null.");
  }
  return new Date(Date.parse(value)).toISOString();
}

function rawCredential(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Create a scoped endpoint bound to a deployed Saga. The raw credential
 * (api key, or webhook HMAC secret the operator must plant in the deployment
 * secret store) is returned once; D1 keeps only the SHA-256 digest. */
export async function createEndpoint(
  db: D1Database,
  orgId: string,
  input: CreateEndpointInput,
  sagaIds: readonly string[],
): Promise<CreatedEndpoint> {
  if (!ENDPOINT_NAME.test(input.name)) {
    throw badEndpoint("Endpoint names are 1 to 64 lowercase letters, digits, or dashes.");
  }
  if (!UUID.test(input.sagaId) || !sagaIds.includes(input.sagaId)) {
    throw new Fault(400, "UNKNOWN_SAGA", "The bound Saga ID is not in the deployed catalog.");
  }
  if (input.kind !== "api-key" && input.kind !== "webhook") {
    throw badEndpoint("Endpoint kind must be api-key or webhook.");
  }
  const challenge = input.challenge ?? "none";
  if (challenge !== "none" && challenge !== "echo-param") {
    throw badEndpoint("Challenge mode must be none or echo-param.");
  }
  if (input.kind === "api-key" && challenge !== "none") {
    throw badEndpoint("Challenge handshakes are webhook-only.");
  }
  const rateLimit = parseRateLimit(input.rateLimitPerMinute);
  const expiresAt = parseExpiry(input.keyExpiresAt);
  if (input.kind === "webhook" && expiresAt !== null) {
    throw badEndpoint("keyExpiresAt applies to api-key endpoints only.");
  }
  const raw = rawCredential();
  const digest = await hash(raw);
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const inserted = await db
    .prepare(
      'INSERT INTO "endpoints"(id,org_id,name,saga_id,kind,enabled,key_hash,key_expires_at,signature_secret_hash,challenge,rate_limit_per_minute,created_at) VALUES (?,?,?,?,?,1,?,?,?,?,?,?) ON CONFLICT(org_id,name) DO NOTHING',
    )
    .bind(
      id,
      orgId,
      input.name,
      input.sagaId,
      input.kind,
      input.kind === "api-key" ? digest : null,
      expiresAt,
      input.kind === "webhook" ? digest : null,
      challenge,
      rateLimit,
      createdAt,
    )
    .run();
  if (inserted.meta.changes === 0) {
    throw new Fault(409, "ENDPOINT_EXISTS", "An endpoint with this name already exists.");
  }
  const row: EndpointRow = {
    id,
    org_id: orgId,
    name: input.name,
    saga_id: input.sagaId,
    kind: input.kind,
    enabled: 1,
    key_hash: input.kind === "api-key" ? digest : null,
    key_expires_at: expiresAt,
    signature_secret_hash: input.kind === "webhook" ? digest : null,
    challenge,
    rate_limit_per_minute: rateLimit,
    created_at: createdAt,
  };
  return { row, rawCredential: raw };
}

export interface UpdateEndpointInput {
  readonly enabled?: boolean;
  readonly rateLimitPerMinute?: number | null;
  readonly keyExpiresAt?: string | null;
}

/** Update endpoint policy: disable/enable (revocation), rate limit, key
 * expiry. Unknown names (or foreign-Organization names) answer 404. */
export async function updateEndpoint(
  db: D1Database,
  orgId: string,
  name: string,
  patch: UpdateEndpointInput,
): Promise<EndpointRow> {
  const row = await loadEndpoint(db, orgId, name);
  if (!row) throw new Fault(404, "NOT_FOUND", "Not found.");
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") {
    throw badEndpoint("enabled must be a boolean.");
  }
  const rateLimit = parseRateLimit(patch.rateLimitPerMinute);
  const expiresAt = parseExpiry(patch.keyExpiresAt);
  if (row.kind === "webhook" && expiresAt !== null) {
    throw badEndpoint("keyExpiresAt applies to api-key endpoints only.");
  }
  const enabled = patch.enabled === undefined ? row.enabled : patch.enabled ? 1 : 0;
  const rate = patch.rateLimitPerMinute === undefined ? row.rate_limit_per_minute : rateLimit;
  const expiry = patch.keyExpiresAt === undefined ? row.key_expires_at : expiresAt;
  await db
    .prepare('UPDATE "endpoints" SET enabled=?,rate_limit_per_minute=?,key_expires_at=? WHERE id=?')
    .bind(enabled, rate, expiry, row.id)
    .run();
  return { ...row, enabled, rate_limit_per_minute: rate, key_expires_at: expiry };
}

/** Rotate an endpoint credential: the old raw value stops verifying, the new
 * raw value is returned once, and expiry policy is preserved. */
export async function rotateEndpointCredential(db: D1Database, orgId: string, name: string): Promise<CreatedEndpoint> {
  const row = await loadEndpoint(db, orgId, name);
  if (!row) throw new Fault(404, "NOT_FOUND", "Not found.");
  const raw = rawCredential();
  const digest = await hash(raw);
  if (row.kind === "api-key") {
    await db.prepare('UPDATE "endpoints" SET key_hash=? WHERE id=?').bind(digest, row.id).run();
    return { row: { ...row, key_hash: digest }, rawCredential: raw };
  }
  await db.prepare('UPDATE "endpoints" SET signature_secret_hash=? WHERE id=?').bind(digest, row.id).run();
  return { row: { ...row, signature_secret_hash: digest }, rawCredential: raw };
}

export interface EndpointEventSummary {
  readonly eventId: string;
  readonly executionId: string;
  readonly createdAt: string;
}

/** Delivery history for replay visibility: newest first, bounded. Unknown or
 * foreign names answer 404. */
export async function listEndpointEvents(
  db: D1Database,
  orgId: string,
  name: string,
  limit: number,
): Promise<EndpointEventSummary[]> {
  const row = await loadEndpoint(db, orgId, name);
  if (!row) throw new Fault(404, "NOT_FOUND", "Not found.");
  const rows = await db
    .prepare(
      'SELECT event_id,execution_id,created_at FROM "endpoint_events" WHERE endpoint_id=? ORDER BY created_at DESC,event_id DESC LIMIT ?',
    )
    .bind(row.id, limit)
    .all<{ event_id: string; execution_id: string; created_at: string }>()
    .catch(() => ({ results: [] as { event_id: string; execution_id: string; created_at: string }[] }));
  return rows.results.map((entry) => ({
    eventId: entry.event_id,
    executionId: entry.execution_id,
    createdAt: entry.created_at,
  }));
}

export interface EndpointExecutionOpts {
  readonly saga: SagaDef;
  readonly eventId: string;
  readonly payload: unknown;
}

/** Execute one endpoint delivery through the standard submit protocol. Replay
 * convergence: the same vendor event ID derives the same Idempotency-Key, so
 * redelivery replays (`200 replayed:true`) and a mismatched duplicate payload
 * answers `409 IDEMPOTENCY_CONFLICT` instead of forking a second Execution.
 * A first-seen event records (endpoint_id, event_id) for replay visibility;
 * the insert races like the submit path (single winner, retained row). No
 * automatic retry of business mutations: submit failures propagate as the
 * submit Fault (409/424/503), and the caller decides whether to redeliver. */
export async function executeEndpointDelivery(
  db: D1Database,
  submitFn: typeof submit,
  env: Parameters<typeof submit>[0],
  principal: EndpointPrincipal,
  endpoint: EndpointRow,
  opts: EndpointExecutionOpts,
): Promise<{ executionId: string; replayed: boolean; statusUrl: string; eventReplayed: boolean }> {
  const { input } = mapEndpointPayload(opts.saga, opts.payload);
  const key = await endpointIdempotencyKey(endpoint.id, opts.eventId);
  parseKey(key);
  const accepted = await submitFn(env, principal, key, opts.saga, input);
  let eventReplayed = accepted.replayed;
  try {
    const inserted = await db
      .prepare(
        'INSERT INTO "endpoint_events"(endpoint_id,event_id,input_json,execution_id,created_at) VALUES (?,?,?,?,?) ON CONFLICT(endpoint_id,event_id) DO NOTHING',
      )
      .bind(endpoint.id, opts.eventId, JSON.stringify(input), accepted.executionId, new Date().toISOString())
      .run();
    if (inserted.meta.changes === 0) {
      eventReplayed = true;
      const prior = await db
        .prepare('SELECT input_json,execution_id FROM "endpoint_events" WHERE endpoint_id=? AND event_id=?')
        .bind(endpoint.id, opts.eventId)
        .first<{ input_json: string; execution_id: string }>();
      if (prior && (prior.input_json !== JSON.stringify(input) || prior.execution_id !== accepted.executionId)) {
        throw new Fault(409, "IDEMPOTENCY_CONFLICT", "This event already delivered different input.");
      }
    }
  } catch (error) {
    if (error instanceof Fault) throw error;
    // endpoint_events is replay visibility only: a missing table (old DB
    // before migration 0021) must not fail the Execution itself.
  }
  return { ...accepted, eventReplayed };
}
