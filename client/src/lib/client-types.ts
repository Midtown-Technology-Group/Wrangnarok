// SPDX-License-Identifier: AGPL-3.0
// Adapted from upstream gobifrost/bifrost client/src/lib/client-types.ts
// (reference: vendor/upstream). Structure borrowed; Wrangnarök shapes only.

/** Execution status values served by the Wrangnarök Worker (ADR 001 CHECK). */
export type ExecutionStatus = "Pending" | "Running" | "Succeeded" | "Failed" | "TimedOut" | "Cancelling" | "Cancelled";

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

/** Integration definition for GET /api/integrations (CON-01): portable
 * schema, defaults, required-secret names, and health — never org state. */
export interface IntegrationSummary {
  id: string;
  name: string;
  description: string;
  secretFields: string[];
  configSchema: {
    name: string;
    type: string;
    required: boolean;
    default?: string;
    maxLength?: number;
    description: string;
  }[];
  requiredSecrets: string[];
  secretEnvVars: Record<string, string>;
  health: { testHint: string; remediation: string };
}

export interface IntegrationsResponse {
  integrations: IntegrationSummary[];
}

/** Connection mapping for GET /api/connections (CON-01): stable IDs,
 * non-secret config, ownership, health — secret values never appear. */
export interface ConnectionSummary {
  id: string;
  integrationId: string;
  integrationName: string;
  orgId: string;
  displayName: string | null;
  endpoint: string;
  config: Record<string, string>;
  enabled: boolean;
  managedBy: string | null;
  ownerKind: "managed" | "loose";
  secretsRequired: string[];
  updatedAt: string | null;
}

export interface ConnectionsResponse {
  connections: ConnectionSummary[];
}

export interface ConnectionResponse {
  connection: ConnectionSummary;
}

export interface ConnectionTestResult {
  ok: boolean;
  checkedAt: string;
  detail: string;
  code?: string;
}

export interface ConnectionTestResponse {
  test: ConnectionTestResult;
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

/** One administrative audit event (GET /api/audit; OPS-01, ADR 020). */
export interface AuditEvent {
  id: string;
  orgId: string;
  actorUserId: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  outcome: "success" | "failure";
  detail: unknown;
  createdAt: string;
}

export interface AuditResponse {
  events: AuditEvent[];
  hasMore: boolean;
  /** Opaque page marker for the next GET /api/audit call; null when done. */
  nextCursor: string | null;
}

/** One operational notification (GET /api/notifications; OPS-01, ADR 020). */
export interface AppNotification {
  id: string;
  orgId: string;
  userId: string;
  scope: "personal" | "org";
  category: string;
  title: string;
  body: string | null;
  status: "pending" | "running" | "awaiting_action" | "completed" | "failed" | "cancelled";
  progressPercent: number | null;
  detail: unknown;
  createdAt: string;
  updatedAt: string;
  dismissedAt: string | null;
}

export interface NotificationsResponse {
  notifications: AppNotification[];
}

/** Artifact status values served by the Wrangnarök Worker (ADR 018). */
export type ArtifactStatus = "active" | "deleted";

/** Attachment-binding scopes: which surface the Artifact backs. */
export type ArtifactBindingScope = "execution" | "workspace" | "conversation";

/** Row shape for GET /api/artifacts (summaries + hasMore, never bytes). */
export interface ArtifactSummary {
  id: string;
  name: string;
  mime: string;
  sizeBytes: number;
  version: number;
  status: ArtifactStatus;
  createdAt: string;
  updatedAt: string;
}

/** Row shape for GET /api/config (CON-02, ADR 020): typed values for this
 * Organization; secret rows answer "[SECRET]", never values. */
export interface ConfigEntry {
  id: string;
  key: string;
  type: string;
  value: unknown;
  description: string | null;
  managedBy: string | null;
  updatedAt: string;
  updatedBy: string;
}

export interface ConfigListResponse {
  configs: ConfigEntry[];
}

/** Browser App SDK runtime wire shapes (APP-02, ADR 019). Mirrors
 * src/app-runtime.ts; guards in lib/app-runtime.ts fail loud on drift. */

/** Scoped capability grant (author view; revoked rows stay listed). */
export interface AppGrant {
  id: string;
  kind: "saga" | "table" | "file";
  ref: string;
  permission: "invoke" | "read" | "write";
  revoked: boolean;
  createdAt: string;
}

/** App Table declaration (author view shows hidden; runtime lists visible only). */
export interface AppTableDef {
  id: string;
  name: string;
  visibility: "visible" | "hidden";
  columns: string[];
  revision: number;
  createdAt: string;
}

/** One JSON document row with its authoritative Table revision. */
export interface AppTableRow {
  id: string;
  data: Record<string, unknown>;
  tableRevision: number;
  createdAt: string;
  updatedAt: string;
}

/** Compatibility handshake descriptor (GET /api/apps/:id/sdk). */
export interface AppHandshake {
  sdk: "wrangnarok.app-runtime";
  version: string;
  app: { id: string; name: string; slug: string; status: string };
}

/** File metadata (never bytes; bytes ride single-use tokens). */
export interface AppFileMeta {
  id: string;
  name: string;
  contentType: string;
  size: number;
  sha256: string;
  version: number;
  status: "pending" | "ready";
  createdAt: string;
  updatedAt: string;
}

/** Scoped invocation linkage (activity tail; result via execution detail). */
export interface AppExecutionLink {
  executionId: string;
  sagaId: string;
  createdAt: string;
}

/** File location declaration (FILE-01, ADR 018). */
export interface FileLocation {
  name: string;
  maxBytes: number;
  contentTypes: string[];
  sharedRead: boolean;
  createdAt: string;
}

export interface FileLocationsResponse {
  locations: FileLocation[];
}

/** File metadata row (only ready rows are downloadable). */
export interface FileMeta {
  location: string;
  path: string;
  version: number;
  size: number;
  contentType: string;
  sha256: string;
  status: "pending" | "ready";
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactsResponse {
  artifacts: ArtifactSummary[];
  hasMore: boolean;
}

export interface ArtifactVersion {
  version: number;
  mime: string;
  sizeBytes: number;
  createdAt: string;
}

export interface ArtifactBinding {
  scope: ArtifactBindingScope;
  refId: string;
}

/** Detail shape for GET /api/artifacts/:id. */
export interface ArtifactDetail extends ArtifactSummary {
  orgId: string;
  creatorUserId: string;
  deletedAt: string | null;
  versions: ArtifactVersion[];
  bindings: ArtifactBinding[];
}

/** Generated-output format subcapability (all deferred: no Python rendering on Workers). */
export interface ArtifactFormat {
  format: string;
  status: string;
}

export interface FilesResponse {
  files: FileMeta[];
  nextCursor: string | null;
}
