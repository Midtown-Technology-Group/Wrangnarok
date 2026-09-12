// Validation and preflight coverage for src/solutions.ts: every manifest
// rejection arm, the version comparator matrix, org-scoped installs, and the
// fenced reconcile conflict. Pure validator tests need no D1; install paths
// run against real local D1 through the full migration chain.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Bindings } from "../src/bindings";
import { ECHO_INTEGRATION_ID, echoSaga } from "../src/domain";
import { compareVersions, installBundle, parseBundleManifest, updateConnectionEndpoint } from "../src/solutions";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration3 from "../migrations/0003_usage_blocks.sql?raw";
import migration4 from "../migrations/0004_solutions_install.sql?raw";
import migration5 from "../migrations/0010_solutions_activation.sql?raw";

const bindings = env as unknown as Bindings;
const BUNDLE_ID = "b10a7c2e-3f4d-4a5b-8c6d-7e8f9a0b1c2d";
const ENDPOINT_V1 = "http://127.0.0.1:8788/echo";
const ENDPOINT_V2 = "http://127.0.0.1:8789/echo";
const UNKNOWN_UUID = "00000000-0000-4000-8000-000000000000";

interface MutableManifest {
  manifestVersion: number;
  bundle: { id: string; name: string; version: string };
  sagas: { id: string; revision: string }[];
  integrations: {
    id: string;
    connections: { org: string; config: Record<string, string>; secretsRequired: string[] }[];
  }[];
  config: { key: string; value: string }[];
}

function manifest(version = "1.0.0", endpoint = ENDPOINT_V1): MutableManifest {
  return {
    manifestVersion: 1,
    bundle: { id: BUNDLE_ID, name: "echo-starter", version },
    sagas: [{ id: echoSaga.id, revision: echoSaga.revision }],
    integrations: [
      {
        id: ECHO_INTEGRATION_ID,
        connections: [{ org: "default", config: { endpoint }, secretsRequired: [] }],
      },
    ],
    config: [{ key: "supportEmail", value: "ops@example.com" }],
  };
}

function invalidManifest(value: unknown, code: string) {
  expect(() => parseBundleManifest(value)).toThrow(expect.objectContaining({ code }));
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(migration3);
  await bindings.DB.exec(migration4);
  await bindings.DB.exec(migration5);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

it("rejects malformed manifest envelopes", async () => {
  invalidManifest(null, "INVALID_MANIFEST");
  invalidManifest({ ...manifest(), manifestVersion: 2 }, "INVALID_MANIFEST");
  invalidManifest(
    { ...manifest(), bundle: { id: "nope", name: "echo-starter", version: "1.0.0" } },
    "INVALID_MANIFEST",
  );
  invalidManifest(
    { ...manifest(), bundle: { id: BUNDLE_ID, name: "Bad Name!", version: "1.0.0" } },
    "INVALID_MANIFEST",
  );
  invalidManifest(
    { ...manifest(), bundle: { id: BUNDLE_ID, name: "echo-starter", version: "1.0" } },
    "INVALID_MANIFEST",
  );
  invalidManifest({ ...manifest(), sagas: [] }, "INVALID_MANIFEST");
  invalidManifest({ ...manifest(), sagas: "nope" }, "INVALID_MANIFEST");
  invalidManifest({ ...manifest(), integrations: "nope" }, "INVALID_MANIFEST");
  invalidManifest({ ...manifest(), config: "nope" }, "INVALID_MANIFEST");
});

it("rejects malformed saga pins", async () => {
  const badId = manifest();
  badId.sagas = [{ id: "nope", revision: echoSaga.revision }];
  invalidManifest(badId, "INVALID_MANIFEST");

  const unknown = manifest();
  unknown.sagas = [{ id: UNKNOWN_UUID, revision: "ghost-v1" }];
  invalidManifest(unknown, "UNKNOWN_SAGA");
});

it("rejects malformed integration declarations", async () => {
  const badId = manifest();
  badId.integrations[0]!.id = "nope";
  invalidManifest(badId, "INVALID_MANIFEST");

  const unknown = manifest();
  unknown.integrations[0]!.id = UNKNOWN_UUID;
  invalidManifest(unknown, "UNKNOWN_INTEGRATION");

  const empty = manifest();
  empty.integrations[0]!.connections = [];
  invalidManifest(empty, "INVALID_MANIFEST");
});

it("rejects malformed connections", async () => {
  const cases: Array<(c: MutableManifest["integrations"][0]["connections"][0]) => void> = [
    (c) => (c.org = ""),
    (c) => (c.org = "o".repeat(129)),
    (c) => (c.org = 5 as never),
    (c) => (c.config = "nope" as never),
    (c) => (c.config = { endpoint: "" }),
    (c) => (c.config = { endpoint: 5 as never }),
    (c) => (c.config = { other: "x" }),
    (c) => (c.secretsRequired = "nope" as never),
    (c) => (c.secretsRequired = [5] as never),
  ];
  for (const mutate of cases) {
    const m = manifest();
    mutate(m.integrations[0]!.connections[0]!);
    invalidManifest(m, "INVALID_MANIFEST");
  }
});

it("rejects secrets outside the integration secret schema", async () => {
  const m = manifest();
  m.integrations[0]!.connections[0]!.secretsRequired = ["clientSecret"];
  // Echo declares no secret fields, so the report names the empty schema.
  invalidManifest(m, "SECRET_SCHEMA_MISMATCH");
});

it("rejects malformed top-level config entries", async () => {
  const badKey = manifest();
  badKey.config = [{ key: "", value: "x" }];
  invalidManifest(badKey, "INVALID_MANIFEST");

  const badValue = manifest();
  badValue.config = [{ key: "supportEmail", value: 5 as never }];
  invalidManifest(badValue, "INVALID_MANIFEST");
});

it("compares versions across cores, prereleases, and short forms", async () => {
  expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  expect(compareVersions("2.0.0", "1.0.0")).toBe(1);
  expect(compareVersions("1.0.0", "2.0.0")).toBe(-1);
  expect(compareVersions("1.0.1", "1.0.0")).toBe(1);
  expect(compareVersions("1.0.0", "1.0.0-alpha")).toBe(1);
  expect(compareVersions("1.0.0-alpha", "1.0.0")).toBe(-1);
  expect(compareVersions("1.0.0-a", "1.0.0-b")).toBe(-1);
  expect(compareVersions("1.0.0-b", "1.0.0-a")).toBe(1);
  expect(compareVersions("1", "1.0.0")).toBe(0);
  expect(compareVersions("x.y.z", "1.0.0")).toBe(-1);
});

it("scopes installs to one org and refuses undeclared orgs", async () => {
  const two = manifest();
  two.integrations[0]!.connections.push({
    org: "second",
    config: { endpoint: ENDPOINT_V1 },
    secretsRequired: [],
  });
  const filtered = await installBundle(bindings.DB, two, { orgName: "second" });
  expect(filtered.drift).toEqual({ created: 3, updated: 0, skipped: 0, deleted: 0 });
  expect(filtered.orgIds).toHaveLength(1);
  const missing = await bindings.DB.prepare("SELECT id FROM organizations WHERE name = ?")
    .bind("default")
    .first<{ id: string }>();
  expect(missing).toBeNull();

  await expect(installBundle(bindings.DB, two, { orgName: "ghost" })).rejects.toMatchObject({
    code: "ORG_NOT_DECLARED",
  });
});

it("creates connections for pre-existing org rows", async () => {
  await bindings.DB.prepare("INSERT INTO organizations(id, name) VALUES (?, ?)").bind("org-row-id", "default").run();
  const result = await installBundle(bindings.DB, manifest());
  expect(result.drift).toEqual({ created: 3, updated: 0, skipped: 0, deleted: 0 });
  expect(result.orgIds).toEqual(["org-row-id"]);
});

it("installs configs whose keys order canonically descending", async () => {
  // Reverse-alpha config keys force the canonical serializer through its
  // greater-than arm; the install itself behaves identically.
  const m = manifest();
  m.integrations[0]!.connections[0]!.config = { zebra: "stripes", endpoint: ENDPOINT_V1 };
  const result = await installBundle(bindings.DB, m);
  expect(result.drift).toEqual({ created: 3, updated: 0, skipped: 0, deleted: 0 });
});

it("refuses silent overwrites when the marker changes under install", async () => {
  await installBundle(bindings.DB, manifest("1.0.0", ENDPOINT_V1));
  // Hold the fenced reconcile UPDATE, slip a concurrent writer in, then let
  // the fenced write land on the stale marker: zero rows match, so install
  // fails closed instead of overwriting.
  const gate: { release: (() => void) | null } = { release: null };
  let resolveArrived!: () => void;
  const arrived = new Promise<void>((resolve) => {
    resolveArrived = resolve;
  });
  const gated = new Proxy(bindings.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string, ...rest: unknown[]) => {
          const stmt = (target.prepare as (...args: unknown[]) => D1PreparedStatement)(sql, ...rest);
          if (typeof sql === "string" && sql.includes("SET endpoint = ?")) {
            return {
              bind: (...values: unknown[]) => {
                const bound = stmt.bind(...values);
                return {
                  first: () => bound.first(),
                  all: () => bound.all(),
                  run: () =>
                    new Promise((resolve) => {
                      gate.release = () => resolve(bound.run());
                      resolveArrived();
                    }),
                } as unknown as D1PreparedStatement;
              },
            } as unknown as D1PreparedStatement;
          }
          return stmt;
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? (value as (...args: never[]) => unknown).bind(target) : value;
    },
  }) as D1Database;
  const pending = installBundle(gated, manifest("2.0.0", ENDPOINT_V2));
  await arrived;
  await bindings.DB.prepare("UPDATE connections SET managed_by = ? WHERE managed_by = ?")
    .bind(`${BUNDLE_ID}@1.0.0+tampered`, `${BUNDLE_ID}@1.0.0`)
    .run();
  gate.release?.();
  await expect(pending).rejects.toMatchObject({ status: 409, code: "INSTALL_CONFLICT" });
});

it("reports missing connections on the update path", async () => {
  await expect(
    updateConnectionEndpoint(bindings.DB, "no-such-org", ECHO_INTEGRATION_ID, ENDPOINT_V1),
  ).rejects.toMatchObject({ status: 404, code: "CONNECTION_NOT_FOUND" });
});
