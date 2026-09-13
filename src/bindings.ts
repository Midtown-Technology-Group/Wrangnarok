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
export interface Bindings extends LabAuth, AccessEnv, AdminEnv, NinjaCredentials, HaloCredentials {
  DB: D1Database;
  FILES: R2Bucket;
  ARTIFACTS?: R2Bucket;
  ECHO_WORKFLOW: Workflow<ExecutionParams>;
  NINJA_WORKFLOW: Workflow<ExecutionParams>;
  DIGEST_WORKFLOW: Workflow<ExecutionParams>;
  SMOKE_WORKFLOW: Workflow<ExecutionParams>;
  HELLO_WORKFLOW: Workflow<ExecutionParams>;
  ASSETS?: Fetcher;
  /** TRG-02 (issue #138, ADR 018): JSON object mapping endpoint ID to its
   * raw webhook HMAC secret. Populated from the deployment secret store in
   * production (never from D1, which holds only the SHA-256 confirmation
   * digest); a test binding in workerd tests. Absent means no webhook
   * endpoint can verify. */
  ENDPOINT_WEBHOOK_SECRETS?: string;
}
