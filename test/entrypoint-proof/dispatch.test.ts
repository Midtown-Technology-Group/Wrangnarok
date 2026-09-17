// SPDX-License-Identifier: AGPL-3.0
// ADR-033-5 native-entrypoint proof (issue #416): the makeSagaWorkflow
// product dispatches as a valid native Workflow entrypoint — binding +
// class_name + dispatch, not just typecheck.
//
// This file runs ONLY in the entrypoint-proof vitest project (a test-only
// workerd worker booted from ./wrangler.jsonc, never deployed): env carries
// the PROOF_WORKFLOW binding whose class_name "ProofWorkflow" resolves to
// the makeSagaWorkflow-generated subclass in ./worker.ts. The test creates
// a native instance, waits for terminal status through the engine, and
// asserts the D1 terminal row the proof Saga wrote.
import { env } from "cloudflare:workers";
import { WorkflowEntrypoint } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { PROOF_SAGA_ID, PROOF_SAGA_REVISION, proofSagaDef } from "./saga";
import { ProofWorkflow } from "./worker";
import { trackWorkflowInstance, useWorkflowHarness } from "../helpers/workflow-harness";

interface ProofEnv {
  readonly DB: D1Database;
  readonly PROOF_WORKFLOW: Workflow;
}

const proofEnv = env as unknown as ProofEnv;
const orgId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";

useWorkflowHarness(proofEnv.DB, { seed: false });

describe("makeSagaWorkflow native-entrypoint proof (issue #416)", () => {
  it("generates a named WorkflowEntrypoint subclass bound to the definition", () => {
    // The named-subclass contract: the factory product sits between the
    // exported class and the native base, so wrangler class_name targets
    // and re-exports keep working while the adapter body stays generated.
    expect(Object.getPrototypeOf(ProofWorkflow)).not.toBe(WorkflowEntrypoint);
    expect(Object.getPrototypeOf(Object.getPrototypeOf(ProofWorkflow))).toBe(WorkflowEntrypoint);
    expect(ProofWorkflow.name).toBe("ProofWorkflow");
    expect(typeof ProofWorkflow.prototype.run).toBe("function");
    expect(proofSagaDef.id).toBe(PROOF_SAGA_ID);
  });

  it("exposes the PROOF_WORKFLOW binding from the proof worker config", () => {
    expect(typeof proofEnv.PROOF_WORKFLOW?.create).toBe("function");
  });

  it("dispatches the generated subclass to terminal success through the engine", async () => {
    const id = "dd".repeat(32);
    await proofEnv.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        id,
        PROOF_SAGA_ID,
        "entrypoint-proof",
        PROOF_SAGA_REVISION,
        orgId,
        userId,
        JSON.stringify({ marker: "proof-marker" }),
        1,
        "Pending",
        new Date().toISOString(),
      )
      .run();
    const tracked = await trackWorkflowInstance(proofEnv.PROOF_WORKFLOW, id);
    await proofEnv.PROOF_WORKFLOW.create({ id, params: { executionId: id } });
    await tracked.inner.waitForStatus("complete");
    const row = await proofEnv.DB.prepare("SELECT status,result_json FROM executions WHERE id=?")
      .bind(id)
      .first<{ status: string; result_json: string | null }>();
    // The terminal row proves the engine resolved binding -> class_name ->
    // exported subclass and ran THIS definition: the output marker echoes
    // the dispatched input through the helper-owned persist interior.
    expect(row?.status).toBe("Succeeded");
    expect(row?.result_json ? JSON.parse(row.result_json) : null).toEqual({
      ready: true,
      marker: "proof-marker",
    });
    const ops = await proofEnv.DB.prepare("SELECT name,status FROM operations WHERE execution_id=? ORDER BY position")
      .bind(id)
      .all<{ name: string; status: string }>();
    expect(ops.results.map((op) => `${op.name}:${op.status}`)).toEqual(["prepare-input-v1:Succeeded"]);
  });
});
