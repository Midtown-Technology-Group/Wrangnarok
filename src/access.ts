// SPDX-License-Identifier: AGPL-3.0
import { Fault, type Principal } from "./domain";

export interface AccessEnv {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ACCESS_ORG_ID?: string;
  ACCESS_ALLOWED_EMAILS?: string;
  ACCESS_ALLOWED_SERVICES?: string;
}

interface AccessConfig {
  teamDomain: string;
  aud: string;
  orgId: string;
  allowed: ReadonlySet<string>;
  services: ReadonlySet<string>;
}

// Module-level cert cache, isolated by Access team domain. Workers isolates
// reuse it; rotation is picked up after the short refresh window. Both team
// and key cardinality are bounded so configuration churn cannot grow isolate
// memory for its lifetime.
const MAX_CERT_KEYS = 32;
const MAX_CERT_TEAMS = 8;
const CERT_KEY_TTL_MS = 6 * 60 * 60 * 1000;
interface TeamCertCache {
  readonly keys: Map<string, { key: CryptoKey; at: number }>;
  readonly unknownKids: Map<string, number>;
  refreshedAt: number;
  unavailableAt: number;
}
const certCaches = new Map<string, TeamCertCache>();
// A successful JWKS response is authoritative for this short window. This is
// the essential rotating-kid fence: distinct unknown kids do not each force a
// new subrequest, while genuine key rotation converges within one minute.
export const ACCESS_CERT_REFRESH_TTL_MS = 60 * 1000;
let certRefreshTtlMs = ACCESS_CERT_REFRESH_TTL_MS;
// Briefly remember endpoint failures too. Without this cooldown a sequential
// forged-kid flood could amplify an Access outage despite the fetch timeout.
export const ACCESS_CERT_FAILURE_TTL_MS = 5 * 1000;
// Unknown kids are also remembered individually so repeats remain cheap after
// the team refresh window elapses. Short TTL preserves rotation convergence.
const NEGATIVE_KID_TTL_MS = 60 * 1000;
let negativeKidTtlMs = NEGATIVE_KID_TTL_MS;
/** Test hook: bound the unknown-kid negative-cache TTL (suite isolation). */
export function setAccessNegativeKidTtlMs(ms: number): void {
  negativeKidTtlMs = ms;
}
/** Test hook: bound the team JWKS freshness window (rotation tests). */
export function setAccessCertRefreshTtlMs(ms: number): void {
  certRefreshTtlMs = ms;
}
// In-flight coalescing covers the complete fetch-and-import operation, not
// merely HTTP. Concurrent misses therefore share one subrequest and one set of
// cryptographic imports.
const certInflight = new Map<string, Promise<void>>();
/** Largest assertion the verifier parses (codex #358): 8 KiB covers real
 * Access JWTs; larger inputs fail closed before any cert fetch. */
export const ACCESS_ASSERTION_MAX = 8192;
/** Largest key id resolved (codex #358): provider kids are short opaque
 * strings; longer values fail closed before any cert fetch. */
export const ACCESS_KID_MAX = 256;

// Cert fetch budget (#235): a hung cert endpoint must fail fast (503) rather
// than stall auth checks. Matches the 5s vendor-probe budget in connections.
export const ACCESS_CERT_FETCH_TIMEOUT_MS = 5_000;
let certFetchTimeoutMs = ACCESS_CERT_FETCH_TIMEOUT_MS;

/** Test hook: bound the cert fetch budget (suite isolation). */
export function setAccessCertFetchTimeoutMs(ms: number): void {
  certFetchTimeoutMs = ms;
}

function teamCache(teamDomain: string): TeamCertCache {
  const existing = certCaches.get(teamDomain);
  if (existing !== undefined) {
    certCaches.delete(teamDomain);
    certCaches.set(teamDomain, existing);
    return existing;
  }
  const created: TeamCertCache = { keys: new Map(), unknownKids: new Map(), refreshedAt: 0, unavailableAt: 0 };
  certCaches.set(teamDomain, created);
  if (certCaches.size > MAX_CERT_TEAMS) {
    const oldest = certCaches.keys().next().value as string;
    certCaches.delete(oldest);
  }
  return created;
}

/** Drop expired entries; each team cache is tiny so a full sweep is cheap. */
function sweepExpiredCertKeys(cache: TeamCertCache, now: number): void {
  for (const [kid, entry] of cache.keys) {
    if (now - entry.at > CERT_KEY_TTL_MS) cache.keys.delete(kid);
  }
}

function rememberUnknown(cache: TeamCertCache, kid: string, now: number): void {
  cache.unknownKids.delete(kid);
  cache.unknownKids.set(kid, now);
  if (cache.unknownKids.size > MAX_CERT_KEYS) {
    const oldest = cache.unknownKids.keys().next().value as string;
    cache.unknownKids.delete(oldest);
  }
}

function base64UrlDecode(input: string): Uint8Array<ArrayBuffer> {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded);
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

function readAccessConfig(env: AccessEnv): AccessConfig | null {
  const rawDomain = (env.ACCESS_TEAM_DOMAIN ?? "").trim();
  // Regex-free trailing-slash strip (CodeQL polynomial-regexp on env input).
  let teamDomain = rawDomain;
  while (teamDomain.endsWith("/")) teamDomain = teamDomain.slice(0, -1);
  const aud = (env.ACCESS_AUD ?? "").trim();
  const orgId = (env.ACCESS_ORG_ID ?? "").trim().toLowerCase();
  if (!teamDomain || !aud || !orgId) return null;
  const allowed = new Set(
    (env.ACCESS_ALLOWED_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
  const services = new Set(
    (env.ACCESS_ALLOWED_SERVICES ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
  return { teamDomain, aud, orgId, allowed, services };
}

/** Fetch the team cert set within the bounded budget. Throws Fault(503) on any
 * fetch failure (timeout, network error, non-200, malformed body) so a hung
 * or down cert endpoint fails fast instead of stalling auth checks. The kind
 * is logged for operators without leaking kid material. A successful fetch
 * that simply lacks the requested kid returns normally; the caller answers
 * that case 401 (forged or rotated-out assertion, not an outage). */
async function fetchCertSet(
  teamDomain: string,
  fetchFn: typeof fetch,
): Promise<{ kid?: string; kty?: string; n?: string; e?: string }[]> {
  let res: Response;
  try {
    res = await fetchFn(`${teamDomain}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(certFetchTimeoutMs) });
  } catch (error) {
    const timedOut =
      error instanceof DOMException
        ? error.name === "TimeoutError"
        : error instanceof Error && error.name === "TimeoutError";
    console.warn(`WRANGNAROK_ACCESS_CERTS_${timedOut ? "TIMEOUT" : "FAILED"}`);
    throw new Fault(503, "ACCESS_CERTS_UNAVAILABLE", "The Access certificate endpoint is unavailable.");
  }
  if (!res.ok) {
    console.warn(`WRANGNAROK_ACCESS_CERTS_FAILED status=${res.status}`);
    throw new Fault(503, "ACCESS_CERTS_UNAVAILABLE", "The Access certificate endpoint is unavailable.");
  }
  let keys: unknown;
  try {
    keys = ((await res.json()) as { keys?: unknown }).keys;
  } catch {
    keys = undefined;
  }
  if (!Array.isArray(keys)) {
    console.warn("WRANGNAROK_ACCESS_CERTS_FAILED malformed");
    throw new Fault(503, "ACCESS_CERTS_UNAVAILABLE", "The Access certificate endpoint is unavailable.");
  }
  if (keys.length > MAX_CERT_KEYS) {
    console.warn("WRANGNAROK_ACCESS_CERTS_FAILED oversized");
    throw new Fault(503, "ACCESS_CERTS_UNAVAILABLE", "The Access certificate endpoint is unavailable.");
  }
  return keys as { kid?: string; kty?: string; n?: string; e?: string }[];
}

async function keyFor(teamDomain: string, kid: string, fetchFn: typeof fetch): Promise<CryptoKey | null> {
  const now = Date.now();
  const cache = teamCache(teamDomain);
  sweepExpiredCertKeys(cache, now);
  const hit = cache.keys.get(kid);
  if (hit) return hit.key;
  // Negative cache: a recently-unknown kid fails closed with no subrequest.
  // Stale entries expire via the sweep in the miss path below.
  const deniedAt = cache.unknownKids.get(kid);
  if (deniedAt !== undefined) {
    if (now - deniedAt < negativeKidTtlMs) return null;
    cache.unknownKids.delete(kid);
  } else {
    // Sweep stale negatives only on a fresh miss: keeps the hot path (hit
    // or live negative) branch-free while expiry still converges.
    for (const [miss, at] of cache.unknownKids) {
      if (now - at >= negativeKidTtlMs) cache.unknownKids.delete(miss);
    }
  }
  if (cache.unavailableAt > 0 && now - cache.unavailableAt < ACCESS_CERT_FAILURE_TTL_MS) {
    throw new Fault(503, "ACCESS_CERTS_UNAVAILABLE", "The Access certificate endpoint is unavailable.");
  }
  if (cache.refreshedAt > 0 && now - cache.refreshedAt < certRefreshTtlMs) {
    // The authoritative fresh set already prevents another fetch. Recording
    // this miss from its lookup time would outlive the freshness window and
    // delay genuine rotation past the first eligible post-window lookup.
    return null;
  }
  await refreshCertSetCoalesced(teamDomain, fetchFn);
  const refreshed = teamCache(teamDomain);
  const resolved = refreshed.keys.get(kid)?.key ?? null;
  if (resolved !== null) refreshed.unknownKids.delete(kid);
  else rememberUnknown(refreshed, kid, Date.now());
  return resolved;
}

async function refreshCertSet(teamDomain: string, fetchFn: typeof fetch): Promise<void> {
  const cache = teamCache(teamDomain);
  try {
    const certs = await fetchCertSet(teamDomain, fetchFn);
    const seen = Date.now();
    const imported = new Map<string, { key: CryptoKey; at: number }>();
    for (const k of certs) {
      if (
        typeof k.kid !== "string" ||
        k.kid.length === 0 ||
        k.kid.length > ACCESS_KID_MAX ||
        k.kty !== "RSA" ||
        k.n == null ||
        k.e == null
      )
        continue;
      const jwk: JsonWebKey = { kty: "RSA", n: k.n, e: k.e, alg: "RS256", ext: true };
      const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
        "verify",
      ]);
      imported.set(k.kid, { key, at: seen });
    }
    cache.keys.clear();
    for (const [importedKid, entry] of imported) cache.keys.set(importedKid, entry);
    cache.refreshedAt = seen;
    cache.unavailableAt = 0;
  } catch (error) {
    cache.unavailableAt = Date.now();
    if (error instanceof Fault) throw error;
    console.warn("WRANGNAROK_ACCESS_CERTS_FAILED invalid-key");
    throw new Fault(503, "ACCESS_CERTS_UNAVAILABLE", "The Access certificate endpoint is unavailable.");
  }
}

/** One complete JWKS refresh per team domain at a time. Settled operations
 * release so genuine rotation can refresh after the bounded freshness window. */
function refreshCertSetCoalesced(teamDomain: string, fetchFn: typeof fetch): Promise<void> {
  const existing = certInflight.get(teamDomain);
  if (existing !== undefined) return existing;
  const task = refreshCertSet(teamDomain, fetchFn);
  certInflight.set(teamDomain, task);
  const cleanup = (): void => {
    if (certInflight.get(teamDomain) === task) certInflight.delete(teamDomain);
  };
  void task.then(cleanup, cleanup);
  return task;
}

/** Verify a Cloudflare Access JWT assertion. Throws Fault(401/403/503). */
export async function verifyAccess(
  assertion: string,
  env: AccessEnv,
  fetchFn: typeof fetch = fetch,
): Promise<Principal> {
  const cfg = readAccessConfig(env);
  if (cfg == null) throw new Fault(503, "ACCESS_NOT_CONFIGURED", "Access auth is not configured.");
  // Codex #358: bound attacker-controlled input before any cert fetch. An
  // oversized assertion or kid fails closed here — no parse, no subrequest.
  if (typeof assertion !== "string" || assertion.length === 0 || assertion.length > ACCESS_ASSERTION_MAX) {
    throw new Fault(401, "UNAUTHORIZED", "Unauthorized.");
  }
  const parts = assertion.split(".");
  if (parts.length !== 3) throw new Fault(401, "UNAUTHORIZED", "Unauthorized.");
  const [headB64, payloadB64, sigB64] = parts as [string, string, string];
  let header: { alg?: string; kid?: string };
  let payload: { aud?: string | string[]; exp?: number; email?: string; common_name?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headB64)));
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));
  } catch {
    throw new Fault(401, "UNAUTHORIZED", "Unauthorized.");
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    throw new Fault(401, "UNAUTHORIZED", "Unauthorized.");
  }
  if (header.kid.length === 0 || header.kid.length > ACCESS_KID_MAX) {
    throw new Fault(401, "UNAUTHORIZED", "Unauthorized.");
  }
  const key = await keyFor(cfg.teamDomain, header.kid, fetchFn);
  if (key == null) throw new Fault(401, "UNAUTHORIZED", "Unauthorized.");
  const data = new TextEncoder().encode(`${headB64}.${payloadB64}`);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlDecode(sigB64), data);
  if (!ok) throw new Fault(401, "UNAUTHORIZED", "Unauthorized.");
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp + 60 < now) {
    throw new Fault(401, "UNAUTHORIZED", "Unauthorized.");
  }
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(cfg.aud)) throw new Fault(401, "UNAUTHORIZED", "Unauthorized.");
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (email && cfg.allowed.has(email)) return { userId: email, orgId: cfg.orgId };
  // Service-token assertions carry common_name instead of email (Phase 3 will
  // fold services into the membership table; until then an explicit allowlist).
  const svc = typeof payload.common_name === "string" ? payload.common_name.trim().toLowerCase() : "";
  if (svc && cfg.services.has(svc)) return { userId: `service:${svc}`, orgId: cfg.orgId };
  throw new Fault(403, "FORBIDDEN", "Forbidden.");
}

/** Credential classes a verified Principal can hold.
 *
 * AUTH-03 (issue #144): upstream Bifrost distinguishes delegated human
 * identity (login/SSO/MFA/passkeys, `api/src/routers/auth.py`,
 * `oauth_sso.py`, `mfa.py`, `passkeys.py`) from scoped machine credentials
 * (user API keys and per-workflow keys, `api/src/routers/workflow_keys.py`).
 * Locally both arrive through the same two gates: a Cloudflare Access
 * assertion (human email or service common_name, ADR 014) or the LAB fixture
 * bearer (local only, never production). The class is derived from the
 * Principal shape alone, so routes, audit rows, and the SDK identity surface
 * share one definition instead of re-parsing prefixes. */
export type CredentialClass = "human" | "service" | "fixture" | "endpoint";

const SERVICE_PREFIX = "service:";
const ENDPOINT_PREFIX = "endpoint:";

/** True for Access service-token principals (`service:<client-id>`), minted
 * by verifyAccess from an allowlisted assertion common_name. Service tokens
 * carry no email and authenticate through Access client-credentials, the
 * local analogue of upstream OAuth2 M2M API Services. */
export function isServicePrincipal(userId: string): boolean {
  return userId.startsWith(SERVICE_PREFIX) && userId.length > SERVICE_PREFIX.length;
}

/** True for TRG-02 scoped endpoint-delivery principals (`endpoint:<id>`),
 * minted by verifyEndpointKey/verifyWebhookSignature from a per-endpoint
 * credential. Endpoint principals are the local analogue of upstream
 * per-workflow keys: least-privilege, expiry/rotation-aware, and bound to a
 * single Saga binding instead of an operator session. */
export function isEndpointPrincipal(userId: string): boolean {
  return userId.startsWith(ENDPOINT_PREFIX) && userId.length > ENDPOINT_PREFIX.length;
}

/** Classify a verified caller Principal into its credential class. Endpoint
 * delivery principals are checked before service principals so a future
 * `service:`-prefixed endpoint id can never be mistaken for an Access
 * service token. Anything else verified through the fixture or Access human
 * path is a delegated human identity (Access email) or the local fixture. */
export function credentialClassFor(userId: string, viaAccess: boolean): CredentialClass {
  if (isEndpointPrincipal(userId)) return "endpoint";
  if (isServicePrincipal(userId)) return "service";
  return viaAccess ? "human" : "fixture";
}

/** Test hook: drop cached certs and reset fetch/refresh budgets (suite isolation). */
export function clearAccessCertCache(): void {
  certCaches.clear();
  certInflight.clear();
  certFetchTimeoutMs = ACCESS_CERT_FETCH_TIMEOUT_MS;
  certRefreshTtlMs = ACCESS_CERT_REFRESH_TTL_MS;
  negativeKidTtlMs = NEGATIVE_KID_TTL_MS;
}
