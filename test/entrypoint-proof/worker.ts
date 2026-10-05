// SPDX-License-Identifier: AGPL-3.0
// Native-entrypoint proof worker (issue #416): a test-only workerd worker
// whose PROOF_WORKFLOW binding targets a makeSagaWorkflow-generated
// subclass. Booted only by the entrypoint-proof vitest project with the
// sibling wrangler.jsonc — never deployed, never in the app config.
import { makeSagaWorkflow } from "../../src/sagas/shared";
import { proofSagaDef } from "./saga";

/** The generated subclass under proof: a one-line named subclass, exactly
 * the shape every migrated Saga adapter takes. workerd resolves the
 * wrangler `class_name` "ProofWorkflow" to this export. */
export class ProofWorkflow extends makeSagaWorkflow(proofSagaDef) {}

export default {
  async fetch(): Promise<Response> {
    return new Response("entrypoint-proof worker: workflows only", { status: 404 });
  },
};
