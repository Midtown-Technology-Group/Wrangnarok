// SPDX-License-Identifier: AGPL-3.0
import { Fault, hash, UUID } from "./domain";
import type { Principal } from "./domain";
import { credentialClassFor, verifyAccess, type AccessEnv, type CredentialClass } from "./access";
import { ensureLabFixture } from "./orgs";
import { ensureRoleTables } from "./roles";
export interface LabAuth {
  LAB_ENABLED?: string;
  LAB_TOKEN?: string;
  LAB_ORG_ID?: string;
  LAB_USER_ID?: string;
  DB?: D1Database;
  /** Test hook: the configured fixture identity. Swapped callers override
   * LAB_USER_ID per request; this preserves the original for the bootstrap
   * comparison. Unset in production paths (same as LAB_USER_ID). */
  LAB_FIXTURE_USER_ID?: string;
}
/** Local fixture only. Organization and user never come from request headers or JSON.
 * A present Cf-Access-Jwt-Assertion routes exclusively to Access verification
 * (ADR 014); unconfigured Access fails closed, never falls through to LAB. */
export async function authenticate(request: Request, env: LabAuth & AccessEnv): Promise<Principal> {
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (assertion) return verifyAccess(assertion, env);
  if (env.LAB_ENABLED !== "true") throw new Fault(404, "NOT_FOUND", "Not found.");
  if (
    !env.LAB_TOKEN ||
    !/^[a-f0-9]{64}$/.test(env.LAB_TOKEN) ||
    !env.LAB_ORG_ID ||
    !UUID.test(env.LAB_ORG_ID) ||
    !env.LAB_USER_ID ||
    !UUID.test(env.LAB_USER_ID)
  ) {
    throw new Fault(503, "LOCAL_AUTH_NOT_CONFIGURED", "Run the local setup script.");
  }
  const supplied = request.headers.get("Authorization") ?? "";
  if (supplied.length > 128) throw new Fault(401, "UNAUTHORIZED", "Unauthorized.");
  const [actual, expected] = await Promise.all([hash(supplied), hash(`Bearer ${env.LAB_TOKEN}`)]);
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  if (difference !== 0) throw new Fault(401, "UNAUTHORIZED", "Unauthorized.");
  const principal = { userId: env.LAB_USER_ID.toLowerCase(), orgId: env.LAB_ORG_ID.toLowerCase() };
  // Local/CI bootstrap: only the configured fixture identity gains admin
  // membership in the fixture org, so the existing suite passes unmodified
  // against the membership-gated routes. Swapped LAB_USER_ID identities used
  // by tests bootstrap nothing — they stay strangers until invited, which is
  // exactly what the lifecycle tests pin. LAB_FIXTURE_USER_ID preserves the
  // configured identity when tests override LAB_USER_ID per caller.
  // Never resurrects disabled orgs/users (fail closed).
  const fixtureUser = (env.LAB_FIXTURE_USER_ID ?? env.LAB_USER_ID ?? "").toLowerCase();
  if (env.DB && fixtureUser && principal.userId === fixtureUser) {
    try {
      await ensureLabFixture(env.DB, principal.orgId, principal.userId);
      // AUTH-02 (ADR 018): same standing bootstrap as the org tables — the
      // migration-0013 tables may not exist on hand-built databases.
      await ensureRoleTables(env.DB);
    } catch {
      // Pre-migration databases (no users table): leave auth working, the
      // membership gate answers 503 with ORG_STORE_NOT_MIGRATED.
    }
  }
  return principal;
}

/** Caller identity view served by GET /api/auth/me.
 *
 * AUTH-03 (issue #144): the single read-only proof of which credential class
 * the caller authenticated with. The class is derived from the verified
 * Principal shape (access.ts), never from request input; the fixture flag
 * marks LAB-only callers so operators can tell delegated human identity
 * apart from local fixture use. No secret values ride this view: userId and
 * orgId are identifiers, not credentials. */
export interface CallerIdentity {
  readonly userId: string;
  readonly orgId: string;
  readonly credentialClass: CredentialClass;
  readonly viaAccess: boolean;
  readonly fixture: boolean;
}

/** Describe an already-authenticated Principal for the identity view. Pure:
 * the caller proves authentication first (authenticate above), then the
 * membership gate in the route proves authorization. */
export function describeCaller(principal: Principal, request: Request): CallerIdentity {
  const viaAccess = request.headers.has("Cf-Access-Jwt-Assertion");
  const credentialClass = credentialClassFor(principal.userId, viaAccess);
  return {
    userId: principal.userId,
    orgId: principal.orgId,
    credentialClass,
    viaAccess,
    fixture: credentialClass === "fixture",
  };
}
