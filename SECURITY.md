# Security policy

Wrangnarök is a pre-alpha experiment. There are no supported releases yet; everything on `main` should be treated as under active development.

## Reporting a vulnerability

Please do **not** open a public issue for a suspected vulnerability. Use GitHub's [private vulnerability reporting](../../security/advisories/new) on this repository instead, so the report stays private until a fix exists.

Include, where known:

- the affected commit or file and how the issue was found;
- what an attacker could achieve (read/write/execution scope, tenant boundary);
- whether Organization isolation or Connection secrets are involved.

## Scope notes

- Production dependencies are intentionally tiny (`react`, `react-dom`, `react-router-dom`); CI gates `npm audit --omit=dev` on every PR.
- Local Cloudflare emulation (`wrangler`, `@cloudflare/vitest-plugin`) pulls in dev-only native dependencies (e.g. `sharp` via `miniflare`) that never ship in the Worker bundle. Findings confined to that tree are tracked but do not trigger production advisories.
- `vendor/upstream` is a commit-pinned submodule of `gobifrost/bifrost` used as a behavioral reference, not shipped code.

## Scanning stack (issue #247)

Distinct coverage with low noise; no two scanners report the same dependency CVEs:

- Dependabot: dependency update workflow (npm, daily).
- `npm audit --omit=dev`: blocking production vulnerability gate in CI.
- Gitleaks (`.github/workflows/secret-scan.yml`, `.gitleaks.toml`): leaked credentials under arbitrary filenames, including fixtures/docs/examples; scans tree plus git history, fails closed, uploads SARIF to code scanning.
- CodeQL (actions + javascript-typescript, security-extended): semantic source/dataflow vulnerabilities.
- Scorecard: supply-chain posture (advisory SARIF).

Tool choice: Gitleaks CLI (pinned `GITLEAKS_VERSION`) over the `gitleaks-action` wrapper (the wrapper needs a `GITLEAKS_LICENSE` org secret, which would break credential-free PR CI) and over Trivy (Trivy vulnerability/config findings would duplicate `npm audit`/Dependabot with extra maintenance and noise). Gitleaks adds unique secrets coverage and nothing else.

Suppression: `.gitleaks.toml` extends Gitleaks defaults with two narrow entries: the `test/fixtures/secret-scan/` path (the controlled canary) and a `generic-api-key`-only rule allowlist for `test/` paths (idempotency-key scaffolding such as `const key = "run02-parent-happy-001"` is not a credential; vendor-specific rules still apply everywhere). Add new suppressions as narrow path/regex entries with a comment citing the reason and issue; never blanket-exclude source dirs or file types.

Fixtures: use the synthetic `wrangnarok_canary_<32 alphanumerics>` shape for scanner tests. Never commit real-format tokens (`ghp_…`, `sk_live_…`, `AKIA…`); GitHub push protection may block them and Gitleaks would flag them on every run.

If a real secret leaks: revoke/rotate it FIRST (removing it from Git alone is insufficient since history retains it), then remove the string, consider history rewrite, and report via private vulnerability reporting above.
