// SPDX-License-Identifier: AGPL-3.0
// LIMITS-01 local load/isolation evidence (issue #177): a deterministic
// workload of 3 Organizations x 3 system.smoke executions (9 Workflow
// instances) against the real local workerd/D1/Workflow harness — no
// handwritten platform mocks, no vendor fetch, no deployment.
//
// Per Organization the lane proves cross-Organization isolation (a foreign
// execution detail request answers 404 without touching the Workflow
// binding; history exposes only the caller's own executions and omits
// input/result), per-run Free-tier budget fit, and the exact deterministic
// aggregate (instances 9, steps 36, D1 reads 36, D1 writes 72). It emits
// exactly one WRANGNAROK_LOCAL_LOAD JSON line labeled "locally measured":
// local runtime counters, never Cloudflare provider billing or production
// quota evidence. The payload carries no wall-clock fields, so the emitted
// line is deterministic; no timing thresholds are asserted.
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { executionId, smokeSaga } from "../src/domain";
import { USAGE_VERSION } from "../src/usage";
import { trackWorkflowInstance, useWorkflowHarness } from "./helpers/workflow-harness";

const bindings = env as unknown as Bindings;
const BEARER = `Bearer ${"a".repeat(64)}`;
// Vitest-configured fixture identity: pinned so the per-request lane
// identities below never trigger the LAB bootstrap path — every lane
// Organization and membership row is inserted explicitly.
const FIXTURE_USER_ID = "00000000-0000-4000-8000-000000000002";

interface LaneOrg {
  readonly name: string;
  readonly orgId: string;
  readonly userId: string;
}

const ORGS: readonly LaneOrg[] = [
  {
    name: "limits-load-a",
    orgId: "a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a1",
    userId: "b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b1",
  },
  {
    name: "limits-load-b",
    orgId: "a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a2",
    userId: "b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b2",
  },
  {
    name: "limits-load-c",
    orgId: "a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a3",
    userId: "b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b3",
  },
] as const;

const RUNS_PER_ORG = 3;
// Existing per-run smoke budgets (test/smoke.test.ts): the deterministic
// smoke path reports reads 4, writes 8, steps 4, instances 1, so the lane
// aggregates are instances 9, steps 36, reads 36, writes 72.
const PER_RUN_BUDGETS = { d1Reads: 10, d1Writes: 20, workflowSteps: 10, workflowInstances: 1 } as const;
const EXPECTED = { instances: 9, steps: 36, reads: 36, writes: 72 } as const;

function orgEnv(org: LaneOrg, extra?: Partial<Bindings>): Bindings {
  return {
    ...bindings,
    ...extra,
    LAB_ORG_ID: org.orgId,
    LAB_USER_ID: org.userId,
    LAB_FIXTURE_USER_ID: FIXTURE_USER_ID,
  };
}

function submitRequest(key: string): Request {
  return new Request("https://local.test/api/executions", {
    method: "POST",
    headers: { Authorization: BEARER, "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ sagaId: smokeSaga.id, input: {} }),
  });
}

function detailRequest(id: string): Request {
  return new Request(`https://local.test/api/executions/${id}`, { method: "GET", headers: { Authorization: BEARER } });
}

function historyRequest(): Request {
  return new Request("https://local.test/api/executions", { method: "GET", headers: { Authorization: BEARER } });
}

interface UsageObservation {
  readonly version: string;
  readonly saga: string;
  readonly executionId: string;
  readonly orgId: string;
  readonly d1: { readonly reads: number; readonly writes: number; readonly operationRows: number };
  readonly workflows: { readonly instancesStarted: number; readonly stepsExecuted: number };
}

useWorkflowHarness(bindings.DB, {
  // system.smoke has no vendor boundary: any outbound fetch is a failure.
  setup: () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("system.smoke must not fetch");
    });
  },
});

it("runs 3 orgs x 3 smoke executions with isolation and budget evidence", async () => {
  const stamp = new Date().toISOString();
  // Explicit Organization and membership records behind every per-request
  // identity: org admins (active, ordinary) so the Saga execute grant
  // resolves through the org-admin allow, never by absence.
  for (const org of ORGS) {
    await bindings.DB.prepare(
      "INSERT INTO organizations(id,name,status,created_at,disabled_at) VALUES (?,?,'active',?,NULL)",
    )
      .bind(org.orgId, org.name, stamp)
      .run();
    await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
      .bind(org.userId, stamp)
      .run();
    await bindings.DB.prepare(
      "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,'admin','active','ordinary',?,?)",
    )
      .bind(org.orgId, org.userId, stamp, stamp)
      .run();
  }
  for (const org of ORGS) {
    const membership = await bindings.DB.prepare("SELECT role,status FROM org_memberships WHERE org_id=? AND user_id=?")
      .bind(org.orgId, org.userId)
      .first<{ role: string; status: string }>();
    expect(membership).toMatchObject({ role: "admin", status: "active" });
  }

  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  try {
    // One distinct Idempotency-Key per request across the whole workload.
    const keys: string[] = [];
    const idsByOrg: string[][] = [];
    for (let o = 0; o < ORGS.length; o += 1) {
      const org = ORGS[o] as LaneOrg;
      const ids: string[] = [];
      for (let r = 0; r < RUNS_PER_ORG; r += 1) {
        const key = `limits-load-org${o}-run${r}`;
        keys.push(key);
        const id = await executionId({ orgId: org.orgId, userId: org.userId }, key);
        const { inner: instance } = await trackWorkflowInstance(bindings.SMOKE_WORKFLOW, id);
        const accepted = await worker.fetch(submitRequest(key), orgEnv(org));
        expect(accepted.status).toBe(202);
        expect(accepted.headers.get("Location")).toBe(`/api/executions/${id}`);
        expect(await accepted.json()).toMatchObject({ executionId: id, replayed: false });
        await instance.waitForStatus("complete");
        ids.push(id);
      }
      idsByOrg.push(ids);
    }
    expect(new Set(keys).size).toBe(ORGS.length * RUNS_PER_ORG);

    // Every run reaches Succeeded under its own Organization identity, and
    // each run fits the existing per-run smoke budgets.
    const usageById = new Map<string, UsageObservation>();
    for (const line of lines) {
      if (!line.startsWith("WRANGNAROK_USAGE ")) continue;
      const observation = JSON.parse(line.replace("WRANGNAROK_USAGE ", "")) as UsageObservation;
      usageById.set(observation.executionId, observation);
    }
    let totalSteps = 0;
    let totalReads = 0;
    let totalWrites = 0;
    let totalInstances = 0;
    for (let o = 0; o < ORGS.length; o += 1) {
      const org = ORGS[o] as LaneOrg;
      for (const id of idsByOrg[o] as string[]) {
        const detail = await worker.fetch(detailRequest(id), orgEnv(org));
        expect(detail.status).toBe(200);
        const body = (await detail.json()) as { status: string; orgId: string; userId: string };
        expect(body.status).toBe("Succeeded");
        expect(body.orgId).toBe(org.orgId);
        expect(body.userId).toBe(org.userId);
        const usage = usageById.get(id);
        expect(usage).toBeDefined();
        expect(usage).toMatchObject({
          version: USAGE_VERSION,
          saga: "system.smoke",
          executionId: id,
          orgId: org.orgId,
        });
        const d1 = (usage as UsageObservation).d1;
        const workflows = (usage as UsageObservation).workflows;
        expect(d1.reads).toBeLessThanOrEqual(PER_RUN_BUDGETS.d1Reads);
        expect(d1.writes).toBeLessThanOrEqual(PER_RUN_BUDGETS.d1Writes);
        expect(workflows.stepsExecuted).toBeLessThanOrEqual(PER_RUN_BUDGETS.workflowSteps);
        expect(workflows.instancesStarted).toBe(PER_RUN_BUDGETS.workflowInstances);
        totalSteps += workflows.stepsExecuted;
        totalReads += d1.reads;
        totalWrites += d1.writes;
        totalInstances += workflows.instancesStarted;
      }
    }
    // Exact deterministic aggregate proposed by the audit.
    expect(totalInstances).toBe(EXPECTED.instances);
    expect(totalSteps).toBe(EXPECTED.steps);
    expect(totalReads).toBe(EXPECTED.reads);
    expect(totalWrites).toBe(EXPECTED.writes);

    // Cross-Organization isolation: a foreign execution detail request
    // answers 404 without touching the Workflow binding, and history
    // exposes only the caller's own executions with no input/result.
    for (let o = 0; o < ORGS.length; o += 1) {
      const org = ORGS[o] as LaneOrg;
      const foreignId = (idsByOrg[(o + 1) % ORGS.length] as string[])[0] as string;
      let workflowTouched = false;
      const target = bindings.SMOKE_WORKFLOW;
      const guarded = new Proxy(target, {
        get(t, p, r) {
          const value = Reflect.get(t, p, r);
          if (typeof value === "function" && (p === "get" || p === "create" || p === "createBatch")) {
            return (...args: unknown[]) => {
              workflowTouched = true;
              return (value as (...callArgs: unknown[]) => unknown).apply(t, args);
            };
          }
          return typeof value === "function" ? value.bind(t) : value;
        },
      });
      const foreign = await worker.fetch(detailRequest(foreignId), orgEnv(org, { SMOKE_WORKFLOW: guarded }));
      expect(foreign.status).toBe(404);
      expect(workflowTouched).toBe(false);

      const history = await worker.fetch(historyRequest(), orgEnv(org));
      expect(history.status).toBe(200);
      const text = await history.text();
      expect(text).not.toContain('"input"');
      expect(text).not.toContain('"result"');
      const page = JSON.parse(text) as {
        executions: { executionId: string; orgId: string; userId: string }[];
      };
      expect(page.executions).toHaveLength(RUNS_PER_ORG);
      expect(page.executions.map((row) => row.executionId).sort()).toEqual([...(idsByOrg[o] as string[])].sort());
      for (const row of page.executions) {
        expect(row.orgId).toBe(org.orgId);
        expect(row.userId).toBe(org.userId);
      }
      for (let f = 0; f < ORGS.length; f += 1) {
        if (f === o) continue;
        for (const foreignOwned of idsByOrg[f] as string[]) {
          expect(text).not.toContain(foreignOwned);
        }
      }
    }

    // The evidence line bypasses the capture above: it must reach the test
    // output, not the lines array. The payload is fully deterministic (no
    // wall-clock fields); the emission count proves exactly-one delivery.
    const loadLine = `WRANGNAROK_LOCAL_LOAD ${JSON.stringify({
      version: "wrangnarok.local-load.v1",
      evidenceClass: "locally measured",
      workload: { organizations: ORGS.length, executionsPerOrg: RUNS_PER_ORG, instances: EXPECTED.instances },
      totals: { instances: totalInstances, steps: totalSteps, d1Reads: totalReads, d1Writes: totalWrites },
      perRunBudgets: {
        d1Reads: PER_RUN_BUDGETS.d1Reads,
        d1Writes: PER_RUN_BUDGETS.d1Writes,
        workflowSteps: PER_RUN_BUDGETS.workflowSteps,
        workflowInstances: PER_RUN_BUDGETS.workflowInstances,
      },
      isolation: {
        crossOrgDetail: 404,
        workflowBindingUntouched: true,
        historyScopedPerOrg: true,
        historyOmitsInputResult: true,
      },
      billing:
        "Local workerd/D1/Workflow application-observed counters only; not Cloudflare provider billing meters and not production quota evidence. Deployed D1 meta plus Workers analytics metering still requires deployment authority.",
    })}`;
    originalLog(loadLine);
    // Exactly-one contract: the call above is the only LOAD writer, and the
    // capture proves no second LOAD line leaked anywhere else.
    expect(lines.filter((line) => line.startsWith("WRANGNAROK_LOCAL_LOAD "))).toHaveLength(0);
    expect(JSON.parse(loadLine.replace("WRANGNAROK_LOCAL_LOAD ", ""))).toEqual({
      version: "wrangnarok.local-load.v1",
      evidenceClass: "locally measured",
      workload: { organizations: 3, executionsPerOrg: 3, instances: 9 },
      totals: { instances: 9, steps: 36, d1Reads: 36, d1Writes: 72 },
      perRunBudgets: { d1Reads: 10, d1Writes: 20, workflowSteps: 10, workflowInstances: 1 },
      isolation: {
        crossOrgDetail: 404,
        workflowBindingUntouched: true,
        historyScopedPerOrg: true,
        historyOmitsInputResult: true,
      },
      billing:
        "Local workerd/D1/Workflow application-observed counters only; not Cloudflare provider billing meters and not production quota evidence. Deployed D1 meta plus Workers analytics metering still requires deployment authority.",
    });
  } finally {
    console.log = originalLog;
  }
  expect(fetch).not.toHaveBeenCalled();
}, 120000);
