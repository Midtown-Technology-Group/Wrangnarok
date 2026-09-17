// SPDX-License-Identifier: AGPL-3.0
// Issue #247 controlled test: the planted synthetic canary matches the
// scanner rule, the main-tree suppression is narrowly path-scoped and
// documented, and the CI workflow wires fail-closed detection plus SARIF
// without overlapping dependency scanners.
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/secret-scan/planted-canary.txt?raw";
import gitleaksConfig from "../.gitleaks.toml?raw";
import workflow from "../.github/workflows/secret-scan.yml?raw";

const CANARY_RE = /wrangnarok_canary_[A-Za-z0-9]{32}/;

describe("secret scanning (#247)", () => {
  it("planted canary matches the scanner rule and carries no real credential shape", () => {
    expect(fixture).toMatch(CANARY_RE);
    // Guard against accidentally committing a format GitHub push protection
    // would block (real PAT / live Stripe / AWS key shapes).
    expect(fixture).not.toMatch(/ghp_[A-Za-z0-9]{36}/);
    expect(fixture).not.toMatch(/sk_live_[A-Za-z0-9]+/);
    expect(fixture).not.toMatch(/AKIA[0-9A-Z]{16}/);
  });

  it("gitleaks config extends defaults, defines the canary, and suppresses only the fixture dir", () => {
    expect(gitleaksConfig).toMatch(/useDefault\s*=\s*true/);
    expect(gitleaksConfig).toContain('id = "wrangnarok-canary"');
    expect(gitleaksConfig).toContain("wrangnarok_canary_");
    expect(gitleaksConfig).toContain("test/fixtures/secret-scan/");
    // The noisy generic-api-key heuristic is scoped down to test/ paths only
    // (idempotency-key scaffolding); vendor rules still apply everywhere.
    expect(gitleaksConfig).toContain('id = "generic-api-key"');
    // No blanket exclusions: no paths allowlist entry targets source dirs.
    expect(gitleaksConfig).not.toMatch(/paths\s*=\s*\[[^\]]*src\//s);
  });

  it("CI workflow fails closed on leaks, uploads SARIF, and adds no dependency scanning", () => {
    expect(workflow).toContain("GITLEAKS_VERSION: 8.30.1");
    expect(workflow).toContain("gitleaks detect");
    expect(workflow).toContain("Canary fixture check");
    expect(workflow).toContain("upload-sarif");
    expect(workflow).toContain("security-events: write");
    expect(workflow).toContain("fetch-depth: 0");
    // Distinct coverage only: no overlapping dependency/CVE scanner USAGE and
    // no action wrapper needing an org license secret. Comments may document
    // the rejected alternatives (and must: the Trivy rationale lives there).
    expect(workflow).toMatch(/trivy/i);
    const code = workflow
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    for (const banned of ["trivy", "npm audit", "snyk", "osv-scanner", "gitleaks-action", "GITLEAKS_LICENSE"]) {
      expect(code.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });
});
