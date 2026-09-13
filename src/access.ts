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

// Module-level cert cache: kid -> imported key plus first-seen timestamp.
// Workers isolates reuse it; rotation is picked up when an unknown kid
// arrives (single refetch). Bounded by size and TTL (#234) so key churn or
// hostile kids cannot grow it for the life of the isolate.
const MAX_CERT_KEYS = 32;
const CERT_KEY_TTL_MS = 6 * 60 * 60 * 1000;
const certCache = new Map<string, { key: CryptoKey; at: number }>();

// Cert fetch budget (#235): a hung cert endpoint must fail fast (503) rather
// than stall auth checks. Matches the 5s vendor-probe budget in connections.
export const ACCESS_CERT_FETCH_TIMEOUT_MS = 5_000;
let certFetchTimeoutMs = ACCESS_CERT_FETCH_TIMEOUT_MS;

/** Test hook: bound the cert fetch budget (suite isolation). */
export function setAccessCertFetchTimeoutMs(ms: number): void {
  certFetchTimeoutMs = ms;
}

/** Drop expired entries; the cache is tiny (<= MAX_CERT_KEYS) so a full sweep is cheap. */
function sweepExpiredCertKeys(now: number): void {
  for (const [kid, entry] of certCache) {
    if (now - entry.at > CERT_KEY_TTL_MS) certCache.delete(kid);
  }
}

function putCertKey(kid: string, key: CryptoKey, now: number): void {
  if (certCache.has(kid)) certCache.delete(kid);
  certCache.set(kid, { key, at: now });
  // LRU: insertion order is recency (hits re-insert below), so evict oldest.
  for (const oldest of certCache.keys()) {
    if (certCache.size <= MAX_CERT_KEYS) break;
    certCache.delete(oldest);
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
  return keys as { kid?: string; kty?: string; n?: string; e?: string }[];
}

async function keyFor(teamDomain: string, kid: string, fetchFn: typeof fetch): Promise<CryptoKey | null> {
  const now = Date.now();
  sweepExpiredCertKeys(now);
  const hit = certCache.get(kid);
  if (hit) {
    // Refresh recency so live keys are not evicted ahead of stale ones.
    certCache.delete(kid);
    certCache.set(kid, hit);
    return hit.key;
  }
  const certs = await fetchCertSet(teamDomain, fetchFn);
  const seen = Date.now();
  // The looked-up kid is pinned most-recent so a large rotation set can
  // never evict the very key this call is resolving mid-import.
  let wanted: CryptoKey | null = null;
  for (const k of certs) {
    if (k.kid == null || k.kty !== "RSA" || k.n == null || k.e == null) continue;
    const jwk: JsonWebKey = { kty: "RSA", n: k.n, e: k.e, alg: "RS256", ext: true };
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
      "verify",
    ]);
    if (k.kid === kid) wanted = key;
    else putCertKey(k.kid, key, seen);
  }
  if (wanted != null) putCertKey(kid, wanted, seen);
  return certCache.get(kid)?.key ?? null;
}

/** Verify a Cloudflare Access JWT assertion. Throws Fault(401/403/503). */
export async function verifyAccess(
  assertion: string,
  env: AccessEnv,
  fetchFn: typeof fetch = fetch,
): Promise<Principal> {
  const cfg = readAccessConfig(env);
  if (cfg == null) throw new Fault(503, "ACCESS_NOT_CONFIGURED", "Access auth is not configured.");
  const parts = assertion.split(".");
  if (parts.length !== 3) throw new Fault(401, "UNAUTHORIZED", "Unauthorized.");
  const [headB64, payloadB64, sigB64] = parts;
  if (headB64 == null || payloadB64 == null || sigB64 == null) {
    throw new Fault(401, "UNAUTHORIZED", "Unauthorized.");
  }
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

/** Test hook: drop cached certs and reset the fetch budget (rotation tests, suite isolation). */
export function clearAccessCertCache(): void {
  certCache.clear();
  certFetchTimeoutMs = ACCESS_CERT_FETCH_TIMEOUT_MS;
}
