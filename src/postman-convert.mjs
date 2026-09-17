// SPDX-License-Identifier: AGPL-3.0
// INT-01 (issue #229): plain-Node mirror of src/postman.ts for the CLI
// (scripts/wrangnarok.mjs), which cannot import TypeScript source.
// Keep the algorithm identical: test/postman-parity.test.ts proves the
// same collection converts to the same document through both modules.
const CONVERTER_VERSION = "postman-v2.1-1";

const OPERATION_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;

function capToken(token) {
  if (token.length === 0) return token;
  return token[0].toUpperCase() + token.slice(1);
}

export function synthesizeOperationId(method, path) {
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

function titleCaseItem(name) {
  return String(name ?? "")
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map(capToken)
    .join("_")
    .slice(0, 120);
}

export function operationIdForItem(name, method, path) {
  const candidate = titleCaseItem(name);
  if (candidate.length > 0 && OPERATION_ID.test(candidate)) return candidate;
  return synthesizeOperationId(method, path);
}

function asPathString(rawUrl) {
  // Percent-encoded braces (%7B/%7D) decode first: `new URL(...).pathname`
  // keeps them encoded, and an encoded brace would otherwise slip past the
  // contract validator's leading-slash check as a non-template literal.
  const decodeBraces = (part) =>
    String(part)
      .replace(/%7[bB]/g, "{")
      .replace(/%7[dD]/g, "}");
  if (typeof rawUrl === "string") {
    const text = rawUrl.trim();
    if (text.length === 0) return null;
    try {
      const parsed = new globalThis.URL(text);
      if (!parsed.pathname || !parsed.pathname.startsWith("/")) return null;
      return decodeBraces(parsed.pathname).split("?")[0];
    } catch {
      return text.startsWith("/") ? decodeBraces(text).split("?")[0] : null;
    }
  }
  if (rawUrl !== null && typeof rawUrl === "object" && !Array.isArray(rawUrl)) {
    const parts = rawUrl.path;
    if (Array.isArray(parts)) {
      const joined = `/${parts.map((part) => decodeBraces(part)).join("/")}`;
      return joined.startsWith("/") ? joined.split("?")[0] : null;
    }
  }
  return null;
}

function normalizePath(path) {
  return path
    .replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, "{$1}")
    .replace(/(^|\/):([A-Za-z0-9_.-]+)(?=\/|$)/g, "$1{$2}");
}

export function convertPostmanCollection(collection) {
  if (collection === null || typeof collection !== "object" || Array.isArray(collection)) {
    throw new Error("The Postman collection must be a JSON object.");
  }
  const info = collection.info;
  const infoName =
    info !== null && typeof info === "object" && typeof info.name === "string" ? info.name : "postman-import";
  const items = collection.item;
  if (!Array.isArray(items)) throw new Error("The Postman collection needs an item array (v2.1).");

  const paths = {};
  const seen = new Set();
  let synthesized = 0;
  let dropped = 0;

  const visit = (entries) => {
    for (const entry of entries) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        dropped += 1;
        continue;
      }
      const nested = entry.item;
      if (Array.isArray(nested)) {
        visit(nested);
        continue;
      }
      const request = entry.request;
      const name = typeof entry.name === "string" ? entry.name : "";
      let method = "";
      let rawUrl = null;
      if (typeof request === "string") {
        // Postman v2.1: a string request is a URL with an implicit GET.
        method = "GET";
        rawUrl = request;
      } else if (request !== null && typeof request === "object" && !Array.isArray(request)) {
        method = typeof request.method === "string" ? request.method : "";
        rawUrl = request.url ?? null;
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
  if (seen.size === 0) throw new Error("The Postman collection declares no operations.");
  return {
    doc: {
      openapi: "3.0.3",
      info: { title: infoName.slice(0, 120), version: "postman-v2.1" },
      paths,
      components: {
        securitySchemes: {
          PostmanApiToken: { type: "http", scheme: "bearer", bearerFormat: "token" },
        },
      },
      security: [{ PostmanApiToken: [] }],
    },
    converterVersion: CONVERTER_VERSION,
    synthesized,
    dropped,
  };
}

export const POSTMAN_CONVERTER_VERSION = CONVERTER_VERSION;
