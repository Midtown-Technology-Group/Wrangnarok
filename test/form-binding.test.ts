import { describe, expect, it } from "vitest";
import {
  bindFormInput,
  checkPrefillValue,
  isFieldVisible,
  isInternalKey,
  mergeFormDefaults,
  parseFileRef,
  parseFormDeclaration,
  parseFormFields,
  parseScheduleAt,
  parseStartupHandle,
  validateAndMerge,
  validateFormInput,
} from "../src/forms";
import { helloSaga } from "../src/domain";
import type { FieldFailure } from "../src/domain";

const declaration = [{ name: "name", type: "text", required: true, maxLength: 1024 }] as const;
const fields = parseFormFields(structuredClone(declaration));
const def = {
  id: "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5",
  orgId: "00000000-0000-4000-8000-000000000001",
  name: "hello-greeting",
  sagaId: helloSaga.id,
  allowPrefill: false,
  fields,
};

describe("form declaration contract", () => {
  it("accepts the pilot declaration and rejects malformed ones", () => {
    expect(parseFormFields(structuredClone(declaration))).toEqual([
      { name: "name", type: "text", required: true, maxLength: 1024 },
    ]);
    expect(parseFormFields([{ name: "nickname", type: "text", required: false }])).toEqual([
      { name: "nickname", type: "text", required: false, maxLength: 1024 },
    ]);
    const bad: unknown[] = [
      [],
      "fields",
      [{ name: "name", type: "text", required: true, extra: 1 }],
      [{ name: "9lives", type: "text", required: true }],
      [
        { name: "name", type: "text", required: true },
        { name: "name", type: "text", required: false },
      ],
      [{ name: "name", type: "watermelon", required: true }],
      [{ name: "name", type: "text", required: "yes" }],
      [{ name: "name", type: "text", required: true, maxLength: 0 }],
      [{ name: "name", type: "text", required: true, maxLength: 2048 }],
      [{ name: "title", type: "heading", required: false, content: "Hi", pattern: "x" }],
      [{ name: "title", type: "heading", required: true, content: "Hi" }],
      [{ name: "title", type: "heading", required: false }],
      [{ name: "name", type: "text", required: true, content: "Hi" }],
      [{ name: "pick", type: "select", required: true }],
      [{ name: "pick", type: "select", required: true, options: ["a"], provider: { kind: "static", options: ["a"] } }],
      [{ name: "doc", type: "file", required: true }],
      [{ name: "n", type: "text", required: false, min: 1 }],
      [{ name: "n", type: "number", required: false, min: 5, max: 2 }],
      [{ name: "n", type: "number", required: false, pattern: "x" }],
      [{ name: "nick", type: "text", required: false, visibleWhen: { field: "nope", equals: "x" } }],
      [{ name: "nick", type: "text", required: false, visibleWhen: { field: "nick", equals: "x" } }],
      Array.from({ length: 51 }, (_, index) => ({ name: `f${index}`, type: "text", required: false })),
    ];
    for (const value of bad) expect(() => parseFormFields(value)).toThrow();
  });
  it("validates submissions field by field and binds the Saga input", () => {
    expect(validateFormInput(fields, { name: "Ada" })).toEqual({ name: "Ada" });
    expect(bindFormInput(def, { name: "Ada" })).toMatchObject({ input: { name: "Ada" } });
    const optional = parseFormFields([{ name: "nickname", type: "text", required: false, maxLength: 8 }]);
    expect(validateFormInput(optional, {})).toEqual({});
    expect(validateFormInput(optional, { nickname: null })).toEqual({});
    const failure = (value: unknown): { code: string; field: string }[] => {
      try {
        validateFormInput(fields, value);
      } catch (error) {
        const fault = error as { status?: number; code?: string; details?: { field: string; code: string }[] };
        expect(fault.status).toBe(422);
        expect(fault.code).toBe("FORM_VALIDATION_FAILED");
        return (fault.details ?? []).map((entry) => ({ code: entry.code, field: entry.field }));
      }
      throw new Error("expected validateFormInput to throw");
    };
    expect(failure({ name: "" })).toEqual([{ code: "REQUIRED", field: "name" }]);
    // A declaration that drifts from its Saga schema surfaces the Saga 400,
    // distinct from field-level 422s: the form gate passed, the Saga gate refused.
    expect(() => bindFormInput({ ...def, sagaId: helloSaga.id, fields: optional }, {})).toThrow(
      expect.objectContaining({ status: 400, code: "INVALID_INPUT" }),
    );
  });
});

describe("FORM-02 dynamic form contract (issue #155)", () => {
  it("parses the declaration envelope with title, description, and prefill opt-in", () => {
    expect(parseFormDeclaration(structuredClone(declaration))).toEqual({ allowPrefill: false, fields });
    const envelope = parseFormDeclaration({
      title: "Greet",
      description: "Say hello.",
      allowPrefill: true,
      fields: structuredClone(declaration),
    });
    expect(envelope).toMatchObject({ title: "Greet", description: "Say hello.", allowPrefill: true });
    expect(envelope.fields).toEqual(fields);
    for (const bad of [
      { fields: structuredClone(declaration), allowPrefill: "yes" },
      { fields: structuredClone(declaration), title: 7 },
      { fields: structuredClone(declaration), bogus: true },
      { nope: true },
    ]) {
      expect(() => parseFormDeclaration(bad)).toThrow();
    }
  });
  it("validates typed fields, display-only rejection, and option membership", () => {
    const typed = parseFormFields([
      { name: "age", type: "number", required: true, min: 0, max: 150 },
      { name: "member", type: "boolean", required: false },
      { name: "email", type: "email", required: false },
      { name: "born", type: "date", required: false },
      { name: "pick", type: "select", required: true, options: ["a", "b"] },
      {
        name: "tags",
        type: "multiselect",
        required: false,
        provider: { kind: "static", options: ["x", "y"] },
      },
      { name: "title", type: "heading", required: false, content: "Hi" },
    ]);
    expect(validateFormInput(typed, { age: 3, pick: "a" })).toEqual({ age: 3, pick: "a" });
    const failure = (value: unknown, opts?: { allowedOptions?: Record<string, readonly string[]> }) => {
      try {
        validateFormInput(typed, value, opts);
      } catch (error) {
        const fault = error as { status?: number; code?: string; details?: { field: string; code: string }[] };
        expect(fault.status).toBe(422);
        expect(fault.code).toBe("FORM_VALIDATION_FAILED");
        return (fault.details ?? []).map((entry) => `${entry.field}:${entry.code}`);
      }
      throw new Error("expected validateFormInput to throw");
    };
    expect(failure({ age: "3", pick: "a" })).toContain("age:NOT_NUMBER");
    expect(failure({ age: 200, pick: "a" })).toContain("age:TOO_LARGE");
    expect(failure({ age: -1, pick: "a" })).toContain("age:TOO_SMALL");
    expect(failure({ age: 3, pick: "a", member: "yes" })).toContain("member:NOT_BOOLEAN");
    expect(failure({ age: 3, pick: "a", email: "nope" })).toContain("email:INVALID_EMAIL");
    expect(failure({ age: 3, pick: "a", born: "tomorrow" })).toContain("born:INVALID_DATE");
    // Empty optionals pass every format gate (required-ness is separate).
    expect(validateFormInput(typed, { age: 3, pick: "a" })).toEqual({ age: 3, pick: "a" });
    expect(failure({ age: 3, pick: "zzz" })).toContain("pick:INVALID_OPTION");
    expect(failure({ age: 3, pick: "a", tags: ["nope"] })).toContain("tags:INVALID_OPTION");
    expect(failure({ age: 3, pick: "a", tags: "x" })).toContain("tags:NOT_ARRAY");
    expect(failure({ age: 3, pick: "a", title: "Hi" })).toContain("title:DISPLAY_ONLY_FIELD");
    // Startup-resolved options override the static declaration list.
    expect(validateFormInput(typed, { age: 3, pick: "c" }, { allowedOptions: { pick: ["c"] } })).toEqual({
      age: 3,
      pick: "c",
    });
    // A required multiselect submitted empty fails; a non-empty list binds.
    const needTags = parseFormFields([{ name: "tags", type: "multiselect", required: true, options: ["x"] }]);
    try {
      validateFormInput(needTags, { tags: [] });
      throw new Error("expected required-multiselect rejection");
    } catch (error) {
      const fault = error as { details?: { field: string; code: string }[] };
      expect((fault.details ?? []).map((entry) => `${entry.field}:${entry.code}`)).toContain("tags:REQUIRED");
    }
    expect(validateFormInput(needTags, { tags: ["x"] })).toEqual({ tags: ["x"] });
  });
  it("drops hidden conditional fields and fails closed on smuggled values", () => {
    expect(isInternalKey("__form")).toBe(true);
    expect(isInternalKey("__scheduleAt")).toBe(true);
    expect(isInternalKey("name")).toBe(false);
    const conditional = parseFormFields([
      { name: "kind", type: "text", required: true },
      { name: "nick", type: "text", required: false, visibleWhen: { field: "kind", equals: "other" } },
    ]);
    expect(isFieldVisible(conditional[1]!, { kind: "other" })).toBe(true);
    expect(isFieldVisible(conditional[1]!, { kind: "real" })).toBe(false);
    expect(validateFormInput(conditional, { kind: "real" })).toEqual({ kind: "real" });
    expect(validateFormInput(conditional, { kind: "other", nick: "Al" })).toEqual({ kind: "other", nick: "Al" });
    try {
      validateFormInput(conditional, { kind: "real", nick: "Al" });
      throw new Error("expected hidden-field rejection");
    } catch (error) {
      const fault = error as { details?: { field: string; code: string }[] };
      expect((fault.details ?? []).map((entry) => `${entry.field}:${entry.code}`)).toContain("nick:HIDDEN_FIELD");
    }
    expect(mergeFormDefaults(conditional, { kind: "real" })).toEqual({ kind: "real" });
    expect(() => mergeFormDefaults("fields" as unknown as never, {})).toThrow();
    expect(() => mergeFormDefaults(conditional, null as unknown as Record<string, unknown>)).toThrow();
  });
  it("resolves conditional defaults in declaration order, fail closed", () => {
    // nick shows when kind is "other". Declared AFTER its defaulted
    // trigger, it merges; declared BEFORE, it stays hidden (fail closed,
    // matching the submission gate — never resolved against unmerged
    // defaults).
    const after = parseFormFields([
      { name: "kind", type: "text", required: false, default: "other" },
      {
        name: "nick",
        type: "text",
        required: false,
        default: "Al",
        visibleWhen: { field: "kind", equals: "other" },
      },
    ]);
    expect(mergeFormDefaults(after, {})).toEqual({ kind: "other", nick: "Al" });
    const before = parseFormFields([
      {
        name: "nick",
        type: "text",
        required: false,
        default: "Al",
        visibleWhen: { field: "kind", equals: "other" },
      },
      { name: "kind", type: "text", required: false, default: "other" },
    ]);
    expect(mergeFormDefaults(before, {})).toEqual({ kind: "other" });
    // Submission overrides still win and still drive visibility.
    expect(mergeFormDefaults(before, { kind: "real" })).toEqual({ kind: "real" });
    expect(mergeFormDefaults(before, { kind: "other", nick: "Bo" })).toEqual({ nick: "Bo", kind: "other" });
  });
  it("merges validated values over declared defaults and parses handles and schedules", () => {
    const withDefaults = parseFormFields([
      { name: "name", type: "text", required: true, default: "Ada" },
      { name: "nickname", type: "text", required: false, default: "Al" },
      { name: "title", type: "heading", required: false, content: "Hi" },
    ]);
    // Submission wins; defaults fill gaps; display-only never merges.
    expect(mergeFormDefaults(withDefaults, { name: "Grace" })).toEqual({ name: "Grace", nickname: "Al" });
    expect(mergeFormDefaults(withDefaults, {})).toEqual({ name: "Ada", nickname: "Al" });
    // A visible required field with a declared default passes when omitted
    // (the merged input still carries a value); without a default it fails.
    expect(validateAndMerge({ ...def, fields: withDefaults }, {})).toEqual({ name: "Ada", nickname: "Al" });
    // Handles are 64-hex; anything else is a stale-handle 422.
    expect(parseStartupHandle("a".repeat(64))).toBe("a".repeat(64));
    for (const bad of ["", "xyz", "A".repeat(64), null, undefined, 7]) {
      try {
        parseStartupHandle(bad);
        throw new Error("expected stale-handle rejection");
      } catch (error) {
        expect(error).toMatchObject({ status: 422, code: "STALE_FORM_HANDLE" });
      }
    }
    // scheduleAt: future within 30 days only.
    const future = new Date(Date.now() + 3600 * 1000).toISOString();
    expect(parseScheduleAt(future)).toBe(new Date(Date.parse(future)).toISOString());
    expect(parseScheduleAt(undefined)).toBeNull();
    expect(parseScheduleAt(null)).toBeNull();
    // Boundary: exactly now is past (at <= now rejects).
    expect(() => parseScheduleAt(new Date(Date.now() - 1).toISOString())).toThrow(
      expect.objectContaining({ code: "INVALID_SCHEDULE" }),
    );
    const badSchedules = [
      "yesterday",
      "2020-01-01T00:00:00.000Z",
      new Date(Date.now() + 31 * 86400 * 1000).toISOString(),
      7,
    ];
    for (const bad of badSchedules) {
      try {
        parseScheduleAt(bad);
        throw new Error("expected schedule rejection");
      } catch (error) {
        expect(error).toMatchObject({ code: expect.stringMatching(/INVALID_SCHEDULE/) });
      }
    }
  });
  it("covers every text-like, numeric, and file branch of the field gate", () => {
    const misc = parseFormFields([
      { name: "at", type: "time", required: false },
      { name: "when", type: "datetime", required: false },
      { name: "site", type: "url", required: false },
      { name: "phone", type: "tel", required: false },
      { name: "bio", type: "textarea", required: false, pattern: "^[a-z ]+$" },
      { name: "code", type: "hidden", required: false },
      { name: "count", type: "number", required: false },
      { name: "doc", type: "file", required: false, file: { location: "uploads" } },
      { name: "gap", type: "paragraph", required: false, content: "—" },
    ]);
    // Every happy shape validates clean.
    expect(
      validateFormInput(misc, {
        at: "12:30",
        when: "2026-09-20T12:30",
        site: "https://example.com/x",
        phone: "+1 (555) 010-2030",
        bio: "hello world",
        code: "s3cr3t",
        count: 3,
        doc: { location: "uploads", path: "a.txt" },
      }),
    ).toMatchObject({ at: "12:30", count: 3 });
    const failure = (value: unknown) => {
      try {
        validateFormInput(misc, value);
      } catch (error) {
        const fault = error as { details?: { field: string; code: string }[] };
        return (fault.details ?? []).map((entry) => `${entry.field}:${entry.code}`);
      }
      throw new Error("expected validateFormInput to throw");
    };
    expect(failure({ at: "noon" })).toContain("at:INVALID_TIME");
    expect(failure({ when: "tomorrow" })).toContain("when:INVALID_DATETIME");
    expect(failure({ site: "gopher://x" })).toContain("site:INVALID_URL");
    expect(failure({ site: "not a url" })).toContain("site:INVALID_URL");
    expect(failure({ phone: "!!" })).toContain("phone:INVALID_TEL");
    expect(failure({ bio: "SHOUTING 123" })).toContain("bio:PATTERN_MISMATCH");
    expect(failure({ count: Number.NaN })).toContain("count:NOT_NUMBER");
    expect(failure({ count: 1, doc: "uploads/a.txt" })).toContain("doc:NOT_FILE_REF");
    expect(failure({ count: 1, doc: { location: "uploads" } })).toContain("doc:NOT_FILE_REF");
    expect(failure({ count: 1, gap: "x" })).toContain("gap:DISPLAY_ONLY_FIELD");
    // A well-shaped file reference passes the shape gate (readiness and
    // bounds are the route file gate's job, pinned by workerd tests).
    expect(validateFormInput(misc, { count: 1, doc: { location: "uploads", path: "a.txt" } })).toEqual({
      count: 1,
      doc: { location: "uploads", path: "a.txt" },
    });
    // Empty file paths fail at the route file gate (parseFileRef), not the
    // shape gate: the reference shape is valid, the path is not usable.
    try {
      parseFileRef({ name: "doc", file: { location: "uploads" } }, { location: "uploads", path: "" });
      throw new Error("expected parseFileRef to throw");
    } catch (error) {
      const fault = error as { status?: number; code?: string; details?: { field: string; code: string }[] };
      expect(fault.status).toBe(422);
      expect(fault.details).toMatchObject([{ field: "doc", code: "INVALID_FILE_PATH" }]);
    }
    // File defaults validate as references; hidden fields accept empties.
    const withFileDefault = parseFormFields([
      {
        name: "doc",
        type: "file",
        required: false,
        file: { location: "uploads" },
        default: { location: "uploads", path: "seed.txt" },
      },
    ]);
    const fileDefaultDef = {
      id: "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5",
      orgId: "00000000-0000-4000-8000-000000000001",
      name: "file-default",
      sagaId: helloSaga.id,
      allowPrefill: false,
      fields: withFileDefault,
    };
    expect(validateAndMerge(fileDefaultDef, {})).toEqual({ doc: { location: "uploads", path: "seed.txt" } });
    // Declaration rejects every malformed file/provider/pattern/default shape.
    for (const bad of [
      [{ name: "d", type: "file", required: false, file: { location: "UPPER" } }],
      [{ name: "d", type: "file", required: false, file: { location: "ok", maxMb: 99 } }],
      [{ name: "d", type: "file", required: false, file: { location: "ok", maxMb: "lots" } }],
      [{ name: "d", type: "file", required: false, file: { location: "ok", contentTypes: [] } }],
      [{ name: "d", type: "file", required: false, file: { location: "ok", contentTypes: ["x".repeat(129)] } }],
      [{ name: "d", type: "file", required: false, file: { location: "ok", bogus: 1 } }],
      [{ name: "d", type: "file", required: false, file: "uploads" }],
      [{ name: "d", type: "file", required: false }],
      [{ name: "t", type: "text", required: false, file: { location: "ok" } }],
      [{ name: "s", type: "select", required: false, provider: { kind: "table" } }],
      [{ name: "s", type: "select", required: false, provider: { kind: "table", table: 7, valueField: "v" } }],
      [{ name: "s", type: "select", required: false, provider: { kind: "table", table: "t", valueField: "9bad" } }],
      [
        {
          name: "s",
          type: "select",
          required: false,
          provider: { kind: "table", table: "t", valueField: "v", labelField: "9bad" },
        },
      ],
      [{ name: "s", type: "select", required: false, provider: { kind: "table", table: "t", valueField: "v", x: 1 } }],
      [{ name: "s", type: "select", required: false, provider: { kind: "carrier-pigeon" } }],
      [{ name: "s", type: "select", required: false, provider: { options: ["a"] } }],
      [{ name: "s", type: "select", required: false, provider: { kind: "static", options: [] } }],
      [{ name: "s", type: "select", required: false, provider: { kind: "static", options: [""] } }],
      [{ name: "s", type: "select", required: false, provider: { kind: "static", options: ["x".repeat(129)] } }],
      [{ name: "s", type: "select", required: false, provider: { kind: "static", options: ["a"], x: 1 } }],
      [{ name: "s", type: "select", required: false, options: ["x".repeat(129)] }],
      [{ name: "s", type: "select", required: false, options: [""] }],
      [{ name: "t", type: "text", required: false, options: ["a"] }],
      [{ name: "t", type: "text", required: false, pattern: "(unclosed" }],
      [{ name: "n", type: "number", required: false, min: "0" }],
      [{ name: "n", type: "number", required: false, max: "9" }],
      [{ name: "n", type: "number", required: false, default: "three" }],
      [{ name: "b", type: "boolean", required: false, default: "yes" }],
      [{ name: "m", type: "multiselect", required: false, options: ["a"], default: "a" }],
      [{ name: "f", type: "file", required: false, file: { location: "ok" }, default: "path" }],
      [{ name: "t", type: "text", required: false, default: 7 }],
      [{ name: "v", type: "text", required: false, visibleWhen: { field: "v", equals: 1 } }],
      [{ name: "v", type: "text", required: false, visibleWhen: { field: "w", equals: null } }],
      [{ name: "v", type: "text", required: false, visibleWhen: { field: "w", equals: 1, or: 2 } }],
      [{ name: "v", type: "text", required: false, visibleWhen: "whenever" }],
      [{ name: "v", type: "text", required: false, visibleWhen: { field: "9bad", equals: 1 } }],
      [{ name: "t", type: "text", required: false, label: "x".repeat(161) }],
      [{ name: "t", type: "text", required: false, content: "x" }],
      [{ name: "t", type: "text", required: true, default: "" }],
      [{ name: "t", type: "text", required: false, maxLength: 2, default: "toolong" }],
      [{ name: "e", type: "email", required: false, default: "not-an-email" }],
      [{ name: "t", type: "text", required: false, pattern: "^a+$", default: "bbb" }],
      [{ name: "n", type: "number", required: false, min: 5, default: 2 }],
      [{ name: "n", type: "number", required: false, max: 2, default: 9 }],
      [{ name: "s", type: "select", required: false, options: ["a", "b"], default: "zzz" }],
      [{ name: "s", type: "select", required: false, options: ["a", "b"], default: 7 }],
      [
        {
          name: "s",
          type: "select",
          required: false,
          provider: { kind: "static", options: ["a"] },
          default: "zzz",
        },
      ],
      [{ name: "m", type: "multiselect", required: false, options: ["a"], default: ["zzz"] }],
      [{ name: "m", type: "multiselect", required: false, options: ["a"], default: "a" }],
      [{ name: "m", type: "multiselect", required: false, options: ["a"], default: Array(51).fill("a") }],
      [{ name: "m", type: "multiselect", required: true, options: ["a"], default: [] }],
      [{ name: "m", type: "multiselect", required: false, options: ["a", ""], default: [""] }],
      [
        {
          name: "m",
          type: "multiselect",
          required: false,
          options: ["a", "x".repeat(129)],
          default: ["x".repeat(129)],
        },
      ],
      [{ name: "n", type: "number", required: false, default: Number.NaN }],
      [{ name: "f", type: "file", required: false, file: { location: "ok" }, default: { location: "x", path: "p" } }],
      [{ name: "f", type: "file", required: false, file: { location: "ok" }, default: { location: "ok", path: "" } }],
    ]) {
      expect(() => parseFormFields(bad)).toThrow();
    }
    // Declaration envelope rejects every malformed wrapper.
    for (const bad of [
      { fields: [], title: "t" },
      "nope",
      { fields: structuredClone(declaration), description: "x".repeat(1025) },
    ]) {
      expect(() => parseFormDeclaration(bad)).toThrow();
    }
  });
  it("gates prefill values like submissions minus required and hidden checks", () => {
    const gate = parseFormFields([
      { name: "n", type: "number", required: true, min: 0, max: 10 },
      { name: "b", type: "boolean", required: true },
      { name: "bio", type: "text", required: true },
      { name: "pick", type: "select", required: true, options: ["a", "b"] },
      { name: "tags", type: "multiselect", required: true, options: ["x", "y"] },
      { name: "doc", type: "file", required: true, file: { location: "uploads" } },
      { name: "nick", type: "text", required: false, visibleWhen: { field: "n", equals: 1 } },
    ]);
    const byName = new Map(gate.map((field) => [field.name, field]));
    const check = (name: string, entry: unknown, allowed: readonly string[] = []): string[] => {
      const failures: FieldFailure[] = [];
      checkPrefillValue(byName.get(name)!, entry, allowed, failures);
      return failures.map((failure) => `${failure.field}:${failure.code}`);
    };
    // Nullish prefill passes through (falls back to defaults); required
    // and hidden rules do not apply at startup time.
    expect(check("n", null)).toEqual([]);
    expect(check("n", undefined)).toEqual([]);
    expect(check("n", 5)).toEqual([]);
    expect(check("nick", "Al")).toEqual([]);
    expect(check("n", "5")).toEqual(["n:NOT_NUMBER"]);
    expect(check("n", Number.NaN)).toEqual(["n:NOT_NUMBER"]);
    expect(check("n", -1)).toEqual(["n:TOO_SMALL"]);
    expect(check("n", 11)).toEqual(["n:TOO_LARGE"]);
    expect(check("b", "yes")).toEqual(["b:NOT_BOOLEAN"]);
    expect(check("b", true)).toEqual([]);
    expect(check("pick", "c", ["a", "b"])).toEqual(["pick:INVALID_OPTION"]);
    expect(check("pick", "a", ["a", "b"])).toEqual([]);
    expect(check("pick", 7, ["a", "b"])).toContain("pick:NOT_STRING");
    expect(check("pick", "x".repeat(1025), ["x".repeat(1025), "b"])).toContain("pick:TOO_LONG");
    expect(check("tags", "x", ["x", "y"])).toEqual(["tags:NOT_ARRAY"]);
    expect(
      check(
        "tags",
        Array.from({ length: 51 }, () => "x"),
        ["x"],
      ),
    ).toEqual(["tags:TOO_MANY_OPTIONS"]);
    expect(check("tags", ["nope"], ["x", "y"])).toEqual(["tags:INVALID_OPTION"]);
    expect(check("tags", ["x"], ["x", "y"])).toEqual([]);
    expect(check("tags", [7], ["x", "y"])).toEqual(["tags:INVALID_OPTION"]);
    expect(check("doc", "uploads/a.txt")).toEqual(["doc:NOT_FILE_REF"]);
    expect(check("doc", { location: "elsewhere", path: "a.txt" })).toEqual(["doc:FILE_LOCATION_MISMATCH"]);
    expect(check("doc", { location: "uploads", path: "a.txt" })).toEqual([]);
    expect(check("doc", { location: "uploads", path: "" })).toEqual(["doc:INVALID_FILE_PATH"]);
    // Empty text prefill passes the startup gate (minus required: nullish
    // and "" fall back to defaults; requiredness is a submit-time verdict).
    expect(check("bio", "")).toEqual([]);
    expect(check("nick", "")).toEqual([]);
    // Empty select prefill is a value, not a gap: "" is not an allowed
    // option, so it fails INVALID_OPTION here (nullish falls back, "").
    expect(check("pick", "", ["a", "b"])).toEqual(["pick:INVALID_OPTION"]);
  });
  it("covers declaration edge branches: records, content, options, patterns, numbers", () => {
    // Non-record entries and non-string content on plain fields fail closed.
    expect(() => parseFormFields([null])).toThrow();
    expect(() => parseFormFields([{ name: "name", type: "text", required: true, content: 7 }])).toThrow();
    expect(() =>
      parseFormFields([
        { name: "n", type: "number", required: false },
        { name: "pick", type: "select", required: true, options: ["a"], extra: 1 },
      ]),
    ).toThrow();
    // Options/provider on a non-select kind fails before the exclusivity check.
    expect(() => parseFormFields([{ name: "name", type: "text", required: true, options: ["a"] }])).toThrow(
      /Only select fields/,
    );
    // Empty select options and a bad option entry fail the options gate.
    expect(() => parseFormFields([{ name: "pick", type: "select", required: true, options: [] }])).toThrow(
      /1 to 50 entries/,
    );
    expect(() => parseFormFields([{ name: "pick", type: "select", required: true, options: [""] }])).toThrow(
      /1-128 char/,
    );
    // Non-string and over-bound patterns fail; a non-text-like kind cannot carry one.
    expect(() => parseFormFields([{ name: "name", type: "text", required: true, pattern: 7 }])).toThrow(/1-256 chars/);
    expect(() => parseFormFields([{ name: "name", type: "text", required: true, pattern: "[" }])).toThrow(
      /valid regular expression/,
    );
    expect(() => parseFormFields([{ name: "n", type: "number", required: false, pattern: "x" }])).toThrow(/text-like/);
    // Number min/max gates: non-numbers and inverted ranges fail closed.
    expect(() => parseFormFields([{ name: "n", type: "number", required: false, min: "x" }])).toThrow(
      /min must be a number/,
    );
    expect(() => parseFormFields([{ name: "n", type: "number", required: false, max: "x" }])).toThrow(
      /max must be a number/,
    );
    expect(() => parseFormFields([{ name: "n", type: "number", required: false, min: 5, max: 2 }])).toThrow(
      /cannot exceed max/,
    );
  });
  it("covers declaration default edge branches across every field kind", () => {
    // A display-only kind cannot carry a default.
    expect(() =>
      parseFormFields([{ name: "title", type: "heading", required: false, content: "Hi", default: "x" }]),
    ).toThrow(/cannot carry a default/);
    // Number defaults: non-finite, below min, above max.
    for (const bad of [
      { name: "n", type: "number", required: false, default: "x" },
      { name: "n", type: "number", required: false, default: Number.NaN },
      { name: "n", type: "number", required: false, min: 0, default: -1 },
      { name: "n", type: "number", required: false, max: 10, default: 11 },
    ]) {
      expect(() => parseFormFields([bad])).toThrow(/default/);
    }
    // Boolean defaults take booleans only.
    expect(() => parseFormFields([{ name: "b", type: "boolean", required: false, default: "yes" }])).toThrow(
      /must be a boolean/,
    );
    // Select defaults: empty, non-string, and unlisted values fail closed.
    for (const bad of [
      { name: "pick", type: "select", required: true, options: ["a"], default: "" },
      { name: "pick", type: "select", required: true, options: ["a"], default: 7 },
      { name: "pick", type: "select", required: true, options: ["a"], default: "zzz" },
    ]) {
      expect(() => parseFormFields([bad])).toThrow(/default/);
    }
    // A select default through a static provider list must be listed too.
    expect(() =>
      parseFormFields([
        {
          name: "pick",
          type: "select",
          required: true,
          provider: { kind: "static", options: ["a"] },
          default: "zzz",
        },
      ]),
    ).toThrow(/listed option/);
    // Multiselect defaults: non-lists, over-long lists, bad entries, unlisted picks.
    for (const bad of [
      { name: "tags", type: "multiselect", required: false, options: ["x"], default: "x" },
      { name: "tags", type: "multiselect", required: false, options: ["x"], default: [""] },
      { name: "tags", type: "multiselect", required: false, options: ["x"], default: ["zzz"] },
      {
        name: "tags",
        type: "multiselect",
        required: true,
        options: ["x"],
        default: [],
      },
      {
        name: "tags",
        type: "multiselect",
        required: false,
        options: ["x"],
        default: Array.from({ length: 51 }, () => "x"),
      },
    ]) {
      expect(() => parseFormFields([bad])).toThrow(/default/);
    }
    // File defaults: wrong shape, wrong location, bad path length.
    for (const bad of [
      { name: "doc", type: "file", required: false, file: { location: "uploads" }, default: "x" },
      {
        name: "doc",
        type: "file",
        required: false,
        file: { location: "uploads" },
        default: { location: "elsewhere", path: "a.txt" },
      },
      {
        name: "doc",
        type: "file",
        required: false,
        file: { location: "uploads" },
        default: { location: "uploads", path: "" },
      },
    ]) {
      expect(() => parseFormFields([bad])).toThrow(/default/);
    }
  });
});
