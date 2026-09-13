// SPDX-License-Identifier: AGPL-3.0
// Worker bundle budget (ADR 004): fail closed when the emitted Worker
// bundle exceeds its size budget. Measures raw bytes of the exact bundle
// `wrangler deploy --dry-run --outfile` produces — no CLI output parsing —
// so dependency bloat and cold-start creep break CI instead of drifting.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
// 2026-09-11 (OPS-01, issue #172): 380 KiB. The audit/notifications slice
// (src/ops.ts: audit + notification domain, keyset pagination, reconcile;
// 4 read routes plus audit emission on 5 app routes and the cancel route;
// SDK audit/notification surface) stacks on the FILE-02 surface with the
// same deliberate feature headroom, not dependency bloat: package.json is
// unchanged. Remeasure after merge; shrink the raise if the combined bundle
// lands lower.
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
// 2026-09-12 (sec-endpoint, issue #236): 445 KiB. The endpoint safe-URL policy
// (src/integrations/index.ts: URL parse plus per-Integration transport/host
// policy at persist time, assertSafeEndpoint guards in the echo/ninjaone
// Actions and the management probe) measures 451460 bytes after a shrink pass
// (short messages, no dead helpers): 900 bytes over the 440 KiB budget.
// Hand-written security-boundary code, no new dependencies (package.json
// unchanged versus main); deliberate feature headroom only.
// 2026-09-12 (sec/response-hardening, issues #237 #238 #239): 450 KiB. The
// response baseline (src/index.ts: inline security headers on the JSON
// helper, Static Assets pass-through, and all raw file/artifact byte
// responses; no re-wrap, no new dependencies) plus the echo
// deployment-environment gate (src/integrations/index.ts, src/connections.ts:
// opts.environment threading, two failure arms) measures 455735 bytes after
// a shrink pass (direct header construction instead of Response re-wrapping):
// 55 bytes over the 445 KiB budget. Hand-written security-boundary code,
// package.json unchanged versus main; deliberate feature headroom only.
// 2026-09-12 (TOOL-01 stacked over sec/response main, issue #170): 490 KiB.
// The opt-in tool registry (4 routes + D1 tool_enrollments + SDK entries),
// the inbound MCP gateway (JSON-RPC tools/list, tools/call, tools/search,
// tools/describe over the membership gate), and the HaloPSA Code Mode host
// (contract search/inspect plus host-mediated execute with policy, egress,
// and provenance) stack on the 450 KiB surface above. Hand-written feature
// code, no new dependencies (package.json unchanged versus main);
// deliberate feature headroom only.
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
const BUDGET_BYTES = 575 * 1024;

const dir = mkdtempSync(join(tmpdir(), "wrangnarok-bundle-"));
const outfile = join(dir, "worker.js");
try {
  // Run the pinned local Wrangler directly under node: no shell, no npx
  // resolution, identical on every platform.
  execFileSync(
    process.execPath,
    ["node_modules/wrangler/bin/wrangler.js", "deploy", "--dry-run", "--outfile", outfile],
    {
      stdio: "inherit",
    },
  );
  const { size } = statSync(outfile);
  console.log(`Worker bundle: ${size} bytes (budget ${BUDGET_BYTES} bytes).`);
  if (size > BUDGET_BYTES) {
    console.error(
      `Worker bundle budget exceeded: ${size} bytes > ${BUDGET_BYTES} bytes. Shrink the bundle or raise the budget deliberately.`,
    );
    process.exitCode = 1;
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
