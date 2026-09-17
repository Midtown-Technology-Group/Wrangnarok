// SPDX-License-Identifier: AGPL-3.0
// SEC-01 (issue #145): execution-scoped secret registration and universal
// substring scrubbing. The registry mechanism (src/secrets.ts) plus the
// write-time/egress wiring is proven here: pure unit coverage of the
// scrubber contract (nested, substrings in URLs/headers/vendor bodies,
// short-secret and encoding limits, cycle handling, per-Execution
// isolation), then live Workflow/D1 evidence with mocked vendor HTTP only.
// Fixture secrets only — never production credentials.
import { describe, expect, it } from "vitest";
import {
  clearAllExecutionSecrets,
  clearExecutionSecrets,
  deploymentSecretsFromEnv,
  getExecutionSecrets,
  MIN_SCRUB_SECRET_LENGTH,
  registerExecutionSecrets,
  SCRUB_PLACEHOLDER,
  scrubExecutionError,
  scrubExecutionText,
  scrubExecutionValue,
  scrubTextWithDeploymentSecrets,
  scrubTextWithSecrets,
  scrubValueWithDeploymentSecrets,
  scrubValueWithSecrets,
} from "../src/secrets";

const SECRET = "test-client-secret-sentinel";
const TOKEN = "test-access-token-sentinel";
// PR #406 credential (issue #411): the Cloudflare deployment token must meet
// the same Worker-isolate scrub bar as the NinjaOne credential.
const CF_TOKEN = "test-cloudflare-token-sentinel";
const ID = "id-for-isolation-probe";
const OTHER = "other-execution-probe";

describe("execution secret registry (SEC-01)", () => {
  it("scrubs nested and embedded substrings, never exact-match only", () => {
    clearAllExecutionSecrets();
    registerExecutionSecrets(ID, [SECRET, TOKEN]);
    // URL, header, and vendor-error embeddings of both the credential and the token.
    expect(scrubExecutionText(ID, `https://vendor.invalid/login?secret=${SECRET}&next=/`)).toBe(
      `https://vendor.invalid/login?secret=${SCRUB_PLACEHOLDER}&next=/`,
    );
    expect(scrubExecutionText(ID, `Bearer ${TOKEN} rejected`)).toBe(`Bearer ${SCRUB_PLACEHOLDER} rejected`);
    expect(scrubExecutionText(ID, `vendor says invalid_client ${SECRET}`)).not.toContain(SECRET);
    // Nested structures, including object keys.
    const nested = { outer: [{ url: `x${SECRET}y`, headers: { Authorization: `Bearer ${TOKEN}` } }] };
    const scrubbed = scrubExecutionValue(nested, ID);
    expect(JSON.stringify(scrubbed)).not.toContain(SECRET);
    expect(JSON.stringify(scrubbed)).not.toContain(TOKEN);
    expect(JSON.stringify(scrubbed)).toContain(SCRUB_PLACEHOLDER);
    // Error envelopes.
    const error = scrubExecutionError({ code: `E_${SECRET}`, message: `token ${TOKEN} leaked` }, ID);
    expect(`${error.code} ${error.message}`).not.toContain(SECRET);
    expect(`${error.code} ${error.message}`).not.toContain(TOKEN);
    clearExecutionSecrets(ID);
  });

  it("keeps registries isolated per Execution and clears on settle", () => {
    clearAllExecutionSecrets();
    registerExecutionSecrets(ID, [SECRET]);
    registerExecutionSecrets(OTHER, [TOKEN]);
    expect(scrubExecutionText(ID, SECRET)).toBe(SCRUB_PLACEHOLDER);
    // One Execution's credential never scrubs (or leaks into) another's view.
    expect(scrubExecutionText(OTHER, SECRET)).toBe(SECRET);
    expect(scrubExecutionText(ID, TOKEN)).toBe(TOKEN);
    expect(getExecutionSecrets(ID)).toEqual([SECRET]);
    clearExecutionSecrets(ID);
    // Settled Executions leave nothing behind for a reused isolate.
    expect(getExecutionSecrets(ID)).toEqual([]);
    expect(scrubExecutionText(ID, SECRET)).toBe(SECRET);
    clearExecutionSecrets(OTHER);
  });

  it("defines the short-secret, encoding, and cycle limits explicitly", () => {
    clearAllExecutionSecrets();
    // Short secrets are not substring-scrubbed: scrubbing "ab" would redact
    // the database. Protection there is shaping, not replacement.
    expect(MIN_SCRUB_SECRET_LENGTH).toBe(8);
    registerExecutionSecrets(ID, ["ab", SECRET]);
    expect(getExecutionSecrets(ID)).toEqual([SECRET]);
    expect(scrubExecutionText(ID, "cab ride")).toBe("cab ride");
    // Encodings are out of scope: only raw UTF-8 substrings are replaced.
    const encoded = btoa(SECRET);
    expect(encoded).not.toBe(SECRET);
    expect(scrubTextWithSecrets(encoded, [SECRET])).toBe(encoded);
    // Cycles terminate through the identity map instead of hanging.
    const cyclic: { self?: unknown; secret?: string } = { secret: SECRET };
    cyclic.self = cyclic;
    const scrubbed = scrubValueWithSecrets(cyclic, [SECRET]) as typeof cyclic;
    expect(scrubbed.secret).toBe(SCRUB_PLACEHOLDER);
    expect(scrubbed.self).toBe(scrubbed);
    // Deployment-secret helper covers the Worker HTTP isolate, which never
    // sees Workflow-registered tokens.
    const env = {
      NINJA_CLIENT_ID: "test-client-id",
      NINJA_CLIENT_SECRET: SECRET,
      CLOUDFLARE_API_TOKEN: CF_TOKEN,
    };
    expect(deploymentSecretsFromEnv(env)).toContain(SECRET);
    expect(deploymentSecretsFromEnv(env)).toContain(CF_TOKEN);
    expect(scrubTextWithDeploymentSecrets(`Bearer ${CF_TOKEN} rejected`, env)).toBe(
      `Bearer ${SCRUB_PLACEHOLDER} rejected`,
    );
    expect(deploymentSecretsFromEnv({})).toEqual([]);
    clearExecutionSecrets(ID);
  });

  it("covers the five deployment-global AI provider keys on every shared surface", () => {
    // AI-01 secret-scrub gap (issue #164, ADR 032 v0): the five provider
    // API keys are deployment-global bindings (Bindings extends
    // AiProviderCredentials). The Worker HTTP isolate scrubs with
    // deploymentSecretsFromEnv, so each key must be registered there —
    // otherwise errors, serialized responses, and audit/log rows built
    // from env could carry raw key material. Safe test sentinels only.
    const aiKeys = {
      OPENAI_API_KEY: "test-openai-api-key-sentinel",
      ANTHROPIC_API_KEY: "test-anthropic-api-key-sentinel",
      GOOGLE_API_KEY: "test-google-api-key-sentinel",
      OPENROUTER_API_KEY: "test-openrouter-api-key-sentinel",
      OPENAI_COMPATIBLE_API_KEY: "test-openai-compatible-key-sentinel",
    };
    const values = Object.values(aiKeys);
    // Registry enumeration: every key is governed by the shared scrubber.
    const registered = deploymentSecretsFromEnv(aiKeys);
    for (const value of values) expect(registered).toContain(value);
    for (const value of values) {
      // Error envelopes: a vendor-shaped failure embedding the key.
      const error = scrubValueWithDeploymentSecrets(
        { error: { code: `PROVIDER_FAILED with ${value}`, message: `probe rejected ${value}` } },
        aiKeys,
      );
      expect(JSON.stringify(error)).not.toContain(value);
      expect(JSON.stringify(error)).toContain(SCRUB_PLACEHOLDER);
      // Serialized responses: keys embedded in URLs, headers, and object keys.
      const response = scrubValueWithDeploymentSecrets(
        {
          endpoint: `https://vendor.invalid/v1?key=${value}`,
          headers: { Authorization: `Bearer ${value}` },
          [`note-${value}`]: "carrier",
        },
        aiKeys,
      );
      const serialized = JSON.stringify(response);
      expect(serialized).not.toContain(value);
      expect(serialized).toContain(SCRUB_PLACEHOLDER);
      // Audit/log surfaces: recordAudit scrubs detail with the exact
      // deploymentSecretsFromEnv(env) list the routes pass, so a hostile
      // detail value carrying the key is replaced before the row lands.
      const auditDetail = scrubValueWithDeploymentSecrets(
        { operationId: "op-ai-probe", note: `key material ${value} in detail` },
        aiKeys,
      );
      expect(JSON.stringify(auditDetail)).not.toContain(value);
      expect(scrubTextWithDeploymentSecrets(`WRANGNAROK_USAGE key=${value}`, aiKeys)).not.toContain(value);
    }
  });

  it("never exports secrets through discovery or portable shapes", () => {
    clearAllExecutionSecrets();
    registerExecutionSecrets(ID, [SECRET, TOKEN]);
    // Portable exports carry declarations (names), never values: scrubbing
    // the carrier proves no value rode along.
    const portable = {
      secretFields: ["clientSecret"],
      requiredIntegrations: ["0606e237-137b-4629-8346-85468e1c2df6"],
      note: `uses ${SECRET} and ${TOKEN}`,
    };
    const scrubbed = scrubExecutionValue(portable, ID) as typeof portable;
    expect(scrubbed.secretFields).toEqual(["clientSecret"]);
    expect(`${scrubbed.secretFields.join(",")}:${scrubbed.requiredIntegrations.join(",")}`).not.toContain(
      SCRUB_PLACEHOLDER,
    );
    expect(scrubbed.note).not.toContain(SECRET);
    expect(scrubbed.note).not.toContain(TOKEN);
    clearExecutionSecrets(ID);
  });

  it("covers registry edges: empty registration, array cycles, class pass-through, deployment text", () => {
    clearAllExecutionSecrets();
    // Empty/short-only registration is a no-op (early return): nothing stored.
    registerExecutionSecrets(ID, ["ab", 42, null]);
    expect(getExecutionSecrets(ID)).toEqual([]);
    // Array cycles terminate through the identity map (cached array path).
    const cyclicArr: unknown[] = [SECRET];
    cyclicArr.push(cyclicArr);
    const scrubbedArr = scrubValueWithSecrets(cyclicArr, [SECRET]) as unknown[];
    expect(scrubbedArr[0]).toBe(SCRUB_PLACEHOLDER);
    expect(scrubbedArr[1]).toBe(scrubbedArr);
    // Class instances pass through untouched (never JSON-persisted anyway).
    const instance = new (class {
      constructor(readonly token = TOKEN) {}
    })();
    expect(scrubValueWithSecrets(instance, [TOKEN])).toBe(instance);
    // Deployment-secret text helper covers the Worker HTTP isolate shape.
    const env = {
      NINJA_CLIENT_ID: "test-client-id",
      NINJA_CLIENT_SECRET: SECRET,
      CLOUDFLARE_API_TOKEN: CF_TOKEN,
    };
    expect(scrubTextWithDeploymentSecrets(`id test-client-id secret ${SECRET}`, env)).toBe(
      `id ${SCRUB_PLACEHOLDER} secret ${SCRUB_PLACEHOLDER}`,
    );
    expect(scrubTextWithDeploymentSecrets(`token ${CF_TOKEN} in vendor body`, env)).not.toContain(CF_TOKEN);
    expect(scrubTextWithDeploymentSecrets("clean", {})).toBe("clean");
    clearExecutionSecrets(ID);
  });
});
