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
// 2026-09-11 (APP-01 + SEC-01 merge, issue #159): 120 KiB. The authored-apps
// surface (12 routes plus the apps domain: lifecycle, fenced activation,
// slug swap, authorized asset serving) plus the merged SEC-01 secret-scrub
// module (src/secrets.ts with scrub call sites, no new dependencies) measure
// ~114 KiB combined. Same deliberate feature headroom as the 110 KiB raise,
// not dependency bloat: package.json is unchanged versus main.
// 2026-09-11 (AUTH-01, issue #142): 145 KiB. The Organization and user
// lifecycle surface (src/orgs.ts: membership gate on every /api/* request,
// 9 admin routes plus the org history list, cascading-delete preview, LAB
// fixture bootstrap; no new dependencies) measures ~144 KiB combined after a
// shrink pass on the bootstrap DDL. Same deliberate feature headroom as the
// 120 KiB raise, not dependency bloat: package.json is unchanged versus main.
// 2026-09-11 (TRG-01, issue #137): 175 KiB. The schedule surface
// (src/schedules.ts: cron validation, IANA timezone labels, UTC window math,
// server-derived window keys, preview, bounded scan/admission; 7 schedule
// routes plus the scheduled() Cron tick; Scheduled status plus schedule
// error codes; no new dependencies) measures ~166 KiB combined. Same
// deliberate feature headroom as the 145 KiB raise, not dependency bloat:
// package.json is unchanged versus main.
const BUDGET_BYTES = 175 * 1024;

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
