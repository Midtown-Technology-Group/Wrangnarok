// SPDX-License-Identifier: AGPL-3.0
// Adapted from upstream gobifrost/bifrost client/src/lib/client-types.ts
// (reference: vendor/upstream). Structure borrowed; Wrangnarök shapes only.

/** Execution status values served by the Wrangnarök Worker (ADR 001 CHECK; TRG-01 promotes schedules directly to Pending). */
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
  /** Semantic capability names this Saga requires (issue #262): discovery
   * only. Absent on older payloads; the server always sends it. */
  requiredCapabilities?: string[];
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
  /** Declared secret-field names with provisioned per-Organization
   * ciphertext (issue #411). Names only — values are never serialized. */
  secretsProvisioned: string[];
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

/** Model profile identity for GET /api/ai/profiles (AI-01, issue #164):
 * stable IDs, operator-authored capability overrides, chat flag, transport
 * label, capability state — provider model ids and key material never
 * appear (the server excludes them by construction). */
export interface AiProfileSummary {
  id: string;
  name: string;
  connectionId: string;
  integrationId: string;
  integrationName: string;
  enabledForChat: boolean;
  capabilities: Record<string, unknown>;
  capabilityState: "unknown" | "supported" | "unsupported";
  openaiTransport: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiProfilesResponse {
  profiles: AiProfileSummary[];
}

export interface AiProfileResponse {
  profile: AiProfileSummary;
}

/** One capability assignment key with its mapped profile identity (AI-01):
 * null when unmapped or no longer resolving. */
export interface AiAssignmentSummary {
  key: string;
  profile: AiProfileSummary | null;
  updatedAt: string | null;
}

export interface AiAssignmentsResponse {
  assignments: AiAssignmentSummary[];
}

export interface AiAssignmentResponse {
  assignment: AiAssignmentSummary;
}

export interface AiResolutionResponse {
  resolution: { key: string; profile: AiProfileSummary };
}

/** Embedding singleton identity (AI-01): connection identity plus
 * dimensions only — the model id never leaves the server. */
export interface AiEmbeddingSummary {
  connectionId: string;
  integrationId: string;
  integrationName: string;
  dimensions: number | null;
  updatedAt: string;
}

export interface AiEmbeddingResponse {
  embedding: AiEmbeddingSummary | null;
}

export interface AiBehaviorResponse {
  behavior: { defaultSystemPrompt: string; updatedAt: string } | null;
}

/** Detail shape for GET /api/executions/:id. */
export interface ExecutionDetail extends ExecutionSummary {
  runtimeStatus: string | null;
  parentExecutionId: string | null;
  parentStep: string | null;
  children: ExecutionChild[];
  /** Applied runtime-policy snapshot (RUN-01, ADR 018): what this Execution ran under. */
  policy: {
    sagaId: string;
    version: number;
    policy: {
      timeout: { vendorTimeoutMs: number; stepTimeout: string };
      retry: { checkpointRetries: number; vendorRetries: number };
      admission: { enabled: boolean; maxConcurrent: number };
    };
  };
  input: unknown;
  result: unknown;
  error: unknown;
  operations: OperationSummary[];
}

/** One direct child Execution (RUN-02 lineage, ADR 018). */
export interface ExecutionChild {
  executionId: string;
  sagaId: string;
  sagaName: string;
  status: string;
  createdAt: string;
}

/** OBS-02 author log level: DEBUG rows persist but are hidden from default
 * reads (the caller must ask for level=DEBUG explicitly). */
export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "PROGRESS";

/** One durable author log row with execution/org/caller attribution. */
export interface LogEntry {
  seq: number;
  executionId: string;
  sagaId: string;
  sagaName: string;
  orgId: string;
  userId: string;
  level: LogLevel;
  message: string;
  data: unknown;
  createdAt: string;
}

/** Cursor-paginated log page: D1 is the source of truth, this is a polling
 * view (refetch from nextCursor after a disconnect; dedupe by seq). */
export interface LogPage {
  logs: LogEntry[];
  hasMore: boolean;
  nextCursor: string | null;
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

/** Row shape for GET /api/config (CON-02, ADR 031): typed values for this
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

/** Dynamic form declaration (FORM-02, issue #155): server-authoritative
 * field list with display-only layout kinds, defaults, conditionals,
 * providers, and file policies. */
export interface FormFieldDef {
  name: string;
  type: string;
  label?: string;
  required: boolean;
  maxLength: number;
  default?: unknown;
  options?: string[];
  provider?: unknown;
  /** Declared auto-fill targets (FORM-02, issue #155): sibling target
   * field name to provider row output key, on table-provider selects. */
  autoFill?: Record<string, string>;
  visibleWhen?: { field: string; equals: string | number | boolean };
  file?: { location: string; maxMb?: number; contentTypes?: string[] };
  min?: number;
  max?: number;
  pattern?: string;
  content?: string;
}

export interface FormSummary {
  id: string;
  name: string;
  sagaId: string;
}

export interface FormsResponse {
  forms: FormSummary[];
}

export interface FormDetail extends FormSummary {
  title?: string;
  description?: string;
  allowPrefill: boolean;
  fields: FormFieldDef[];
}

export interface FormResponse {
  form: FormDetail;
}

export interface FormStartupResponse {
  form: string;
  handle: string;
  expiresAt: string;
  snapshot: Record<string, unknown>;
  options: Record<string, string[]>;
}

export interface FormProvidersResponse {
  form: string;
  options: Record<string, string[]>;
  errors: Record<string, string>;
}

export interface FormSubmitResponse {
  form: string;
  executionId: string;
  replayed: boolean;
  statusUrl: string;
  scheduled?: boolean;
  scheduleAt?: string;
}

// Signed form embeds (EMBED-01 slice 1, issue #156). Summaries carry
// identity, policy, and binding state only — never secret material. The
// raw secret rides the create/rotate response once and is never read back.

export interface EmbedGrantSummary {
  id: string;
  formName: string;
  allowedOrigins: string[];
  fingerprint: string;
  enabled: boolean;
  expiresAt: string | null;
  createdAt: string;
  rotatedAt: string | null;
  lastUsedAt: string | null;
}

export interface EmbedGrantsResponse {
  embeds: EmbedGrantSummary[];
}

export interface EmbedGrantIssuedResponse {
  grant: EmbedGrantSummary;
  secret: string;
}

export interface EmbedGrantResponse {
  grant: EmbedGrantSummary;
}

// Signed app embeds + anonymous public forms (EMBED-01 slice 2, issue
// #156). App summaries carry identity, policy, and binding state only —
// never secret material. Publications carry no secrets at all: the
// publication ID is a public link identifier, and the summary adds the
// live staleness bit the review UX keys on.

export interface AppEmbedGrantSummary {
  id: string;
  appSlug: string;
  allowedOrigins: string[];
  fingerprint: string;
  enabled: boolean;
  expiresAt: string | null;
  createdAt: string;
  rotatedAt: string | null;
  lastUsedAt: string | null;
}

export interface AppEmbedGrantsResponse {
  embeds: AppEmbedGrantSummary[];
}

export interface AppEmbedGrantIssuedResponse {
  grant: AppEmbedGrantSummary;
  secret: string;
}

export interface AppEmbedGrantResponse {
  grant: AppEmbedGrantSummary;
}

export interface FormPublicationSummary {
  id: string;
  formName: string;
  honeypotField: string;
  fingerprint: string;
  enabled: boolean;
  stale: boolean;
  createdAt: string;
  reviewedAt: string | null;
  lastUsedAt: string | null;
}

export interface FormPublicationResponse {
  publication: FormPublicationSummary | null;
}

// Organization branding + own profile (UX-01 slice 1, issue #176). The
// branding view is the safe public shape (name, colors, logo metadata);
// the profile view is caller-scoped. Neither carries credentials.

export interface BrandingLogo {
  contentType: string;
  sizeBytes: number;
  sha256: string;
}

export interface BrandingView {
  orgId: string;
  appName: string;
  primaryColor: string;
  accentColor: string;
  logo: BrandingLogo | null;
  updatedAt: string | null;
}

export interface BrandingResponse {
  branding: BrandingView;
}

export type ProfileTheme = "light" | "dark" | "system";

export interface ProfileAvatar {
  contentType: string;
  sizeBytes: number;
  sha256: string;
}

export interface ProfileView {
  orgId: string;
  userId: string;
  displayName: string;
  theme: ProfileTheme;
  avatar: ProfileAvatar | null;
  updatedAt: string | null;
}

export interface ProfileResponse {
  profile: ProfileView;
}

export interface CallerResponse {
  caller: {
    userId: string;
    orgId: string;
    credentialClass: string;
    viaAccess: boolean;
    fixture: boolean;
  };
  role: "member" | "admin" | null;
  kind: "ordinary" | "external" | null;
}

// Trigger and schedule management (issue #557): summaries mirror the Worker
// route shapes over /api/schedules, /api/event-sources, and /api/endpoints.
// Raw credentials (apiKey, webhookSecret) appear only on the create/rotate
// responses, never on list/detail summaries.

/** One schedule row: persisted environment state binding a name to a Saga. */
export interface ScheduleSummary {
  id: string;
  name: string;
  sagaId: string;
  sagaName: string;
  kind: "recurring" | "one-off";
  cron: string;
  timezone: string;
  enabled: boolean;
  input: unknown;
  runAt: string | null;
  nextDueAt: string | null;
  lastWindow: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SchedulesResponse {
  schedules: ScheduleSummary[];
}

export interface ScheduleResponse {
  schedule: ScheduleSummary;
}

export interface ScheduleDelivery {
  schedule: string;
  window: string;
  executionId: string;
}

export interface ScheduleDeliveryResponse {
  delivery: ScheduleDelivery;
}

/** One event-source row: the registry entry owning an append-only log. */
export interface EventSourceSummary {
  id: string;
  name: string;
  kind: "schedule" | "webhook" | "topic";
  refId: string | null;
  enabled: boolean;
  createdAt: string;
}

export interface EventSourcesResponse {
  sources: EventSourceSummary[];
}

export interface EventSourceResponse {
  source: EventSourceSummary;
}

export interface SourceEvent {
  eventId: string;
  topic: string;
  payload: unknown;
  executionId: string | null;
  createdAt: string;
}

export interface SourceEventsResponse {
  events: SourceEvent[];
}

export interface EmitEventResponse {
  event: SourceEvent;
  replayed: boolean;
  deliveries: unknown[];
  overflowSkipped: number;
}

/** One subscription: a topic filter binding a source to a target Saga. */
export interface SubscriptionSummary {
  id: string;
  name: string;
  sagaId: string;
  topicFilter: string;
  enabled: boolean;
  createdAt: string;
}

export interface SubscriptionsResponse {
  subscriptions: SubscriptionSummary[];
}

export interface SubscriptionResponse {
  subscription: SubscriptionSummary;
}

export interface SubscriptionDelivery {
  eventId: string;
  topic: string;
  executionId: string | null;
  outcome: "delivered" | "failed";
  createdAt: string;
}

export interface SubscriptionDeliveriesResponse {
  deliveries: SubscriptionDelivery[];
}

export interface RetryDeliveryResponse {
  delivery: {
    subscription: string;
    eventId: string;
    executionId: string;
    replayed: boolean;
  };
}

/** One endpoint row: identity and policy only, never digests or secrets. */
export interface EndpointSummary {
  id: string;
  name: string;
  sagaId: string;
  kind: "api-key" | "webhook";
  enabled: boolean;
  keyExpiresAt: string | null;
  challenge: "none" | "echo-param";
  rateLimitPerMinute: number | null;
  createdAt: string;
}

export interface EndpointsResponse {
  endpoints: EndpointSummary[];
}

export interface EndpointResponse {
  endpoint: EndpointSummary;
}

/** Create/rotate answers carry the raw credential exactly once. */
export interface EndpointIssuedResponse {
  endpoint: EndpointSummary;
  apiKey?: string;
  webhookSecret?: string;
}

export interface EndpointEvent {
  eventId: string;
  executionId: string;
  createdAt: string;
}

export interface EndpointEventsResponse {
  events: EndpointEvent[];
}
