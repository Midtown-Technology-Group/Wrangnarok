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
const BUDGET_BYTES = 380 * 1024;

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
