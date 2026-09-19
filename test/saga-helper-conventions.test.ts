// SPDX-License-Identifier: AGPL-3.0
// Issue #415 (ADR-033-4): Action-vocabulary guardrails + provider-leg
// convention lock. Slice A landed the guardrails; Slice B migrates every
// Integration leg to integrationOperation, so run sources carry no required
// list and no required/optional branch. Runs in real workerd via
// @cloudflare/vitest-plugin like the contract gates; assertions read live
// module exports and Function source, never the filesystem.
import { describe, expect, it } from "vitest";
import * as sagaHelpers from "../src/saga-helpers";
import { SAGA_DEFINITIONS } from "../src/sagas";

/** Declared parameter names of a helper function, read from its own source.
 * Bracket- and quote-aware so generic/union/function-typed parameters with
 * interior commas do not split into phantom names. (Same reader as the
 * issue-#57 contract gate: the two gates must agree on what a signature is.) */
function helperParameterNames(fn: (...args: never[]) => unknown): string[] {
  const source = Function.prototype.toString.call(fn);
  const open = source.indexOf("(");
  let depth = 0;
  let end = -1;
  let quote: string | null = null;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index] as string;
    if (quote !== null) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{" || char === "<") depth += 1;
    else if (char === ")" || char === "]" || char === "}" || char === ">") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (open === -1 || end === -1) throw new Error(`Cannot read parameter list of ${fn.name}.`);
  const names: string[] = [];
  let segment = "";
  let nested = 0;
  let segmentQuote: string | null = null;
  const flush = (): void => {
    const name = segment.split("=")[0]?.split(":")[0]?.trim();
    if (name) names.push(name);
    segment = "";
  };
  for (let index = open + 1; index < end; index += 1) {
    const char = source[index] as string;
    if (segmentQuote !== null) {
      segment += char;
      if (char === "\\") {
        segment += source[index + 1] ?? "";
        index += 1;
        continue;
      }
      if (segmentQuote === char) segmentQuote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      segmentQuote = char;
      segment += char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{" || char === "<") nested += 1;
    else if (char === ")" || char === "]" || char === "}" || char === ">") nested -= 1;
    if (char === "," && nested === 0) flush();
    else segment += char;
  }
  flush();
  return names;
}

/** Runtime-policy knob tokens that must never appear in a saga-helper
 * signature (issue #415 decision). Mirrors OPERATIONAL_POLICY_KEYS in
 * src/saga.ts, which validateSagaDefinition rejects in Saga source; the
 * helper-signature review rule extends the same boundary to the interior
 * helpers. Matching is case-insensitive substring: `timeoutMs`, `retries`,
 * and `maxBackoff` all smell like policy. */
const POLICY_KNOBS = [
  "timeout",
  "timeouts",
  "retry",
  "retries",
  "schedule",
  "schedules",
  "cron",
  "endpoint",
  "endpoints",
  "access",
  "ratelimit",
  "cache",
  "ttl",
  "concurrency",
  "backoff",
] as const;

function findPolicyKnobs(names: readonly string[]): string[] {
  return names.filter((name) => POLICY_KNOBS.some((knob) => name.toLowerCase().includes(knob)));
}

/** Names destructured from the `options` bag (`const { a, b } = options`),
 * plus direct `options.<name>` member reads: together with the top-level
 * parameter list they are the helper's full caller-visible surface, so a
 * policy knob smuggled in as an options field fails the same gate. */
function optionsSurfaceNames(source: string): string[] {
  const names: string[] = [];
  const destructured = source.match(/const\s*\{([^}]*)\}\s*=\s*options\b/);
  if (destructured?.[1]) {
    for (const segment of destructured[1].split(",")) {
      const name = segment.split(":")[0]?.split("=")[0]?.trim();
      if (name) names.push(name);
    }
  }
  for (const match of source.matchAll(/options\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
    if (match[1]) names.push(match[1]);
  }
  return names;
}

/** Vendor tokens that must never freeze into a helper name (RFC principle 4:
 * Integration Action — not vendor HTTP — is the author-facing abstraction).
 * Helpers are named `integrationOperation(...)`, never `doVendor`-style. */
const VENDOR_TOKENS = [
  "echo",
  "ninja",
  "halo",
  "meraki",
  "graph",
  "microsoft",
  "cloudflare",
  "vendor",
  "http",
  "fetch",
  "rest",
  "grpc",
  "mcp",
] as const;

function findVendorTokens(name: string): string[] {
  const lower = name.toLowerCase();
  return VENDOR_TOKENS.filter((token) => lower.includes(token));
}

/** Top-level argument strings of every `callee(...)` call in source.
 * Quote-aware; assumes no block comments inside the call spans (true of the
 * resolveConnection-family call sites pinned below). Accepts both the direct
 * `callee(args)` shape and the vite SSR rewrite of imported calls,
 * `(0,__vite_ssr_import_N__.callee)(args)`. */
function callArgumentLists(source: string, callee: string): string[][] {
  const lists: string[][] = [];
  const isIdentChar = (char: string | undefined): boolean => char !== undefined && /[\w$]/.test(char);
  const isWhitespace = (char: string | undefined): boolean => char === " " || char === "\t" || char === "\n";
  let from = 0;
  while (from < source.length) {
    const start = source.indexOf(callee, from);
    if (start === -1) return lists;
    // Skip longer identifiers that merely contain the callee name.
    if (isIdentChar(source[start - 1]) || isIdentChar(source[start + callee.length])) {
      from = start + callee.length;
      continue;
    }
    let cursor = start + callee.length;
    while (isWhitespace(source[cursor])) cursor += 1;
    // SSR-wrapped member call: `...callee)(args)`.
    if (source[cursor] === ")") {
      cursor += 1;
      while (isWhitespace(source[cursor])) cursor += 1;
    }
    if (source[cursor] !== "(") {
      // A bare mention, not a call (the site-count anchor below guards
      // against the matcher going blind instead of failing loudly).
      from = cursor + 1;
      continue;
    }
    let depth = 0;
    let end = -1;
    let quote: string | null = null;
    for (let index = cursor; index < source.length; index += 1) {
      const char = source[index] as string;
      if (quote !== null) {
        if (char === "\\") {
          index += 1;
          continue;
        }
        if (char === quote) quote = null;
        continue;
      } else if (char === "'" || char === '"' || char === "`") {
        quote = char;
      } else if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end === -1) throw new Error(`Cannot read ${callee}() call arguments.`);
    const args: string[] = [];
    let segment = "";
    let nested = 0;
    let segmentQuote: string | null = null;
    for (let index = cursor + 1; index < end; index += 1) {
      const char = source[index] as string;
      if (segmentQuote !== null) {
        segment += char;
        if (char === "\\") {
          segment += source[index + 1] ?? "";
          index += 1;
          continue;
        }
        if (char === segmentQuote) segmentQuote = null;
        continue;
      }
      if (char === "'" || char === '"' || char === "`") {
        segmentQuote = char;
        segment += char;
        continue;
      }
      if (char === "(" || char === "[" || char === "{") nested += 1;
      else if (char === ")" || char === "]" || char === "}") nested -= 1;
      if (char === "," && nested === 0) {
        args.push(segment.trim());
        segment = "";
      } else {
        segment += char;
      }
    }
    if (segment.trim()) args.push(segment.trim());
    lists.push(args);
    from = end + 1;
  }
  return lists;
}

describe("Saga helper conventions (issue #415 Slice A)", () => {
  it("rejects policy-knob parameters on every saga-helpers export signature", () => {
    const checked: string[] = [];
    for (const [name, value] of Object.entries(sagaHelpers)) {
      if (typeof value !== "function") continue;
      checked.push(name);
      const fn = value as (...args: never[]) => unknown;
      const surface = [...helperParameterNames(fn), ...optionsSurfaceNames(Function.prototype.toString.call(fn))];
      expect(findPolicyKnobs(surface), `${name} signature must not smell like runtime policy`).toEqual([]);
    }
    // Anchor against vacuous passes: the known helpers are covered.
    expect(checked).toContain("prepareInput");
    expect(checked).toContain("integrationOperation");
  });

  it("flags a scratch policy-knob parameter (checker is not vacuous)", () => {
    async function scratchTimeout(_ctx: unknown, timeoutMs?: number): Promise<number> {
      return timeoutMs ?? 0;
    }
    expect(findPolicyKnobs(helperParameterNames(scratchTimeout))).toEqual(["timeoutMs"]);
    async function scratchSchedule(_ctx: unknown, scheduleCron?: string): Promise<string> {
      return scheduleCron ?? "";
    }
    expect(findPolicyKnobs(helperParameterNames(scratchSchedule))).toEqual(["scheduleCron"]);
    async function scratchConcurrency(_ctx: unknown, maxConcurrency?: number): Promise<number> {
      return maxConcurrency ?? 0;
    }
    expect(findPolicyKnobs(helperParameterNames(scratchConcurrency))).toEqual(["maxConcurrency"]);
    const scratchDestructure = "const { op, retryLimit } = options;";
    expect(findPolicyKnobs(optionsSurfaceNames(scratchDestructure))).toEqual(["retryLimit"]);
    expect(findPolicyKnobs(optionsSurfaceNames("await sleep(options.backoffMs);"))).toEqual(["backoffMs"]);
    // The live surface this gate pins today (guard against reader drift).
    expect(helperParameterNames(sagaHelpers.prepareInput)).toEqual(["ctx", "saga", "parse"]);
    expect(helperParameterNames(sagaHelpers.integrationOperation)).toEqual(["ctx", "def", "prepared", "options"]);
  });

  it("pins vendor-neutral helper names (lexicon: no vendor-frozen names)", () => {
    for (const name of Object.keys(sagaHelpers)) {
      expect(findVendorTokens(name), `helper export ${name} must not freeze a vendor or transport`).toEqual([]);
    }
    // Bodies stay vendor-neutral too: no doVendor/op.vendor shape, and no
    // direct ctx.integrations.<vendor> reach — the Action arrives as `call`.
    const FROZEN_SHAPES = [/\bdoVendor\b/, /\bop\s*\.\s*vendor\b/, /\bintegrations\s*\./];
    for (const fn of [sagaHelpers.prepareInput, sagaHelpers.integrationOperation]) {
      const source = Function.prototype.toString.call(fn);
      for (const shape of FROZEN_SHAPES) {
        expect(source, `${fn.name} must not freeze a vendor shape`).not.toMatch(shape);
      }
    }
    // Negative controls: the checker flags what the convention forbids.
    expect(findVendorTokens("doVendor")).toEqual(["vendor"]);
    expect(findVendorTokens("ninjaOperation")).toEqual(["ninja"]);
    expect("ctx.integrations.echo.echo(connection)").toMatch(/\bintegrations\s*\./);
  });

  it("pins canonical-def requirement derivation in integrationOperation", () => {
    // Call sites pass no `required` list: required-vs-optional derives from
    // the Saga definition plus the integration ID, inside the helper.
    expect(helperParameterNames(sagaHelpers.integrationOperation)).not.toContain("required");
    const source = Function.prototype.toString.call(sagaHelpers.integrationOperation);
    expect(source).toMatch(/def\.requiredIntegrations/);
  });

  it("pins canonical-def-only required threading at every resolveConnection-family call site", () => {
    // resolveConnection(db, orgCtx, integrationId, requiredList) takes the
    // list fourth. Every site must pass a canonical-def member
    // (X.requiredIntegrations) — never an inline list. Scans every
    // registered run plus the helper interior. The retired cloudflare
    // resolveCloudflareVendor(db, orgCtx, required, account) shape stays in
    // the callee list so a reintroduction fails loudly instead of slipping
    // past the gate.
    const SITES: Array<{ callee: string; requiredIndex: number }> = [
      { callee: "resolveConnection", requiredIndex: 3 },
      { callee: "resolveCloudflareVendor", requiredIndex: 2 },
    ];
    const bodies = new Map<string, string>();
    for (const def of SAGA_DEFINITIONS) {
      bodies.set(`run:${def.name}`, Function.prototype.toString.call(def.run));
    }
    bodies.set("helper:integrationOperation", Function.prototype.toString.call(sagaHelpers.integrationOperation));
    let siteCount = 0;
    for (const [body, source] of bodies) {
      for (const { callee, requiredIndex } of SITES) {
        for (const args of callArgumentLists(source, callee)) {
          siteCount += 1;
          const requiredArg = args[requiredIndex]?.trim() ?? "";
          expect(
            requiredArg,
            `${body} ${callee}() must pass the canonical X.requiredIntegrations (no per-call list)`,
          ).toMatch(/\.requiredIntegrations$/);
        }
      }
    }
    // Anchor: every Integration leg migrated to integrationOperation in
    // Slice B (#415), so no run source calls resolveConnection directly —
    // the helper interior is the one remaining site.
    expect(siteCount).toBe(1);
    // Negative controls, including the retired private-helper passthrough
    // shape from src/sagas/cloudflare.ts resolveCloudflareVendor (bare
    // `required` identifier): both must fail the member-access rule, which
    // is why that helper retired in #415 instead of surviving the migration.
    expect(callArgumentLists("await resolveConnection(db, orgCtx, id, []);", "resolveConnection")[0]?.[3]).not.toMatch(
      /\.requiredIntegrations$/,
    );
    expect(
      callArgumentLists("await resolveConnection(db, orgCtx, X, required);", "resolveConnection")[0]?.[3],
    ).not.toMatch(/\.requiredIntegrations$/);
    // The SSR-wrapped rewrite rejects the same way (proves the wrapped-call
    // matcher above is not a silent pass-through).
    expect(
      callArgumentLists(
        "await (0,__vite_ssr_import_7__.resolveConnection)(db, orgCtx, id, []);",
        "resolveConnection",
      )[0]?.[3],
    ).not.toMatch(/\.requiredIntegrations$/);
  });

  it("pins no per-call required list at integrationOperation call sites", () => {
    // Anchor: echo 1, ninjaone-orgs 1, ninjaone-org-lookup 1, digest 2,
    // cloudflare-verify 1, cloudflare-inventory 1 — every Integration leg
    // goes through integrationOperation with one Action convention
    // (Slice B, #415).
    let legCount = 0;
    for (const def of SAGA_DEFINITIONS) {
      const source = Function.prototype.toString.call(def.run);
      for (const args of callArgumentLists(source, "integrationOperation")) {
        legCount += 1;
        for (const arg of args) {
          expect(arg, `${def.name} integrationOperation() must pass no per-call required list`).not.toMatch(
            /(^|[,{]\s*)required\s*:/,
          );
        }
      }
    }
    expect(legCount).toBe(7);
    // Positive control: the canonical-def exemplar passes the checker.
    const exemplar = "integrationOperation(ctx, echoSagaDef, prepared, { op, position: 1 })";
    for (const args of callArgumentLists(exemplar, "integrationOperation")) {
      for (const arg of args) expect(arg).not.toMatch(/(^|[,{]\s*)required\s*:/);
    }
    // Negative control: a per-call required list fails it.
    const offender = "integrationOperation(ctx, def, prepared, { op, required: def.requiredIntegrations })";
    const offenderArgs = callArgumentLists(offender, "integrationOperation")[0] ?? [];
    expect(offenderArgs.some((arg) => /(^|[,{]\s*)required\s*:/.test(arg))).toBe(true);
  });
});
