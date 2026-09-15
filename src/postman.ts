// SPDX-License-Identifier: AGPL-3.0
// INT-01 (issue #229): Postman Collection v2.1 to OpenAPI 3.x converter.
// Pure function: Postman JSON in, OpenAPI document out. No fetch, no D1,
// no secrets. The collection's servers/variables are diagnostics only —
// the operator's --origin allowlist stays the egress authority, exactly
// like OpenAPI `servers` entries. Shared by the typed generator
// (src/generate-integration.ts) and the plain-Node CLI
// (scripts/wrangnarok.mjs) so both entry points accept the same sources.
const CONVERTER_VERSION = "postman-v2.1-1";

const OPERATION_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;

function capToken(token: string): string {
  const head = token[0];
  if (token.length === 0 || head === undefined) return token;
  return head.toUpperCase() + token.slice(1);
}

/** Derive a stable operationId from METHOD + path when the collection
 * item carries no usable name. Mirrors the real-spec overlay rule:
 * `Method_Path_Segments` with `{var}` braces stripped. */
export function synthesizeOperationId(method: string, path: string): string {
  const clean = String(method).toLowerCase() === "delete" ? "Delete" : capToken(String(method).toLowerCase());
  const segments = String(path)
    .split("/")
    .map((part) => part.replace(/^\{|\}$/g, "").trim())
    .map((part) => part.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, ""))
    .filter((part) => part.length > 0)
    .map((part) => (/^[0-9]/.test(part) ? `_${part}` : part));
  const base = segments.length === 0 ? "root" : segments.map(capToken).join("_");
  return `${clean}_${base}`.slice(0, 128);
}

function titleCaseItem(name: string): string {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map(capToken)
    .join("_")
    .slice(0, 120);
}

/** Derive the operationId for one collection item: the item name when it
 * is already a stable identifier, otherwise METHOD + path synthesis. */
export function operationIdForItem(name: string, method: string, path: string): string {
  const candidate = titleCaseItem(String(name ?? ""));
  if (candidate.length > 0 && OPERATION_ID.test(candidate)) return candidate;
  return synthesizeOperationId(method, path);
}

function asPathString(rawUrl: unknown): string | null {
  // Percent-encoded braces (%7B/%7D) decode first: `new URL(...).pathname`
  // keeps them encoded, and an encoded brace would otherwise slip past the
  // contract validator's leading-slash check as a non-template literal.
  const decodeBraces = (part: string): string => part.replace(/%7[bB]/g, "{").replace(/%7[dD]/g, "}");
  if (typeof rawUrl === "string") {
    const text = rawUrl.trim();
    if (text.length === 0) return null;
    try {
      const parsed = new URL(text);
      if (!parsed.pathname || !parsed.pathname.startsWith("/")) return null;
      const decoded = decodeBraces(parsed.pathname).split("?")[0];
      return decoded === undefined ? null : decoded;
    } catch {
      if (!text.startsWith("/")) return null;
      const decoded = decodeBraces(text).split("?")[0];
      return decoded === undefined ? null : decoded;
    }
  }
  if (rawUrl !== null && typeof rawUrl === "object" && !Array.isArray(rawUrl)) {
    const parts = (rawUrl as { path?: unknown }).path;
    if (Array.isArray(parts)) {
      const joined = `/${parts.map((part) => decodeBraces(String(part))).join("/")}`;
      if (!joined.startsWith("/")) return null;
      const head = joined.split("?")[0];
      return head === undefined ? null : head;
    }
  }
  return null;
}

function normalizePath(path: string): string {
  // `:var` (Postman) and `{{var}}` (environment) both become `{var}`.
  return path
    .replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, "{$1}")
    .replace(/(^|\/):([A-Za-z0-9_.-]+)(?=\/|$)/g, "$1{$2}");
}

export interface ConvertedOperation {
  readonly method: string;
  readonly path: string;
  readonly name: string;
}

export interface PostmanConvertResult {
  readonly doc: {
    readonly openapi: string;
    readonly info: { readonly title: string; readonly version: string };
    readonly paths: Record<string, Record<string, { readonly operationId: string; readonly summary: string }>>;
  };
  readonly converterVersion: string;
  readonly synthesized: number;
  readonly dropped: number;
}

/** Convert a Postman Collection v2.1 document to a minimal OpenAPI 3.x
 * document the Code Mode validator accepts. Folder nesting flattens in
 * document order; duplicate operationIds (after synthesis) fail closed;
 * items without a method or path are dropped and counted, never guessed. */
export function convertPostmanCollection(collection: unknown): PostmanConvertResult {
  if (collection === null || typeof collection !== "object" || Array.isArray(collection)) {
    throw new Error("The Postman collection must be a JSON object.");
  }
  const root = collection as Record<string, unknown>;
  const info = root["info"];
  const infoName =
    info !== null && typeof info === "object" && typeof (info as Record<string, unknown>)["name"] === "string"
      ? ((info as Record<string, unknown>)["name"] as string)
      : "postman-import";
  const items = root["item"];
  if (!Array.isArray(items)) throw new Error("The Postman collection needs an item array (v2.1).");

  const paths: Record<string, Record<string, { operationId: string; summary: string }>> = {};
  const seen = new Set<string>();
  let synthesized = 0;
  let dropped = 0;

  const visit = (entries: unknown[]): void => {
    for (const entry of entries) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        dropped += 1;
        continue;
      }
      const node = entry as Record<string, unknown>;
      const nested = node["item"];
      if (Array.isArray(nested)) {
        visit(nested as unknown[]);
        continue;
      }
      const request = node["request"];
      const name = typeof node["name"] === "string" ? node["name"] : "";
      let method = "";
      let rawUrl: unknown = null;
      if (typeof request === "string") {
        // Postman v2.1: a string request is a URL with an implicit GET.
        method = "GET";
        rawUrl = request;
      } else if (request !== null && typeof request === "object" && !Array.isArray(request)) {
        const req = request as Record<string, unknown>;
        method = typeof req["method"] === "string" ? (req["method"] as string) : "";
        rawUrl = req["url"] ?? null;
      }
      const pathRaw = asPathString(rawUrl);
      if (method.trim().length === 0 || pathRaw === null) {
        dropped += 1;
        continue;
      }
      const path = normalizePath(pathRaw);
      if (!path.startsWith("/")) {
        dropped += 1;
        continue;
      }
      const lower = method.toLowerCase();
      const named = titleCaseItem(name);
      const namedUsable = named.length > 0 && OPERATION_ID.test(named);
      const operationId = namedUsable ? named : synthesizeOperationId(method, path);
      if (!namedUsable) synthesized += 1;
      if (!OPERATION_ID.test(operationId) || seen.has(operationId)) {
        throw new Error(
          seen.has(operationId)
            ? `Duplicate operationId ${JSON.stringify(operationId)}.`
            : `Contract operation ${method.toUpperCase()} ${path} needs a stable operationId.`,
        );
      }
      seen.add(operationId);
      const summary = name.length > 0 ? name.slice(0, 280) : `${method.toUpperCase()} ${path}`;
      const slot = paths[path] ?? {};
      // Two operationIds sharing one method+path slot would silently
      // overwrite: fail closed instead of dropping the first operation.
      if (Object.hasOwn(slot, lower)) {
        throw new Error(`Duplicate operation ${method.toUpperCase()} ${path}.`);
      }
      slot[lower] = { operationId, summary };
      paths[path] = slot;
    }
  };
  visit(items);
  const count = seen.size;
  if (count === 0) throw new Error("The Postman collection declares no operations.");
  return {
    doc: {
      openapi: "3.0.3",
      info: { title: infoName.slice(0, 120), version: "postman-v2.1" },
      paths,
    },
    converterVersion: CONVERTER_VERSION,
    synthesized,
    dropped,
  };
}

export const POSTMAN_CONVERTER_VERSION = CONVERTER_VERSION;
