// SPDX-License-Identifier: AGPL-3.0
// Dynamic forms (FORM-02, issue #155; FORM-01 binding in this module).
//
// FORM-01 owns the persisted declaration plus the validate-against-the-
// declaration gate (unknown names rejected, per-field 422 details, Saga
// parse gate authoritative on drift). FORM-02 adds the usable surface on
// top of the same D1 `forms` table (migration 0005, no new DDL):
//
// - Field types beyond text: number, boolean, email, date, time,
//   datetime, select, multiselect, textarea, url, tel, file, hidden,
//   heading, paragraph, divider. Display-only kinds (heading, paragraph,
//   divider) never bind to Saga inputs: declarations may carry them for
//   layout, submissions carrying their names fail closed with
//   DISPLAY_ONLY_FIELD.
// - Defaults with input merge semantics: validated submission values win,
//   declared defaults fill visible gaps (a visible required field with a
//   default passes when omitted; hidden-field defaults stay dropped, fail
//   closed like hidden values), and neither invents undeclared names.
// - Conditional visibility (`visibleWhen: { field, equals }`): evaluated
//   over the startup snapshot under the submit body; a field hidden by the
//   rule is dropped from the bound input (form state stays inspectable
//   through the startup handle snapshot, never the Execution).
// - Dynamic option providers: a declared `provider: { kind: "table",
//   table, valueField, labelField? }` or `{ kind: "static",
//   options }` feeds select/multiselect option lists. The startup route
//   resolves options through the caller-scoped Table policy gate (foreign
//   or denied tables fail closed, never leak); the submit route
//   re-checks option membership against freshly resolved options, so a
//   stale client list cannot smuggle an unlisted value.
// - Bounded startup handles: POST /api/forms/:name/startup mints a
//   random 30-minute session-bound handle (token hash persisted in
//   `form_startups`, single row per handle). Submit peeks the handle for
//   validation and consumes it only after all validation gates pass
//   (form gate, file check, Saga parse), so failed validation leaves it
//   live for a corrected retry; the dispatch fence then answers 202/200
//   or 409. Unknown, expired, foreign, or already-used handles answer
//   422 STALE_FORM_HANDLE and dispatch nothing.
// - Delegated authorization: the handle is the form-to-Saga grant. Submit
//   through a live handle dispatches without requiring a separate
//   direct-Saga grant; the submitter still needs the form readable in
//   their own Organization (cross-org handles fail closed).
// - URL-prefill opt-in: declarations carry `allowPrefill`; the startup
//   route merges an allowlisted prefill object over defaults (declaration
//   opt-in only) after running prefill values through the submission
//   per-field gate (unknown/display-only names, wrong types, over-bound
//   text, unlisted options, malformed file refs all fail closed), so a bad
//   prefill can never poison the snapshot. Trust split: caller-controlled
//   values (prefill, submission) are always gated; author-declared
//   defaults are kind-checked at declaration time and re-checked only
//   through the Saga parse gate — an author can already declare any
//   option list, so option-vs-default drift is author error, not a
//   caller bypass.
// - Immediate or scheduled submission: `{ scheduleAt }` defers dispatch
//   (deferred receipt, undispatched Pending row with `__scheduleAt`
//   linkage, no Workflow dispatch); omitting it dispatches inline.
// - File-field integration: a `file` field declares `{ location, maxMb?,
//   contentTypes? }`; submit accepts a finalized FILE-01 `{ location,
//   path }` reference and re-validates readiness/size/type against the
//   live file row, so a stale or foreign pointer cannot bypass upload.
import { Fault, parseSubmission, UUID } from "./domain";
import type { FieldFailure, Principal, SagaDef } from "./domain";

/** Closed v2 field type set. Display-only kinds (heading, paragraph,
// divider) render layout and never bind to Saga inputs. */
export const FORM_FIELD_TYPES = [
  "text",
  "number",
  "boolean",
  "email",
  "date",
  "time",
  "datetime",
  "select",
  "multiselect",
  "textarea",
  "url",
  "tel",
  "file",
  "hidden",
  "heading",
  "paragraph",
  "divider",
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

/** Display-only kinds: layout metadata in the declaration, never Saga
 * inputs. Submissions carrying their names fail closed. */
export const FORM_DISPLAY_TYPES: readonly FormFieldType[] = ["heading", "paragraph", "divider"];

export interface FormVisibleWhen {
  readonly field: string;
  readonly equals: string | number | boolean;
}

export interface FormStaticProvider {
  readonly kind: "static";
  readonly options: readonly string[];
}

export interface FormTableProvider {
  readonly kind: "table";
  readonly table: string;
  readonly valueField: string;
  readonly labelField?: string;
}

export type FormFieldProvider = FormStaticProvider | FormTableProvider;

export interface FormFilePolicy {
  readonly location: string;
  readonly maxMb?: number;
  readonly contentTypes?: readonly string[];
}

export interface FormField {
  readonly name: string;
  readonly type: FormFieldType;
  readonly label?: string;
  readonly required: boolean;
  readonly maxLength: number;
  /** Declared default: merged under validated submission values. File
   * fields take a { location, path } reference (kind-checked at
   * declaration time). */
  readonly default?: string | number | boolean | readonly string[] | { location: string; path: string };
  /** Declared option membership for select/multiselect (static). */
  readonly options?: readonly string[];
  /** Declared option provider: resolved at startup, re-checked at submit. */
  readonly provider?: FormFieldProvider;
  /** Conditional visibility: hidden fields drop from the bound input. */
  readonly visibleWhen?: FormVisibleWhen;
  /** File-field upload policy (FILE-01 location reference). */
  readonly file?: FormFilePolicy;
  /** Minimum/maximum for number fields; pattern for text-like fields. */
  readonly min?: number;
  readonly max?: number;
  readonly pattern?: string;
  /** Display-only content (heading/paragraph text). */
  readonly content?: string;
}

export interface FormDefinition {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly sagaId: string;
  readonly title?: string;
  readonly description?: string;
  /** URL-prefill opt-in (default false): startup accepts a prefill object. */
  readonly allowPrefill: boolean;
  readonly fields: readonly FormField[];
}

export interface FormSubmission {
  readonly saga: SagaDef;
  readonly input: unknown;
}

export const FORM_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
/** Internal linkage keys (`__form`, `__scheduleAt`) ride the merged input
 * internally and are stripped before the Saga gate. A declaration can never
 * carry them (FIELD_NAME forbids the `__` prefix); a submission carrying
 * them is rejected before validation. */
export function isInternalKey(name: string): boolean {
  return name.startsWith("__");
}
const TABLE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const LOCATION_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const FORM_MAX_FIELDS = 50;
export const FORM_MAX_KEYS = 200;
export const FORM_FIELD_MAX_LENGTH = 1024;
/** Startup handle TTL: 30 minutes, session-bound (org + user + form). */
export const FORM_STARTUP_TTL_MS = 30 * 60 * 1000;
export const FORM_STARTUP_HANDLE_RE = /^[a-f0-9]{64}$/;
/** Provider fetch caps: 50 option keys from the bounded reader. */
export const FORM_PROVIDER_MAX_OPTIONS = 50;
/** Scheduled-submit lookahead: at most 30 days out, never in the past. */
export const FORM_SCHEDULE_MAX_MS = 30 * 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

interface FormRow {
  id: string;
  org_id: string;
  name: string;
  saga_id: string;
  fields_json: string;
}

interface StartupRow {
  handle_hash: string;
  org_id: string;
  user_id: string;
  form_id: string;
  form_name: string;
  prefill_json: string | null;
  options_json: string | null;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

export interface FormStartup {
  readonly handle: string;
  readonly formName: string;
  readonly expiresAt: string;
  /** Resolved startup snapshot: defaults, prefill merge, provider options. */
  readonly snapshot: Record<string, unknown>;
  readonly options: Record<string, readonly string[]>;
}

function fail(field: string, code: string, message: string): FieldFailure {
  return { field, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseVisibleWhen(fieldName: string, value: unknown): FormVisibleWhen | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.field !== "string" || !FIELD_NAME.test(value.field)) {
    throw new Error(`Form field "${fieldName}" visibleWhen needs { field, equals }.`);
  }
  if (value.field === fieldName) throw new Error(`Form field "${fieldName}" cannot condition on itself.`);
  const equals = value.equals;
  if (typeof equals !== "string" && typeof equals !== "number" && typeof equals !== "boolean") {
    throw new Error(`Form field "${fieldName}" visibleWhen.equals must be a string, number, or boolean.`);
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "field" && key !== "equals")) {
    throw new Error(`Form field "${fieldName}" visibleWhen declares only field and equals.`);
  }
  return { field: value.field, equals };
}

function parseProvider(fieldName: string, value: unknown): FormFieldProvider | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error(`Form field "${fieldName}" provider needs a kind.`);
  }
  if (value.kind === "static") {
    if (
      !Array.isArray(value.options) ||
      value.options.length === 0 ||
      value.options.length > FORM_PROVIDER_MAX_OPTIONS
    ) {
      throw new Error(`Form field "${fieldName}" static provider needs 1 to 50 options.`);
    }
    for (const option of value.options) {
      if (typeof option !== "string" || option.length === 0 || option.length > 128) {
        throw new Error(`Form field "${fieldName}" static provider options must be 1-128 char strings.`);
      }
    }
    if (Object.keys(value).some((key) => key !== "kind" && key !== "options")) {
      throw new Error(`Form field "${fieldName}" static provider declares only kind and options.`);
    }
    return { kind: "static", options: [...value.options] as readonly string[] };
  }
  if (value.kind === "table") {
    if (typeof value.table !== "string" || !TABLE_NAME.test(value.table)) {
      throw new Error(`Form field "${fieldName}" table provider needs a table name.`);
    }
    if (typeof value.valueField !== "string" || !FIELD_NAME.test(value.valueField)) {
      throw new Error(`Form field "${fieldName}" table provider needs a valueField.`);
    }
    if (
      value.labelField !== undefined &&
      (typeof value.labelField !== "string" || !FIELD_NAME.test(value.labelField))
    ) {
      throw new Error(`Form field "${fieldName}" table provider labelField must be a field name.`);
    }
    if (Object.keys(value).some((key) => !["kind", "table", "valueField", "labelField"].includes(key))) {
      throw new Error(`Form field "${fieldName}" table provider declares only kind, table, valueField, labelField.`);
    }
    return {
      kind: "table",
      table: value.table,
      valueField: value.valueField,
      ...(value.labelField === undefined ? {} : { labelField: value.labelField as string }),
    };
  }
  throw new Error(`Form field "${fieldName}" provider kind must be static or table.`);
}

function parseFilePolicy(fieldName: string, value: unknown): FormFilePolicy | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.location !== "string" || !LOCATION_NAME.test(value.location)) {
    throw new Error(`Form field "${fieldName}" file policy needs a location name.`);
  }
  if (
    value.maxMb !== undefined &&
    (!Number.isFinite(value.maxMb) || (value.maxMb as number) <= 0 || (value.maxMb as number) > 25)
  ) {
    throw new Error(`Form field "${fieldName}" file maxMb must be greater than 0 and at most 25 MB.`);
  }
  if (value.contentTypes !== undefined) {
    if (!Array.isArray(value.contentTypes) || value.contentTypes.length === 0 || value.contentTypes.length > 10) {
      throw new Error(`Form field "${fieldName}" file contentTypes needs 1 to 10 entries.`);
    }
    for (const entry of value.contentTypes) {
      if (typeof entry !== "string" || entry.length === 0 || entry.length > 128) {
        throw new Error(`Form field "${fieldName}" file contentTypes must be 1-128 char strings.`);
      }
    }
  }
  if (Object.keys(value).some((key) => !["location", "maxMb", "contentTypes"].includes(key))) {
    throw new Error(`Form field "${fieldName}" file policy declares only location, maxMb, contentTypes.`);
  }
  return {
    location: value.location,
    ...(value.maxMb === undefined ? {} : { maxMb: value.maxMb as number }),
    ...(value.contentTypes === undefined ? {} : { contentTypes: [...(value.contentTypes as string[])] }),
  };
}

/** Validate one persisted field declaration (fail closed: corrupt declarations
 * are a server defect, never caller input). */
export function parseFormFields(value: unknown): FormField[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > FORM_MAX_FIELDS) {
    throw new Error("Form declaration must list 1 to 50 fields.");
  }
  const seen = new Set<string>();
  const parsed = value.map((entry) => {
    if (!isRecord(entry)) throw new Error("Form fields must be objects.");
    const allowed = [
      "name",
      "type",
      "label",
      "required",
      "maxLength",
      "default",
      "options",
      "provider",
      "visibleWhen",
      "file",
      "min",
      "max",
      "pattern",
      "content",
    ];
    if (Object.keys(entry).some((key) => !allowed.includes(key))) {
      throw new Error(
        "Form fields declare only name, type, label, required, maxLength, default, options, provider, visibleWhen, file, min, max, pattern, content.",
      );
    }
    if (typeof entry.name !== "string" || !FIELD_NAME.test(entry.name)) {
      throw new Error("Form field names must start with a letter and hold letters, digits, or underscores.");
    }
    if (seen.has(entry.name)) throw new Error(`Duplicate form field "${entry.name}".`);
    seen.add(entry.name);
    if (typeof entry.type !== "string" || !(FORM_FIELD_TYPES as readonly string[]).includes(entry.type)) {
      throw new Error(`Form field "${entry.name}" has an unsupported type.`);
    }
    const type = entry.type as FormFieldType;
    const display = (FORM_DISPLAY_TYPES as readonly string[]).includes(type);
    if (typeof entry.required !== "boolean") {
      throw new Error(`Form field "${entry.name}" must declare required.`);
    }
    if (display && entry.required) {
      throw new Error(`Display-only field "${entry.name}" cannot be required.`);
    }
    let maxLength = FORM_FIELD_MAX_LENGTH;
    if (entry.maxLength !== undefined) {
      if (!Number.isInteger(entry.maxLength) || (entry.maxLength as number) < 1 || (entry.maxLength as number) > 1024) {
        throw new Error(`Form field "${entry.name}" maxLength must be an integer from 1 to 1024.`);
      }
      maxLength = entry.maxLength as number;
    }
    if (entry.label !== undefined && (typeof entry.label !== "string" || entry.label.length > 160)) {
      throw new Error(`Form field "${entry.name}" label must be at most 160 chars.`);
    }
    if (entry.content !== undefined && (typeof entry.content !== "string" || entry.content.length > 1024)) {
      throw new Error(`Form field "${entry.name}" content must be at most 1024 chars.`);
    }
    if (display && entry.content === undefined) {
      throw new Error(`Display-only field "${entry.name}" needs content.`);
    }
    if (!display && entry.content !== undefined) {
      throw new Error(`Only display-only fields carry content (field "${entry.name}").`);
    }
    // Options/provider belong to select/multiselect only; options and
    // provider are mutually exclusive (one membership source).
    if (entry.options !== undefined || entry.provider !== undefined) {
      if (type !== "select" && type !== "multiselect") {
        throw new Error(`Only select fields carry options or a provider (field "${entry.name}").`);
      }
      if (entry.options !== undefined && entry.provider !== undefined) {
        throw new Error(`Form field "${entry.name}" carries options or a provider, never both.`);
      }
    }
    let options: readonly string[] | undefined;
    if (entry.options !== undefined) {
      if (
        !Array.isArray(entry.options) ||
        entry.options.length === 0 ||
        entry.options.length > FORM_PROVIDER_MAX_OPTIONS
      ) {
        throw new Error(`Form field "${entry.name}" options need 1 to 50 entries.`);
      }
      for (const option of entry.options) {
        if (typeof option !== "string" || option.length === 0 || option.length > 128) {
          throw new Error(`Form field "${entry.name}" options must be 1-128 char strings.`);
        }
      }
      options = [...entry.options] as readonly string[];
    }
    const provider = parseProvider(entry.name, entry.provider);
    if ((type === "select" || type === "multiselect") && options === undefined && provider === undefined) {
      throw new Error(`Select field "${entry.name}" needs options or a provider.`);
    }
    const file = parseFilePolicy(entry.name, entry.file);
    if (file !== undefined && type !== "file") {
      throw new Error(`Only file fields carry a file policy (field "${entry.name}").`);
    }
    if (type === "file" && file === undefined) {
      throw new Error(`File field "${entry.name}" needs a file policy.`);
    }
    const fieldMin = entry.min as number | undefined;
    const fieldMax = entry.max as number | undefined;
    if ((fieldMin !== undefined || fieldMax !== undefined) && type !== "number") {
      throw new Error(`Only number fields carry min/max (field "${entry.name}").`);
    }
    if (fieldMin !== undefined && typeof fieldMin !== "number") {
      throw new Error(`Form field "${entry.name}" min must be a number.`);
    }
    if (fieldMax !== undefined && typeof fieldMax !== "number") {
      throw new Error(`Form field "${entry.name}" max must be a number.`);
    }
    if (fieldMin !== undefined && fieldMax !== undefined && fieldMin > fieldMax) {
      throw new Error(`Form field "${entry.name}" min cannot exceed max.`);
    }
    if (entry.pattern !== undefined) {
      if (typeof entry.pattern !== "string" || entry.pattern.length === 0 || entry.pattern.length > 256) {
        throw new Error(`Form field "${entry.name}" pattern must be 1-256 chars.`);
      }
      try {
        new RegExp(entry.pattern as string);
      } catch {
        throw new Error(`Form field "${entry.name}" pattern is not a valid regular expression.`);
      }
      if (!["text", "textarea", "email", "url", "tel", "hidden"].includes(type)) {
        throw new Error(`Only text-like fields carry a pattern (field "${entry.name}").`);
      }
    }
    const visibleWhen = parseVisibleWhen(entry.name, entry.visibleWhen);
    // Defaults must match the field kind: scalar kinds take scalar
    // defaults, select takes a string, multiselect takes a string list
    // (at most 50), file refs take a same-location { location, path }
    // reference, display-only kinds take none. String-like defaults also
    // meet maxLength/pattern/format, and select/multiselect defaults must
    // be listed in the static options/provider list when one is declared
    // (table-provider contents are author-trusted at declaration and
    // re-checked only through the Saga parse gate at submit), so a default
    // can never poison the merged input with a value the submission gate
    // would refuse.
    if (entry.default !== undefined) {
      if (display) throw new Error(`Display-only field "${entry.name}" cannot carry a default.`);
      const dflt = entry.default;
      switch (type) {
        case "number":
          if (typeof dflt !== "number" || !Number.isFinite(dflt)) {
            throw new Error(`Form field "${entry.name}" default must be a finite number.`);
          }
          if (fieldMin !== undefined && dflt < fieldMin) {
            throw new Error(`Form field "${entry.name}" default must be at least ${fieldMin}.`);
          }
          if (fieldMax !== undefined && dflt > fieldMax) {
            throw new Error(`Form field "${entry.name}" default must be at most ${fieldMax}.`);
          }
          break;
        case "boolean":
          if (typeof dflt !== "boolean") throw new Error(`Form field "${entry.name}" default must be a boolean.`);
          break;
        case "select": {
          if (typeof dflt !== "string") throw new Error(`Form field "${entry.name}" default must be a string.`);
          if (dflt.length === 0 || dflt.length > 128) {
            throw new Error(`Form field "${entry.name}" default must be 1-128 chars.`);
          }
          checkDefaultString(entry.name, dflt, {
            maxLength,
            pattern: entry.pattern as string | undefined,
            type,
            required: entry.required,
          });
          const allowed = options ?? (provider?.kind === "static" ? provider.options : undefined);
          if (allowed !== undefined && !allowed.includes(dflt)) {
            throw new Error(`Form field "${entry.name}" default must be a listed option.`);
          }
          break;
        }
        case "multiselect": {
          if (!Array.isArray(dflt) || !dflt.every((item) => typeof item === "string")) {
            throw new Error(`Form field "${entry.name}" default must be a string list.`);
          }
          if (dflt.length > FORM_PROVIDER_MAX_OPTIONS) {
            throw new Error(`Form field "${entry.name}" default must hold at most 50 options.`);
          }
          if (entry.required && dflt.length === 0) {
            throw new Error(`Form field "${entry.name}" default must not be empty.`);
          }
          const allowed = options ?? (provider?.kind === "static" ? provider.options : undefined);
          for (const item of dflt as readonly string[]) {
            if (item.length === 0 || item.length > 128) {
              throw new Error(`Form field "${entry.name}" default options must be 1-128 char strings.`);
            }
            if (allowed !== undefined && !allowed.includes(item)) {
              throw new Error(`Form field "${entry.name}" default must be a listed option.`);
            }
          }
          break;
        }
        case "file": {
          if (!isRecord(dflt) || typeof dflt.location !== "string" || typeof dflt.path !== "string") {
            throw new Error(`Form field "${entry.name}" default must be a { location, path } reference.`);
          }
          const policy = file;
          if (policy && dflt.location !== policy.location) {
            throw new Error(`Form field "${entry.name}" default must reference "${policy.location}".`);
          }
          if (dflt.path.length === 0 || dflt.path.length > 512) {
            throw new Error(`Form field "${entry.name}" default path must be 1-512 chars.`);
          }
          break;
        }
        default:
          if (typeof dflt !== "string") throw new Error(`Form field "${entry.name}" default must be a string.`);
          checkDefaultString(entry.name, dflt, {
            maxLength,
            pattern: entry.pattern as string | undefined,
            type,
            required: entry.required,
          });
      }
    }
    return {
      name: entry.name,
      type,
      ...(entry.label === undefined ? {} : { label: entry.label as string }),
      required: entry.required,
      maxLength,
      ...(entry.default === undefined ? {} : { default: entry.default as FormField["default"] }),
      ...(options === undefined ? {} : { options }),
      ...(provider === undefined ? {} : { provider }),
      ...(visibleWhen === undefined ? {} : { visibleWhen }),
      ...(file === undefined ? {} : { file }),
      ...(entry.min === undefined ? {} : { min: entry.min as number }),
      ...(entry.max === undefined ? {} : { max: entry.max as number }),
      ...(entry.pattern === undefined ? {} : { pattern: entry.pattern as string }),
      ...(entry.content === undefined ? {} : { content: entry.content as string }),
    } satisfies FormField;
  });
  // visibleWhen targets must name a declared field (checked after the full
  // pass so forward references read naturally).
  const names = new Set(parsed.map((field) => field.name));
  for (const field of parsed) {
    if (field.visibleWhen !== undefined && !names.has(field.visibleWhen.field)) {
      throw new Error(`Form field "${field.name}" conditions on unknown field "${field.visibleWhen.field}".`);
    }
  }
  return parsed;
}

/** Parse the full declaration envelope (fields plus FORM-02 metadata:
 * title, description, allowPrefill). Accepts the FORM-01 bare array shape
 * (fields only) for backward compatibility. */
export function parseFormDeclaration(value: unknown): {
  title?: string;
  description?: string;
  allowPrefill: boolean;
  fields: FormField[];
} {
  if (Array.isArray(value)) return { allowPrefill: false, fields: parseFormFields(value) };
  if (!isRecord(value) || !Array.isArray(value.fields)) {
    throw new Error("Form declarations hold fields plus optional title, description, allowPrefill.");
  }
  if (Object.keys(value).some((key) => !["fields", "title", "description", "allowPrefill"].includes(key))) {
    throw new Error("Form declarations hold fields plus optional title, description, allowPrefill.");
  }
  if (value.title !== undefined && (typeof value.title !== "string" || value.title.length > 160)) {
    throw new Error("Form title must be at most 160 chars.");
  }
  if (value.description !== undefined && (typeof value.description !== "string" || value.description.length > 1024)) {
    throw new Error("Form description must be at most 1024 chars.");
  }
  if (value.allowPrefill !== undefined && typeof value.allowPrefill !== "boolean") {
    throw new Error("Form allowPrefill must be a boolean.");
  }
  return {
    ...(value.title === undefined ? {} : { title: value.title as string }),
    ...(value.description === undefined ? {} : { description: value.description as string }),
    allowPrefill: value.allowPrefill === true,
    fields: parseFormFields(value.fields),
  };
}

/** Load one persisted declaration for this Organization. Unknown names (or
 * foreign-Organization names) resolve to null so the route answers 404,
 * never a cross-tenant leak. */
export async function loadForm(db: D1Database, orgId: string, name: string): Promise<FormDefinition | null> {
  const row = await db
    .prepare("SELECT id,org_id,name,saga_id,fields_json FROM forms WHERE org_id=? AND name=?")
    .bind(orgId, name)
    .first<FormRow>();
  if (!row) return null;
  if (!UUID.test(row.id) || !UUID.test(row.saga_id)) throw new Error("Form declaration carries invalid identity.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.fields_json);
  } catch {
    throw new Error("Form declaration is not valid JSON.");
  }
  const declaration = parseFormDeclaration(parsed);
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    sagaId: row.saga_id,
    ...(declaration.title === undefined ? {} : { title: declaration.title }),
    ...(declaration.description === undefined ? {} : { description: declaration.description }),
    allowPrefill: declaration.allowPrefill,
    fields: declaration.fields,
  };
}

/** Create or replace an org-scoped form declaration (FORM-02 designer).
 * Names follow FORM_NAME; sagaId must be a stable UUID; corrupt rows fail
 * closed. Returns the persisted definition. */
export async function saveForm(db: D1Database, caller: Principal, body: unknown): Promise<FormDefinition> {
  if (!isRecord(body)) throw new Fault(400, "INVALID_FORM", "Form declarations must be a JSON object.");
  if (typeof body.name !== "string" || !FORM_NAME.test(body.name)) {
    throw new Fault(400, "INVALID_FORM", "Form names are lowercase slugs (letters, digits, dashes).");
  }
  if (typeof body.sagaId !== "string" || !UUID.test(body.sagaId)) {
    throw new Fault(400, "INVALID_FORM", "Form sagaId must be a stable Saga UUID.");
  }
  if (!("fields" in body)) throw new Fault(400, "INVALID_FORM", "Form declarations hold fields.");
  const envelopeKeys = ["name", "sagaId", "fields", "title", "description", "allowPrefill"];
  if (Object.keys(body).some((key) => !envelopeKeys.includes(key))) {
    throw new Fault(400, "INVALID_FORM", "Form declarations hold name, sagaId, fields, and metadata only.");
  }
  let declaration: ReturnType<typeof parseFormDeclaration>;
  try {
    declaration = parseFormDeclaration(
      Array.isArray(body.fields)
        ? {
            fields: body.fields,
            ...(body.title === undefined ? {} : { title: body.title }),
            ...(body.description === undefined ? {} : { description: body.description }),
            ...(body.allowPrefill === undefined ? {} : { allowPrefill: body.allowPrefill }),
          }
        : body,
    );
  } catch (error) {
    throw new Fault(400, "INVALID_FORM", error instanceof Error ? error.message : "Invalid form declaration.");
  }
  const fieldsJson = JSON.stringify({
    ...(declaration.title === undefined ? {} : { title: declaration.title }),
    ...(declaration.description === undefined ? {} : { description: declaration.description }),
    ...(declaration.allowPrefill ? { allowPrefill: true } : {}),
    fields: declaration.fields,
  });
  if (new TextEncoder().encode(fieldsJson).length > 4096) {
    throw new Fault(400, "INVALID_FORM", "Form declarations hold at most 4 KB of JSON.");
  }
  const now = new Date().toISOString();
  const existing = await db
    .prepare("SELECT id FROM forms WHERE org_id=? AND name=?")
    .bind(caller.orgId, body.name)
    .first<{ id: string }>()
    .catch(() => null);
  const id = existing?.id && UUID.test(existing.id) ? existing.id : crypto.randomUUID().toLowerCase();
  await db
    .prepare(
      "INSERT INTO forms(id,org_id,name,saga_id,fields_json,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,saga_id=excluded.saga_id,fields_json=excluded.fields_json",
    )
    .bind(id, caller.orgId, body.name, (body.sagaId as string).toLowerCase(), fieldsJson, now)
    .run();
  const saved = await loadForm(db, caller.orgId, body.name);
  if (!saved) throw new Error("Form save did not persist.");
  return saved;
}

/** Delete an org-scoped form declaration. Unknown or foreign names answer
 * FORM_NOT_FOUND (404), never a cross-tenant signal. */
export async function deleteForm(db: D1Database, caller: Principal, name: string): Promise<void> {
  const changed = await db.prepare("DELETE FROM forms WHERE org_id=? AND name=?").bind(caller.orgId, name).run();
  if (changed.meta.changes === 0) throw new Fault(404, "FORM_NOT_FOUND", "Form not found.");
}

/** List org-scoped form summaries (id, name, sagaId). */
export async function listForms(
  db: D1Database,
  caller: Principal,
): Promise<readonly { id: string; name: string; sagaId: string }[]> {
  const rows = await db
    .prepare("SELECT id,name,saga_id FROM forms WHERE org_id=? ORDER BY name ASC")
    .bind(caller.orgId)
    .all<{ id: string; name: string; saga_id: string }>();
  return rows.results
    .filter((row) => UUID.test(row.id) && UUID.test(row.saga_id))
    .map((row) => ({ id: row.id, name: row.name, sagaId: row.saga_id }));
}

/** Whether the field is visible under the conditional rules, given a
 * value map. The submit gate passes the startup snapshot under the submit
 * body (edits win); the renderer passes the snapshot under current edits;
 * the defaults merge passes validated values plus earlier-merged defaults.
 * Missing condition targets read as not-equal (hidden), never as a crash. */
export function isFieldVisible(field: FormField, values: Record<string, unknown>): boolean {
  if (field.visibleWhen === undefined) return true;
  return values[field.visibleWhen.field] === field.visibleWhen.equals;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function checkStringField(field: FormField, entry: unknown, failures: FieldFailure[]): string | undefined {
  if (typeof entry !== "string") {
    failures.push(fail(field.name, "NOT_STRING", "This field must be a string."));
    return undefined;
  }
  if (field.required && entry.length === 0) {
    failures.push(fail(field.name, "REQUIRED", "This field is required."));
    return undefined;
  }
  if (byteLength(entry) > field.maxLength) {
    failures.push(fail(field.name, "TOO_LONG", `At most ${field.maxLength} UTF-8 bytes are accepted.`));
    return undefined;
  }
  switch (field.type) {
    case "email":
      if (entry.length > 0 && !EMAIL_RE.test(entry)) {
        failures.push(fail(field.name, "INVALID_EMAIL", "This field must be an email address."));
        return undefined;
      }
      break;
    case "date":
      if (entry.length > 0 && !DATE_RE.test(entry)) {
        failures.push(fail(field.name, "INVALID_DATE", "This field must be a YYYY-MM-DD date."));
        return undefined;
      }
      break;
    case "time":
      if (entry.length > 0 && !TIME_RE.test(entry)) {
        failures.push(fail(field.name, "INVALID_TIME", "This field must be an HH:MM time."));
        return undefined;
      }
      break;
    case "datetime":
      if (entry.length > 0 && !DATETIME_RE.test(entry)) {
        failures.push(fail(field.name, "INVALID_DATETIME", "This field must be an ISO datetime."));
        return undefined;
      }
      break;
    case "url":
      if (entry.length > 0) {
        try {
          const parsed = new URL(entry);
          if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("scheme");
        } catch {
          failures.push(fail(field.name, "INVALID_URL", "This field must be an http(s) URL."));
          return undefined;
        }
      }
      break;
    case "tel":
      if (entry.length > 0 && !/^[+()\-.\s\d]{3,32}$/.test(entry)) {
        failures.push(fail(field.name, "INVALID_TEL", "This field must be a phone number."));
        return undefined;
      }
      break;
    default:
      break;
  }
  if (field.pattern !== undefined && entry.length > 0) {
    let matches: boolean;
    try {
      matches = new RegExp(field.pattern).test(entry);
    } catch {
      matches = false;
    }
    if (!matches) {
      failures.push(fail(field.name, "PATTERN_MISMATCH", "This field did not match the required pattern."));
      return undefined;
    }
  }
  return entry;
}

/** Declaration-time string-default gate: the submission text checks
 * (length, format, pattern) surfaced as declaration errors, so a default
 * can never merge a value the submission gate would refuse. Empty
 * defaults on required fields are rejected outright. */
function checkDefaultString(
  name: string,
  value: string,
  opts: { maxLength: number; pattern?: string; type: FormFieldType; required: boolean },
): void {
  if (opts.required && value.length === 0) {
    throw new Error(`Form field "${name}" default must not be empty.`);
  }
  const failures: FieldFailure[] = [];
  const field: FormField = {
    name,
    type: opts.type,
    required: false,
    maxLength: opts.maxLength,
    ...(opts.pattern === undefined ? {} : { pattern: opts.pattern }),
  };
  checkStringField(field, value, failures);
  const first = failures[0];
  if (first) throw new Error(`Form field "${name}" default is invalid (${first.code}).`);
}

/** Prefill value gate: the submission per-field checks minus required
 * and hidden-field handling (a prefilled conditional may legitimately
 * disagree with defaults until submit-time values arrive; nullish prefill
 * falls back to defaults at snapshot build while "" persists as an
 * explicit empty value, requiredness is a submit-time verdict). Wrong
 * types, over-bound text, bad patterns, non-finite numbers, non-boolean
 * booleans, unlisted select options, non-list multiselects, and malformed
 * file references fail closed. */
export function checkPrefillValue(
  field: FormField,
  entry: unknown,
  allowed: readonly string[],
  failures: FieldFailure[],
): void {
  if (entry === undefined || entry === null) return;
  switch (field.type) {
    case "number":
      if (typeof entry !== "number" || !Number.isFinite(entry)) {
        failures.push(fail(field.name, "NOT_NUMBER", "This field must be a number."));
      } else {
        if (field.min !== undefined && entry < field.min) {
          failures.push(fail(field.name, "TOO_SMALL", `This field must be at least ${field.min}.`));
        }
        if (field.max !== undefined && entry > field.max) {
          failures.push(fail(field.name, "TOO_LARGE", `This field must be at most ${field.max}.`));
        }
      }
      return;
    case "boolean":
      if (typeof entry !== "boolean") {
        failures.push(fail(field.name, "NOT_BOOLEAN", "This field must be a boolean."));
      }
      return;
    case "select": {
      const before = failures.length;
      const checked = checkStringField({ ...field, type: "text", required: false }, entry, failures);
      if (checked !== undefined && failures.length === before && !allowed.includes(checked)) {
        failures.push(fail(field.name, "INVALID_OPTION", "This value is not an allowed option."));
      }
      return;
    }
    case "multiselect": {
      if (!Array.isArray(entry)) {
        failures.push(fail(field.name, "NOT_ARRAY", "This field must be a list of options."));
        return;
      }
      if (entry.length > FORM_PROVIDER_MAX_OPTIONS) {
        failures.push(
          fail(field.name, "TOO_MANY_OPTIONS", `At most ${FORM_PROVIDER_MAX_OPTIONS} options are accepted.`),
        );
        return;
      }
      for (const item of entry) {
        if (typeof item !== "string" || !allowed.includes(item)) {
          failures.push(fail(field.name, "INVALID_OPTION", "One value is not an allowed option."));
          return;
        }
      }
      return;
    }
    case "file": {
      if (!isRecord(entry) || typeof entry.location !== "string" || typeof entry.path !== "string") {
        failures.push(fail(field.name, "NOT_FILE_REF", "File fields take a { location, path } reference."));
        return;
      }
      if (field.file && entry.location !== field.file.location) {
        failures.push(
          fail(field.name, "FILE_LOCATION_MISMATCH", `File field "${field.name}" uploads to "${field.file.location}".`),
        );
      }
      if (entry.path.length === 0 || entry.path.length > 512) {
        failures.push(fail(field.name, "INVALID_FILE_PATH", "File paths are 1-512 chars."));
      }
      return;
    }
    default: {
      // Minus required: empty prefill falls back to defaults;
      // requiredness is a submit-time verdict.
      checkStringField({ ...field, required: false }, entry, failures);
    }
  }
}

/** Validate a submission against the persisted declaration. Unknown field
 * names are rejected; display-only names fail closed; per-field failures
 * accumulate into one 422 Fault whose details carry the structured
 * per-field list. Conditional visibility is evaluated over the startup
 * snapshot under the submit body (edits win); hidden-by-condition fields
 * submitted with a value fail closed (HIDDEN_FIELD) and omitted hidden
 * fields stay dropped. A visible required field with a declared default
 * passes when omitted (the defaults merge fills it); without a default,
 * omission fails REQUIRED. Option membership is checked against
 * `allowedOptions` (startup-resolved provider options override static
 * declaration options); unknown membership fails closed with
 * INVALID_OPTION. */
export function validateFormInput(
  fields: readonly FormField[],
  value: unknown,
  options?: { allowedOptions?: Record<string, readonly string[]>; values?: Record<string, unknown> },
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Fault(422, "FORM_VALIDATION_FAILED", "The form submission must be a JSON object.", [
      fail("", "NOT_OBJECT", "The form submission must be a JSON object."),
    ]);
  }
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length > FORM_MAX_KEYS) {
    throw new Fault(422, "FORM_VALIDATION_FAILED", "The form submission carries too many fields.", [
      fail("", "TOO_MANY_FIELDS", `At most ${FORM_MAX_KEYS} fields are accepted.`),
    ]);
  }
  const declared = new Map(fields.map((field) => [field.name, field]));
  const failures: FieldFailure[] = [];
  for (const key of keys) {
    // Internal linkage keys are never declared (FIELD_NAME forbids `__`)
    // and never submittable: reject before any other gate.
    if (isInternalKey(key)) {
      failures.push(fail(key, "UNKNOWN_FIELD", "This field is not declared."));
      continue;
    }
    const field = declared.get(key);
    if (!field) {
      failures.push(fail(key, "UNKNOWN_FIELD", "This field is not declared."));
      continue;
    }
    if ((FORM_DISPLAY_TYPES as readonly string[]).includes(field.type)) {
      failures.push(fail(key, "DISPLAY_ONLY_FIELD", "Display-only fields cannot be submitted."));
    }
  }
  const merged: Record<string, unknown> = { ...(options?.values ?? {}) };
  for (const key of keys) merged[key] = body[key];
  // Conditional visibility is evaluated over the submit body alone (plus
  // the startup snapshot for context): the submit body is the complete
  // record, so a dependent field cannot smuggle a value while hidden.
  for (const field of fields) {
    if (field.visibleWhen === undefined) continue;
    if (isFieldVisible(field, merged)) continue;
    if (body[field.name] !== undefined && body[field.name] !== null) {
      failures.push(fail(field.name, "HIDDEN_FIELD", "This field is hidden by the form rules."));
    }
  }
  if (failures.length > 0) {
    throw new Fault(422, "FORM_VALIDATION_FAILED", "The form submission did not pass validation.", failures);
  }
  const validated: Record<string, unknown> = {};
  for (const field of fields) {
    if ((FORM_DISPLAY_TYPES as readonly string[]).includes(field.type)) continue;
    if (!isFieldVisible(field, merged)) continue;
    const entry = body[field.name];
    if (entry === undefined || entry === null) {
      // A declared default fills the gap in mergeFormDefaults below, so a
      // visible required field with a default passes when omitted — the
      // merged input still carries a value. Without a default, omission
      // fails. Snapshot/prefill never satisfies requiredness on its own:
      // the submit body is the complete record (the client echoes snapshot
      // values for visible fields), so a required value lives in the body
      // or in the author-declared default.
      if (field.required && field.default === undefined) {
        failures.push(fail(field.name, "REQUIRED", "This field is required."));
      }
      continue;
    }
    switch (field.type) {
      case "number": {
        if (typeof entry !== "number" || !Number.isFinite(entry)) {
          failures.push(fail(field.name, "NOT_NUMBER", "This field must be a number."));
          continue;
        }
        if (field.min !== undefined && entry < field.min) {
          failures.push(fail(field.name, "TOO_SMALL", `This field must be at least ${field.min}.`));
          continue;
        }
        if (field.max !== undefined && entry > field.max) {
          failures.push(fail(field.name, "TOO_LARGE", `This field must be at most ${field.max}.`));
          continue;
        }
        validated[field.name] = entry;
        break;
      }
      case "boolean": {
        if (typeof entry !== "boolean") {
          failures.push(fail(field.name, "NOT_BOOLEAN", "This field must be a boolean."));
          continue;
        }
        validated[field.name] = entry;
        break;
      }
      case "select": {
        const checked = checkStringField({ ...field, type: "text" }, entry, failures);
        if (checked === undefined) continue;
        const allowed = options?.allowedOptions?.[field.name] ?? field.options ?? [];
        if (!allowed.includes(checked)) {
          failures.push(fail(field.name, "INVALID_OPTION", "This value is not an allowed option."));
          continue;
        }
        validated[field.name] = checked;
        break;
      }
      case "multiselect": {
        if (!Array.isArray(entry)) {
          failures.push(fail(field.name, "NOT_ARRAY", "This field must be a list of options."));
          continue;
        }
        if (entry.length > FORM_PROVIDER_MAX_OPTIONS) {
          failures.push(
            fail(field.name, "TOO_MANY_OPTIONS", `At most ${FORM_PROVIDER_MAX_OPTIONS} options are accepted.`),
          );
          continue;
        }
        const allowed = options?.allowedOptions?.[field.name] ?? field.options ?? [];
        const picked: string[] = [];
        let bad = false;
        for (const item of entry) {
          if (typeof item !== "string" || !allowed.includes(item)) {
            failures.push(fail(field.name, "INVALID_OPTION", "One value is not an allowed option."));
            bad = true;
            break;
          }
          picked.push(item);
        }
        if (bad) continue;
        if (field.required && picked.length === 0) {
          failures.push(fail(field.name, "REQUIRED", "This field is required."));
          continue;
        }
        validated[field.name] = picked;
        break;
      }
      case "file": {
        if (!isRecord(entry)) {
          failures.push(fail(field.name, "NOT_FILE_REF", "File fields take a { location, path } reference."));
          continue;
        }
        if (typeof entry.location !== "string" || typeof entry.path !== "string") {
          failures.push(fail(field.name, "NOT_FILE_REF", "File fields take a { location, path } reference."));
          continue;
        }
        validated[field.name] = { location: entry.location, path: entry.path };
        break;
      }
      default: {
        const checked = checkStringField(field, entry, failures);
        if (checked === undefined) continue;
        validated[field.name] = checked;
      }
    }
  }
  if (failures.length > 0) {
    throw new Fault(422, "FORM_VALIDATION_FAILED", "The form submission did not pass validation.", failures);
  }
  return validated;
}

/** Merge validated submission values over declared defaults. Validated
 * values always win; defaults fill gaps for visible fields; hidden-field
 * defaults are dropped like any hidden value (fail closed, matching the
 * submission gate); undeclared names never appear. Visibility for
 * the defaults pass is evaluated against validated values plus
 * earlier-merged defaults in declaration order. A conditional on a
 * not-yet-merged default stays hidden (fail closed, matching the
 * submission gate, which evaluates visibility over the startup snapshot
 * plus the submit body). */
export function mergeFormDefaults(
  fields: readonly FormField[],
  validated: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(fields)) throw new Error("mergeFormDefaults needs a field list.");
  if (!isRecord(validated)) throw new Error("mergeFormDefaults needs a validated input object.");
  // Single declaration-order pass: validated values always win; defaults
  // fill gaps whose condition already resolves against validated values
  // plus earlier-merged defaults. A conditional on a not-yet-merged
  // default stays hidden — fail closed, matching the submission gate,
  // which evaluates visibility over the startup snapshot plus the submit
  // body.
  const merged: Record<string, unknown> = {};
  for (const field of fields) {
    if ((FORM_DISPLAY_TYPES as readonly string[]).includes(field.type)) continue;
    if (validated[field.name] !== undefined) {
      merged[field.name] = validated[field.name];
      continue;
    }
    if (field.default === undefined) continue;
    if (!isFieldVisible(field, merged)) continue;
    merged[field.name] = field.default;
  }
  return merged;
}

/** Validate and merge without touching the Saga gate: form-gate
 * validation (with startup-resolved provider options), then defaults
 * merged under validated values. The route file-checks the merged map
 * before the Saga parse gate runs. */
export function validateAndMerge(
  def: FormDefinition,
  body: unknown,
  options?: { allowedOptions?: Record<string, readonly string[]>; values?: Record<string, unknown> },
): Record<string, unknown> {
  const validated = validateFormInput(def.fields, body, options);
  return mergeFormDefaults(def.fields, validated);
}

/** Bind a submission to its Saga: validate-and-merge first, then the Saga
 * parse gate (a drift between declaration and Saga schema surfaces as the
 * Saga 400 INVALID_INPUT, distinct from field-level 422s). */
export function bindFormInput(
  def: FormDefinition,
  body: unknown,
  options?: { allowedOptions?: Record<string, readonly string[]>; values?: Record<string, unknown> },
): FormSubmission {
  const merged = validateAndMerge(def, body, options);
  const { saga, input } = parseSubmission({ sagaId: def.sagaId, input: merged });
  return { saga, input };
}

// --- Startup handles --------------------------------------------------------
// Session-bound capability rows in `form_startups` (created on demand with
// CREATE TABLE IF NOT EXISTS, the migration-0007 bootstrap pattern). The
// handle is a random 64-hex token; only its SHA-256 hash persists. Handles
// expire 30 minutes after minting, bind to (org, user, form), and are
// peeked for validation then consumed only after validation passes, so a
// replayed handle answers STALE_FORM_HANDLE instead of dispatching twice.

export function parseStartupHandle(value: unknown): string {
  if (typeof value !== "string" || !FORM_STARTUP_HANDLE_RE.test(value)) {
    throw new Fault(422, "STALE_FORM_HANDLE", "This form session is unknown or expired. Restart the form.");
  }
  return value;
}

/** Parse an optional scheduleAt instant: ISO 8601, future, at most 30 days
 * out. Returns the normalized ISO instant, or null when absent. */
export function parseScheduleAt(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new Fault(400, "INVALID_SCHEDULE", "scheduleAt must be an ISO 8601 instant.");
  }
  const at = Date.parse(value);
  if (Number.isNaN(at)) throw new Fault(400, "INVALID_SCHEDULE", "scheduleAt must be an ISO 8601 instant.");
  const now = Date.now();
  if (at <= now) throw new Fault(400, "INVALID_SCHEDULE", "scheduleAt must be in the future.");
  if (at - now > FORM_SCHEDULE_MAX_MS) {
    throw new Fault(400, "INVALID_SCHEDULE", "scheduleAt must be within 30 days.");
  }
  return new Date(at).toISOString();
}

async function ensureStartupTable(db: D1Database): Promise<void> {
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS form_startups(handle_hash TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL, form_id TEXT NOT NULL, form_name TEXT NOT NULL, prefill_json TEXT, options_json TEXT, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL)",
    )
    .run();
  await db
    .prepare("CREATE INDEX IF NOT EXISTS form_startups_expiry ON form_startups(expires_at)")
    .run()
    .catch(() => undefined);
}

async function hashHandle(handle: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(handle)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomHandle(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Resolve provider options for one declaration through the caller's Table
 * policy gate. Static providers read the declaration; table providers scan
 * one Table (read grant required — denied or foreign tables yield an empty
 * list plus a per-field error entry, never a leak). Output projection
 * caps at 50 option keys: the bounded reader never returns more. */
export async function resolveProviderOptions(
  db: D1Database,
  caller: Principal,
  fields: readonly FormField[],
  readTable: (db: D1Database, caller: Principal, table: string, valueField: string) => Promise<readonly string[]>,
): Promise<{ options: Record<string, readonly string[]>; errors: Record<string, string> }> {
  const options: Record<string, readonly string[]> = {};
  const errors: Record<string, string> = {};
  for (const field of fields) {
    if (field.type !== "select" && field.type !== "multiselect") continue;
    if (field.provider === undefined) {
      if (field.options !== undefined) options[field.name] = field.options;
      continue;
    }
    if (field.provider.kind === "static") {
      options[field.name] = field.provider.options;
      continue;
    }
    try {
      options[field.name] = (await readTable(db, caller, field.provider.table, field.provider.valueField)).slice(
        0,
        FORM_PROVIDER_MAX_OPTIONS,
      );
    } catch {
      errors[field.name] = "Provider table is not available to this caller.";
      options[field.name] = [];
    }
  }
  return { options, errors };
}

/** Mint a startup handle: resolve providers, merge prefill over defaults
 * (declaration opt-in only), persist the snapshot hash row, and return the
 * one-time handle plus the inspectable snapshot. Unknown prefill names,
 * prefill for display-only fields, and prefill values that would fail the
 * submission gate (wrong type, over bound, unlisted option, file shape)
 * fail closed with 422. */
export async function startFormSession(
  db: D1Database,
  caller: Principal,
  def: FormDefinition,
  body: unknown,
  readTable: (db: D1Database, caller: Principal, table: string, valueField: string) => Promise<readonly string[]>,
): Promise<FormStartup> {
  await ensureStartupTable(db);
  let prefill: Record<string, unknown> = {};
  if (body !== undefined && body !== null) {
    if (!isRecord(body)) {
      throw new Fault(400, "INVALID_PREFILL", "Startup takes an optional { prefill } object.");
    }
    if (Object.keys(body).some((key) => key !== "prefill")) {
      throw new Fault(400, "INVALID_PREFILL", "Startup takes an optional { prefill } object.");
    }
    if (body.prefill !== undefined) {
      if (!isRecord(body.prefill)) {
        throw new Fault(400, "INVALID_PREFILL", "Startup takes an optional { prefill } object.");
      }
      prefill = body.prefill;
      const keys = Object.keys(prefill);
      if (keys.length > FORM_MAX_KEYS) {
        throw new Fault(422, "FORM_VALIDATION_FAILED", "Prefill carries too many fields.", [
          fail("", "TOO_MANY_FIELDS", `At most ${FORM_MAX_KEYS} fields are accepted.`),
        ]);
      }
    }
  }
  const declared = new Map(def.fields.map((field) => [field.name, field]));
  if (Object.keys(prefill).length > 0 && !def.allowPrefill) {
    throw new Fault(403, "PREFILL_NOT_ALLOWED", "This form does not accept URL prefill.");
  }
  const { options } = await resolveProviderOptions(db, caller, def.fields, readTable);
  // Prefill runs the same per-field gate as submissions (minus required
  // and hidden-field checks, which belong to submit time): unknown names,
  // display-only names, wrong types, over-bound text, bad patterns, broken
  // numbers/booleans, unlisted options, and malformed file references fail
  // here, so a bad prefill can never poison the snapshot.
  const failures: FieldFailure[] = [];
  for (const key of Object.keys(prefill)) {
    const field = declared.get(key);
    if (!field) {
      failures.push(fail(key, "UNKNOWN_FIELD", "This field is not declared."));
      continue;
    }
    if ((FORM_DISPLAY_TYPES as readonly string[]).includes(field.type)) {
      failures.push(fail(key, "DISPLAY_ONLY_FIELD", "Display-only fields cannot be prefilled."));
      continue;
    }
    // Membership reads the just-resolved provider output, falling back to
    // the static declaration list — the same source the submit gate uses.
    const allowed =
      field.type === "select" || field.type === "multiselect" ? (options[field.name] ?? field.options ?? []) : [];
    checkPrefillValue(field, prefill[key], allowed, failures);
  }
  if (failures.length > 0) {
    throw new Fault(422, "FORM_VALIDATION_FAILED", "Prefill did not pass validation.", failures);
  }
  const snapshot: Record<string, unknown> = {};
  for (const field of def.fields) {
    if ((FORM_DISPLAY_TYPES as readonly string[]).includes(field.type)) continue;
    // Null prefill means "no value" (falls back to defaults): never persist
    // null into the snapshot, so visibility and submit treat it as a gap.
    if (prefill[field.name] !== undefined && prefill[field.name] !== null) {
      snapshot[field.name] = prefill[field.name];
      continue;
    }
    if (field.default !== undefined) snapshot[field.name] = field.default;
  }
  const now = new Date();
  const expiresAt = new Date(now.getTime() + FORM_STARTUP_TTL_MS).toISOString();
  const handle = randomHandle();
  await db
    .prepare(
      "INSERT INTO form_startups(handle_hash,org_id,user_id,form_id,form_name,prefill_json,options_json,expires_at,used_at,created_at) VALUES (?,?,?,?,?,?,?,?,NULL,?)",
    )
    .bind(
      await hashHandle(handle),
      caller.orgId,
      caller.userId,
      def.id,
      def.name,
      JSON.stringify(snapshot),
      JSON.stringify(options),
      expiresAt,
      now.toISOString(),
    )
    .run();
  // Best-effort expiry sweep keeps the table bounded (D1 has no TTL;
  // SQLite has no DELETE ... LIMIT, so the delete is bounded by a
  // handle_hash subselect instead).
  await db
    .prepare(
      "DELETE FROM form_startups WHERE handle_hash IN (SELECT handle_hash FROM form_startups WHERE expires_at<? LIMIT 100)",
    )
    .bind(now.toISOString())
    .run()
    .catch(() => undefined);
  return { handle, formName: def.name, expiresAt, snapshot, options };
}

/** Peek a startup handle for (org, user, form) without consuming it.
 * Unknown, expired, foreign, already-used, or form-mismatched handles
 * answer 422 STALE_FORM_HANDLE. Returns the persisted snapshot (prefill
 * plus resolved provider options) for the submit merge. The route peeks
 * first so failed validation leaves the handle live for a corrected
 * retry, and consumes only after every validation gate passes. */
export async function peekStartupHandle(
  db: D1Database,
  caller: Principal,
  formName: string,
  handle: string,
): Promise<{ snapshot: Record<string, unknown>; options: Record<string, readonly string[]>; handleHash: string }> {
  parseStartupHandle(handle);
  await ensureStartupTable(db);
  const handleHash = await hashHandle(handle);
  const row = await db
    .prepare(
      "SELECT handle_hash,org_id,user_id,form_id,form_name,prefill_json,options_json,expires_at,used_at,created_at FROM form_startups WHERE handle_hash=?",
    )
    .bind(handleHash)
    .first<StartupRow>()
    .catch(() => null);
  if (
    !row ||
    row.org_id !== caller.orgId ||
    row.user_id !== caller.userId ||
    row.form_name !== formName ||
    row.used_at !== null ||
    Date.parse(row.expires_at) <= Date.now()
  ) {
    throw new Fault(422, "STALE_FORM_HANDLE", "This form session is unknown or expired. Restart the form.");
  }
  let snapshot: Record<string, unknown>;
  let options: Record<string, readonly string[]>;
  try {
    snapshot = row.prefill_json ? (JSON.parse(row.prefill_json) as Record<string, unknown>) : {};
    options = row.options_json ? (JSON.parse(row.options_json) as Record<string, readonly string[]>) : {};
  } catch {
    throw new Fault(422, "STALE_FORM_HANDLE", "This form session is unknown or expired. Restart the form.");
  }
  return { snapshot, options, handleHash };
}

/** Consume a startup handle for (org, user, form): peek first (same 422
 * contract), then win the single-use fence. Unknown, expired, foreign,
 * already-used, form-mismatched, or corrupt handles answer 422
 * STALE_FORM_HANDLE and dispatch nothing. Returns the persisted snapshot
 * (prefill + resolved provider options) for the submit merge. */
export async function consumeStartupHandle(
  db: D1Database,
  caller: Principal,
  formName: string,
  handle: string,
): Promise<{ snapshot: Record<string, unknown>; options: Record<string, readonly string[]> }> {
  const { snapshot, options, handleHash } = await peekStartupHandle(db, caller, formName, handle);
  // The conditional UPDATE is the single-use fence: exactly one consumer
  // wins the row; a lost race (changes === 0) answers stale rather than
  // dispatching twice.
  const consumed = await db
    .prepare("UPDATE form_startups SET used_at=? WHERE handle_hash=? AND used_at IS NULL")
    .bind(new Date().toISOString(), handleHash)
    .run()
    .catch(() => null);
  if (!consumed || consumed.meta.changes === 0) {
    throw new Fault(422, "STALE_FORM_HANDLE", "This form session is unknown or expired. Restart the form.");
  }
  return { snapshot, options };
}

/** Parse a file-field reference against its declared policy (shape only;
 * readiness/size/type are re-validated against the live FILE-01 row by
 * the submit route's checkFormFiles step). */
export function parseFileRef(
  field: { readonly name: string; readonly file?: FormFilePolicy },
  entry: unknown,
): { location: string; path: string } {
  if (!isRecord(entry) || typeof entry.location !== "string" || typeof entry.path !== "string") {
    throw new Fault(422, "FORM_VALIDATION_FAILED", "The form submission did not pass validation.", [
      fail(field.name, "NOT_FILE_REF", "File fields take a { location, path } reference."),
    ]);
  }
  if (field.file && entry.location !== field.file.location) {
    throw new Fault(422, "FORM_VALIDATION_FAILED", "The form submission did not pass validation.", [
      fail(field.name, "FILE_LOCATION_MISMATCH", `File field "${field.name}" uploads to "${field.file.location}".`),
    ]);
  }
  if (entry.path.length === 0 || entry.path.length > 512) {
    throw new Fault(422, "FORM_VALIDATION_FAILED", "The form submission did not pass validation.", [
      fail(field.name, "INVALID_FILE_PATH", "File paths are 1-512 chars."),
    ]);
  }
  return { location: entry.location, path: entry.path };
}
