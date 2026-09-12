// SPDX-License-Identifier: AGPL-3.0
// Adapted from upstream gobifrost/bifrost client/src/lib/client-types.ts
// (reference: vendor/upstream). Structure borrowed; Wrangnarök shapes only.

/** Execution status values served by the Wrangnarök Worker (ADR 001 CHECK, plus Scheduled per TRG-01/ADR 012). */
export type ExecutionStatus =
  "Pending" | "Running" | "Succeeded" | "Failed" | "TimedOut" | "Cancelling" | "Cancelled" | "Scheduled";

/** One durable unit of Saga execution (maps to a Workflow step). */
export interface OperationSummary {
  name: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  result: unknown;
  error: unknown;
}

/** Row shape for GET /api/executions (20 + hasMore, no input/results in rows). */
export interface ExecutionSummary {
  executionId: string;
  sagaId: string;
  sagaName: string;
  sagaRevision: string;
  orgId: string;
  userId: string;
  status: ExecutionStatus;
  dispatchConfirmed: boolean;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ExecutionHistoryResponse {
  executions: ExecutionSummary[];
  hasMore: boolean;
  /** Opaque page marker for the next GET /api/executions call; null when done. */
  nextCursor: string | null;
}

/** Catalog entry for GET /api/sagas (read-only Saga discovery metadata). */
export interface SagaSummary {
  id: string;
  name: string;
  revision: string;
  description: string;
  /** Optional discovery metadata (ADR 002): never operational policy. */
  tags?: string[];
  category?: string;
  /** Stable Integration IDs this Saga requires in its Organization context
   * (ADR 010 section 3): discovery only, no endpoints or credentials. */
  requiredIntegrations: string[];
  inputSchema?: unknown;
  outputSchema?: unknown;
}

export interface SagasResponse {
  sagas: SagaSummary[];
}

/** Detail shape for GET /api/executions/:id. */
export interface ExecutionDetail extends ExecutionSummary {
  runtimeStatus: string | null;
  input: unknown;
  result: unknown;
  error: unknown;
  operations: OperationSummary[];
}

/** Application status values served by the Wrangnarök Worker (ADR 017). */
export type AppStatus = "created" | "ready" | "building" | "live" | "failed";

/** Ownership marker (ADR 017 section 1): independent rows live through the
 * app API; solution-owned rows reject live mutation with MANAGED_RESOURCE. */
export type AppOwnerKind = "independent" | "solution";

/** Row shape for GET /api/apps. */
export interface AppSummary {
  id: string;
  name: string;
  slug: string;
  ownerKind: AppOwnerKind;
  status: AppStatus;
  activeDeploymentId: string | null;
  revision: number | null;
  updatedAt: string;
}

export interface AppsResponse {
  apps: AppSummary[];
}

export interface AppFile {
  path: string;
  content: string;
}

export interface AppDependency {
  name: string;
  version: string;
}

export interface AppFieldFailure {
  field: string;
  code: string;
  message: string;
}

export interface AppRevision {
  revision: number;
  files: AppFile[];
  dependencies: AppDependency[];
  validation: "pending" | "valid" | "invalid";
  failures: AppFieldFailure[] | null;
  createdAt: string;
}

/** Deploy job receipt (ADR 017 section 2): the async job the author inspects. */
export interface AppJob {
  id: string;
  revision: number;
  status: "queued" | "running" | "succeeded" | "failed";
  error: { code: string; message: string } | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AppDeployment {
  id: string;
  revision: number;
  contentHash: string;
  createdAt: string;
}

/** Detail shape for GET /api/apps/:id. */
export interface AppDetail extends AppSummary {
  createdAt: string;
  revisions: AppRevision[];
  jobs: AppJob[];
  activeDeployment: AppDeployment | null;
}
