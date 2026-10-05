// SPDX-License-Identifier: AGPL-3.0
// Capability Adapters (issue #262, ADR TBD §3): thin typed modules per
// (Capability, Integration) pair implementing the shared identity-operation
// subset by calling the underlying Integration's Actions. Adapters own no
// credentials, no Connection rows, and no transport — pure call-shaping over
// an already-resolved Connection. Portability is earned per operation: each
// Adapter covers only the operations the proving scenario demonstrates, and
// everything else stays provider-direct (ADR TBD §1 escape hatches).
import {
  AD_INTEGRATION_ID,
  GOOGLEWORKSPACE_INTEGRATION_ID,
  GRAPH_INTEGRATION_ID,
  NINJA_INTEGRATION_ID,
} from "../domain";
import { Fault } from "../domain";
import { addAdUserToGroups, createAdUser, provisionAdMailbox } from "../integrations/ad";
import type { AdTransportSecrets } from "../integrations/ad";
import { addGoogleUserToGroups, createGoogleUser, provisionGoogleMailbox } from "../integrations/googleworkspace";
import { addGraphUserToGroups, createGraphUser, provisionGraphMailbox } from "../integrations/graph";
export interface IdentitySubject {
  readonly givenName: string;
  readonly familyName: string;
  readonly userPrincipalName: string;
}
export interface IdentityCreation {
  readonly userId: string;
  readonly userPrincipalName: string;
}
/** What one Adapter call receives: the already-resolved directory
 * Connection (endpoint only — secrets never reach Adapter code) plus a lazy
 * Transport loader for Adapters that execute through a mechanism rather
 * than direct vendor HTTPS. The loader resolves only when the Adapter
 * invokes it, so direct-HTTPS Adapters never touch it. */
export interface AdapterPorts {
  readonly directory: { readonly endpoint: string };
  readonly loadTransport: () => Promise<{
    readonly connection: { readonly endpoint: string };
    readonly secrets: AdTransportSecrets;
  }>;
  /** The Execution performing the call, when the caller runs inside one:
   * forwarded to Integration Actions so secret material (Transport tokens)
   * registers with the execution-scoped registry before any
   * execution-scoped write (SEC-02). Absent outside executions. */
  readonly executionId?: string;
}
export interface IdentityAdapter {
  readonly id: string;
  readonly revision: string;
  readonly integrationId: string;
  /** The delivery mechanism this Adapter executes through: direct vendor
   * HTTPS, or the NinjaOne agent-mediated Transport for AD. Recorded on
   * the frozen Execution binding so auditors see the mechanism, not just
   * the directory. */
  readonly transport: "direct-https" | "ninjaone";
  /** The Integration whose Connection carries the Transport, resolved
   * optionally from the Execution's own Organization when the Adapter
   * executes through a mechanism. Absent for direct-HTTPS Adapters. */
  readonly transportIntegrationId?: string;
  createIdentity(
    ports: AdapterPorts,
    subject: IdentitySubject,
    operationId: string,
    deadline: number,
  ): Promise<IdentityCreation>;
  assignToGroups(
    ports: AdapterPorts,
    userId: string,
    groups: readonly string[],
    operationId: string,
    deadline: number,
  ): Promise<readonly string[]>;
  provisionMailbox(ports: AdapterPorts, userId: string, operationId: string, deadline: number): Promise<string>;
}
function displayNameOf(subject: IdentitySubject): string {
  return `${subject.givenName} ${subject.familyName}`;
}
const graphIdentityAdapter: IdentityAdapter = {
  id: "graph-identity-v1",
  revision: "graph-identity-v1",
  integrationId: GRAPH_INTEGRATION_ID,
  transport: "direct-https",
  async createIdentity(ports, subject, operationId, deadline) {
    const created = await createGraphUser(
      { endpoint: ports.directory.endpoint },
      { ...subject, displayName: displayNameOf(subject) },
      operationId,
      deadline,
    );
    return { userId: created.id, userPrincipalName: created.userPrincipalName };
  },
  async assignToGroups(ports, userId, groups, operationId, deadline) {
    return (await addGraphUserToGroups({ endpoint: ports.directory.endpoint }, userId, groups, operationId, deadline))
      .assigned;
  },
  async provisionMailbox(ports, userId, operationId, deadline) {
    return (await provisionGraphMailbox({ endpoint: ports.directory.endpoint }, userId, operationId, deadline)).mailbox;
  },
};
const googleIdentityAdapter: IdentityAdapter = {
  id: "googleworkspace-identity-v1",
  revision: "googleworkspace-identity-v1",
  integrationId: GOOGLEWORKSPACE_INTEGRATION_ID,
  transport: "direct-https",
  async createIdentity(ports, subject, operationId, deadline) {
    const created = await createGoogleUser(
      { endpoint: ports.directory.endpoint },
      { ...subject, displayName: displayNameOf(subject) },
      operationId,
      deadline,
    );
    return { userId: created.id, userPrincipalName: created.userPrincipalName };
  },
  async assignToGroups(ports, userId, groups, operationId, deadline) {
    return (await addGoogleUserToGroups({ endpoint: ports.directory.endpoint }, userId, groups, operationId, deadline))
      .assigned;
  },
  async provisionMailbox(ports, userId, operationId, deadline) {
    return (await provisionGoogleMailbox({ endpoint: ports.directory.endpoint }, userId, operationId, deadline))
      .mailbox;
  },
};
const adIdentityAdapter: IdentityAdapter = {
  id: "ad-identity-v1",
  revision: "ad-identity-v1",
  integrationId: AD_INTEGRATION_ID,
  transport: "ninjaone",
  transportIntegrationId: NINJA_INTEGRATION_ID,
  async createIdentity(ports, subject, operationId, deadline) {
    const transport = await ports.loadTransport();
    const created = await createAdUser(
      transport.connection.endpoint,
      transport.secrets,
      { endpoint: ports.directory.endpoint },
      { ...subject, displayName: displayNameOf(subject) },
      operationId,
      ports.executionId,
      deadline,
    );
    return { userId: created.id, userPrincipalName: created.userPrincipalName };
  },
  async assignToGroups(ports, userId, groups, operationId, deadline) {
    const transport = await ports.loadTransport();
    return (
      await addAdUserToGroups(
        transport.connection.endpoint,
        transport.secrets,
        { endpoint: ports.directory.endpoint },
        userId,
        groups,
        operationId,
        ports.executionId,
        deadline,
      )
    ).assigned;
  },
  async provisionMailbox(ports, userId, operationId, deadline) {
    const transport = await ports.loadTransport();
    return (
      await provisionAdMailbox(
        transport.connection.endpoint,
        transport.secrets,
        { endpoint: ports.directory.endpoint },
        userId,
        operationId,
        ports.executionId,
        deadline,
      )
    ).mailbox;
  },
};
/** Resolve the identity Adapter for a capability-bound Connection by its
 * Integration id. The key is the frozen binding's Integration — environment
 * state, never an org/provider branch in Saga source. Unknown Integrations
 * fail loud: silently falling back to another provider's Adapter would
 * execute against the wrong directory. */
export function identityAdapterFor(integrationId: string): IdentityAdapter {
  if (integrationId === GRAPH_INTEGRATION_ID) return graphIdentityAdapter;
  if (integrationId === GOOGLEWORKSPACE_INTEGRATION_ID) return googleIdentityAdapter;
  if (integrationId === AD_INTEGRATION_ID) return adIdentityAdapter;
  throw new Fault(500, "UNKNOWN_IDENTITY_ADAPTER", "No identity Adapter exists for this Integration.");
}
