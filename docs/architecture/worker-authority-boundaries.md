# ADR TBD: Split Workers by authority boundary

- **Status:** Proposed
- **Date:** 2026-09-12
- **Amends:** ADR 008 — Full-stack app on a single Worker
- **Related:** ADR 001 — Saga, Execution, and Operation execution model; ADR 003 — Integrations and Connections; ADR 005 — Secret storage; ADR 014 — Access authentication; ADR 015 — Organization lifecycle

## Context

Wrangnarök began with a deliberately simple deployment model: one Cloudflare Worker serves the browser application and JSON API while Cloudflare Workflows, D1, and other bindings provide the durable platform underneath it.

That choice was appropriate for the MVP. It minimized infrastructure, deployment coordination, and Cloudflare primitive count while the product contract was still being established.

The application is now developing materially different authority domains inside that one Worker:

1. **Edge and product control plane**
   - browser UI and static assets;
   - public HTTP/API routing;
   - Cloudflare Access identity verification;
   - Organization membership and administration;
   - Saga, Connection, Trigger, Form, policy, and other product configuration;
   - admission to privileged operations.

2. **Execution plane**
   - Execution admission after authorization;
   - D1 Execution/Operation state transitions;
   - Cloudflare Workflow creation and control;
   - Saga execution;
   - Integration invocation;
   - retries, cancellation, recovery, and execution policy enforcement.

3. **Potential connector/tool execution plane**
   - OpenAPI/code-mode Integration execution;
   - credential mediation;
   - outbound request policy;
   - future agent-directed tool calls.

Keeping all of these authorities in one Worker makes the boundaries primarily conventions in source code. A route-local mistake can therefore accidentally gain access to bindings or implementation capabilities that it did not conceptually need.

This has already become strategically relevant. Temporary authorization mechanisms and caller-supplied marker headers have reached privileged execution-related paths during implementation. The correct fix for those individual paths is canonical authorization, but the broader architecture should also make privilege mistakes harder to express.

At the same time, Wrangnarök must not turn a useful isolation boundary into a conventional microservice decomposition. Feature-level Worker proliferation would add deployment ordering, compatibility contracts, observability complexity, local-development burden, and additional Worker invocations without materially improving the security model.

Cloudflare Service Bindings provide a private Worker-to-Worker boundary without requiring a public HTTP service. By default the bound Workers execute locally within Cloudflare's runtime rather than introducing a conventional network hop.

The question is therefore not whether Wrangnarök should become a collection of microservices. The question is whether its major **authority boundaries should become deployment boundaries**.

## Decision

Wrangnarök will evolve from one general-purpose Worker toward a **small number of Workers split by authority boundary, not by product feature**.

The initial target is two Workers:

```text
                       Internet
                          |
                          v
               +---------------------+
               |  Edge / Control     |
               |  Plane Worker       |
               |                     |
               | UI + static assets  |
               | HTTP API            |
               | Access identity     |
               | Organizations       |
               | Product config      |
               | Authorization       |
               +----------+----------+
                          |
                   Service Binding
                   typed internal API
                          |
                          v
               +---------------------+
               |  Execution Plane    |
               |  Worker             |
               |                     |
               | Execution admission |
               | Workflow bindings   |
               | Saga runtime        |
               | Operation state     |
               | Cancellation        |
               | Recovery            |
               | Integration invoke  |
               +---------------------+
```

A third **Connector/Tool Execution Worker** may be extracted later if the code-mode/OpenAPI capability demonstrates that credential mediation and arbitrary Integration execution warrant their own authority boundary.

It is **not part of the initial split**.

### 1. Edge / Control Plane Worker

The existing full-stack Worker becomes the public Edge / Control Plane Worker.

It remains responsible for:

- Workers Static Assets and the React application;
- all public HTTP routes;
- Cloudflare Access identity verification;
- construction of the canonical authenticated principal;
- Organization membership and management;
- user-facing authorization checks;
- configuration CRUD;
- Saga catalog/product discovery;
- Connection metadata and secret references;
- Trigger/Form/UI surfaces;
- admission validation before execution requests cross the boundary.

The public internet MUST NOT directly address the Execution Plane Worker.

ADR 008 therefore remains authoritative for the **UI + public API being one full-stack Worker**, but no longer requires all backend execution authority to live in that same deployment.

### 2. Execution Plane Worker

The Execution Plane Worker owns runtime authority.

It is responsible for:

- creating and controlling Cloudflare Workflow instances;
- the canonical ADR 001 Execution creation/recovery protocol;
- execution and Operation state transitions;
- Saga runtime dispatch;
- cancellation and runtime status inspection;
- retry and execution-policy enforcement;
- execution-time Integration calls until/unless a Connector Worker is justified;
- runtime-specific bindings and secrets.

Bindings that grant execution authority SHOULD exist only on this Worker unless another Worker has a demonstrated requirement for them.

In particular, the Edge Worker should not retain Workflow-control bindings merely for convenience after the execution boundary is established.

### 3. Service Binding is the only normal control-plane-to-runtime path

The Edge Worker communicates with the Execution Worker through a Cloudflare Service Binding.

No public hostname, bearer-token-authenticated internal REST API, or second internet-facing ingress is introduced for this purpose.

The internal interface SHOULD use typed RPC where placement requirements do not argue otherwise.

The interface must remain coarse-grained. Examples include:

```ts
runtime.startExecution(principal, request)
runtime.cancelExecution(principal, executionId)
runtime.getRuntimeStatus(principal, executionId)
```

It SHOULD NOT expose D1-shaped CRUD or low-level Workflow primitives such as:

```ts
runtime.updateExecutionRow(...)
runtime.workflowCreate(...)
runtime.setStatus(...)
```

The Worker boundary represents a domain/authority boundary, not merely a source-code relocation.

### 4. Authentication and authorization remain distinct responsibilities

The Edge Worker is the sole normal verifier of internet-originating identity.

It converts Cloudflare Access identity into Wrangnarök's canonical server-side principal and performs public-route authorization.

The Execution Worker MUST NOT:

- inspect caller-supplied authorization marker headers;
- derive privilege from arbitrary HTTP headers forwarded from the browser;
- accept an Organization or user identity directly from an untrusted public request;
- expose a public path that bypasses the Edge Worker.

Crossing a Service Binding is not, by itself, sufficient authorization for every runtime operation.

The Execution Worker remains responsible for enforcing runtime/domain invariants appropriate to the requested operation. Privileged runtime actions must consume the canonical principal/authorization contract rather than inventing route-local identity or capability shims.

Where a security-sensitive operation can cheaply re-resolve authoritative Organization or policy state from canonical persistence, it SHOULD do so rather than trusting duplicated mutable claims.

### 5. Persistence ownership follows authority where practical

Splitting Workers does **not** imply splitting databases.

Wrangnarök retains the existing D1 persistence model unless another ADR establishes a reason to change it.

However, bindings SHOULD follow least authority.

The intended direction is:

- Control Plane owns configuration mutations.
- Execution Plane owns Execution/Operation runtime mutations.
- Both may read shared D1 state where required by the established contracts.
- Schema and migrations remain one coordinated application concern.

A Worker split MUST NOT create two competing authoritative persistence paths for the same state transition.

Existing ADRs remain authoritative for domain semantics regardless of which Worker executes them.

### 6. Secrets remain references across boundaries

The Worker split must reinforce ADR 005 rather than introduce secret transport.

The Control Plane SHOULD manipulate secret metadata/references.

Execution-time secret material SHOULD be resolved only in the Worker that requires it.

Raw secret values MUST NOT be passed through the browser, persisted into Execution output/history, or unnecessarily serialized across Worker boundaries.

If the future Connector/Tool Worker is extracted, credential resolution should preferentially move with Integration execution so the Execution Worker can invoke a capability without receiving reusable credential material.

### 7. Do not split by feature

The following are explicitly **not** justification for another Worker on their own:

- Forms;
- Triggers;
- Organizations;
- Saga catalog;
- audit views;
- policy CRUD;
- individual Integration providers;
- dashboard/history UI;
- one particular external API;
- convenience for a single implementation lane.

A new Worker requires a demonstrated boundary in at least one of:

- authority/trust;
- secret access;
- resource bindings;
- independent failure containment;
- materially different placement requirements;
- independently scaled/executed workload;
- a platform constraint that cannot reasonably be handled within an existing Worker.

When none applies, keep the capability as a module inside the appropriate Worker.

### 8. Worker count is intentionally constrained

The architectural target is **2 Workers initially and no more than approximately 3–5 platform Workers without a new steward decision**.

This is a guardrail, not a requirement to reach that number.

Every additional Service Binding call consumes part of Cloudflare's Worker-invocation/subrequest budget. Runtime call graphs therefore SHOULD remain shallow.

A normal user request should ideally cross at most one internal Worker boundary.

This is intentionally different from conventional fine-grained microservices.

### 9. Cloudflare Free remains a hard constraint

This decision does not relax the Cloudflare Free design constraint.

Before the split is accepted as implemented, the project must verify that:

- Service Binding usage fits Free-plan behavior and limits;
- expected invocation multiplication remains inside request/subrequest limits;
- no newly required primitive silently introduces a paid dependency;
- deployment count and CI behavior remain practical;
- local development/testing works without requiring paid infrastructure.

A design that needs many Worker hops to complete ordinary requests fails this ADR even if it technically remains inside platform limits.

### 10. Placement is not a reason for the initial split

The initial split is justified by authority and binding isolation, not geographic optimization.

Service Bindings currently make Worker-to-Worker calls inexpensive, but placement semantics differ between fetch handlers and RPC/named entrypoints.

Wrangnarök MUST NOT make correctness depend on Smart Placement behavior.

If external Integration latency later demonstrates a meaningful placement requirement, that can influence whether a call uses RPC, `fetch()`, or a separate Connector Worker. Such a change should be measured rather than assumed.

### 11. Deployment compatibility becomes an explicit contract

Separating deployable Workers introduces version skew.

Changes to an internal Service Binding contract therefore use expand/migrate/contract sequencing:

1. deploy the callee with a backward-compatible addition;
2. deploy the caller that consumes it;
3. remove the old contract only after all callers have migrated.

Internal RPC types SHOULD live in a shared package/module so caller and callee compile against one source-level contract.

A deployment must fail closed when a required compatible runtime service is unavailable. It must not silently fall back to a second execution implementation in the Edge Worker.

### 12. Recovery has one authoritative path

The split must preserve ADR 001 recovery semantics.

Moving Workflow bindings into the Execution Worker must move the complete canonical execution creation/recovery protocol with them.

The Edge Worker must not:

- write an Execution row and independently ask the Execution Worker to dispatch it;
- maintain its own retry/reconciler path;
- fall back to direct Workflow creation;
- reinterpret ambiguous runtime failures.

The Execution Worker owns that protocol atomically to the same extent the current single-Worker implementation does.

This prevents the Worker split from creating competing authoritative paths for dispatch and recovery.

## Initial migration

This ADR does not authorize a broad feature lane.

The split should occur as **spine/hardening work** only after the current steward/simplicity checkpoint permits it.

Migration should be incremental:

### Stage 1 — define the boundary inside the monolith

Before deploying another Worker:

- define the typed Runtime service interface;
- route execution admission/control through that interface internally;
- eliminate route-local access to Workflow bindings where possible;
- identify the minimum bindings required by each side;
- add tests for the authority boundary.

This provides architectural value even before physical separation.

### Stage 2 — extract the Execution Worker

Move behind a Service Binding:

- ADR 001 execution creation/recovery;
- Workflow bindings;
- Workflow runtime entrypoints;
- execution cancellation/control;
- runtime-specific D1 writes;
- execution-time Integration invocation.

Keep the browser, public API, Organization management, and product configuration in the Edge Worker.

### Stage 3 — remove duplicate authority

After the extraction is proven:

- remove runtime-only bindings from the Edge Worker;
- delete compatibility/fallback execution paths;
- verify no public route reaches runtime authority except through the canonical service contract;
- update the platform diagram and steward checklist.

### Stage 4 — evaluate Connector isolation only from evidence

Do not create a Connector/Tool Worker merely because the architecture permits one.

Revisit the boundary when code-mode/OpenAPI execution can demonstrate one or more of:

- materially broader credential access than the Saga runtime should possess;
- user/agent-directed arbitrary outbound calls;
- a useful outbound allow/deny policy boundary;
- different placement requirements;
- meaningful blast-radius reduction.

## Required invariants

After implementation, the platform must satisfy:

1. There is exactly one internet-facing application Worker.
2. There is exactly one canonical identity-verification path.
3. There is exactly one canonical Organization authorization model.
4. There is exactly one canonical Execution creation/recovery path.
5. Only the runtime authority owns normal Workflow control.
6. Browser-controlled headers cannot create internal privilege.
7. Secret values cross Worker boundaries only when explicitly required.
8. An unavailable runtime service fails closed; it never activates a duplicate local execution path.
9. Splitting a feature into another Worker requires authority/platform evidence, not code-organization preference.
10. The architecture remains viable under the Cloudflare Free constraint.

These invariants should be included in the recurring steward checkpoint.

## Consequences

### Positive

- Binding access becomes an enforceable security boundary rather than only a source convention.
- Public/product code can no longer accidentally use Workflow authority once those bindings are removed.
- Execution code receives a clearer ownership boundary.
- Runtime recovery semantics remain centralized.
- A future code-mode Connector boundary has a natural place to emerge if justified.
- UI/API remain simple and co-deployed.
- Service Bindings avoid introducing a conventional internal network/API tier.
- Deployment units better reflect actual trust domains.

### Negative

- There are now at least two deployment artifacts.
- Internal interface compatibility and deployment ordering matter.
- Local development requires multiple Worker processes/configurations.
- Observability must correlate requests across Worker boundaries.
- Each Service Binding invocation consumes platform invocation/subrequest budget.
- Shared D1 access requires discipline so deployable separation does not become competing state ownership.
- Integration tests must cover version/boundary failures that did not exist in the monolith.

### Neutral / deliberately deferred

- D1 is not split.
- Organizations are not split into their own Worker.
- Authentication is not split into a dedicated auth Worker.
- Integration execution initially remains with the Execution Worker.
- No new Queue, Durable Object, R2, KV, Workers for Platforms, or other primitive is justified by this ADR.
- Smart Placement is not required.
- This ADR does not itself authorize Phase 4–6 product breadth.

## Rejected alternatives

### Keep one Worker indefinitely

Simpler operationally, but increasingly leaves high-value authority boundaries dependent on coding convention. The existing application is approaching the point where binding minimization provides meaningful defense in depth.

Rejected as the long-term target.

### Worker per subsystem or feature

Examples would include separate Workers for auth, Organizations, Forms, Triggers, policy, Saga catalog, audit, and individual Integrations.

This creates microservice coordination costs without corresponding trust boundaries and increases Worker invocation depth.

Rejected.

### Separate authentication Worker

Cloudflare Access already provides the external identity boundary. Wrangnarök still needs domain authorization and Organization membership inside the application.

A dedicated auth Worker would add a hop while making the distinction between authentication and authorization less clear.

Rejected unless a later multi-application use case demonstrates a shared authentication service requirement.

### Public internal REST services

Exposing the Execution Worker on a hostname and authenticating calls using application-managed bearer credentials would add secret management, network exposure, and another authentication mechanism where Cloudflare already provides Service Bindings.

Rejected.

### Split D1 by Worker

Deployment separation does not require persistence separation. Splitting the database now would introduce synchronization and transactional problems without a demonstrated scaling or tenancy need.

Rejected.

### Extract Connector/Tool Worker immediately

The anticipated security boundary is plausible, particularly for code-mode/OpenAPI execution, but the capability is not mature enough to prove the shape of that boundary.

Deferred until evidence exists.

## Steward review triggers

Revisit this ADR if any of the following occurs:

- normal request paths regularly require more than two internal Worker hops;
- Service Binding invocation limits materially constrain the product;
- Free-plan limits make the split materially less viable than the monolith;
- D1 binding breadth prevents useful least-authority isolation;
- Integration/tool execution gains materially broader secret or outbound authority;
- Workers for Platforms or dynamic user-authored execution becomes a serious candidate;
- placement requirements make RPC unsuitable for a major runtime path;
- deployment/version coordination becomes a recurring source of incidents;
- another Worker is proposed without a clear authority/platform boundary.

The default response to growing product breadth should remain **more modules, not more Workers**.
