// SPDX-License-Identifier: AGPL-3.0
import type { AccessEnv } from "./access";
import type { LabAuth } from "./auth";
import type { AdminEnv } from "./orgs";
import type { ExecutionParams } from "./domain";
export interface NinjaCredentials {
  NINJA_CLIENT_ID?: string;
  NINJA_CLIENT_SECRET?: string;
}
/** TOOL-01 HaloPSA Code Mode provider (issue #170): deployment credential
 * surface for the lab proof Connection. Presence-checked at execution, never
 * persisted, never returned through discovery. */
export interface HaloCredentials {
  HALO_CLIENT_ID?: string;
  HALO_CLIENT_SECRET?: string;
}
/** Zone Inventory migration (issues #116 MIG-01, #119 MIG-02): deployment
 * credential surface for the Cloudflare bearer Connection. The account-owned
 * API token lives in env, never in D1; the account mapping resolves
 * per-Execution from the scenario/test binding. */
export interface CloudflareCredentials {
  CLOUDFLARE_API_TOKEN?: string;
}
export interface Bindings extends LabAuth, AccessEnv, AdminEnv, NinjaCredentials, HaloCredentials, CloudflareCredentials {
  DB: D1Database;
  FILES: R2Bucket;
  ARTIFACTS?: R2Bucket;
  /** OAUTH-01 follow-up (issue #149): cross-instance rotating-refresh fence.
   * The `OAuthRefreshFence` object behind each (tenant, generation) key runs
   * one volatile vendor POST per rotation round. Memory-only: no storage, no
   * D1, no persisted token. Optional so unit tests can ride `env` without a
   * DO binding; callers without it keep the isolate-local single-flight map. */
  OAUTH_REFRESH_FENCE?: DurableObjectNamespace;
  ECHO_WORKFLOW: Workflow<ExecutionParams>;
  NINJA_WORKFLOW: Workflow<ExecutionParams>;
  DIGEST_WORKFLOW: Workflow<ExecutionParams>;
  SMOKE_WORKFLOW: Workflow<ExecutionParams>;
  HELLO_WORKFLOW: Workflow<ExecutionParams>;
  HELLO_PARENT_WORKFLOW: Workflow<ExecutionParams>;
  CLOUDFLARE_VERIFY_WORKFLOW: Workflow<ExecutionParams>;
  CLOUDFLARE_INVENTORY_WORKFLOW: Workflow<ExecutionParams>;
  ASSETS?: Fetcher;
  /** TRG-02 (issue #138, ADR 018): JSON object mapping endpoint ID to its
   * raw webhook HMAC secret. Populated from the deployment secret store in
   * production (never from D1, which holds only the SHA-256 confirmation
   * digest); a test binding in workerd tests. Absent means no webhook
   * endpoint can verify. */
  ENDPOINT_WEBHOOK_SECRETS?: string;
}
