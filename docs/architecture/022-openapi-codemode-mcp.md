# ADR 022: OpenAPI Code Mode for Agent-Driven Integration Calls

- **Status:** Proposed
- **Date:** 2026-09-11
- **Extends:** ADR 003 (Integrations and Connections), ADR 005 (secret storage), ADR 013 (egress/resource limits), ADR 014/015 (identity and organization authorization), ADR 020 (scoped configuration), ADR 021 (user-code source/runtime)
- **Implements:** issue #170 (TOOL-01)

## Context

Wrangnarok needs two related but distinct agent-facing capabilities:

1. an **inbound MCP surface** so external MCP clients can discover and invoke Wrangnarok-authorized capabilities; and
2. an **outbound vendor API surface** so a Wrangnarok agent can reason over a large provider API and execute calls through the correct Organization-scoped Connection.

The second problem does not scale well if every REST endpoint becomes a handwritten MCP/tool wrapper. Large APIs such as Cloudflare and HaloPSA expose broad OpenAPI descriptions; eagerly materializing hundreds or thousands of endpoint-shaped tools wastes model context, duplicates provider contracts, and creates another surface that can drift from the provider specification.

Cloudflare's Code Mode pattern demonstrates a better shape: keep the OpenAPI document server-side, let the model search/inspect the relevant API operations on demand, then execute a narrowly scoped request through a host-controlled request function. The credential and network authority remain outside model-generated code.

For Wrangnarok, the motivating operator experience is deliberately high level:

> "Using the Halo connection for this customer, find the open tickets assigned to the networking team and add a note to the one for the firewall replacement."

The agent should be able to discover the necessary Halo operations from the Integration's OpenAPI contract and execute them without us first writing one tool per Halo endpoint.

## Decision

### OpenAPI Code Mode is the preferred broad API adapter

For Integrations with a usable OpenAPI 3.x specification, Wrangnarok should prefer a Code Mode adapter over generating or hand-authoring one MCP/tool schema per REST operation.

The logical surface is small and progressive:

```text
Integration OpenAPI spec
        |
        v
  search / inspect
        |
        v
     execute
        |
        v
Wrangnarok policy + Connection resolver
        |
        v
      vendor API
```

The implementation may use Cloudflare's `@cloudflare/codemode` package or an equivalent compatible mechanism. This ADR chooses the architecture and security boundary, not a permanent dependency on one package.

### Integration metadata owns the API contract; Connection owns credentials

An Integration may declare or reference:

- an OpenAPI document and version/digest;
- the allowed base URL(s);
- provider-specific normalization metadata when required;
- operation allow/deny policy or risk classification;
- optional curated semantic helpers for operations that benefit from a stable higher-level abstraction.

An Organization-scoped Connection supplies the actual credential/configuration material.

OpenAPI documents, generated request code, prompts, logs, and model-visible tool results must never contain raw Connection secrets.

### Model-generated code receives capability, not credentials

The sandboxed/model-generated execution environment may construct a request against operations present in the selected Integration contract, but it receives only a controlled request primitive. It does not receive bearer tokens, OAuth refresh tokens, API keys, secret references, or unrestricted `fetch` authority.

The host request path is responsible for:

1. resolving the caller and Organization;
2. resolving the selected Integration and Connection;
3. validating the requested operation against the pinned OpenAPI contract;
4. applying allow/deny and approval policy;
5. enforcing configured base URL and egress constraints;
6. injecting credentials outside model-visible state;
7. applying timeout, redirect, response-size, and retry rules from the Integration contract;
8. auditing the attempted operation and sanitized result.

### Code Mode does not bypass Wrangnarok authorization

`execute` is not a generic HTTP proxy.

Every vendor call must preserve the same Organization, Connection, role/policy, egress, redaction, and audit boundaries as a hand-authored Integration Action or Saga call. A caller that could not invoke an equivalent Integration capability directly must not gain that authority by asking an agent in natural language.

Vendor OAuth and MCP-client authentication remain separate concerns. MCP authenticates the caller to Wrangnarok; the Connection authenticates Wrangnarok to the vendor.

### Read and write operations are policy-distinct

OpenAPI describes request validity, not whether a request is wise.

Wrangnarok therefore classifies operations independently of HTTP method when possible, with method-level defaults as a fallback. Initial policy should be conservative:

- safe reads may be eligible for automatic execution when the caller already has authority;
- mutations require explicit Integration policy and may require interactive approval depending on caller/context;
- destructive, credential, billing, security-boundary, or tenant-administration operations are deny-by-default until explicitly enabled;
- unknown/unclassified operations fail closed.

The policy engine must be able to deny individual OpenAPI `operationId`s even when other operations on the same Integration are permitted.

### Curated semantic tools remain valuable

Code Mode provides breadth, not necessarily the best interface for every recurring task.

Wrangnarok may still expose curated tools/actions such as `create_user`, `onboard_employee`, `deploy_solution`, or `reconcile_customer` when they encode important business semantics, validation, compensation, or multi-call orchestration.

The intended division is:

```text
OpenAPI Code Mode
  broad provider capability discovery and direct API operations

Curated Integration Actions / Sagas
  stable business semantics, orchestration, compensation, policy-rich workflows
```

We should not handwrite endpoint-shaped wrappers merely to mirror an OpenAPI document.

### Inbound MCP and outbound Code Mode are separate layers

Issue #170's inbound MCP gateway remains useful. External agents should be able to discover Wrangnarok capabilities through a compact, standards-compliant MCP surface.

However, Wrangnarok does not need to expose every vendor OpenAPI operation as a first-class MCP tool. An inbound agent can invoke a small Wrangnarok capability that searches/executes against an authorized Integration, while Wrangnarok performs provider discovery and execution internally.

Representative shape:

```text
external MCP client
       |
       v
Wrangnarok MCP gateway
  - search integration API
  - execute integration API operation
  - execute curated Saga/tool
       |
       v
Authorization / Organization / Connection policy
       |
       +--> Halo OpenAPI Code Mode --> Halo API
       +--> other OpenAPI Integration --> vendor API
```

The exact MCP tool naming is deferred; the boundary is not.

## HaloPSA acceptance case

HaloPSA is the first representative large-OpenAPI provider for this design.

A successful proof must demonstrate, against a non-production/lab Halo environment or safely mocked provider harness:

1. register/pin Halo's OpenAPI specification as Integration metadata;
2. configure an Organization-scoped Halo Connection without exposing its secret to the model;
3. give an agent a natural-language request whose required endpoint(s) were not pre-authored as dedicated tools;
4. have the agent search/inspect the Halo API contract and select the correct operation;
5. successfully execute an authorized read operation;
6. successfully execute an explicitly authorized non-destructive mutation;
7. reject an unapproved/destructive or out-of-scope operation;
8. reject cross-Organization Connection selection;
9. prove base-URL/egress restrictions cannot be escaped through crafted OpenAPI input or generated code;
10. record sanitized audit/provenance sufficient to answer which provider operation was executed, for which Organization/Connection identity, by which caller, and under which spec revision.

No endpoint-specific handwritten MCP wrapper may be required for the read or mutation used by this acceptance test.

## OpenAPI contract handling

Provider specifications are untrusted external inputs and may be incomplete or incorrect.

Wrangnarok should:

- pin a spec digest/version for auditable executions;
- validate accepted OpenAPI documents before activation;
- constrain declared server/base URLs to Integration-configured allowlists rather than trusting arbitrary `servers` entries;
- bound spec size and parsing work;
- support local patches/overlays for known provider-spec defects without silently mutating the upstream artifact;
- record the upstream source and any applied overlay digest;
- fail closed when a requested operation cannot be reconciled with the active contract.

A provider without a useful OpenAPI document may use a handwritten Integration client or a smaller authored schema. Code Mode is preferred where it fits, not mandatory for every provider.

## Invariants

1. Raw Connection credentials are never exposed to model-generated code or tool results.
2. Code Mode cannot issue arbitrary network requests outside the selected Integration's allowed origins.
3. Every executable request maps to an operation in the active/pinned Integration contract or an explicitly curated action.
4. Authorization and Organization/Connection scope are checked at execution time, not trusted from model arguments.
5. Unknown, stale, or unclassified write operations fail closed.
6. Provider spec revision/digest is retained in audit/provenance for executed calls.
7. Large OpenAPI surfaces are discovered progressively rather than eagerly materialized into one MCP tool per endpoint.
8. Curated semantic Sagas/Actions coexist with Code Mode; Code Mode does not replace orchestration.
9. Inbound MCP caller authentication and outbound vendor authentication remain separate security boundaries.

## Consequences

### Positive

- Makes very large provider APIs practical for natural-language agent use without thousands of tool schemas.
- Dramatically reduces endpoint-wrapper maintenance and contract drift.
- Lets Halo and similar APIs become useful quickly when their OpenAPI documents are sufficiently complete.
- Preserves Wrangnarok's Connection, tenant-isolation, egress, audit, and secret boundaries.
- Keeps token/context cost roughly proportional to the operations an agent actually needs to inspect.
- Leaves room for stable business-level tools where direct API operations are too low level.

### Costs and risks

- OpenAPI quality becomes a real runtime concern; overlays and validation will need disciplined ownership.
- Search/reason/execute behavior needs adversarial testing against prompt injection in descriptions and malicious/incorrect specs.
- Operation risk classification and approval policy become first-class platform responsibilities.
- Generated-code sandboxing and request mediation are security-critical components.
- Natural-language direct API use can encourage overly low-level automation if we fail to promote repeated multi-step behavior into curated Sagas/Actions.

## Alternatives rejected

### One MCP/tool definition per OpenAPI endpoint

Rejected as the default for large APIs because of context cost, registration complexity, and duplicated contracts.

### Handwritten REST-to-MCP wrappers for every supported provider operation

Rejected. Wrangnarok should not reproduce upstream Bifrost's wrapper-maintenance burden when a provider already publishes a usable machine-readable contract.

### Give the model credentials and unrestricted `fetch`

Rejected. Credential secrecy, origin restrictions, auditability, and policy enforcement require a host-mediated request boundary.

### Use Code Mode as the only Integration abstraction

Rejected. OpenAPI exposes transport-level operations; Wrangnarok still needs curated business semantics, Sagas, compensation, validation, and provider adapters for incomplete/non-OpenAPI systems.

## Deferred decisions

Issue #170 and focused follow-ups own:

- exact Code Mode package/runtime selection and sandbox implementation;
- search/index strategy for specs and whether any preprocessing is persisted;
- OpenAPI overlay format and ownership;
- operation risk-classification schema and approval UX;
- inbound MCP transport/auth details;
- how Code Mode operations appear in agent tool discovery metadata;
- rate-limit and pagination helpers;
- response shaping/truncation for model consumption;
- whether Code Mode execution is available directly to Sagas in addition to agents;
- production readiness criteria after the Halo proof.
