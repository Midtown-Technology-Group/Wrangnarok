// SPDX-License-Identifier: AGPL-3.0
// SEC-02 pre-0029 compatibility (issue #411): Connection management keeps
// working on databases that predate the `connection_secrets` table —
// secrets reads resolve to none and deletes skip the secrets delete —
// while a wrong-shaped table fails loud instead of being mistaken for an
// absent one. Manual partial chain (0001+0004+0007+0011), no harness.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Bindings } from "../src/bindings";
import { CLOUDFLARE_API_BASE, CLOUDFLARE_INTEGRATION_ID } from "../src/domain";
import { deleteConnection, getConnection, listConnections, resolveConnectionSecrets } from "../src/connections";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration4 from "../migrations/0004_solutions_install.sql?raw";
import migration7 from "../migrations/0007_org_membership.sql?raw";
import migration11 from "../migrations/0011_connection_admin.sql?raw";

const bindings = env as unknown as Bindings;
const ORG = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000002";
const caller = { orgId: ORG, userId: USER };
const ROW = "00000000-0000-4000-8000-000000000401";

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration4);
  await bindings.DB.exec(migration7);
  await bindings.DB.exec(migration11);
  await bindings.DB.exec("DROP TABLE IF EXISTS connection_secrets");
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?) ON CONFLICT(id) DO NOTHING")
    .bind(ORG, "Fixture")
    .run();
  await bindings.DB.prepare("DELETE FROM connections WHERE org_id=?").bind(ORG).run();
});

afterEach(reset);

async function seedMapping() {
  await bindings.DB.prepare("INSERT INTO connections(id,org_id,integration_id,endpoint) VALUES (?,?,?,?)")
    .bind(ROW, ORG, CLOUDFLARE_INTEGRATION_ID, CLOUDFLARE_API_BASE)
    .run();
}

describe("pre-0029 chains (SEC-02 tolerance)", () => {
  it("reads resolve to no per-org secrets and deletes skip the secrets delete", async () => {
    await seedMapping();
    expect(await listConnections(bindings.DB, caller)).toMatchObject([{ id: ROW, secretsProvisioned: [] }]);
    expect(await getConnection(bindings.DB, caller, CLOUDFLARE_INTEGRATION_ID)).toMatchObject({
      id: ROW,
      secretsProvisioned: [],
    });
    expect(await resolveConnectionSecrets(bindings.DB, ORG, ROW, { 1: "unused" })).toEqual({});
    await deleteConnection(bindings.DB, caller, CLOUDFLARE_INTEGRATION_ID);
    await expect(getConnection(bindings.DB, caller, CLOUDFLARE_INTEGRATION_ID)).rejects.toMatchObject({
      code: "CONNECTION_NOT_FOUND",
    });
  });

  it("fails loud on a wrong-shaped secrets table instead of treating it as absent", async () => {
    await seedMapping();
    await bindings.DB.exec("CREATE TABLE connection_secrets(bogus TEXT)");
    await expect(listConnections(bindings.DB, caller)).rejects.toThrow();
    await expect(resolveConnectionSecrets(bindings.DB, ORG, ROW, { 1: "unused" })).rejects.toThrow();
    await expect(deleteConnection(bindings.DB, caller, CLOUDFLARE_INTEGRATION_ID)).rejects.toThrow();
    // The mapping itself is untouched by the failed paths.
    await bindings.DB.exec("DROP TABLE connection_secrets");
    expect(await getConnection(bindings.DB, caller, CLOUDFLARE_INTEGRATION_ID)).toMatchObject({ id: ROW });
  });
});
