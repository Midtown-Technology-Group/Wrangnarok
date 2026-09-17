// SPDX-License-Identifier: AGPL-3.0
// INT-01 (issue #229): generator tests. Pure node-safe: no bindings, no D1,
// no Workflows, no vendor HTTP. A Halo-shaped fixture proves the exit:
// converts to a compiling-shaped module or fails loudly with the gap.
import { describe, expect, it } from "vitest";
import { runCommand, validateAndGenerate } from "../scripts/wrangnarok.mjs";
import { runGenerateIntegration } from "../scripts/wrangnarok-core.mjs";
import { Fault } from "../src/domain";
import { generateIntegrationModule } from "../src/generate-integration";

const DIGEST = "ab".repeat(32);

interface GeneratedCliResult {
  readonly generated: {
    readonly content: string;
    readonly operations: number;
    readonly path: string;
    readonly specDigest: string;
    readonly next: readonly string[];
  };
}

function haloShaped() {
  return JSON.stringify({
    openapi: "3.0.3",
    info: { version: "halo-lab-1", title: "HaloPSA lab proof" },
    servers: [{ url: "https://halo-lab.example.com" }],
    paths: {
      "/api/Tickets/{id}": {
        get: { operationId: "Ticket_Get", summary: "Get one ticket by id." },
        delete: { operationId: "Ticket_Delete", summary: "Delete one ticket (destructive)." },
      },
      "/api/Tickets/{id}/Notes": {
        post: { operationId: "Ticket_AddNote", summary: "Add a note to one ticket." },
      },
    },
  });
}

function opts() {
  return {
    id: "halo",
    name: "halo",
    allowedOrigins: ["https://halo-lab.example.com"],
    classifications: { Ticket_Delete: "destructive" as const },
  };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("INT-01 generator (issue #229)", () => {
  it("emits a self-contained module from a Halo-shaped spec", () => {
    const out = generateIntegrationModule(haloShaped(), opts(), DIGEST);
    expect(out.fileName).toBe("halo.ts");
    expect(out.operationCount).toBe(3);
    expect(out.specDigest).toBe(DIGEST);
    expect(out.source).toContain(`export const HALO_INTEGRATION_ID = "halo";`);
    expect(out.source).toContain(`// Spec digest: ${DIGEST}`);
    expect(out.source).toContain("// Spec version: halo-lab-1");
    expect(out.source).toContain(`"Ticket_Get": "read"`);
    expect(out.source).toContain(`"Ticket_Delete": "destructive"`);
    expect(out.source).toContain(`"Ticket_AddNote": "mutation"`);
    expect(out.source).toContain(`"https://halo-lab.example.com"`);
    expect(out.source).toContain("executeHaloOperation");
    expect(out.source).toContain("scrubValueWithSecrets");
    expect(out.source).toContain("buildProvenance");
    // TOOL-01 (issue #170) host boundaries: bounded vendor bodies and
    // genuine-absence-only Connection mapping must survive regeneration.
    expect(out.source).toContain("readBoundedVendorBody");
    expect(out.source).not.toContain("await response.text()");
    expect(out.source).toContain('error.code === "CONNECTION_NOT_FOUND"');
    expect(out.source).not.toContain(".catch(() => null)");
    expect(out.source).not.toMatch(/clientSecret\s*[:=]\s*["'][^"']+["']/);
    expect(out.source).not.toContain("halo-lab.example.com/api");
    // TOOL-01 (issue #170) auth contract: generated hosts exchange the
    // deployment pair at an explicit token path and send only the access
    // token as Bearer — never the pseudo-Bearer `id:secret` shape.
    expect(out.source).toContain("requestClientCredentialsToken");
    expect(out.source).toContain('export const HALO_TOKEN_PATH = "/auth/token";');
    expect(out.source).toContain("Authorization: `Bearer ${token}`");
    expect(out.source).not.toContain("Bearer ${clientId}:${clientSecret}");
  });

  it("is deterministic: same spec plus same options yields identical source", () => {
    const first = generateIntegrationModule(haloShaped(), opts(), DIGEST);
    const second = generateIntegrationModule(haloShaped(), opts(), DIGEST);
    expect(second.source).toBe(first.source);
  });

  it("keeps the plain-node CLI on the exact canonical emitted implementation", async () => {
    const spec = haloShaped();
    const digest = await sha256Hex(spec);
    const canonical = generateIntegrationModule(spec, opts(), digest);
    const cli = (await runCommand({
      command: "generate-integration",
      genId: "halo",
      genName: "halo",
      genSpec: spec,
      genOrigins: ["https://halo-lab.example.com"],
      genClassifications: { Ticket_Delete: "destructive" },
    })) as GeneratedCliResult;

    expect(cli.generated.content).toBe(canonical.source);
    expect(cli.generated.content).toContain("await fetchImpl(url");
    expect(cli.generated.content).toContain("resolveRequestUrl({ ...pinned");
    expect(cli.generated.content).not.toContain("return { result: null, provenance: {} as CodeModeProvenance }");
  });

  // Alerts 57/58/60/61 (js/http-to-file-access) were a static-analysis
  // artifact of routing the offline generator through the shared
  // network-result object. CLI dispatch now calls these direct offline
  // entries; this pins them to the dispatch payload.
  it("exposes direct offline generator entries matching dispatch", async () => {
    const spec = haloShaped();
    const ctx = {
      command: "generate-integration",
      genId: "halo",
      genName: "halo",
      genSpec: spec,
      genOrigins: ["https://halo-lab.example.com"],
      genClassifications: { Ticket_Delete: "destructive" },
    };
    const viaDispatch = (await runCommand(ctx)) as GeneratedCliResult;
    const direct = validateAndGenerate(ctx) as GeneratedCliResult;
    expect(direct.generated).toEqual(viaDispatch.generated);
    const coreFirst = (await runGenerateIntegration(ctx)) as GeneratedCliResult;
    const coreSecond = (await runGenerateIntegration(ctx)) as GeneratedCliResult;
    expect(coreSecond.generated).toEqual(coreFirst.generated);
    expect(coreFirst.generated.path).toBe("src/integrations/halo.ts");
    expect(coreFirst.generated.operations).toBe(3);
  });

  it("keeps the CLI auth flags on the canonical typed output", async () => {
    const spec = haloShaped();
    const digest = await sha256Hex(spec);
    const typed = generateIntegrationModule(
      spec,
      { ...opts(), tokenPath: "/oauth2/token", scope: "monitoring", timeoutMs: 8000 },
      digest,
    );
    const cli = (await runCommand({
      command: "generate-integration",
      genId: "halo",
      genName: "halo",
      genSpec: spec,
      genOrigins: ["https://halo-lab.example.com"],
      genClassifications: { Ticket_Delete: "destructive" },
      genTokenPath: "/oauth2/token",
      genScope: "monitoring",
      genTimeoutMs: 8000,
    })) as GeneratedCliResult;

    expect(cli.generated.content).toBe(typed.source);
    expect(cli.generated.content).toContain('export const HALO_TOKEN_PATH = "/oauth2/token";');
    expect(cli.generated.content).toContain("export const HALO_TIMEOUT_MS = 8000;");
  });

  it("fails loudly on structural defects and bad options", () => {
    expect(() => generateIntegrationModule("not-json", opts(), DIGEST)).toThrow(Fault);
    expect(() => generateIntegrationModule(JSON.stringify({ openapi: "3.0.0" }), opts(), DIGEST)).toThrow(
      expect.objectContaining({ code: "GENERATOR_INVALID_SPEC" }),
    );
    expect(() => generateIntegrationModule(haloShaped(), { ...opts(), id: "Bad!" }, DIGEST)).toThrow(
      expect.objectContaining({ code: "GENERATOR_INVALID_OPTIONS" }),
    );
    expect(() => generateIntegrationModule(haloShaped(), { ...opts(), allowedOrigins: [] }, DIGEST)).toThrow(
      expect.objectContaining({ code: "GENERATOR_INVALID_OPTIONS" }),
    );
  });

  it("keeps crafted path separators inside the emitted comment line", () => {
    const evil = JSON.parse(haloShaped());
    evil.paths["/api/Evil\r\ninjected"] = { get: { operationId: "Evil_Get", summary: "Evil." } };
    evil.paths["/api/Split\u2028line"] = { get: { operationId: "Evil_Split", summary: "Split." } };
    const out = generateIntegrationModule(JSON.stringify(evil), opts(), DIGEST);
    // The review thread (CWE-94) is about the emitted `//` comment: only the
    // classification lines can break out of a comment. The embedded spec
    // literal keeps U+2028 raw inside a quoted string, which is valid ES2019+
    // and cannot terminate the comment.
    for (const line of out.source.split("\n")) {
      if (line.includes("// GET /api/Evil") || line.includes("// GET /api/Split")) {
        expect(line).not.toMatch(/[\r\n\u2028\u2029]/);
      }
    }
    expect(out.source).toContain("// GET /api/Evil injected");
    expect(out.source).toContain("// GET /api/Split line");
  });

  it("keeps a crafted version/path breakout payload inside comments (#343)", async () => {
    // Codex finding #343: a provider spec could terminate the `//` comment
    // and smuggle active TypeScript into the generated module (close the
    // classifications object, add top-level statements, reopen a filler
    // object). The payload must stay inert in both emitters.
    const payload = "\n};\n(globalThis as any).__injected = 1;\nconst __filler = {";
    const evil = JSON.parse(haloShaped());
    evil.info.version = `1.0${payload}`;
    evil.paths[`/api/Break${payload}`] = { get: { operationId: "Break_Get", summary: "Break." } };
    const specText = JSON.stringify(evil);
    const out = generateIntegrationModule(specText, opts(), DIGEST);
    const lines = out.source.split("\n");
    const versionLine = lines.find((line) => line.startsWith("// Spec version:"));
    expect(versionLine).toBeDefined();
    // The payload text may survive inside the comment, but it must stay on
    // one comment line: no separator may terminate the comment early.
    expect(versionLine).not.toMatch(/[\r\n\u2028\u2029]/);
    // No emitted line may start active code from the payload: every injected
    // statement must remain comment text or escaped string content.
    for (const line of lines) {
      const trimmed = line.trimStart();
      expect(trimmed.startsWith("(globalThis")).toBe(false);
      expect(trimmed.startsWith("const __filler")).toBe(false);
    }
    // The classifications block must stay a well-formed single-line-per-op
    // object: no injected statements may escape it.
    const classStart = lines.findIndex((line) => line.includes("_CLASSIFICATIONS"));
    const classEnd = lines.findIndex((line, index) => index > classStart && line.trim() === "});");
    expect(classStart).toBeGreaterThanOrEqual(0);
    expect(classEnd).toBeGreaterThan(classStart);
    const classLines = lines.slice(classStart + 1, classEnd);
    expect(classLines.length).toBeGreaterThan(0);
    for (const line of classLines) {
      expect(line).not.toMatch(/[\r\n\u2028\u2029]/);
    }
    // The CLI shares the canonical emitter, so the same payload stays inert
    // there too (compared against the CLI's own digest input, which the
    // CLI derives from the raw spec rather than the pinned test digest).
    const cliDigest = await sha256Hex(specText);
    const cliCanonical = generateIntegrationModule(specText, opts(), cliDigest);
    const cli = (await runCommand({
      command: "generate-integration",
      genId: "halo",
      genName: "halo",
      genSpec: specText,
      genOrigins: ["https://halo-lab.example.com"],
      genClassifications: { Ticket_Delete: "destructive" },
    })) as GeneratedCliResult;
    expect(cli.generated.content).toBe(cliCanonical.source);
    expect(cli.generated.content).not.toContain("__injected\n");
  });

  it("rejects oversized specs before parsing", () => {
    const big = " ".repeat(2 * 1024 * 1024 + 1);
    expect(() => generateIntegrationModule(big, opts(), DIGEST)).toThrow(
      expect.objectContaining({ code: "GENERATOR_INVALID_SPEC" }),
    );
  });

  it("validates origins and contract defects per branch", () => {
    expect(() => generateIntegrationModule(haloShaped(), { ...opts(), allowedOrigins: ["::bad::"] }, DIGEST)).toThrow(
      expect.objectContaining({ code: "GENERATOR_INVALID_OPTIONS" }),
    );
    expect(() =>
      generateIntegrationModule(haloShaped(), { ...opts(), allowedOrigins: ["ftp://x.example"] }, DIGEST),
    ).toThrow(expect.objectContaining({ code: "GENERATOR_INVALID_OPTIONS" }));
    const dupe = JSON.parse(haloShaped());
    dupe.paths["/api/Dupe"] = { get: { operationId: "Ticket_Get", summary: "Dupe." } };
    expect(() => generateIntegrationModule(JSON.stringify(dupe), opts(), DIGEST)).toThrow(
      expect.objectContaining({ code: "GENERATOR_INVALID_SPEC" }),
    );
    const empty = JSON.stringify({ openapi: "3.0.0", info: { version: "v1" }, paths: {} });
    expect(() => generateIntegrationModule(empty, opts(), DIGEST)).toThrow(
      expect.objectContaining({ code: "GENERATOR_INVALID_SPEC" }),
    );
  });

  it("honors custom name, description, prefix, and classifications", () => {
    const out = generateIntegrationModule(
      haloShaped(),
      {
        ...opts(),
        name: "halo-custom",
        description: "Custom desc.",
        secretEnvPrefix: "HALO_X",
        classifications: { Ticket_Get: "mutation" } as const,
      },
      DIGEST,
    );
    expect(out.source).toContain(`"Ticket_Get": "mutation"`);
    expect(out.operationCount).toBe(3);
  });

  it("emits explicit provider auth strategy with safe defaults", () => {
    const out = generateIntegrationModule(haloShaped(), opts(), DIGEST);
    expect(out.source).toContain('export const HALO_TOKEN_PATH = "/auth/token";');
    expect(out.source).toContain("export const HALO_TIMEOUT_MS = 5000;");
    expect(out.source).toContain("HALO_TOKEN_FAULTS");
    expect(out.source).toContain('"HALO_UNAUTHORIZED"');
    const custom = generateIntegrationModule(
      haloShaped(),
      { ...opts(), tokenPath: "/oauth2/token", scope: "monitoring", timeoutMs: 8000 },
      DIGEST,
    );
    expect(custom.source).toContain('export const HALO_TOKEN_PATH = "/oauth2/token";');
    expect(custom.source).toContain('scope: "monitoring"');
    expect(custom.source).toContain("export const HALO_TIMEOUT_MS = 8000;");
    expect(custom.source).not.toBe(out.source);
  });

  it("rejects bad auth options loudly", () => {
    for (const bad of [
      { ...opts(), tokenPath: "https://evil.example.com/token" },
      { ...opts(), tokenPath: "auth/token" },
      { ...opts(), scope: "" },
      { ...opts(), scope: "x".repeat(129) },
      { ...opts(), timeoutMs: 0 },
      { ...opts(), timeoutMs: 30001 },
      { ...opts(), timeoutMs: Number.NaN },
    ]) {
      expect(() => generateIntegrationModule(haloShaped(), bad, DIGEST)).toThrow(
        expect.objectContaining({ code: "GENERATOR_INVALID_OPTIONS" }),
      );
    }
  });

  it("rejects classification typos, bad prefixes, http origins, and line breaks", () => {
    expect(() =>
      generateIntegrationModule(
        haloShaped(),
        { ...opts(), classifications: { Ticket_Get: "typo" } as unknown as Record<string, "read"> },
        DIGEST,
      ),
    ).toThrow(expect.objectContaining({ code: "GENERATOR_INVALID_OPTIONS" }));
    expect(() =>
      generateIntegrationModule(haloShaped(), { ...opts(), secretEnvPrefix: "HALO-CLIENT" }, DIGEST),
    ).toThrow(expect.objectContaining({ code: "GENERATOR_INVALID_OPTIONS" }));
    expect(() =>
      generateIntegrationModule(haloShaped(), { ...opts(), allowedOrigins: ["http://halo.example.com"] }, DIGEST),
    ).toThrow(expect.objectContaining({ code: "GENERATOR_INVALID_OPTIONS" }));
    expect(() =>
      generateIntegrationModule(haloShaped(), { ...opts(), allowedOrigins: ["http://127.0.0.1:8788/echo"] }, DIGEST),
    ).not.toThrow();
    const evil = JSON.parse(haloShaped());
    evil.info.version = "1.0\ninjected: true";
    const out = generateIntegrationModule(JSON.stringify(evil), opts(), DIGEST);
    expect(out.source).toContain("// Spec version: 1.0 injected: true");
    expect(out.source).toContain("const __GENERATED_SPEC__: OpenApiDocument = {");
  });

  it("generates from a Postman Collection through the same validation path", () => {
    const collection = JSON.stringify({
      info: { name: "HaloPSA lab" },
      item: [
        { name: "Ticket_Get", request: { method: "GET", url: "https://halo-lab.example.com/api/Tickets/{id}" } },
        { name: "Ticket_AddNote", request: { method: "POST", url: { path: ["api", "Tickets", ":id", "Notes"] } } },
      ],
    });
    const out = generateIntegrationModule(collection, opts(), DIGEST);
    expect(out.operationCount).toBe(2);
    expect(out.source).toContain(`"Ticket_Get": "read"`);
    expect(out.source).toContain(`"Ticket_AddNote": "mutation"`);
    expect(out.source).toContain("// Spec version: postman-v2.1");
  });

  it("keeps the CLI on the canonical Postman output", async () => {
    const collection = JSON.stringify({
      info: { name: "HaloPSA lab" },
      item: [{ name: "Ticket_Get", request: { method: "GET", url: "https://halo-lab.example.com/api/Tickets/{id}" } }],
    });
    const digest = await sha256Hex(collection);
    const canonical = generateIntegrationModule(collection, opts(), digest);
    const cli = (await runCommand({
      command: "generate-integration",
      genId: "halo",
      genName: "halo",
      genSpec: collection,
      genOrigins: ["https://halo-lab.example.com"],
    })) as GeneratedCliResult;
    expect(cli.generated.content).toBe(canonical.source);
    expect(cli.generated.operations).toBe(1);
  });

  it("fails loudly on malformed Postman collections", () => {
    expect(() => generateIntegrationModule(JSON.stringify({ info: { name: "e" } }), opts(), DIGEST)).toThrow(
      expect.objectContaining({ code: "GENERATOR_INVALID_SPEC" }),
    );
    expect(() => generateIntegrationModule(JSON.stringify({ info: { name: "e" }, item: [] }), opts(), DIGEST)).toThrow(
      expect.objectContaining({ code: "GENERATOR_INVALID_SPEC" }),
    );
  });
});
