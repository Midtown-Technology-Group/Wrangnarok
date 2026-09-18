// SPDX-License-Identifier: AGPL-3.0
// AI model profiles, capability assignments, embedding config, and behavior
// (AI-01, issue #164, ADR 032 build slice 2).
//
// Upstream `ai_model_service.py` (`3543c7eb`) adapted to the CON-01 substrate:
// provider Connections are org-scoped Integration mappings (not AI-owned
// rows), profile/assignment/embedding/behavior rows live in migration 0028,
// and credentials stay deployment-global in v0 (SEC-02 tripwire shut —
// never D1 values, never discovery-visible).
//
// Boundaries:
// - Views carry profile identities and capability summaries only. Provider
//   model ids and key material never reach the browser (upstream
//   `test_chat_model_profiles.py` pins the same exclusion).
// - Resolution fails closed: a missing mapping, a missing profile, or a
//   missing/disabled backing Connection resolves to null, never to a guess.
// - Every lifecycle guard below is enforced in code (typed Faults, not
//   D1 errors): first-profile auto-assign, chat_default disable rejection,
//   referenced-delete block, merge reassign + OR chat flags. The 0028
//   RESTRICT FKs backstop the same rules at the storage layer.
import { AI_ASSIGNMENT_KEYS, AI_PROVIDER_KINDS, boundedJson, Fault, UUID } from "./domain";
import type { AiAssignmentKey, Principal } from "./domain";
import { assertSafeEndpoint, integrationById } from "./integrations";
import type { IntegrationDefinition } from "./integrations";

export const AI_PROFILE_NAME_MAX = 128;
export const AI_MODEL_ID_MAX = 256;
export const AI_TRANSPORT_MAX = 64;
/** Operator capability overrides stay well under the shared 4 KiB request
 * body cap, so an oversized blob answers the typed AI_INVALID_PROFILE
 * instead of the transport-level 413. */
export const AI_CAPABILITIES_JSON_MAX = 2048;
export const AI_CAPABILITIES_KEYS_MAX = 64;
export const AI_CAPABILITY_KEY_MAX = 128;
/** Default system prompt bound, sized under the same 4 KiB request cap so
 * the typed AI_INVALID_BEHAVIOR wins over the transport-level 413. */
export const AI_PROMPT_MAX = 2048;
export const AI_DIMENSIONS_MAX = 32768;
export const AI_MERGE_SELECTION_MAX = 25;
/** Vendor deadline for verify/discovery probes (CON-01 5s probe posture). */
export const AI_VENDOR_TIMEOUT_MS = 5000;
/** Transport cap for vendor model-list bodies (shaped, never persisted). */
export const AI_VENDOR_BODY_MAX = 65536;
/** Model-id scan cap inside one vendor model list. */
export const AI_DISCOVERY_MODELS_MAX = 1000;

export type AiCapabilityState = "unknown" | "supported" | "unsupported";
const CAPABILITY_STATES: readonly AiCapabilityState[] = ["unknown", "supported", "unsupported"];

/** Identity-only profile view: no provider model id, no key material. */
export interface AiProfileView {
  readonly id: string;
  readonly name: string;
  readonly connectionId: string;
  readonly integrationId: string;
  readonly integrationName: string;
  readonly enabledForChat: boolean;
  /** Operator-authored capability overrides (non-secret config). */
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly capabilityState: AiCapabilityState;
  readonly openaiTransport: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AiAssignmentView {
  readonly key: AiAssignmentKey;
  /** Null when unmapped or when the mapped profile no longer resolves. */
  readonly profile: AiProfileView | null;
  readonly updatedAt: string | null;
}

export interface AiResolution {
  readonly key: AiAssignmentKey;
  readonly profile: AiProfileView;
}

/** Embedding singleton view: connection identity plus dimensions only. */
export interface AiEmbeddingView {
  readonly connectionId: string;
  readonly integrationId: string;
  readonly integrationName: string;
  readonly dimensions: number | null;
  readonly updatedAt: string;
}

export interface AiBehaviorView {
  readonly defaultSystemPrompt: string;
  readonly updatedAt: string;
}

export type AiVerifyOutcome =
  | {
      readonly ok: true;
      readonly checkedAt: string;
      readonly profileId: string;
      readonly modelAvailable: boolean;
      readonly detail: string;
    }
  | { readonly ok: false; readonly checkedAt: string; readonly code: string; readonly detail: string };

export interface AiModelAvailability {
  readonly profileId: string;
  readonly name: string;
  readonly modelAvailable: boolean;
}

export type AiDiscoveryOutcome =
  | {
      readonly ok: true;
      readonly checkedAt: string;
      readonly connectionId: string;
      readonly integrationId: string;
      readonly modelCount: number;
      readonly profiles: readonly AiModelAvailability[];
    }
  | { readonly ok: false; readonly checkedAt: string; readonly code: string; readonly detail: string };

/** Deployment credential surface for verify/discovery (presence + transient
 * use only — never persisted, logged, or returned). The Worker passes its
 * Bindings straight through; test doubles pass plain records. */
export interface AiSecretEnv {
  readonly OPENAI_API_KEY?: string;
  readonly ANTHROPIC_API_KEY?: string;
  readonly GOOGLE_API_KEY?: string;
  readonly OPENROUTER_API_KEY?: string;
  readonly OPENAI_COMPATIBLE_API_KEY?: string;
}

export interface AiVendorOpts {
  readonly fetchImpl?: typeof fetch;
  /** Override for the abort-path test only; production uses the 5s default. */
  readonly timeoutMs?: number;
}

function invalid(code: string, message: string, status = 400): Fault {
  return new Fault(status, code, message);
}

function secretValue(env: AiSecretEnv, name: string): string | undefined {
  const value: unknown = (env as Record<string, unknown>)[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

interface AiProfileRow {
  readonly id: string;
  readonly org_id: string;
  readonly connection_id: string;
  readonly name: string;
  readonly model_id: string;
  readonly capabilities_json: string;
  readonly openai_transport: string | null;
  readonly enabled_for_chat: number;
  readonly capability_state: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Connection columns the AI surface reads. `enabled` is NOT NULL since
 * migration 0011, which always precedes the 0028 AI tables — no pre-0011
 * tolerance needed here (unlike the Execution path in src/connections.ts). */
interface AiConnectionRow {
  readonly id: string;
  readonly org_id: string;
  readonly integration_id: string;
  readonly endpoint: string;
  readonly enabled: number;
}

interface AiAssignmentRow {
  readonly assignment_key: string;
  readonly profile_id: string;
  readonly updated_at: string;
}

function parseAssignmentKey(value: unknown): AiAssignmentKey {
  if (typeof value === "string" && (AI_ASSIGNMENT_KEYS as readonly string[]).includes(value)) {
    return value as AiAssignmentKey;
  }
  throw invalid("AI_INVALID_ASSIGNMENT", "Unknown model assignment key.");
}

function parseProfileName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > AI_PROFILE_NAME_MAX) {
    throw invalid("AI_INVALID_PROFILE", `Profile name must be 1 to ${AI_PROFILE_NAME_MAX} chars.`);
  }
  return value.trim();
}

function parseModelId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > AI_MODEL_ID_MAX) {
    throw invalid("AI_INVALID_PROFILE", `Model id must be 1 to ${AI_MODEL_ID_MAX} chars.`);
  }
  return value.trim();
}

function parseTransport(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > AI_TRANSPORT_MAX) {
    throw invalid("AI_INVALID_PROFILE", `Transport must be 1 to ${AI_TRANSPORT_MAX} chars or null.`);
  }
  return value.trim();
}

function parseCapabilityState(value: unknown): AiCapabilityState {
  if (typeof value === "string" && (CAPABILITY_STATES as readonly string[]).includes(value)) {
    return value as AiCapabilityState;
  }
  throw invalid("AI_INVALID_PROFILE", "Capability state must be unknown, supported, or unsupported.");
}

/** Operator-authored capability overrides: a bounded plain JSON object.
 * Returns the canonical stored text plus the parsed view shape. */
function parseCapabilities(value: unknown): { text: string; parsed: Record<string, unknown> } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("AI_INVALID_PROFILE", "Capabilities must be a JSON object.");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > AI_CAPABILITIES_KEYS_MAX) {
    throw invalid("AI_INVALID_PROFILE", `Capabilities carry at most ${AI_CAPABILITIES_KEYS_MAX} keys.`);
  }
  for (const [key] of entries) {
    if (key.length === 0 || key.length > AI_CAPABILITY_KEY_MAX) {
      throw invalid("AI_INVALID_PROFILE", `Capability names are 1 to ${AI_CAPABILITY_KEY_MAX} chars.`);
    }
  }
  const text = JSON.stringify(value);
  if (text.length > AI_CAPABILITIES_JSON_MAX) {
    throw invalid("AI_INVALID_PROFILE", `Capabilities carry at most ${AI_CAPABILITIES_JSON_MAX} JSON bytes.`);
  }
  return { text, parsed: JSON.parse(text) as Record<string, unknown> };
}

function storedCapabilities(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to the empty object: rows predate validation or were
    // written outside it, and a corrupt blob must never break the read path.
  }
  return {};
}

function isAiProviderName(name: string): boolean {
  return (AI_PROVIDER_KINDS as readonly string[]).includes(name);
}

/** Resolve the backing Connection for a profile/embedding write: exact org
 * ownership (foreign or missing rows 404, never leak), AI provider kind
 * only, and enabled. `invalidCode` names the caller entity for the
 * wrong-kind rejection. */
async function requireAiConnection(
  db: D1Database,
  orgId: string,
  connectionId: string,
  invalidCode: "AI_INVALID_PROFILE" | "AI_INVALID_EMBEDDING",
): Promise<{ row: AiConnectionRow; def: IntegrationDefinition }> {
  if (!UUID.test(connectionId)) {
    throw invalid("CONNECTION_NOT_FOUND", "No Connection exists for this Organization and Integration.", 404);
  }
  const row = await db
    .prepare("SELECT id,org_id,integration_id,endpoint,enabled FROM connections WHERE id=? AND org_id=?")
    .bind(connectionId, orgId)
    .first<AiConnectionRow>();
  if (!row) {
    throw invalid("CONNECTION_NOT_FOUND", "No Connection exists for this Organization and Integration.", 404);
  }
  const def = integrationById(row.integration_id);
  if (!def || !isAiProviderName(def.name)) {
    throw invalid(invalidCode, "AI configuration attaches to AI provider Connections only.");
  }
  if (row.enabled === 0) {
    // Same posture as the CON-01 test route: a disabled mapping reads as
    // missing (404), never as a silent skip or a half-credentialed probe.
    throw invalid(
      "CONNECTION_DISABLED",
      "This Connection is disabled: enable it before attaching AI configuration.",
      404,
    );
  }
  return { row, def };
}

function toProfileView(row: AiProfileRow, def: IntegrationDefinition): AiProfileView {
  return {
    id: row.id,
    name: row.name,
    connectionId: row.connection_id,
    integrationId: def.id,
    integrationName: def.name,
    enabledForChat: row.enabled_for_chat === 1,
    capabilities: Object.freeze({ ...storedCapabilities(row.capabilities_json) }),
    // The 0028 CHECK constrains this column to the three states; the cast
    // names the DDL contract (no second validation path).
    capabilityState: row.capability_state as AiCapabilityState,
    openaiTransport: row.openai_transport,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function ownedProfileRow(db: D1Database, orgId: string, id: string): Promise<AiProfileRow | null> {
  if (!UUID.test(id)) return null;
  return db
    .prepare(
      "SELECT id,org_id,connection_id,name,model_id,capabilities_json,openai_transport,enabled_for_chat,capability_state,created_at,updated_at FROM ai_model_profiles WHERE id=? AND org_id=?",
    )
    .bind(id, orgId)
    .first<AiProfileRow>();
}

/** View one owned profile row, or null when the row or its backing
 * Connection no longer resolves (stale rows vanish like CON-01's stale
 * Integration rows — never a half-shaped view). The 0028 RESTRICT FKs make
 * the vanished-row half unreachable through the API; the null stands for
 * rows written outside validation. */
async function viewableProfile(db: D1Database, orgId: string, row: AiProfileRow): Promise<AiProfileView | null> {
  const connection = await db
    .prepare("SELECT id,org_id,integration_id,endpoint,enabled FROM connections WHERE id=? AND org_id=?")
    .bind(row.connection_id, orgId)
    .first<AiConnectionRow>();
  if (!connection) return null;
  const def = integrationById(connection.integration_id);
  if (!def || !isAiProviderName(def.name)) return null;
  return toProfileView(row, def);
}

async function profileHasAssignment(
  db: D1Database,
  orgId: string,
  profileId: string,
  key: AiAssignmentKey,
): Promise<boolean> {
  const found = await db
    .prepare("SELECT 1 AS ok FROM ai_assignments WHERE org_id=? AND assignment_key=? AND profile_id=?")
    .bind(orgId, key, profileId)
    .first<{ ok: number }>();
  return found !== null;
}

async function orgHasAssignment(db: D1Database, orgId: string, key: AiAssignmentKey): Promise<boolean> {
  const found = await db
    .prepare("SELECT 1 AS ok FROM ai_assignments WHERE org_id=? AND assignment_key=?")
    .bind(orgId, key)
    .first<{ ok: number }>();
  return found !== null;
}

async function nameTaken(db: D1Database, orgId: string, name: string, excludeId?: string): Promise<boolean> {
  // The name column is COLLATE NOCASE, so `=` is the upstream
  // case-insensitive uniqueness check (plus the UNIQUE backstop in DDL).
  const found =
    excludeId === undefined
      ? await db
          .prepare("SELECT 1 AS ok FROM ai_model_profiles WHERE org_id=? AND name=?")
          .bind(orgId, name)
          .first<{ ok: number }>()
      : await db
          .prepare("SELECT 1 AS ok FROM ai_model_profiles WHERE org_id=? AND name=? AND id!=?")
          .bind(orgId, name, excludeId)
          .first<{ ok: number }>();
  return found !== null;
}

/** List this Organization's model profiles, CI-ordered by name (upstream
 * `list_profiles`). Identity-only views; stale rows vanish. */
export async function listProfiles(db: D1Database, caller: Principal): Promise<readonly AiProfileView[]> {
  const found = await db
    .prepare(
      "SELECT id,org_id,connection_id,name,model_id,capabilities_json,openai_transport,enabled_for_chat,capability_state,created_at,updated_at FROM ai_model_profiles WHERE org_id=? ORDER BY name",
    )
    .bind(caller.orgId)
    .all<AiProfileRow>();
  const views: AiProfileView[] = [];
  for (const row of found.results) {
    const view = await viewableProfile(db, caller.orgId, row);
    if (view) views.push(view);
  }
  return Object.freeze(views);
}

/** Read one owned profile. Foreign, unknown, or stale rows answer
 * AI_PROFILE_NOT_FOUND (404), never a leak. */
export async function getProfile(db: D1Database, caller: Principal, id: string): Promise<AiProfileView> {
  const row = await ownedProfileRow(db, caller.orgId, id);
  const view = row ? await viewableProfile(db, caller.orgId, row) : null;
  if (!view) throw invalid("AI_PROFILE_NOT_FOUND", "No model profile exists for this Organization.", 404);
  return view;
}

export interface AiProfileCreate {
  readonly name?: unknown;
  readonly connectionId?: unknown;
  readonly modelId?: unknown;
  readonly capabilities?: unknown;
  readonly enabledForChat?: unknown;
  readonly openaiTransport?: unknown;
  readonly capabilityState?: unknown;
}

/** Create a reusable model profile (upstream `create_profile`, org-scoped).
 * Lifecycle guard 1: the first profile in an org is forced chat-enabled and
 * auto-assigned to all six keys; a later chat-enabled profile backfills a
 * missing chat_default. Guard inputs reject with AI_INVALID_PROFILE. */
export async function createProfile(db: D1Database, caller: Principal, body: AiProfileCreate): Promise<AiProfileView> {
  const name = parseProfileName(body.name);
  if (typeof body.connectionId !== "string") {
    throw invalid("AI_INVALID_PROFILE", "A profile needs a connectionId.");
  }
  const modelId = parseModelId(body.modelId);
  const { def } = await requireAiConnection(db, caller.orgId, body.connectionId, "AI_INVALID_PROFILE");
  const capabilities =
    body.capabilities === undefined ? { text: "{}", parsed: {} } : parseCapabilities(body.capabilities);
  if (body.enabledForChat !== undefined && typeof body.enabledForChat !== "boolean") {
    throw invalid("AI_INVALID_PROFILE", "enabledForChat must be true or false when provided.");
  }
  const transport = parseTransport(body.openaiTransport);
  const capabilityState = body.capabilityState === undefined ? "unknown" : parseCapabilityState(body.capabilityState);
  if (await nameTaken(db, caller.orgId, name)) {
    throw invalid("AI_PROFILE_EXISTS", "A model profile with this name already exists.", 409);
  }
  const existing = await db
    .prepare("SELECT 1 AS ok FROM ai_model_profiles WHERE org_id=? LIMIT 1")
    .bind(caller.orgId)
    .first<{ ok: number }>();
  const isFirst = existing === null;
  const enabledForChat = body.enabledForChat === true || isFirst;
  const now = new Date().toISOString();
  const id = crypto.randomUUID().toLowerCase();
  await db
    .prepare(
      "INSERT INTO ai_model_profiles(id,org_id,connection_id,name,model_id,capabilities_json,openai_transport,enabled_for_chat,capability_state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      id,
      caller.orgId,
      body.connectionId,
      name,
      modelId,
      capabilities.text,
      transport,
      enabledForChat ? 1 : 0,
      capabilityState,
      now,
      now,
    )
    .run();
  if (isFirst) {
    for (const key of AI_ASSIGNMENT_KEYS) {
      await db
        .prepare("INSERT INTO ai_assignments(org_id,assignment_key,profile_id,updated_at) VALUES (?,?,?,?)")
        .bind(caller.orgId, key, id, now)
        .run();
    }
  } else if (enabledForChat && !(await orgHasAssignment(db, caller.orgId, "chat_default"))) {
    await db
      .prepare("INSERT INTO ai_assignments(org_id,assignment_key,profile_id,updated_at) VALUES (?,?,?,?)")
      .bind(caller.orgId, "chat_default", id, now)
      .run();
  }
  const row = await ownedProfileRow(db, caller.orgId, id);
  if (!row) throw invalid("AI_PROFILE_NOT_FOUND", "The profile could not be read after create.", 500);
  return toProfileView(row, def);
}

export interface AiProfileUpdate {
  readonly name?: unknown;
  readonly connectionId?: unknown;
  readonly modelId?: unknown;
  readonly capabilities?: unknown;
  readonly enabledForChat?: unknown;
  readonly openaiTransport?: unknown;
  readonly capabilityState?: unknown;
}

/** Update a reusable model profile (upstream `update_profile`, org-scoped).
 * Partial: omitted keys keep current values. Lifecycle guard 2: clearing
 * chat while holding chat_default is rejected. Connection or model changes
 * reset openai_transport and capability_state (upstream transport reset plus
 * the ADR 032 capability reset); an explicit transport change resets
 * capability_state. Enabling chat backfills a missing chat_default. */
export async function updateProfile(
  db: D1Database,
  caller: Principal,
  id: string,
  body: AiProfileUpdate,
): Promise<AiProfileView> {
  const row = await ownedProfileRow(db, caller.orgId, id);
  if (!row) throw invalid("AI_PROFILE_NOT_FOUND", "No model profile exists for this Organization.", 404);
  const name = body.name === undefined ? row.name : parseProfileName(body.name);
  if (body.name !== undefined && (await nameTaken(db, caller.orgId, name, row.id))) {
    throw invalid("AI_PROFILE_EXISTS", "A model profile with this name already exists.", 409);
  }
  const connectionId = body.connectionId === undefined ? row.connection_id : body.connectionId;
  if (typeof connectionId !== "string") {
    throw invalid("AI_INVALID_PROFILE", "A profile needs a connectionId.");
  }
  const { def } = await requireAiConnection(db, caller.orgId, connectionId, "AI_INVALID_PROFILE");
  const modelId = body.modelId === undefined ? row.model_id : parseModelId(body.modelId);
  const capabilities =
    body.capabilities === undefined ? row.capabilities_json : parseCapabilities(body.capabilities).text;
  if (body.enabledForChat !== undefined && typeof body.enabledForChat !== "boolean") {
    throw invalid("AI_INVALID_PROFILE", "enabledForChat must be true or false when provided.");
  }
  const enabledForChat = body.enabledForChat === undefined ? row.enabled_for_chat === 1 : body.enabledForChat;
  if (!enabledForChat && (await profileHasAssignment(db, caller.orgId, row.id, "chat_default"))) {
    throw invalid("AI_CHAT_DEFAULT_HELD", "The default chat profile must stay enabled for chat.", 409);
  }
  const connectionChanged = connectionId !== row.connection_id;
  const modelChanged = modelId !== row.model_id;
  // Upstream resets openai_transport on connection/model change; ADR 032
  // resets capability knowledge on endpoint/transport identity change. An
  // explicit transport edit resets capability_state but keeps the new value.
  const transport =
    connectionChanged || modelChanged
      ? null
      : body.openaiTransport === undefined
        ? row.openai_transport
        : parseTransport(body.openaiTransport);
  const transportChanged = transport !== row.openai_transport;
  const capabilityState =
    connectionChanged || modelChanged || transportChanged
      ? "unknown"
      : body.capabilityState === undefined
        ? (row.capability_state as AiCapabilityState)
        : parseCapabilityState(body.capabilityState);
  const now = new Date().toISOString();
  await db
    .prepare(
      "UPDATE ai_model_profiles SET connection_id=?,name=?,model_id=?,capabilities_json=?,openai_transport=?,enabled_for_chat=?,capability_state=?,updated_at=? WHERE id=? AND org_id=?",
    )
    .bind(
      connectionId,
      name,
      modelId,
      capabilities,
      transport,
      enabledForChat ? 1 : 0,
      capabilityState,
      now,
      row.id,
      caller.orgId,
    )
    .run();
  if (enabledForChat && !(await orgHasAssignment(db, caller.orgId, "chat_default"))) {
    await db
      .prepare("INSERT INTO ai_assignments(org_id,assignment_key,profile_id,updated_at) VALUES (?,?,?,?)")
      .bind(caller.orgId, "chat_default", row.id, now)
      .run();
  }
  const next = await ownedProfileRow(db, caller.orgId, row.id);
  if (!next) throw invalid("AI_PROFILE_NOT_FOUND", "The profile could not be read after update.", 500);
  return toProfileView(next, def);
}

/** Delete a model profile. Lifecycle guard 3 (upstream `delete_profile`):
 * deletes blocked while any assignment references the profile. */
export async function deleteProfile(db: D1Database, caller: Principal, id: string): Promise<void> {
  const row = await ownedProfileRow(db, caller.orgId, id);
  if (!row) throw invalid("AI_PROFILE_NOT_FOUND", "No model profile exists for this Organization.", 404);
  const referenced = await db
    .prepare("SELECT 1 AS ok FROM ai_assignments WHERE org_id=? AND profile_id=? LIMIT 1")
    .bind(caller.orgId, row.id)
    .first<{ ok: number }>();
  if (referenced) {
    throw invalid("AI_PROFILE_REFERENCED", "Model profile is used by assignments.", 409);
  }
  await db.prepare("DELETE FROM ai_model_profiles WHERE id=? AND org_id=?").bind(row.id, caller.orgId).run();
}

export interface AiProfileMerge {
  readonly profileIds?: unknown;
  readonly targetProfileId?: unknown;
}

export interface AiProfileMergeResult {
  readonly profile: AiProfileView;
  readonly mergedProfileIds: readonly string[];
  readonly reassignedAssignmentKeys: readonly AiAssignmentKey[];
}

/** Merge profiles into one target (upstream `merge_profiles`, org-scoped,
 * without the agent half — no agent entity exists in v0). Lifecycle guard 4:
 * assignments pointing at sources reassign to the target and chat flags OR.
 * Selection is bounded for the D1 per-invocation query budget. */
export async function mergeProfiles(
  db: D1Database,
  caller: Principal,
  body: AiProfileMerge,
): Promise<AiProfileMergeResult> {
  if (!Array.isArray(body.profileIds) || typeof body.targetProfileId !== "string") {
    throw invalid("AI_INVALID_MERGE", "A merge needs profileIds plus a targetProfileId.");
  }
  const ids = body.profileIds;
  if (ids.some((entry) => typeof entry !== "string") || new Set(ids).size !== ids.length) {
    throw invalid("AI_INVALID_MERGE", "Profile selection must not contain duplicates.");
  }
  if (ids.length < 2 || ids.length > AI_MERGE_SELECTION_MAX) {
    throw invalid("AI_INVALID_MERGE", `Select 2 to ${AI_MERGE_SELECTION_MAX} model profiles to merge.`);
  }
  const targetId = body.targetProfileId;
  if (!ids.includes(targetId)) {
    throw invalid("AI_INVALID_MERGE", "Target profile must be included in the profile selection.");
  }
  const rows: AiProfileRow[] = [];
  for (const id of ids) {
    const row = await ownedProfileRow(db, caller.orgId, id);
    // Foreign or unknown ids answer 404 (never which one, never a leak).
    if (!row) throw invalid("AI_PROFILE_NOT_FOUND", "One or more model profiles were not found.", 404);
    rows.push(row);
  }
  const target = rows.find((row) => row.id === targetId);
  if (!target) throw invalid("AI_PROFILE_NOT_FOUND", "One or more model profiles were not found.", 404);
  const sourceIds = rows.map((row) => row.id).filter((id) => id !== targetId);
  const assignments = await db
    .prepare("SELECT assignment_key,profile_id,updated_at FROM ai_assignments WHERE org_id=?")
    .bind(caller.orgId)
    .all<AiAssignmentRow>();
  const reassigned: AiAssignmentKey[] = [];
  const now = new Date().toISOString();
  for (const assignment of assignments.results) {
    if (!sourceIds.includes(assignment.profile_id)) continue;
    await db
      .prepare("UPDATE ai_assignments SET profile_id=?,updated_at=? WHERE org_id=? AND assignment_key=?")
      .bind(targetId, now, caller.orgId, assignment.assignment_key)
      .run();
    reassigned.push(assignment.assignment_key as AiAssignmentKey);
  }
  const preserveChat = rows.some((row) => row.enabled_for_chat === 1);
  await db
    .prepare("UPDATE ai_model_profiles SET enabled_for_chat=?,updated_at=? WHERE id=? AND org_id=?")
    .bind(preserveChat ? 1 : 0, now, targetId, caller.orgId)
    .run();
  for (const id of sourceIds) {
    await db.prepare("DELETE FROM ai_model_profiles WHERE id=? AND org_id=?").bind(id, caller.orgId).run();
  }
  const merged = await getProfile(db, caller, targetId);
  return {
    profile: merged,
    mergedProfileIds: Object.freeze([...sourceIds].sort()),
    reassignedAssignmentKeys: Object.freeze([...reassigned].sort()),
  };
}

/** List all six assignment keys with their mapped profile (or null when
 * unmapped or no longer resolving). Ordered by key, like upstream. */
export async function listAssignments(db: D1Database, caller: Principal): Promise<readonly AiAssignmentView[]> {
  const found = await db
    .prepare("SELECT assignment_key,profile_id,updated_at FROM ai_assignments WHERE org_id=?")
    .bind(caller.orgId)
    .all<AiAssignmentRow>();
  const byKey = new Map(found.results.map((row) => [row.assignment_key, row]));
  const views: AiAssignmentView[] = [];
  for (const key of AI_ASSIGNMENT_KEYS) {
    const row = byKey.get(key);
    if (!row) {
      views.push({ key, profile: null, updatedAt: null });
      continue;
    }
    views.push({ key, profile: await resolveProfileView(db, caller.orgId, row.profile_id), updatedAt: row.updated_at });
  }
  return Object.freeze(views);
}

/** Resolve one mapped profile id to a usable view, or null when the profile
 * row, its backing Connection, or the Connection's enabled flag fails. The
 * single fail-closed gate behind listAssignments and resolveAssignment. */
async function resolveProfileView(db: D1Database, orgId: string, profileId: string): Promise<AiProfileView | null> {
  const row = await ownedProfileRow(db, orgId, profileId);
  if (!row) return null;
  const connection = await db
    .prepare("SELECT id,org_id,integration_id,endpoint,enabled FROM connections WHERE id=? AND org_id=?")
    .bind(row.connection_id, orgId)
    .first<AiConnectionRow>();
  if (!connection || connection.enabled === 0) return null;
  const def = integrationById(connection.integration_id);
  if (!def || !isAiProviderName(def.name)) return null;
  return toProfileView(row, def);
}

/** Centralized fail-closed resolver (upstream `resolve_config` minus the
 * decrypted runtime half, which waits on live inference): an assignment key
 * resolves to exactly one usable profile view, or null. Unknown keys reject
 * (400); every unusable state — unmapped, dangling, disabled — is null. */
export async function resolveAssignment(
  db: D1Database,
  caller: Principal,
  key: AiAssignmentKey,
): Promise<AiResolution | null> {
  const row = await db
    .prepare("SELECT assignment_key,profile_id,updated_at FROM ai_assignments WHERE org_id=? AND assignment_key=?")
    .bind(caller.orgId, key)
    .first<AiAssignmentRow>();
  if (!row) return null;
  const profile = await resolveProfileView(db, caller.orgId, row.profile_id);
  if (!profile) return null;
  return { key, profile };
}

export interface AiAssignmentWrite {
  readonly profileId?: unknown;
}

/** Set (or clear, via explicit null) one assignment (upstream
 * `set_assignment` / `clear_assignment`, org-scoped). `primary` and
 * `chat_default` cannot be cleared; chat_default needs a chat-enabled
 * profile; the mapped profile must be owned with an enabled AI Connection. */
export async function setAssignment(
  db: D1Database,
  caller: Principal,
  key: AiAssignmentKey,
  body: AiAssignmentWrite,
): Promise<AiAssignmentView> {
  if (body.profileId === null) {
    if (key === "primary" || key === "chat_default") {
      throw invalid("AI_ASSIGNMENT_REQUIRED", `The '${key}' assignment is required.`, 409);
    }
    await db.prepare("DELETE FROM ai_assignments WHERE org_id=? AND assignment_key=?").bind(caller.orgId, key).run();
    return { key, profile: null, updatedAt: null };
  }
  if (typeof body.profileId !== "string") {
    // Missing and mistyped alike: only a profile id sets, only explicit
    // null clears — an empty body must never clear by accident.
    throw invalid("AI_INVALID_ASSIGNMENT", "An assignment needs a profileId or explicit null.");
  }
  const row = await ownedProfileRow(db, caller.orgId, body.profileId);
  if (!row) throw invalid("AI_PROFILE_NOT_FOUND", "No model profile exists for this Organization.", 404);
  await requireAiConnection(db, caller.orgId, row.connection_id, "AI_INVALID_PROFILE");
  if (key === "chat_default" && row.enabled_for_chat !== 1) {
    throw invalid("AI_PROFILE_NOT_CHAT", "Default chat assignment requires a chat-enabled profile.");
  }
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO ai_assignments(org_id,assignment_key,profile_id,updated_at) VALUES (?,?,?,?) ON CONFLICT(org_id,assignment_key) DO UPDATE SET profile_id=excluded.profile_id,updated_at=excluded.updated_at",
    )
    .bind(caller.orgId, key, row.id, now)
    .run();
  return { key, profile: await resolveProfileView(db, caller.orgId, row.id), updatedAt: now };
}

/** Parse one assignment key from a route capture (400 on unknown keys). */
export function parseRouteAssignmentKey(value: string): AiAssignmentKey {
  return parseAssignmentKey(value);
}

export interface AiEmbeddingWrite {
  readonly connectionId?: unknown;
  readonly modelId?: unknown;
  readonly dimensions?: unknown;
}

function parsePrompt(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > AI_PROMPT_MAX) {
    throw invalid("AI_INVALID_BEHAVIOR", `Default prompt must be 1 to ${AI_PROMPT_MAX} chars.`);
  }
  return value;
}

function parseDimensions(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > AI_DIMENSIONS_MAX) {
    throw invalid("AI_INVALID_EMBEDDING", `Dimensions must be an integer 1 to ${AI_DIMENSIONS_MAX} or null.`);
  }
  return value;
}

/** Read this Organization's embedding singleton (null when unconfigured).
 * Independent of generation profiles by design (ADR 032). */
export async function getEmbedding(db: D1Database, caller: Principal): Promise<AiEmbeddingView | null> {
  const row = await db
    .prepare("SELECT connection_id,model_id,dimensions,updated_at FROM ai_embedding_config WHERE org_id=?")
    .bind(caller.orgId)
    .first<{ connection_id: string; model_id: string; dimensions: number | null; updated_at: string }>();
  if (!row) return null;
  const connection = await db
    .prepare("SELECT id,org_id,integration_id,endpoint,enabled FROM connections WHERE id=? AND org_id=?")
    .bind(row.connection_id, caller.orgId)
    .first<AiConnectionRow>();
  if (!connection) return null;
  const def = integrationById(connection.integration_id);
  if (!def || !isAiProviderName(def.name)) return null;
  return {
    connectionId: row.connection_id,
    integrationId: def.id,
    integrationName: def.name,
    dimensions: row.dimensions,
    updatedAt: row.updated_at,
  };
}

/** Upsert this Organization's embedding singleton. The Connection must be an
 * owned, enabled AI provider mapping; the model id persists server-side and
 * never appears in the returned view. */
export async function setEmbedding(
  db: D1Database,
  caller: Principal,
  body: AiEmbeddingWrite,
): Promise<AiEmbeddingView> {
  if (typeof body.connectionId !== "string") {
    throw invalid("AI_INVALID_EMBEDDING", "Embedding configuration needs a connectionId.");
  }
  if (
    typeof body.modelId !== "string" ||
    body.modelId.trim().length === 0 ||
    body.modelId.trim().length > AI_MODEL_ID_MAX
  ) {
    throw invalid("AI_INVALID_EMBEDDING", `Model id must be 1 to ${AI_MODEL_ID_MAX} chars.`);
  }
  const dimensions = parseDimensions(body.dimensions);
  const { def } = await requireAiConnection(db, caller.orgId, body.connectionId, "AI_INVALID_EMBEDDING");
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO ai_embedding_config(org_id,connection_id,model_id,dimensions,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(org_id) DO UPDATE SET connection_id=excluded.connection_id,model_id=excluded.model_id,dimensions=excluded.dimensions,updated_at=excluded.updated_at",
    )
    .bind(caller.orgId, body.connectionId, body.modelId.trim(), dimensions, now)
    .run();
  return {
    connectionId: body.connectionId,
    integrationId: def.id,
    integrationName: def.name,
    dimensions,
    updatedAt: now,
  };
}

export interface AiBehaviorWrite {
  readonly defaultSystemPrompt?: unknown;
}

/** Read this Organization's behavior row (null when unconfigured). */
export async function getBehavior(db: D1Database, caller: Principal): Promise<AiBehaviorView | null> {
  const row = await db
    .prepare("SELECT default_system_prompt,updated_at FROM ai_behavior WHERE org_id=?")
    .bind(caller.orgId)
    .first<{ default_system_prompt: string; updated_at: string }>();
  if (!row) return null;
  return { defaultSystemPrompt: row.default_system_prompt, updatedAt: row.updated_at };
}

/** Upsert this Organization's behavior row (default system prompt). */
export async function setBehavior(db: D1Database, caller: Principal, body: AiBehaviorWrite): Promise<AiBehaviorView> {
  const prompt = parsePrompt(body.defaultSystemPrompt);
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO ai_behavior(org_id,default_system_prompt,updated_at) VALUES (?,?,?) ON CONFLICT(org_id) DO UPDATE SET default_system_prompt=excluded.default_system_prompt,updated_at=excluded.updated_at",
    )
    .bind(caller.orgId, prompt, now)
    .run();
  return { defaultSystemPrompt: prompt, updatedAt: now };
}

interface AiVendorTarget {
  readonly modelsPath: string;
  readonly headers: (key: string) => Record<string, string>;
}

/** Per-provider model-list target (verify/discovery). Keys ride headers,
 * never URLs (URLs are logged); Google uses its header form for the same
 * reason. Anthropic's version header is its documented required field.
 * Total over the five AI provider kinds; unknown names are a registry bug
 * and fail loud (never a guessed endpoint). */
export function vendorTarget(name: string): AiVendorTarget {
  if (name === "openai" || name === "openai-compatible") {
    return {
      modelsPath: "/v1/models",
      headers: (key) => ({ Accept: "application/json", Authorization: `Bearer ${key}` }),
    };
  }
  if (name === "openrouter") {
    return {
      modelsPath: "/api/v1/models",
      headers: (key) => ({ Accept: "application/json", Authorization: `Bearer ${key}` }),
    };
  }
  if (name === "anthropic") {
    return {
      modelsPath: "/v1/models",
      headers: (key) => ({
        Accept: "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      }),
    };
  }
  if (name === "google") {
    return {
      modelsPath: "/v1beta/models",
      headers: (key) => ({ Accept: "application/json", "x-goog-api-key": key }),
    };
  }
  throw new Fault(500, "INTERNAL_ERROR", `No vendor model-list target for provider "${name}".`);
}

/** Join an operator endpoint with a vendor list path without doubling a
 * version prefix the endpoint already carries (openai-compatible origins
 * often include `/v1`) or dropping an endpoint subpath (so no URL resolve). */
export function joinVendorListPath(endpoint: string, modelsPath: string): string {
  const trimmed = endpoint.replace(/\/+$/, "");
  if (trimmed.endsWith("/models")) return trimmed;
  for (const prefix of ["/api/v1", "/v1beta", "/v1"]) {
    if (modelsPath.startsWith(`${prefix}/`) && trimmed.endsWith(prefix)) {
      return trimmed + modelsPath.slice(prefix.length);
    }
  }
  return trimmed + modelsPath;
}

/** Collect candidate model ids from a vendor list body: OpenAI-shaped
 * `{data:[{id}]}` (openai/openai-compatible/openrouter/anthropic) and
 * Google-shaped `{models:[{name}]}` where names read `models/<id>`.
 * Unknown shapes answer null (fail closed, never a guessed match). */
export function collectVendorModelIds(value: unknown): readonly string[] | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const out: string[] = [];
  const push = (entry: unknown): void => {
    if (out.length >= AI_DISCOVERY_MODELS_MAX) return;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return;
    const fields = entry as Record<string, unknown>;
    const raw = fields["id"] ?? fields["name"];
    if (typeof raw !== "string" || raw.length === 0) return;
    out.push(raw);
    const leaf = raw.split("/").pop();
    if (leaf && leaf !== raw) out.push(leaf);
  };
  if (Array.isArray(record["data"])) {
    for (const entry of record["data"] as unknown[]) push(entry);
    return out;
  }
  if (Array.isArray(record["models"])) {
    for (const entry of record["models"] as unknown[]) push(entry);
    return out;
  }
  return null;
}

interface AiVendorList {
  readonly ok: boolean;
  readonly ids: readonly string[];
  readonly failure: string;
}

/** Bounded read-only vendor model list (shared by verify and discovery):
 * 5s deadline, manual redirects, 64 KiB body cap, fixed failure strings
 * only — vendor text never flows outward (the route scrubs regardless). */
async function fetchVendorModelIds(
  endpoint: string,
  target: AiVendorTarget,
  key: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<AiVendorList> {
  const fail = (failure: string): AiVendorList => ({ ok: false, ids: [], failure });
  let response: Response;
  try {
    response = await fetchImpl(joinVendorListPath(endpoint, target.modelsPath), {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: target.headers(key),
    });
  } catch {
    return fail("The provider did not answer before the deadline.");
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return fail("The provider redirected the request.");
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    return fail("The provider rejected the deployment credential.");
  }
  if (response.status === 429) {
    await response.body?.cancel();
    return fail("The provider rate-limited the request.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    return fail("The provider did not return a model list.");
  }
  let value: unknown;
  try {
    value = await boundedJson(response.body, AI_VENDOR_BODY_MAX);
  } catch {
    return fail("The provider returned an unreadable model list.");
  }
  const ids = collectVendorModelIds(value);
  if (ids === null) return fail("The provider returned an unexpected model list shape.");
  return { ok: true, ids, failure: "" };
}

/** Shared guard ladder for the key-authenticated probes (verify,
 * conformance): exact org ownership (foreign rows 404, never leak), AI
 * provider kind only, and enabled. Returns the owned triple; every message
 * below is the verify wording both probes share. */
async function loadProbeTarget(
  db: D1Database,
  caller: Principal,
  id: string,
): Promise<{ row: AiProfileRow; connection: AiConnectionRow; def: IntegrationDefinition }> {
  const row = await ownedProfileRow(db, caller.orgId, id);
  if (!row) throw invalid("AI_PROFILE_NOT_FOUND", "No model profile exists for this Organization.", 404);
  const connection = await db
    .prepare("SELECT id,org_id,integration_id,endpoint,enabled FROM connections WHERE id=? AND org_id=?")
    .bind(row.connection_id, caller.orgId)
    .first<AiConnectionRow>();
  if (!connection) {
    throw invalid("CONNECTION_NOT_FOUND", "No Connection exists for this Organization and Integration.", 404);
  }
  const def = integrationById(connection.integration_id);
  if (!def || !isAiProviderName(def.name)) {
    throw invalid("AI_INVALID_PROFILE", "AI configuration attaches to AI provider Connections only.");
  }
  if (connection.enabled === 0) {
    throw invalid("CONNECTION_DISABLED", "This Connection is disabled: enable it before verifying profiles.", 404);
  }
  return { row, connection, def };
}

/** Capability-conformance outcome: the operator-asserted posture
 * (capability override keys + capabilityState) compared against the observed
 * vendor list (model listed or not). Read-only by construction: no D1
 * writes, no state mutation. The vendor list only observes availability, so
 * conformance flags exactly the provable contradictions — asserted keys or
 * a supported state with the model absent — and never claims per-capability
 * verification it cannot observe. Key and model id never ride the outcome. */
export type AiConformanceOutcome =
  | {
      readonly ok: true;
      readonly checkedAt: string;
      readonly profileId: string;
      readonly modelAvailable: boolean;
      readonly capabilityState: AiCapabilityState;
      /** Sorted asserted override keys (non-secret operator config). */
      readonly assertedCapabilities: readonly string[];
      readonly conforms: boolean;
      /** Fixed mismatch tokens, empty when conforming. */
      readonly mismatches: readonly string[];
      readonly detail: string;
    }
  | { readonly ok: false; readonly checkedAt: string; readonly code: string; readonly detail: string };

/** Check one profile's asserted capabilities against the observed vendor
 * list with the deployment key (same ADR 032 ladder as verify: presence
 * check, endpoint re-parse, bounded list). Client errors throw; vendor
 * failures answer ok:false with fixed details. */
export async function checkConformance(
  db: D1Database,
  caller: Principal,
  id: string,
  env: AiSecretEnv,
  vendor: AiVendorOpts = {},
): Promise<AiConformanceOutcome> {
  const { row, connection, def } = await loadProbeTarget(db, caller, id);
  const checkedAt = new Date().toISOString();
  const failed = (code: string, detail: string): AiConformanceOutcome => ({ ok: false, checkedAt, code, detail });
  const envVar = def.secretEnvVars["apiKey"] as string;
  const key = secretValue(env, envVar);
  if (key === undefined) {
    return failed(
      "SECRET_NOT_CONFIGURED",
      `Deployment credential ${envVar} is not configured: refusing a half-credentialed conformance check.`,
    );
  }
  try {
    assertSafeEndpoint(def.name, connection.endpoint);
  } catch {
    return failed("INVALID_CONNECTION", "This Connection endpoint is not a safe URL: update it before checking.");
  }
  const target = vendorTarget(def.name);
  const fetchImpl = vendor.fetchImpl ?? globalThis.fetch;
  const timeoutMs = vendor.timeoutMs ?? AI_VENDOR_TIMEOUT_MS;
  const listed = await fetchVendorModelIds(connection.endpoint, target, key, fetchImpl, timeoutMs);
  if (!listed.ok) return failed("AI_CONFORMANCE_FAILED", listed.failure);
  const modelAvailable = listed.ids.includes(row.model_id);
  const assertedCapabilities = Object.freeze(Object.keys(storedCapabilities(row.capabilities_json)).sort());
  const capabilityState = row.capability_state as AiCapabilityState;
  const mismatches: string[] = [];
  if (!modelAvailable) {
    if (assertedCapabilities.length > 0) mismatches.push("asserted-capabilities-unconfirmed");
    if (capabilityState === "supported") mismatches.push("state-supported-but-model-absent");
  }
  const conforms = mismatches.length === 0;
  return {
    ok: true,
    checkedAt,
    profileId: row.id,
    modelAvailable,
    capabilityState,
    assertedCapabilities,
    conforms,
    mismatches: Object.freeze(mismatches),
    detail: !conforms
      ? "The asserted capabilities do not conform to the observed vendor list."
      : modelAvailable
        ? "The provider lists the profile model and nothing asserted contradicts it."
        : "The provider list does not include the profile model; nothing asserted depends on it.",
  };
}

/** Verify one profile against its provider with the deployment key
 * (upstream test-before-save, ADR 032 ladder): presence-check the declared
 * secret (no fetch without it), re-parse the persisted endpoint, run the
 * bounded key-authenticated list, and report whether the profile's model
 * rides it. Read-only by construction; the key and the model id never
 * appear in the outcome. Client errors throw; vendor failures answer
 * ok:false with fixed details. */
export async function verifyProfile(
  db: D1Database,
  caller: Principal,
  id: string,
  env: AiSecretEnv,
  vendor: AiVendorOpts = {},
): Promise<AiVerifyOutcome> {
  const { row, connection, def } = await loadProbeTarget(db, caller, id);
  const checkedAt = new Date().toISOString();
  const failed = (code: string, detail: string): AiVerifyOutcome => ({ ok: false, checkedAt, code, detail });
  // The registry pins secretEnvVars.apiKey on all five AI defs (ai-01-build
  // test); a missing mapping is a registry bug, surfaced as unconfigured.
  const envVar = def.secretEnvVars["apiKey"] as string;
  const key = secretValue(env, envVar);
  if (key === undefined) {
    return failed(
      "SECRET_NOT_CONFIGURED",
      `Deployment credential ${envVar} is not configured: refusing a half-credentialed verification.`,
    );
  }
  try {
    assertSafeEndpoint(def.name, connection.endpoint);
  } catch {
    return failed("INVALID_CONNECTION", "This Connection endpoint is not a safe URL: update it before verifying.");
  }
  const target = vendorTarget(def.name);
  const fetchImpl = vendor.fetchImpl ?? globalThis.fetch;
  const timeoutMs = vendor.timeoutMs ?? AI_VENDOR_TIMEOUT_MS;
  const listed = await fetchVendorModelIds(connection.endpoint, target, key, fetchImpl, timeoutMs);
  if (!listed.ok) return failed("AI_VERIFY_FAILED", listed.failure);
  const modelAvailable = listed.ids.includes(row.model_id);
  return {
    ok: true,
    checkedAt,
    profileId: row.id,
    modelAvailable,
    detail: modelAvailable
      ? "The provider lists the profile model."
      : "The provider list does not include the profile model.",
  };
}

/** Discover vendor models for one AI provider mapping (integration-addressed
 * like CON-01): the bounded key-authenticated list answered as a count plus
 * per-profile availability — vendor model ids and key material never ride
 * the outcome. Client errors throw; vendor failures answer ok:false. */
export async function discoverModels(
  db: D1Database,
  caller: Principal,
  integrationId: string,
  env: AiSecretEnv,
  vendor: AiVendorOpts = {},
): Promise<AiDiscoveryOutcome> {
  if (!UUID.test(integrationId)) throw invalid("UNKNOWN_INTEGRATION", "Unknown Integration id.", 404);
  const def = integrationById(integrationId);
  if (!def || !isAiProviderName(def.name)) {
    throw invalid("UNKNOWN_INTEGRATION", "Unknown Integration id.", 404);
  }
  const checkedAt = new Date().toISOString();
  const failed = (code: string, detail: string): AiDiscoveryOutcome => ({ ok: false, checkedAt, code, detail });
  const connection = await db
    .prepare("SELECT id,org_id,integration_id,endpoint,enabled FROM connections WHERE org_id=? AND integration_id=?")
    .bind(caller.orgId, integrationId)
    .first<AiConnectionRow>();
  if (!connection) {
    throw invalid("CONNECTION_NOT_FOUND", "No Connection exists for this Organization and Integration.", 404);
  }
  if (connection.enabled === 0) {
    throw invalid("CONNECTION_DISABLED", "This Connection is disabled: enable it before discovering models.", 404);
  }
  const envVar = def.secretEnvVars["apiKey"] as string;
  const key = secretValue(env, envVar);
  if (key === undefined) {
    return failed(
      "SECRET_NOT_CONFIGURED",
      `Deployment credential ${envVar} is not configured: refusing a half-credentialed discovery.`,
    );
  }
  try {
    assertSafeEndpoint(def.name, connection.endpoint);
  } catch {
    return failed("INVALID_CONNECTION", "This Connection endpoint is not a safe URL: update it before discovering.");
  }
  const target = vendorTarget(def.name);
  const fetchImpl = vendor.fetchImpl ?? globalThis.fetch;
  const timeoutMs = vendor.timeoutMs ?? AI_VENDOR_TIMEOUT_MS;
  const listed = await fetchVendorModelIds(connection.endpoint, target, key, fetchImpl, timeoutMs);
  if (!listed.ok) return failed("AI_DISCOVERY_FAILED", listed.failure);
  const owned = await db
    .prepare("SELECT id,name,model_id FROM ai_model_profiles WHERE org_id=? AND connection_id=? ORDER BY name")
    .bind(caller.orgId, connection.id)
    .all<{ id: string; name: string; model_id: string }>();
  const profiles: AiModelAvailability[] = owned.results.map((entry) => ({
    profileId: entry.id,
    name: entry.name,
    modelAvailable: listed.ids.includes(entry.model_id),
  }));
  return {
    ok: true,
    checkedAt,
    connectionId: connection.id,
    integrationId: def.id,
    modelCount: listed.ids.length,
    profiles: Object.freeze(profiles),
  };
}
