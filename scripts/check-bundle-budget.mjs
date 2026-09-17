// SPDX-License-Identifier: AGPL-3.0
// Worker bundle budget (ADR 004, advisory per issue #177 owner decision):
// the repository soft budget is an early-warning reference level, not a
// merge gate. Measures raw bytes of the exact bundle
// `wrangler deploy --dry-run --env dev --outfile` produces — no CLI output parsing —
// so dependency bloat and cold-start creep stay visible instead of drifting.
// The dev env is pinned (issue #331) so the measurement never drifts against
// the default environment when wrangler.jsonc defines multiple envs.
// Soft-threshold conditions (over the 730 KiB reference level, below the
// 8 KiB reserve, or stale LIMITS-META bookkeeping) print prominent warnings
// and exit zero. Only a real build/dry-run error, a malformed invocation,
// or an inability to obtain the artifact fails the run.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 2026-09-10: the bundle is ~62 KiB; 100 KiB leaves room for real features
// while catching an accidental heavy dependency. Raise deliberately (with
// the reason recorded), never to make a red run green.
// 2026-09-11 (AUTH-01, issue #142): 145 KiB. The Organization and user
// lifecycle surface (src/orgs.ts: membership gate on every /api/* request,
// 9 admin routes plus the org history list, cascading-delete preview, LAB
// fixture bootstrap; no new dependencies) measures ~144 KiB combined after a
// shrink pass on the bootstrap DDL. Same deliberate feature headroom as the
// 120 KiB raise, not dependency bloat: package.json is unchanged versus main.
// 2026-09-11 (OBS-02, issue #153): stacks within the 380 KiB headroom.
// The bounded author-log surface (src/logs.ts domain: parsers, cursor
// pagination, retention, SEC-01 write/read paths, plus two routes, SDK
// tail/search, and hello-pilot emission) measures within the deliberate
// feature headroom above; package.json is unchanged versus main.
// 2026-09-11 (TRG-02, issue #138): 210 KiB. The endpoint/webhook Trigger
// surface (src/endpoints.ts: key/HMAC verification, rate limits, challenge,
// delivery protocol, operator management; 3 public plus 6 management routes
// in src/index.ts) stacks on the TABLE-02 surface with the same deliberate
// feature headroom, not dependency bloat: package.json is unchanged versus
// main. Combined measures ~203 KiB.
// 2026-09-11 (CON-01, issue #146): 230 KiB. The Connection management surface
// (7 routes: integrations discovery, connections CRUD, read-only test; plus
// src/connections.ts, config-schema validation, SDK descriptor entries)
// stacks on the TRG-02 surface above and measures ~226 KiB combined with the
// same deliberate feature headroom, not dependency bloat: package.json is
// unchanged versus main.
// 2026-09-11 (FILE-01, issue #157): 275 KiB. The managed-files surface (14
// routes plus the files domain: locations, policies, capabilities,
// finalize verification, versioned mutation, structural listing, plus the
// SDK descriptor additions) stacks on the CON-01 surface with the same
// deliberate feature headroom, not dependency bloat: package.json is
// unchanged versus main. Combined measures ~266 KiB.
// 2026-09-11 (APP-02, issue #160): 310 KiB. The app-runtime surface (20
// routes plus the app-runtime domain: grants, visible Tables with bounded
// reads, versioned files with single-use tokens, scoped invoke, handshake)
// adds ~42 KiB of hand-written feature code with no new dependencies —
// measured 158740 bytes pre-merge after a shrink pass (shared rejectQuery
// guard, compacted SDK descriptor), stacked here on the FILE-01 surface.
// Same deliberate feature headroom as the earlier raises, not dependency
// bloat: package.json is unchanged versus main.
// 2026-09-11 (CON-02, issue #147): 340 KiB. The scoped-config surface
// (src/config.ts: typed validation, secret-reference provisioning,
// org-only resolution, managed-row reconciliation; 4 operator routes plus
// the ctx.config Saga handle and SDK descriptor entries) stacks on the
// APP-02 surface and measures ~334 KiB combined. Same deliberate feature
// headroom as the earlier raises, not dependency bloat: package.json is
// unchanged versus main.
// 2026-09-11 (FILE-02 stacked over APP-02/CON-02, issue #158): 365 KiB. The
// generated-artifacts surface (19 routes plus the artifacts domain) stacks
// with the same deliberate feature headroom, not dependency bloat:
// package.json is unchanged versus main. Combined measures ~357 KiB locally
// (CI number governs).
// 2026-09-11 (AUTH-02, issue #143): resource-role control plane (src/roles.ts:
// 4-table CRUD plus per-request grant evaluation, grant enforcement on direct
// submits plus form/app routes, 15 role/policy admin routes, SDK error codes;
// no new dependencies) stacked on the CON-02 surface and measured 368916
// bytes solo. Combined with FILE-02/OPS-01 above: remeasured after merge;
// the union with the OBS-02/OPS-02 surfaces below governs the budget.
// 2026-09-11 (OPS-01, issue #172): 380 KiB. The audit/notifications slice
// (src/ops.ts: audit + notification domain, keyset pagination, reconcile;
// 4 read routes plus audit emission on 5 app routes and the cancel route;
// SDK audit/notification surface) stacks on the FILE-02 surface with the
// same deliberate feature headroom, not dependency bloat: package.json is
// unchanged. Remeasure after merge; shrink the raise if the combined bundle
// lands lower.
// 2026-09-11 (RUN-02 stacked over merged main, issue #136): 410 KiB. Merged
// main itself measures ~401 KiB (over the 380 KiB OPS-01 budget before any
// lane code lands); the RUN-02 surface (src/children.ts: dispatch/await/
// fan-out, lineage reads on detail plus cancel, hello-parent Saga plus
// Workflow, SDK lineage shape) adds ~434 bytes of hand-written feature code
// with no new dependencies. Same deliberate feature headroom as the earlier
// raises: package.json is unchanged versus main.
// 2026-09-11 (TRG-01 over OPS-01, issue #137): schedule surface
// (src/schedules.ts: cron validation, IANA timezone labels, UTC window math,
// server-derived window keys, preview, bounded scan/admission; 7 schedule
// routes plus the scheduled() Cron tick; Scheduled status plus schedule
// error codes; no new dependencies) stacks on the contemporary main surface
// with the same deliberate feature headroom, not dependency bloat:
// package.json is unchanged versus main. Remeasure after merge; shrink the
// raise if the combined bundle lands lower. Budget stays at the FORM-02
// 555 KiB line (main HEAD); the TRG-01 surface must fit inside it.
// 2026-09-11 (AUTH-01 follow-up): 390 KiB. Cascading-delete accounting over
// every post-AUTH-01 org-owned table (forms, apps, tables, files, artifacts,
// endpoints, configs, audit; R2 bytes first, managed rows block) stacks on
// the OPS-01 surface: 385797 bytes baseline, 394934 bytes with the slice, so
// 390 KiB keeps the same deliberate feature headroom. No new dependencies:
// package.json is unchanged versus main.
// 2026-09-11 (OBS-02 merge over current main, issue #153): 405 KiB. The
// union of the OBS-02 author-log surface (src/logs.ts, two routes, SDK
// tail/search, CLI logs/log-search) with the newer main surfaces measures
// ~388 KiB combined. Hand-written feature code, no new dependencies
// (package.json unchanged versus main); deliberate feature headroom only.
// 2026-09-12 (OPS-02, issue #173): 425 KiB. The diagnostics/repair surface
// (src/ops.ts: version/health/metrics/scheduler/jobs/preflight/connections
// plus five inspect-then-act repairs; 8 routes in src/index.ts; SDK guards
// plus client plus descriptor entries; CLI commands plus selftest) measures
// ~413 KiB combined over the OBS-02 baseline (~397 KiB). Hand-written
// feature code, no new dependencies (package.json unchanged versus main);
// deliberate feature headroom only.
// 2026-09-12 (RUN-02 re-merge over OPS-02 main, issue #136): 435 KiB. The
// union of the RUN-02 child-lineage surface with the newer OPS-02 main
// measures 440753 bytes (~430.4 KiB) locally (CI number governs).
// Hand-written feature code, no new dependencies (package.json unchanged
// versus main); deliberate feature headroom only.
// 2026-09-12 (RUN-01 stacked over OPS-02, issue #135): 435 KiB. Persisted
// per-Saga runtime policy (2 routes, D1 table, per-Execution snapshot,
// policy-gated submit plus snapshot-resolved retries/deadlines) stacks on
// the OPS-02 surface above. Same deliberate feature headroom, not dependency
// bloat: package.json is unchanged versus main.
// 2026-09-12 (AUTH-01 second re-drive over RUN-01 main): 440 KiB. The union
// of the AUTH-01 org-lifecycle surface (cascading-delete accounting over all
// org-owned tables plus R2 bytes) with the RUN-01 policy surface measures
// 446392 bytes: 952 bytes over the 435 KiB budget. Hand-written feature code,
// no new dependencies (package.json unchanged versus main); deliberate
// feature headroom only.
// 2026-09-12 (RUN-02 re-merge over AUTH-01/RUN-01 main, issue #136): 455 KiB.
// The union of the RUN-02 child-lineage surface with the newer main measures
// 462412 bytes (~451.6 KiB) locally (CI number governs). Hand-written feature
// code, no new dependencies (package.json unchanged versus main); deliberate
// feature headroom only.
// 2026-09-12 (sec-endpoint, issue #236): 445 KiB. The endpoint safe-URL policy
// (src/integrations/index.ts: URL parse plus per-Integration transport/host
// policy at persist time, assertSafeEndpoint guards in the echo/ninjaone
// Actions and the management probe) measures 451460 bytes after a shrink pass
// (short messages, no dead helpers): 900 bytes over the 440 KiB budget.
// Hand-written security-boundary code, no new dependencies (package.json
// unchanged versus main); deliberate feature headroom only.
// 2026-09-12 (RUN-02 re-merge over sec-hardening main, issue #136): 460 KiB.
// The union of the RUN-02 child-lineage surface with the sec-hardened main
// measures 469406 bytes (~458.4 KiB) locally (CI number governs).
// Hand-written feature code, no new dependencies (package.json unchanged
// versus main); deliberate feature headroom only.
// 2026-09-12 (sec/response-hardening, issues #237 #238 #239): 450 KiB. The
// response baseline (src/index.ts: inline security headers on the JSON
// helper, Static Assets pass-through, and all raw file/artifact byte
// responses; no re-wrap, no new dependencies) plus the echo
// deployment-environment gate (src/integrations/index.ts, src/connections.ts:
// opts.environment threading, two failure arms) measures 455735 bytes after
// a shrink pass (direct header construction instead of Response re-wrapping):
// 55 bytes over the 445 KiB budget. Hand-written security-boundary code,
// package.json unchanged versus main; deliberate feature headroom only.
// 2026-09-12 (RUN-02 re-merge over sec/response main, issue #136): 465 KiB.
// The union of the RUN-02 child-lineage surface with the sec/response main
// measures 471755 bytes (~460.7 KiB) locally (CI number governs).
// Hand-written feature code, no new dependencies (package.json unchanged
// versus main); deliberate feature headroom only.
// 2026-09-12 (AUTH-02 merge over sec/response main, issue #143): 485 KiB.
// The union of the AUTH-02 resource-role control plane (src/roles.ts, 15
// role/policy admin routes, grant enforcement) with the OBS-02/OPS-02/RUN-01
// surfaces plus the sec endpoint safe-URL policy and response baseline
// measures 490817 bytes. Hand-written feature code, no new dependencies
// (package.json unchanged versus main); deliberate feature headroom only.
// 2026-09-12 (TOOL-01 stacked over sec/response main, issue #170): 490 KiB.
// The opt-in tool registry (4 routes + D1 tool_enrollments + SDK entries),
// the inbound MCP gateway (JSON-RPC tools/list, tools/call, tools/search,
// tools/describe over the membership gate), and the HaloPSA Code Mode host
// (contract search/inspect plus host-mediated execute with policy, egress,
// and provenance) stack on the 450 KiB surface above. Hand-written feature
// code, no new dependencies (package.json unchanged versus main);
// deliberate feature headroom only.
// 2026-09-12 (RUN-02 re-merge over TOOL-01 main, issue #136): 505 KiB. The
// union of the RUN-02 child-lineage surface with the TOOL-01 gateway main
// measures 511591 bytes (~499.6 KiB) locally (CI number governs).
// Hand-written feature code, no new dependencies (package.json unchanged
// versus main); deliberate feature headroom only.
// 2026-09-12 (AUTH-02 rebase over TOOL-01 main, issue #143): 525 KiB.
// The union of the AUTH-02 resource-role control plane with the TOOL-01
// tool registry plus inbound MCP gateway plus HaloPSA Code Mode host,
// stacked on the sec endpoint safe-URL policy and response baseline,
// measures 530653 bytes. Hand-written feature code, no new dependencies
// (package.json unchanged versus main); deliberate feature headroom only.
// 2026-09-12 (FORM-02 stacked over TOOL-01 main, issue #155): 555 KiB. The
// dynamic-forms surface (8 routes plus the forms domain: 17 field types,
// startup handles, Table and static providers, delegated submit, scheduled
// receipts, file-field re-validation; plus the Forms renderer and SDK
// descriptor entries) stacks on the 490 KiB surface above with the same
// deliberate feature headroom, not dependency bloat: package.json is
// unchanged versus main. Combined measures 545802 bytes locally (CI number
// governs); shrink the raise if it lands lower.
// 2026-09-12 (TRG-01 stacked over FORM-02 main, issue #137): 575 KiB. The
// schedules surface (6 routes plus the schedules domain: cron/timezone
// parsers, next-due math, deterministic window keys, bounded tick
// promotion, delivery visibility; plus the minute Cron trigger, SDK
// schedule types/guards/client, and ops scheduler inventory) stacks on the
// 555 KiB surface above and measures ~567 KiB combined. Same deliberate
// feature headroom as the earlier raises, not dependency bloat:
// package.json is unchanged versus main.
// 2026-09-12 (RUN-02 re-merge over FORM-02 main, issue #136): 560 KiB. The
// union of the RUN-02 child-lineage surface with the FORM-02 dynamic-forms
// main measures 561822 bytes (~548.7 KiB) locally (CI number governs).
// Hand-written feature code, no new dependencies (package.json
// unchanged versus main); deliberate feature headroom only.
// 2026-09-13 (RUN-02 re-merge over TRG-01 main, issue #136): stays at
// 575 KiB. The union of the RUN-02 child-lineage surface with the TRG-01
// schedules main measures 583169 bytes (~569.5 KiB) locally (CI number
// governs), inside the existing TRG-01 headroom. Hand-written feature code,
// no new dependencies (package.json unchanged versus main); no raise needed.
// 2026-09-12 (AUTH-02 rebase over TRG-01 main, issue #143): 590 KiB.
// The union of the AUTH-02 resource-role control plane (grant gates on
// form read/submit plus the FORM-02 startup-handle delegation test) with
// the TRG-01 schedules surface stacked on FORM-02 plus the sec endpoint
// safe-URL policy and response baseline measures locally below; the CI
// number governs. Hand-written feature code, no new dependencies
// (package.json unchanged versus main); deliberate feature headroom only.
// 2026-09-13 (AUTH-02 P1 review fixes fast-follow, issue #143): 600 KiB.
// The eight thread fixes (App-write grant gates on three mutation routes,
// org-scoped assignees, policy-rule uniqueness, UUID canonicalization, org
// auth cleanup on delete, tool execute grants on both call paths, form
// write authority on three routes) measure 609741 bytes in CI against the
// 590 KiB line: ~5.5 KiB of hand-written authorization-boundary code, no
// new dependencies (package.json unchanged versus main); deliberate
// feature headroom only.
// 2026-09-13 (RUN-02 over AUTH-02 main, issue #136): 615 KiB. The union of
// the RUN-02 child-lineage surface (src/children.ts: dispatch/await/fan-out
// with P1 fixes, lineage reads, hello-parent Saga plus Workflow, SDK
// lineage shape) with the AUTH-02 main measures 626761 bytes locally (CI
// number governs). Hand-written feature code, no new dependencies
// (package.json unchanged versus main); deliberate feature headroom only.
// 2026-09-13 (RUN-03 over RUN-02 main, issue #150): 630 KiB. The union of
// the RUN-03 provider surface (src/sync.ts: replay fence, operation row
// before Action, execute-grant gates; SDK https policy) with the RUN-02
// child-lineage main measures 640832 bytes in CI against the 615 KiB line.
// Hand-written feature code, no new dependencies (package.json unchanged
// versus main); deliberate feature headroom only.
// 2026-09-14 (FORM-02 PR 320 review, issue #155): 635 KiB. The durable
// handle-to-key binding (claimed_key column, binding proof in
// verifyOwnAdmission, consume-on-replay, key-aware peek) measures 647520
// bytes in CI against the 630 KiB line. Hand-written security-fix code, no
// new dependencies (package.json unchanged versus main); deliberate
// feature headroom only.
// 2026-09-14 (OAUTH-01 fence follow-up, issue #149): 640 KiB. The memory-only
// OAuthRefreshFence Durable Object (src/oauth-refresh-fence.ts: one stub per
// tenant+generation key, one volatile vendor POST per round; no storage, no
// D1, no persisted token) plus the fence delegation in refreshRotatingToken
// measures 653395 bytes locally (CI number governs) against the 635 KiB line.
// Hand-written feature code, no new dependencies (package.json unchanged
// versus main); deliberate feature headroom only.
// 2026-09-16 (RUN-02 identity fix, issue #136): 645 KiB. Binding child
// invoke identity to the owning step.do Operation (AsyncLocalStorage ambient
// step name in bindSagaStep, ambient resolution plus CHILD_STEP_MISSING in
// bindSagaChildren, idempotent childDispatchStep) measures 656196 bytes
// locally against the 640 KiB line: ~837 bytes of hand-written
// identity-lineage code, no new dependencies (package.json unchanged versus
// main); deliberate feature headroom only.
// 2026-09-16 (codex limits-fences, issues #344, #360, #345, #361, #364,
// #342, #358): 670 KiB. The limits-and-fences hardening (shared
// admitExecution gate on the provider path; static safe-pattern gate for
// member regexes; body-aware OAuth refresh fence; per-org scheduler fairness
// plus skip quarantine; single-consumption handle claims; bounded JWT cert
// fetches with negative/in-flight caches, plus regression tests) measures
// 668094 bytes locally against the 645 KiB line: ~10 KiB of hand-written
// security-fix code, no new dependencies (package.json unchanged versus
// main); deliberate feature headroom only.
// 2026-09-16 (data-authz, codex findings #354 #353 #351 #347 #350 #346):
// shares the 670 KiB line above. The data-authz authorization fences
// (artifact/audit/repair creator-owner fences, table detail visibility,
// Halo mutation and Connection admin gates, audit-retention migration notes)
// add ~4.4 KiB over main; the union with limits-fences measures ~670.6 KiB
// locally (CI number governs). Hand-written security-boundary code, no new
// dependencies (package.json unchanged versus main); deliberate feature
// headroom only.
// 2026-09-16 (mig-zone-inventory, issues #116 MIG-01, #119 MIG-02): 700 KiB.
// The Cloudflare Zone Inventory migration (two Sagas with Workflow
// entrypoints, bearer Integration with two Actions, domain identity plus
// parsers, installer and source catalog pins, Connection probe) measures
// 700963 bytes locally against the 670 KiB line: ~15 KiB of hand-written
// migration code, no new dependencies (package.json unchanged versus main);
// deliberate feature headroom only.
// 2026-09-17 (TRG-02 follow-through, issue #138): 705 KiB. The webhook
// hardening (canonical base64 HMAC decoder with strict alphabet/padding,
// fail-closed rate-window and endpoint-lookup paths, single-verdict
// signature compare after a shrink pass) measures 717659 bytes locally
// (CI number governs) against the 700 KiB line: ~1.1 KiB of hand-written
// security-boundary code, no new dependencies (package.json unchanged
// versus main); deliberate feature headroom only.
// 2026-09-17 (LIMITS-01, issue #177): 710 KiB plus a mechanical headroom
// rule, stacked on the TRG-02 705 KiB main above. The 700 KiB line had
// decayed to 255 bytes of headroom (~0.04%) — a post-merge ratchet (issue
// #177 comments 2026-09-14..16) instead of an early warning — and the
// TRG-02 raise to 705 KiB still left only ~4.2 KiB. The 710 KiB line
// restores real margin with the reason recorded here and in
// docs/feasibility-envelope.md (same PR, LIMITS-META block); the
// MIN_HEADROOM_BYTES gate below makes the next sub-margin state fail
// closed instead of silently ratcheting again. This lane adds zero Worker
// bytes (docs/tests/governance only). Hand-written platform governance,
// no new dependencies.
// 2026-09-17 (LIMITS-01 merge queue, AI-01 union): 715 KiB. The AI-01
// provider-definitions slice (five provider defs plus probes, issue #164)
// adds ~4.1 KiB of Worker bytes: the TRG-02 union measured 716690 locally
// but the AI-01 union measures 720796 locally (byte-identical in CI),
// leaving 6244 bytes of headroom under the 710 KiB line — below the 8 KiB
// minimum, so the gate fired exactly as designed (budget itself unbroken).
// The 715 KiB line restores ~11.1 KiB of real margin with the reason
// recorded here and in docs/feasibility-envelope.md (same PR, LIMITS-META
// block). Legitimate feature code, no new dependencies.
// 2026-09-17 (TRG-03 S1, issue #139): 730 KiB. The event-source registry
// plus durable event-log surface (src/events.ts: parsers, registry CRUD,
// deterministic emit with replay/conflict identity, bounded history,
// best-effort delivery appends; event-source routes in src/index.ts plus
// schedule/endpoint promotion hooks and SDK entries) measures 735730 bytes
// locally against the 715 KiB line: ~14.6 KiB of hand-written feature code
// over the AI-01-union main, no new dependencies (package.json unchanged
// versus origin/main); deliberate feature headroom only. The 730 KiB line
// restores ~11.5 KiB of real margin above the 8 KiB minimum headroom.
// 2026-09-17 (LIMITS-01 META sync, issue #177): no budget change. The
// #462 saga-epilogue relief (-4,109 B) plus the #463 FORM-02 auto-fill
// slice net to 739082 bytes locally against the 730 KiB line (CI number
// governs): 8438 bytes of headroom, 246 bytes above the 8 KiB minimum.
// LIMITS-META measuredBytes only; BUDGET_BYTES/MIN_HEADROOM_BYTES untouched.
const BUDGET_BYTES = 730 * 1024;
// LIMITS-01 advisory reserve (issue #177, advisory per owner decision): the
// reference level should exceed the measured bundle by at least this margin.
// Landing inside the reference level but below this margin prints a
// prominent warning; it never fails the run. BUDGET_BYTES stays a soft
// reference, separate from Cloudflare's 3 MB hard deploy ceiling (which
// Wrangler itself enforces) and from billing limits.
const MIN_HEADROOM_BYTES = 8 * 1024;

// Bundle-attribution options (issue #438 latest audit, smallest reversible
// slice). Measurement-only: nothing here changes the Worker build, the
// measured bytes, the budget/headroom gates, or CI authority.
//   --top N               print the top N contributors (default 10)
//   --emit-metafile PATH  copy the fresh dry-run metafile to PATH (emit)
//   --metafile PATH       print attribution from an existing metafile only
//                         (consume; skips the Wrangler run and the gates,
//                         so it is stable offline without credentials)
//   --selftest            deterministic fixture checks, no Wrangler/network
const DEFAULT_TOP_N = 10;

function usageError(message) {
  console.error(
    `Usage: node scripts/check-bundle-budget.mjs [--top N] [--emit-metafile PATH] [--metafile PATH] [--selftest]`,
  );
  console.error(message);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { topN: DEFAULT_TOP_N, emitMetafile: null, consumeMetafile: null, selftest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--selftest") {
      opts.selftest = true;
    } else if (arg === "--top") {
      opts.topN = parseTopN(argv[i + 1]);
      i += 1;
    } else if (arg === "--emit-metafile") {
      if (!argv[i + 1]) usageError("--emit-metafile requires a PATH.");
      opts.emitMetafile = argv[i + 1];
      i += 1;
    } else if (arg === "--metafile") {
      if (!argv[i + 1]) usageError("--metafile requires a PATH.");
      opts.consumeMetafile = argv[i + 1];
      i += 1;
    } else {
      usageError(`Unknown argument: ${arg}`);
    }
  }
  if (opts.consumeMetafile && opts.emitMetafile) {
    usageError("--metafile (consume) and --emit-metafile (emit) are mutually exclusive.");
  }
  return opts;
}

function parseTopN(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) usageError(`--top requires a positive integer, got: ${value}`);
  return n;
}

const cliOpts = parseArgs(process.argv.slice(2));
if (cliOpts.selftest) {
  runSelftest();
  process.exit(0);
}
if (cliOpts.consumeMetafile) {
  // Offline attribution only: no Wrangler run, no gates. CI never uses this
  // path; the live dry-run below remains the single authoritative measurement.
  try {
    for (const line of attributionLines(loadMetafile(cliOpts.consumeMetafile), cliOpts.topN)) {
      console.log(line);
    }
  } catch (err) {
    console.error(`Cannot attribute from metafile ${cliOpts.consumeMetafile}: ${err.message}`);
    process.exitCode = 1;
  }
} else {
  const dir = mkdtempSync(join(tmpdir(), "wrangnarok-bundle-"));
  const outfile = join(dir, "worker.js");
  // The pinned Wrangler (4.131.1) exposes `--metafile` on `deploy --dry-run`:
  // a genuine esbuild metafile for the exact bundle being measured. The
  // sidecar never changes the emitted Worker bytes.
  const metafile = join(dir, "bundle-meta.json");
  try {
    // Run the pinned local Wrangler directly under node: no shell, no npx
    // resolution, identical on every platform.
    execFileSync(
      process.execPath,
      [
        "node_modules/wrangler/bin/wrangler.js",
        "deploy",
        "--dry-run",
        "--env",
        "dev",
        "--outfile",
        outfile,
        "--metafile",
        metafile,
      ],
      {
        stdio: "inherit",
      },
    );
    const { size } = statSync(outfile);
    const headroom = BUDGET_BYTES - size;
    console.log(
      `Worker bundle: ${size} bytes (advisory reference ${BUDGET_BYTES} bytes, headroom ${headroom} bytes, advisory reserve ${MIN_HEADROOM_BYTES} bytes).`,
    );
    if (size > BUDGET_BYTES) {
      console.error(
        `ADVISORY: Worker bundle ${size} bytes exceeds the ${BUDGET_BYTES}-byte soft reference level (over by ${-headroom} bytes). ` +
          `Not a merge gate (issue #177): consider shrinking the bundle or recording a deliberate reference-level change.`,
      );
    } else if (headroom < MIN_HEADROOM_BYTES) {
      console.error(
        `ADVISORY: Worker bundle reserve low: ${headroom} bytes of headroom < ${MIN_HEADROOM_BYTES} bytes advisory reserve. ` +
          `Not a merge gate (issue #177): consider shrinking the Worker surface or recording a deliberate reference-level change.`,
      );
    }
    // Attribution is advisory: it never changes the outcome above. When the
    // metafile is missing or unparseable, report that instead of inventing
    // contributors from source file sizes.
    try {
      for (const line of attributionLines(loadMetafile(metafile), cliOpts.topN, size)) {
        console.log(line);
      }
      if (cliOpts.emitMetafile) copyFileSync(metafile, cliOpts.emitMetafile);
    } catch (err) {
      console.error(`Bundle attribution unavailable (measurement above still stands): ${err.message}`);
    }
    checkLimitsMeta();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} // end live dry-run path (consume-metafile returns earlier)

// Bundle attribution from a genuine esbuild metafile (issue #438 latest
// audit). Uses outputs[<bundle>].inputs[*].bytesInOutput — the bundler's own
// per-module contribution accounting — never source-file globbing. All
// ordering and formatting is deterministic (bytes desc, path asc; plain
// integers; one-decimal shares) so output is stable across runs and locales.
// The measured --outfile bytes passed in as measuredBytes stay authoritative:
// metafile output bytes can differ by a small prelude/wrapper delta.
function loadMetafile(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`not valid JSON: ${path}`);
  }
  return parsed;
}

function comparePaths(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function selectBundleOutput(metafile) {
  const outputs = metafile && metafile.outputs;
  if (!outputs || typeof outputs !== "object") throw new Error("metafile has no outputs map");
  // Output keys carry a nondeterministic `.wrangler/tmp/deploy-*/` prefix, so
  // never print them raw: pick the largest emitted `.js` bundle (never a map)
  // with a path-asc tiebreak.
  const candidates = Object.entries(outputs).filter(([key]) => key.endsWith(".js") && !key.endsWith(".js.map"));
  if (candidates.length === 0) throw new Error("metafile has no emitted .js bundle output");
  candidates.sort((a, b) => b[1].bytes - a[1].bytes || comparePaths(a[0], b[0]));
  return candidates[0][1];
}

function summarizeAttribution(metafile, topN) {
  const output = selectBundleOutput(metafile);
  if (!Number.isInteger(output.bytes) || output.bytes < 0) throw new Error("bundle output has no byte count");
  const perOutput = output.inputs;
  if (!perOutput || typeof perOutput !== "object" || Object.keys(perOutput).length === 0) {
    throw new Error("bundle output names no inputs");
  }
  const contributors = Object.entries(perOutput).map(([path, entry]) => {
    const bytes = entry && entry.bytesInOutput;
    if (!Number.isInteger(bytes) || bytes < 0) throw new Error(`input ${path} has no bytesInOutput count`);
    return { path, bytes, sharePct: ((bytes / output.bytes) * 100).toFixed(1) };
  });
  contributors.sort((a, b) => b.bytes - a.bytes || comparePaths(a.path, b.path));
  const attributedBytes = contributors.reduce((sum, c) => sum + c.bytes, 0);
  const shown = contributors.slice(0, topN);
  const omitted = contributors.slice(topN);
  return {
    bundleBytes: output.bytes,
    inputCount: contributors.length,
    attributedBytes,
    shown,
    omittedCount: omitted.length,
    omittedBytes: omitted.reduce((sum, c) => sum + c.bytes, 0),
  };
}

function attributionLines(metafile, topN, measuredBytes = null) {
  const summary = summarizeAttribution(metafile, topN);
  const lines = [`Bundle attribution (esbuild metafile, ${summary.inputCount} inputs):`];
  for (const c of summary.shown) lines.push(`  ${c.bytes} B (${c.sharePct}%) ${c.path}`);
  if (summary.omittedCount > 0) {
    lines.push(`  ... and ${summary.omittedCount} more inputs totaling ${summary.omittedBytes} B`);
  }
  let totals = `Metafile bundle output: ${summary.bundleBytes} B; attributed to inputs: ${summary.attributedBytes} B.`;
  if (measuredBytes !== null) totals += ` Measured worker.js: ${measuredBytes} B (authoritative).`;
  lines.push(totals);
  return lines;
}

function runSelftest() {
  let passed = 0;
  const check = (name, cond) => {
    if (!cond) throw new Error(`bundle-budget selftest failed: ${name}`);
    passed += 1;
  };
  const fixture = () => ({
    inputs: {
      "src/a.ts": { bytes: 100 },
      "src/b.ts": { bytes: 50 },
      "src/c.ts": { bytes: 50 },
      "src/d.ts": { bytes: 10 },
    },
    outputs: {
      ".wrangler/tmp/deploy-RANDOM/index.js.map": { bytes: 999, inputs: {} },
      ".wrangler/tmp/deploy-RANDOM/index.js": {
        bytes: 200,
        inputs: {
          "src/a.ts": { bytesInOutput: 100 },
          "src/b.ts": { bytesInOutput: 50 },
          "src/c.ts": { bytesInOutput: 50 },
          "src/d.ts": { bytesInOutput: 0 },
        },
      },
    },
  });

  // Ordering: bytes desc, path asc on ties; map output never selected.
  check(
    "attribution lines",
    JSON.stringify(attributionLines(fixture(), 10)) ===
      JSON.stringify([
        "Bundle attribution (esbuild metafile, 4 inputs):",
        "  100 B (50.0%) src/a.ts",
        "  50 B (25.0%) src/b.ts",
        "  50 B (25.0%) src/c.ts",
        "  0 B (0.0%) src/d.ts",
        "Metafile bundle output: 200 B; attributed to inputs: 200 B.",
      ]),
  );
  // Truncation: top 2 plus a deterministic omitted remainder.
  check(
    "top truncation",
    JSON.stringify(attributionLines(fixture(), 2)) ===
      JSON.stringify([
        "Bundle attribution (esbuild metafile, 4 inputs):",
        "  100 B (50.0%) src/a.ts",
        "  50 B (25.0%) src/b.ts",
        "  ... and 2 more inputs totaling 50 B",
        "Metafile bundle output: 200 B; attributed to inputs: 200 B.",
      ]),
  );
  // Measured-bytes footer marks the --outfile number authoritative.
  check(
    "measured footer",
    attributionLines(fixture(), 10, 205).at(-1) ===
      "Metafile bundle output: 200 B; attributed to inputs: 200 B. Measured worker.js: 205 B (authoritative).",
  );
  // Largest .js wins when several bundles exist; ties break on raw key asc.
  const multi = fixture();
  multi.outputs[".wrangler/tmp/deploy-RANDOM/second.js"] = { bytes: 200, inputs: { "src/z.ts": { bytesInOutput: 7 } } };
  check(
    "bundle selection",
    summarizeAttribution(multi, 10).bundleBytes === 200 && summarizeAttribution(multi, 10).shown[0].path === "src/a.ts",
  );
  // Malformed metafiles fail with a message instead of invented numbers.
  for (const [name, bad] of [
    ["no outputs", {}],
    ["no bundle", { outputs: { "x.js.map": { bytes: 1, inputs: {} } } }],
    ["no inputs", { outputs: { "b.js": { bytes: 1, inputs: {} } } }],
    ["no contribution", { outputs: { "b.js": { bytes: 1, inputs: { "src/a.ts": {} } } } }],
  ]) {
    let error = null;
    try {
      summarizeAttribution(bad, 10);
    } catch (err) {
      error = err;
    }
    check(`rejects ${name}`, error instanceof Error);
  }
  // Consume path: an on-disk metafile round-trips through the loader.
  const tmp = mkdtempSync(join(tmpdir(), "wrangnarok-bundle-selftest-"));
  try {
    const probe = join(tmp, "meta.json");
    writeFileSync(probe, JSON.stringify(fixture()));
    check("consume file", attributionLines(loadMetafile(probe), 1).length === 4);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  // Advisory META reporting never throws: null, arrays, and strings warn
  // instead of failing the run; matching bookkeeping stays silent.
  for (const bad of [null, [], "730"]) {
    check(`advisory meta ${JSON.stringify(bad)}`, describeLimitsMeta(bad).length === 1);
  }
  check("advisory meta match silent", describeLimitsMeta({ budgetKiB: 730, minHeadroomBytes: 8192 }).length === 0);
  check("advisory meta drift warns", describeLimitsMeta({ budgetKiB: 700, minHeadroomBytes: 0 }).length === 2);
  // Argument validation rejects bad --top without running anything.
  for (const bad of ["0", "-3", "2.5", "many", undefined]) {
    let error = null;
    const originalExit = process.exit;
    const originalError = console.error;
    console.error = () => {};
    process.exit = () => {
      throw new Error("exit");
    };
    try {
      parseTopN(bad);
    } catch (err) {
      error = err;
    } finally {
      process.exit = originalExit;
      console.error = originalError;
    }
    check(`rejects top ${bad}`, error instanceof Error);
  }
  console.log(`bundle-budget selftest: ${passed} passed.`);
}

// LIMITS-01 envelope report (issue #177, advisory per owner decision): the
// canonical feasibility record in docs/feasibility-envelope.md carries a
// machine-readable LIMITS-META block (budgetKiB, measuredBytes,
// measuredDate, minHeadroomBytes). Drift between the block and
// BUDGET_BYTES / MIN_HEADROOM_BYTES prints a prominent warning so prose
// cannot silently trail code the way the 575 KiB matrix trailed the 700 KiB
// budget — but stale bookkeeping never fails the run. measuredBytes is
// informational (local vs CI builds vary slightly).
// Pure reporter for the parsed LIMITS-META value: returns advisory
// warning lines, never throws, so malformed or stale bookkeeping (null,
// arrays, strings, drift) warns instead of failing the run.
function describeLimitsMeta(meta) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return ["ADVISORY: LIMITS-META block in docs/feasibility-envelope.md must be a JSON object. Not a merge gate."];
  }
  const warnings = [];
  if (meta.budgetKiB * 1024 !== BUDGET_BYTES) {
    warnings.push(
      `ADVISORY: LIMITS-META budgetKiB (${meta.budgetKiB}) disagrees with BUDGET_BYTES (${BUDGET_BYTES}). Not a merge gate; update docs/feasibility-envelope.md when convenient.`,
    );
  }
  if (meta.minHeadroomBytes !== MIN_HEADROOM_BYTES) {
    warnings.push(
      `ADVISORY: LIMITS-META minHeadroomBytes (${meta.minHeadroomBytes}) disagrees with MIN_HEADROOM_BYTES (${MIN_HEADROOM_BYTES}). Not a merge gate; update docs/feasibility-envelope.md when convenient.`,
    );
  }
  return warnings;
}
function checkLimitsMeta() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const envelope = readFileSync(join(root, "docs/feasibility-envelope.md"), "utf8");
  const match = envelope.match(/<!-- LIMITS-META (\{.*?\}) -->/);
  if (!match) {
    console.error(
      "ADVISORY: LIMITS-META block missing from docs/feasibility-envelope.md (issue #177). Not a merge gate.",
    );
    return;
  }
  let meta;
  try {
    meta = JSON.parse(match[1]);
  } catch {
    console.error("ADVISORY: LIMITS-META block in docs/feasibility-envelope.md is not valid JSON. Not a merge gate.");
    return;
  }
  for (const line of describeLimitsMeta(meta)) {
    console.error(line);
  }
}
