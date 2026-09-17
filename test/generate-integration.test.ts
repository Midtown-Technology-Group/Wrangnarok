// SPDX-License-Identifier: AGPL-3.0
// INT-01 (issue #229): generator tests. Pure node-safe: no bindings, no D1,
// no Workflows, no vendor HTTP. A Halo-shaped fixture proves the exit:
// converts to a compiling-shaped module or fails loudly with the gap.
import { describe, expect, it } from "vitest";
import { runCommand, validateAndGenerate } from "../scripts/wrangnarok.mjs";
import { runGenerateIntegration } from "../scripts/wrangnarok-core.mjs";
import { Fault } from "../src/domain";
import { GENERATOR_EMBED_BYTES_MAX, generateIntegrationModule } from "../src/generate-integration";
import { defineIntegration } from "../src/integrations/index";
import { applySpecOverlay, detectGeneratorAuthKind, indexOperations, integrationUuidV5 } from "../src/openapi";
import type { OpenApiDocument } from "../src/openapi";
import { HALO_REAL_OVERLAY } from "../src/integrations/halo";
import haloRealFixtureText from "./fixtures/halo-real-spec-excerpt.json?raw";

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
    components: {
      securitySchemes: {
        HaloOAuth: {
          type: "oauth2",
          flows: { clientCredentials: { tokenUrl: "https://halo-lab.example.com/auth/token", scopes: {} } },
        },
      },
    },
    security: [{ HaloOAuth: [] }],
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
    expect(out.source).toContain(`export const HALO_INTEGRATION_ID = "${integrationUuidV5(DIGEST)}";`);
    expect(out.source).toContain(`// Spec digest: ${DIGEST}`);
    expect(out.source).toContain("// Spec version: halo-lab-1");
    expect(out.source).toContain(`"Ticket_Get": "read"`);
    expect(out.source).toContain(`"Ticket_Delete": "destructive"`);
    expect(out.source).toContain(`"Ticket_AddNote": "mutation"`);
    expect(out.source).toContain(`"https://halo-lab.example.com"`);
    expect(out.source).toContain("executeHaloOperation");
    expect(out.source).toContain("scrubValueWithSecrets");
    expect(out.source).toContain("buildProvenance");
    // OAuth fixture keeps the client-credentials shape (Halo proof stays green).
    expect(out.source).toContain("// Auth kind: clientCredentials");
    expect(out.source).toContain("clientSecret");
    expect(out.source).toContain("requestClientCredentialsToken");
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

  it("generates from the overlay-corrected real HaloPSA excerpt (TOOL-01 S2)", async () => {
    const raw = JSON.parse(haloRealFixtureText) as { spec: OpenApiDocument };
    // The real excerpt declares the vendor's http Bearer [REDACTED] so the auth kind
    // is detected from the bytes, never assumed.
    expect(detectGeneratorAuthKind(raw.spec)).toBe("apiToken");
    // Uncorrected, the real bytes fail closed (missing operationIds).
    expect(() => generateIntegrationModule(JSON.stringify(raw.spec), { ...opts(), id: "halo-real" }, DIGEST)).toThrow(
      expect.objectContaining({ code: "GENERATOR_INVALID_SPEC" }),
    );
    // Overlay-corrected, the same bytes generate deterministically.
    const overlaid = await applySpecOverlay(raw.spec, HALO_REAL_OVERLAY);
    expect(overlaid.overlayDigest).toMatch(/^[a-f0-9]{64}$/);
    const specText = JSON.stringify(overlaid.doc);
    const first = generateIntegrationModule(specText, { ...opts(), id: "halo-real" }, DIGEST);
    const second = generateIntegrationModule(specText, { ...opts(), id: "halo-real" }, DIGEST);
    expect(second.source).toBe(first.source);
    expect(first.operationCount).toBe(4);
    expect(first.source).toContain("// Auth kind: apiToken");
    expect(first.source).toContain("Authorization: `Bearer ${apiToken}`");
    expect(first.source).toContain(`"Ticket_Delete": "destructive"`);
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
    // Collections declare a bearer scheme: bearer shape, never OAuth fields.
    expect(out.source).toContain("// Auth kind: apiToken");
    expect(out.source).toContain("apiToken");
    expect(out.source).not.toContain("clientSecret");
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

  it("detects bearer schemes and emits the bearer shape (fix 1)", () => {
    const bearer = {
      openapi: "3.0.3",
      info: { version: "1.0.0", title: "Bearer API" },
      components: { securitySchemes: { BearerAuth: { type: "http", scheme: "bearer", bearerFormat: "dnkey" } } },
      security: [{ BearerAuth: [] }],
      paths: { "/v1/things": { get: { operationId: "Things_List", summary: "List things." } } },
    };
    expect(detectGeneratorAuthKind(bearer)).toBe("apiToken");
    const out = generateIntegrationModule(JSON.stringify(bearer), { ...opts(), id: "bearer" }, DIGEST);
    expect(out.source).toContain("// Auth kind: apiToken");
    expect(out.source).toContain("Authorization: `Bearer ${apiToken}`");
    expect(out.source).not.toContain("clientSecret");
    expect(out.source).not.toContain("requestClientCredentialsToken");
    // Bearer timeouts map to the vendor-timeout Fault like the OAuth host.
    expect(out.source).toContain('throw new Fault(504, "BEARER_VENDOR_TIMEOUT", "The vendor exceeded its deadline.");');
    // apiKey and basic schemes share the bearer shape (single token, never OAuth).
    const apiKey = {
      openapi: "3.0.3",
      info: { version: "1.0.0" },
      components: { securitySchemes: { Key: { type: "apiKey", in: "header", name: "X-Key" } } },
      security: [{ Key: [] }],
      paths: { "/v1/things": { get: { operationId: "Things_List" } } },
    };
    expect(detectGeneratorAuthKind(apiKey)).toBe("apiToken");
    const basic = {
      openapi: "3.0.3",
      info: { version: "1.0.0" },
      components: { securitySchemes: { Basic: { type: "http", scheme: "basic" } } },
      security: [{ Basic: [] }],
      paths: { "/v1/things": { get: { operationId: "Things_List" } } },
    };
    expect(detectGeneratorAuthKind(basic)).toBe("apiToken");
    // Declared-but-unreferenced schemes never select the kind (fail closed).
    expect(
      detectGeneratorAuthKind({
        openapi: "3.0.3",
        info: { version: "1.0.0" },
        components: { securitySchemes: { BearerAuth: { type: "http", scheme: "bearer" } } },
        paths: { "/v1/things": { get: { operationId: "Things_List" } } },
      }),
    ).toBe("unknown");
    // Heterogeneous requirements (one host, two credential shapes) fail closed.
    expect(
      detectGeneratorAuthKind({
        openapi: "3.0.3",
        info: { version: "1.0.0" },
        components: {
          securitySchemes: {
            BearerAuth: { type: "http", scheme: "bearer" },
            O: { type: "oauth2", flows: { clientCredentials: { tokenUrl: "https://x.example/token", scopes: {} } } },
          },
        },
        security: [{ BearerAuth: [] }, { O: [] }],
        paths: { "/v1/things": { get: { operationId: "Things_List" } } },
      }),
    ).toBe("unknown");
    // Unresolved references fail closed (never stamp a shape for a scheme
    // the spec does not declare).
    expect(
      detectGeneratorAuthKind({
        openapi: "3.0.3",
        info: { version: "1.0.0" },
        components: { securitySchemes: { BearerAuth: { type: "http", scheme: "bearer" } } },
        security: [{ Missing: [] }],
        paths: { "/v1/things": { get: { operationId: "Things_List" } } },
      }),
    ).toBe("unknown");
  });

  it("detects OAuth client-credentials and keeps existing OAuth specs working (fix 1)", () => {
    expect(detectGeneratorAuthKind(JSON.parse(haloShaped()))).toBe("clientCredentials");
    const implicit = {
      openapi: "3.0.3",
      info: { version: "1.0.0" },
      components: {
        securitySchemes: {
          Implicit: {
            type: "oauth2",
            flows: { implicit: { authorizationUrl: "https://x.example/auth", scopes: {} } },
          },
        },
      },
      security: [{ Implicit: [] }],
      paths: { "/v1/things": { get: { operationId: "Things_List" } } },
    };
    expect(detectGeneratorAuthKind(implicit)).toBe("unknown");
    expect(() => generateIntegrationModule(JSON.stringify(implicit), { ...opts(), id: "implicit" }, DIGEST)).toThrow(
      expect.objectContaining({ code: "GENERATOR_INVALID_OPTIONS" }),
    );
    // Branch cover: unresolved references fail closed, never skipped.
    expect(
      detectGeneratorAuthKind({
        openapi: "3.0.3",
        info: { version: "1.0.0" },
        components: { securitySchemes: { BearerAuth: { type: "http", scheme: "bearer" } } },
        security: [{ Missing: [] }],
        paths: { "/v1/things": { get: { operationId: "Things_List" } } },
      }),
    ).toBe("unknown");
    // Missing, malformed, and empty flows fail closed: only an explicit
    // clientCredentials-capable grant selects the OAuth shape.
    for (const flows of [{}, undefined, null, ["x"]]) {
      expect(
        detectGeneratorAuthKind({
          openapi: "3.0.3",
          info: { version: "1.0.0" },
          components: { securitySchemes: { O: { type: "oauth2", ...(flows === undefined ? {} : { flows }) } } },
          security: [{ O: [] }],
          paths: { "/v1/things": { get: { operationId: "Things_List" } } },
        }),
      ).toBe("unknown");
    }
    expect(
      detectGeneratorAuthKind({
        openapi: "3.0.3",
        info: { version: "1.0.0" },
        components: { securitySchemes: { O: { type: "oauth2", flows: { authorizationCode: {} } } } },
        security: [{ O: [] }],
        paths: { "/v1/things": { get: { operationId: "Things_List" } } },
      }),
    ).toBe("unknown");
    // No security blocks at all: never guess bearer from silence.
    // Undeclared references stay unknown even when bearer-shaped.
    expect(
      detectGeneratorAuthKind({
        openapi: "3.0.3",
        info: { version: "1.0.0" },
        security: [{ ServiceToken: [] }],
        paths: { "/v1/things": { get: { operationId: "Things_List" } } },
      }),
    ).toBe("unknown");
    expect(
      detectGeneratorAuthKind({
        openapi: "3.0.3",
        info: { version: "1.0.0" },
        security: [{ SessionCookie: [] }],
        paths: { "/v1/things": { get: { operationId: "Things_List" } } },
      }),
    ).toBe("unknown");
    // Per-operation references select the kind when top-level is absent.
    expect(
      detectGeneratorAuthKind({
        openapi: "3.0.3",
        info: { version: "1.0.0" },
        components: { securitySchemes: { BearerAuth: { type: "http", scheme: "bearer" } } },
        paths: {
          "/v1/things": {
            get: { operationId: "Things_List", security: [{ BearerAuth: [] }] },
          },
        },
      }),
    ).toBe("apiToken");
    // Malformed security blocks (non-arrays, non-objects) stay unknown.
    expect(
      detectGeneratorAuthKind({
        openapi: "3.0.3",
        info: { version: "1.0.0" },
        security: "bearer",
        paths: {
          "/v1/things": {
            get: { operationId: "Things_List", security: [{ Bad: [] }, null, "x"] },
          },
        },
      }),
    ).toBe("unknown");
  });

  it("fails closed on unknown schemes and mismatched overrides (fix 1)", () => {
    const bare = JSON.stringify({
      openapi: "3.0.3",
      info: { version: "v1" },
      paths: { "/a": { get: { operationId: "A_Get" } } },
    });
    expect(() => generateIntegrationModule(bare, { ...opts(), id: "bare" }, DIGEST)).toThrow(
      expect.objectContaining({ code: "GENERATOR_INVALID_OPTIONS" }),
    );
    const bearer = JSON.stringify({
      openapi: "3.0.3",
      info: { version: "v1" },
      components: { securitySchemes: { BearerAuth: { type: "http", scheme: "bearer" } } },
      security: [{ BearerAuth: [] }],
      paths: { "/a": { get: { operationId: "A_Get" } } },
    });
    // Mismatched override fails closed; agreeing override passes.
    expect(() =>
      generateIntegrationModule(bearer, { ...opts(), id: "bare", authKind: "clientCredentials" }, DIGEST),
    ).toThrow(expect.objectContaining({ code: "GENERATOR_INVALID_OPTIONS" }));
    expect(() => generateIntegrationModule(bearer, { ...opts(), id: "bare", authKind: "unknown" }, DIGEST)).toThrow(
      expect.objectContaining({ code: "GENERATOR_INVALID_OPTIONS" }),
    );
    expect(() =>
      generateIntegrationModule(bearer, { ...opts(), id: "bare", authKind: "apiToken" }, DIGEST),
    ).not.toThrow();
    // OAuth-only options on a bearer spec are a caller error, not ignored.
    expect(() =>
      generateIntegrationModule(bearer, { ...opts(), id: "bare", tokenPath: "/oauth/token" }, DIGEST),
    ).toThrow(expect.objectContaining({ code: "GENERATOR_INVALID_OPTIONS" }));
  });

  it("derives a deterministic UUIDv5 Integration ID from the spec digest (fix 2)", () => {
    const first = integrationUuidV5(DIGEST);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(integrationUuidV5(DIGEST)).toBe(first);
    expect(integrationUuidV5("cd".repeat(32))).not.toBe(first);
    expect(() => integrationUuidV5("not-hex")).toThrow(expect.objectContaining({ code: "GENERATOR_INVALID_OPTIONS" }));
    const out = generateIntegrationModule(haloShaped(), opts(), DIGEST);
    expect(out.source).toContain(`export const HALO_INTEGRATION_ID = "${first}";`);
    // The emitted UUID registers: defineIntegration requires a stable UUID.
    expect(() =>
      defineIntegration({
        id: first,
        name: "halo-generated",
        description: "Generator regression proof.",
        secretFields: ["clientSecret"],
        configSchema: [
          {
            name: "endpoint",
            type: "string",
            required: true,
            maxLength: 512,
            description: "Provider origin.",
          },
        ],
        requiredSecrets: ["clientSecret"],
        secretEnvVars: { clientSecret: "HALO_GENERATED_CLIENT_SECRET" },
        health: { testHint: "Probe the generated provider.", remediation: "Check the endpoint and retry." },
      }),
    ).not.toThrow();
  });

  it("excludes deprecated operations by default with an opt-in flag (fix 3)", () => {
    const spec = {
      openapi: "3.0.3",
      info: { version: "v1", title: "Deprecations" },
      components: { securitySchemes: { BearerAuth: { type: "http", scheme: "bearer" } } },
      security: [{ BearerAuth: [] }],
      paths: {
        "/v1/old": { get: { operationId: "Old_Get", summary: "Old.", deprecated: true } },
        "/v1/new": { get: { operationId: "New_Get", summary: "New." } },
      },
    };
    const text = JSON.stringify(spec);
    expect(indexOperations(spec).map((op) => op.operationId)).toEqual(["New_Get"]);
    expect(
      indexOperations(spec, {}, { includeDeprecated: true })
        .map((op) => op.operationId)
        .sort(),
    ).toEqual(["New_Get", "Old_Get"]);
    const excluded = generateIntegrationModule(text, { ...opts(), id: "dep" }, DIGEST);
    expect(excluded.operationCount).toBe(1);
    expect(excluded.source).not.toContain(`"Old_Get":`);
    // The embedded literal keeps the deprecated op (pinned contract evidence)
    // but it is never callable: no classification entry, no search hit.
    const embedded = JSON.parse(
      excluded.source.match(/__GENERATED_SPEC__: OpenApiDocument = (\{.*?\});\n\nasync function pinnedSpec/s)?.[1] ??
        "{}",
    ) as { paths: Record<string, Record<string, { operationId?: string }>> };
    expect(embedded.paths["/v1/old"]?.get?.operationId).toBe("Old_Get");
    expect(indexOperations(embedded, {})).toHaveLength(1);
    const included = generateIntegrationModule(text, { ...opts(), id: "dep", includeDeprecated: true }, DIGEST);
    expect(included.operationCount).toBe(2);
    expect(included.source).toContain(`"Old_Get": "read"`);
    // The opt-in flag threads into every generated runtime indexing call so
    // the advertised classifications stay executable and searchable.
    expect(included.source).toContain("DEP_CLASSIFICATIONS, { includeDeprecated: true }");
    expect(included.source).not.toContain("DEP_CLASSIFICATIONS, {}");
    expect(excluded.source).toContain("DEP_CLASSIFICATIONS, {}");
    expect(excluded.source).not.toContain("DEP_CLASSIFICATIONS, { includeDeprecated: true }");
  });

  it("keeps the embedded spec under the documented budget via the strip policy (fix 4)", () => {
    expect(GENERATOR_EMBED_BYTES_MAX).toBe(96 * 1024);
    const fat = {
      openapi: "3.0.3",
      info: { version: "v1" },
      components: { securitySchemes: { BearerAuth: { type: "http", scheme: "bearer" } } },
      security: [{ BearerAuth: [] }],
      paths: {
        "/v1/things": {
          get: {
            operationId: "Things_List",
            summary: "List.",
            description: "d".repeat(2000),
            responses: { 200: { description: "ok", content: { "application/json": { example: { big: true } } } } },
          },
        },
      },
      "x-vendor": { huge: true },
    };
    const out = generateIntegrationModule(JSON.stringify(fat), { ...opts(), id: "fat" }, DIGEST);
    const embedded =
      out.source.match(/__GENERATED_SPEC__: OpenApiDocument = (\{.*?\});\n\nasync function pinnedSpec/s)?.[1] ?? "";
    expect(new TextEncoder().encode(embedded).length).toBeLessThanOrEqual(GENERATOR_EMBED_BYTES_MAX);
    expect(embedded).not.toContain("example");
    expect(embedded).not.toContain("x-vendor");
    expect(embedded).toContain("[truncated]");
    // A stripped spec still over budget fails closed instead of emitting.
    const enormous = {
      openapi: "3.0.3",
      info: { version: "v1" },
      components: { securitySchemes: { BearerAuth: { type: "http", scheme: "bearer" } } },
      security: [{ BearerAuth: [] }],
      paths: Object.fromEntries(
        Array.from({ length: 1200 }, (_, i) => [
          `/v1/thing${i}`,
          {
            get: {
              operationId: `Thing${i}_Get`,
              summary: `Thing ${i}.`,
              description: `Description for thing ${i} with enough text to pad the literal.`,
            },
          },
        ]),
      ),
    };
    expect(() => generateIntegrationModule(JSON.stringify(enormous), { ...opts(), id: "fat" }, DIGEST)).toThrow(
      expect.objectContaining({ code: "GENERATOR_INVALID_SPEC" }),
    );
  });

  it("keeps the CLI on the canonical bearer output (fix 1 parity)", async () => {
    const bearer = JSON.stringify({
      openapi: "3.0.3",
      info: { version: "1.0.0", title: "Bearer API" },
      components: { securitySchemes: { BearerAuth: { type: "http", scheme: "bearer" } } },
      security: [{ BearerAuth: [] }],
      paths: { "/v1/things": { get: { operationId: "Things_List", summary: "List things." } } },
    });
    const digest = await sha256Hex(bearer);
    const canonical = generateIntegrationModule(bearer, { ...opts(), id: "bearer", name: "bearer" }, digest);
    const cli = (await runCommand({
      command: "generate-integration",
      genId: "bearer",
      genName: "bearer",
      genSpec: bearer,
      genOrigins: ["https://halo-lab.example.com"],
    })) as GeneratedCliResult;
    expect(cli.generated.content).toBe(canonical.source);
    expect(cli.generated.content).toContain("// Auth kind: apiToken");
    expect(cli.generated.content).not.toContain("clientSecret");
  });
});
