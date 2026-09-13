// SPDX-License-Identifier: AGPL-3.0
// Execution-scoped secret registry + universal substring scrubbing (ADR 005
// gating deliverable, issue #145; decision gate stays #110).
//
// A secret value materialized during an Execution (deployment credential at
// the Integration/Action boundary, fetched OAuth token) is registered for
// that Execution only. Every persisted or outward value is then scrubbed by
// raw substring — never exact-match only — so secrets embedded in URLs,
// headers, or vendor error bodies cannot ride D1, Workflow results, logs,
// exceptions, HTTP responses, or usage/telemetry out.
//
// Explicit limits (not a sandbox for arbitrary untrusted source):
// - Short secrets (< MIN_SCRUB_SECRET_LENGTH) are NOT substring-scrubbed: a
//   2-char secret would redact the whole database. They stay protected by
//   shaping (never persisted, fixed error envelopes), not by replacement.
// - Encoding: raw UTF-8 substrings only. Base64, URL-encoded, or otherwise
//   transformed copies are not decoded and are out of scope.
// - Cycles: the deep scrubber preserves object identity through a WeakMap so
//   it never hangs; redaction is defense-in-depth, not a claim that arbitrary
//   untrusted graphs are safe to persist.
// - Isolates: the registry is in-memory per isolate. Workflow write-time
//   scrub (where the token is known) carries token protection into D1; the
//   Worker HTTP layer scrubs with deployment secrets only. Tokens never
//   persist by construction, so HTTP responses built from scrubbed D1 rows
//   are clean without the HTTP isolate ever seeing the token.
//
// Tenancy: the registry is keyed by Execution ID and cleared when the
// Execution settles. Scrubbing for one Execution never sees another
// Execution's secrets. Provider-global v0 (ADR 005) is unchanged: deployment
// credentials plus org-scoped non-secret Connections; the per-tenant-secret
// envelope stays tripwire-gated and is not built here.
export const SCRUB_PLACEHOLDER = "[REDACTED]";
export const MIN_SCRUB_SECRET_LENGTH = 8;

type SecretEnv = {
  readonly NINJA_CLIENT_ID?: string;
  readonly NINJA_CLIENT_SECRET?: string;
  readonly HALO_CLIENT_ID?: string;
  readonly HALO_CLIENT_SECRET?: string;
};

/** Normalize candidate secrets: keep strings at or above the floor, dedupe,
 * longest-first so nested values scrub outermost first. */
export function normalizeSecretList(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    if (value.length < MIN_SCRUB_SECRET_LENGTH) continue;
    seen.add(value);
  }
  return [...seen].sort((a, b) => b.length - a.length);
}

/** Replace every registered substring in one string. Pure; no registry. */
export function scrubTextWithSecrets(text: string, secrets: readonly unknown[]): string {
  const list = normalizeSecretList(secrets);
  let out = text;
  for (const secret of list) {
    if (out.includes(secret)) out = out.split(secret).join(SCRUB_PLACEHOLDER);
  }
  return out;
}

/** Deep-clone a JSON-like value with every string (values and object keys)
 * scrubbed by substring. Cycles round-trip through an identity map instead
 * of hanging; class instances pass through untouched (never JSON-persisted
 * anyway). Pure; no registry. */
export function scrubValueWithSecrets<T>(value: T, secrets: readonly unknown[]): T {
  const list = normalizeSecretList(secrets);
  if (list.length === 0) return value;
  const seen = new WeakMap<object, unknown>();
  const visit = (node: unknown): unknown => {
    if (typeof node === "string") return scrubTextWithSecrets(node, list);
    if (Array.isArray(node)) {
      const cached = seen.get(node);
      if (cached !== undefined) return cached;
      const out: unknown[] = [];
      seen.set(node, out);
      for (const entry of node) out.push(visit(entry));
      return out;
    }
    if (node !== null && typeof node === "object") {
      const proto: unknown = Object.getPrototypeOf(node);
      if (proto !== Object.prototype && proto !== null) return node;
      const cached = seen.get(node);
      if (cached !== undefined) return cached;
      const out: Record<string, unknown> = {};
      seen.set(node, out);
      for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
        out[scrubTextWithSecrets(key, list)] = visit(entry);
      }
      return out;
    }
    return node;
  };
  return visit(value) as T;
}

// --- Execution-scoped registry ------------------------------------------------
// Module-level Map keyed by Execution ID. The Workflow adapter registers
// deployment secrets at start and Integration Actions register fetched
// tokens; the adapter clears the entry when the Execution settles so one
// Execution's secrets never leak into another in a reused isolate.
const registry = new Map<string, string[]>();

export function registerExecutionSecrets(executionId: string, values: readonly unknown[]): void {
  const incoming = normalizeSecretList(values);
  if (incoming.length === 0) return;
  registry.set(executionId, normalizeSecretList([...(registry.get(executionId) ?? []), ...incoming]));
}

export function getExecutionSecrets(executionId: string): readonly string[] {
  return registry.get(executionId) ?? [];
}

export function clearExecutionSecrets(executionId: string): void {
  registry.delete(executionId);
}

/** Test hook: drop every registration (suite isolation). Never called in prod. */
export function clearAllExecutionSecrets(): void {
  registry.clear();
}

/** Scrub one string with this Execution's registered secrets. */
export function scrubExecutionText(executionId: string, text: string): string {
  return scrubTextWithSecrets(text, getExecutionSecrets(executionId));
}

/** Deep-scrub one value with this Execution's registered secrets. */
export function scrubExecutionValue<T>(value: T, executionId: string): T {
  return scrubValueWithSecrets(value, getExecutionSecrets(executionId));
}

/** Scrub a structured {code, message} error with this Execution's secrets. */
export function scrubExecutionError<T extends { readonly code: string; readonly message: string }>(
  error: T,
  executionId: string,
): T {
  const secrets = getExecutionSecrets(executionId);
  return {
    ...error,
    code: scrubTextWithSecrets(error.code, secrets),
    message: scrubTextWithSecrets(error.message, secrets),
  };
}

// --- Deployment-secret helpers (Worker HTTP layer) ---------------------------
// The Worker fetch isolate never sees Workflow-registered tokens, so HTTP
// responses and error envelopes scrub with the deployment credentials from
// env. Token substrings are already gone from D1 by write-time scrubbing.
export function deploymentSecretsFromEnv(env: SecretEnv): string[] {
  return normalizeSecretList([
    env.NINJA_CLIENT_ID,
    env.NINJA_CLIENT_SECRET,
    env.HALO_CLIENT_ID,
    env.HALO_CLIENT_SECRET,
  ]);
}

export function scrubTextWithDeploymentSecrets(text: string, env: SecretEnv): string {
  return scrubTextWithSecrets(text, deploymentSecretsFromEnv(env));
}

export function scrubValueWithDeploymentSecrets<T>(value: T, env: SecretEnv): T {
  return scrubValueWithSecrets(value, deploymentSecretsFromEnv(env));
}
