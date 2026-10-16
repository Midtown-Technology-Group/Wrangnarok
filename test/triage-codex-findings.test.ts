// SPDX-License-Identifier: AGPL-3.0
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wrangnarok-triage-"));
const script = fileURLToPath(new URL("../scripts/triage-codex-findings.mjs", import.meta.url));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function csv(status: string): string {
  return [
    "finding_url,title,description,severity,status,detected_at,committed_at,commit_hash,relevant_paths",
    `https://security.invalid/finding,Private report,Actionable details,medium,${status},2026-09-16,2026-09-15,abc123,src/index.ts`,
  ].join("\n");
}

function run(status: string, flag?: string) {
  const path = join(dir, `${status}-${flag ?? "none"}.csv`);
  writeFileSync(path, csv(status), "utf8");
  return spawnSync(process.execPath, [script, path, ...(flag === undefined ? [] : [flag])], {
    encoding: "utf8",
    env: { ...process.env, PATH: dir },
  });
}

describe("Codex finding triage publication guard", () => {
  it("requires affirmative live-publication confirmation", () => {
    const result = run("fixed");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--publish-fixed");
  });

  it("withholds unresolved findings before any GitHub lookup or issue creation", () => {
    const result = run("new", "--publish-fixed");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("findings=0 withheld=1");
    expect(result.stdout).toContain("done: created=0 skipped=0 failed=0");
    expect(result.stderr).toBe("");
  });

  it("allows fixed findings into dry-run review without publishing", () => {
    const result = run("fixed", "--dry-run");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("findings=1 withheld=0");
    expect(result.stdout).toContain("DRY [codex] Private report");
    expect(result.stderr).toContain("proceeding without dedupe");
  });
});
