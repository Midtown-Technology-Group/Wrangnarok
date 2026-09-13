// SPDX-License-Identifier: AGPL-3.0
// Local Solution source exporter (SOL-03, issue #163): validates a
// solution.source.json package through the real exportSourcePackage
// implementation (src/solution-export.ts), not a reimplementation, then
// writes solution.source.json plus the extracted solution.manifest.json.
//
// Usage: node scripts/export-local.mjs <package.json> <outdir>
//
// - <package.json>: path to a solution.source.json shareable package.
// - <outdir>: directory receiving solution.source.json + solution.manifest.json.
//
// This validates portable source only. It never touches D1, never reads
// secrets, and never exports tenant state (table rows, execution history,
// artifact bytes, credential values are rejected, not carried). Encrypted
// operational backup is tracked separately under OPS-03.
//
// Prerequisites: npm ci (the runner bundles src/solution-export.ts with the
// repo's own esbuild so it exercises the exact source tests cover).
import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unlink } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = resolve(join(fileURLToPath(new URL(".", import.meta.url)), ".."));
const ESBUILD = join(ROOT, "node_modules", "esbuild", "bin", "esbuild");

function bundleSources() {
  return new Promise((resolvePromise, reject) => {
    const out = join(tmpdir(), `wrangnarok-solution-export-${process.pid}.mjs`);
    execFile(
      process.execPath,
      [
        ESBUILD,
        join(ROOT, "src", "solution-export.ts"),
        "--bundle",
        "--platform=node",
        "--format=esm",
        `--outfile=${out}`,
        "--log-level=error",
      ],
      { cwd: ROOT },
      (error, _stdout, stderr) => (error ? reject(new Error(stderr.trim() || error.message)) : resolvePromise(out)),
    );
  });
}

const args = process.argv.slice(2);
const packagePath = args.find((a) => !a.startsWith("--"));
const outDir = args.filter((a) => !a.startsWith("--"))[1];
if (!packagePath || !outDir || args.some((a) => a.startsWith("--"))) {
  console.error("Usage: node scripts/export-local.mjs <package.json> <outdir>");
  process.exit(2);
}
if (!existsSync(ESBUILD)) {
  console.error("esbuild is not installed. Run npm ci first.");
  process.exit(1);
}

let bundled;
try {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(resolve(ROOT, packagePath), "utf8");
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    console.error("INVALID_SOURCE: the package file is not valid JSON.");
    process.exit(1);
  }
  bundled = await bundleSources();
  const mod = await import(pathToFileURL(bundled).href);
  const result = await mod.exportSourcePackage(pkg);
  const target = resolve(ROOT, outDir);
  await mkdir(target, { recursive: true });
  for (const file of result.files) {
    await writeFile(join(target, file.name), file.json, "utf8");
  }
  console.log(
    JSON.stringify(
      {
        files: result.files.map((file) => ({ name: file.name, bytes: file.bytes })),
        sha256: result.sha256,
        outdir: outDir,
      },
      null,
      2,
    ),
  );
} catch (error) {
  const code = error && typeof error.code === "string" ? error.code : "EXPORT_FAILED";
  console.error(`${code}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
} finally {
  if (bundled) await unlink(bundled).catch(() => {});
}
