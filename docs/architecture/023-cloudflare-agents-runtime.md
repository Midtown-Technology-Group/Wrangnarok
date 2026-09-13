# ADR 023: Cloudflare Agents SDK as the Platform-Agent Runtime

- **Status:** Proposed
- **Date:** 2026-09-12
- **Extends:** ADR 003 (Integrations and Connections), ADR 005 (secret storage), ADR 013 (egress/resource limits), ADR 014/015 (identity and organization authorization), ADR 020 (scoped configuration), ADR 021 (user-code source/runtime), ADR 022 (OpenAPI Code Mode and MCP)
- **Implements:** AI-02 (user-managed platform agents)

## Context

Wrangnarok needs a first-class platform-agent runtime that is distinct from Sagas.

Sagas are user-authored, durable automations with an explicit execution path and are primarily implemented with Cloudflare Workflows. Agents are goal-directed runtimes that may reason across multiple turns, invoke tools, retain agent-local state, schedule future work, and delegate deterministic work to Sagas.

The current architecture already defines several agent-facing pieces:

- AI provider/model configuration is tracked separately by AI-01;
- ADR 022 defines the agent-facing integration/tool boundary for broad provider APIs, MCP, Code Mode, credential isolation, and policy enforcement;
- D1 remains the shared relational source of truth for platform/workspace state;
- Vectorize is the natural substrate for shared semantic retrieval where needed;
- Workflows remain the preferred runtime for deterministic, durable Saga execution.

What is not yet decided is the runtime substrate for a persistent Wrangnarok Agent itself.

Cloudflare's Agents SDK is designed for persistent stateful agents on Workers. Agent instances are backed by Durable Objects, can retain private SQL-backed state, can maintain durable identity across requests, and can schedule work and participate in long-lived conversations without requiring Wrangnarok to rebuild those lifecycle primitives from scratch. Model selection stays with AI-01 and tool execution stays behind the ADR-022 capability boundary; the SDK provides the Durable Object-backed runtime support only.

Wrangnarok's deployment model is normally single-organization / self-hosted per enterprise, MSP, or end customer. Workspace code and platform agents are therefore trusted operator-owned code within that instance. The purpose of this ADR is not hostile multi-tenant sandboxing; it is to select a durable, Cloudflare-native agent runtime that composes cleanly with the rest of the platform.

## Decision

### Adopt Cloudflare Agents SDK as the preferred platform-agent substrate

Wrangnarok platform agents should be implemented on Cloudflare's Agents SDK unless an acceptance test demonstrates a material gap that cannot be addressed without violating platform invariants.

A Wrangnarok Agent is therefore modeled as a persistent Cloudflare Agent identity backed by a Durable Object.

Representative shape:

```text
Wrangnarok Agent definition
          |
          v
Cloudflare Agents SDK
          |
          v
Durable Object identity
  - agent-local SQL/state
  - schedules / alarms
  - conversation-local state
  - runtime coordination
          |
          +--> Wrangnarok tools/capabilities
          +--> Sagas / Workflows
          +--> model provider via AI-01
```

The Agents SDK is the runtime substrate, not the user-facing programming contract. Wrangnarok should expose its own stable Agent definition/configuration API and keep Cloudflare-specific lifecycle details behind the platform boundary where practical.

### Agents and Sagas remain distinct execution models

Wrangnarok must preserve a hard semantic distinction:

```text
Saga
  deterministic / authored orchestration
  explicit steps
  durable execution
  Cloudflare Workflows

Agent
  goal-directed reasoning
  iterative observation / tool selection
  agent-local persistent state
  Cloudflare Agents SDK + Durable Object
```

Agents may invoke Sagas when a known deterministic process already exists. Repeated multi-step behavior discovered through agent usage should be promoted into a Saga or curated Integration Action when doing so improves repeatability, auditability, safety, or cost.

An Agent must not replace a Saga merely because an LLM can reproduce the same sequence of calls.

### Model provider is independent of agent runtime

Wrangnarok must not equate Cloudflare Agents with Workers AI.

AI-01 owns provider Connections, model profiles, capability assignments, and model-routing policy. An Agent may use Workers AI, OpenAI, Anthropic, another supported provider, or an approved OpenAI-compatible endpoint according to the active model profile.

Conceptually:

```text
Agent runtime
   = Cloudflare Agents SDK

Model provider
   = configured separately by AI-01
```

Workers AI is a first-class Cloudflare-local option and may be a sensible default for some profiles, but it is not a mandatory dependency for the Agent abstraction.

### Agent-local state belongs with the Agent; shared truth does not

The Durable Object / Agents SDK storage attached to an Agent is for state whose natural owner is that Agent instance, such as:

- conversational state;
- scratch/planning state;
- transient tool context that must survive requests;
- agent-local preferences or resumable reasoning state;
- scheduled-agent bookkeeping.

Shared organizational or workspace truth must remain in the shared platform primitives that own it:

```text
D1         -> relational/shared platform and workspace state
Vectorize  -> shared semantic retrieval/index state
R2         -> durable blobs/artifacts
Workflow   -> Saga execution state
Agent DO   -> agent-local state and coordination
```

An Agent should reference shared records by stable identifiers rather than silently copying durable business truth into private agent-local storage. Canonical conversation history lives with AI-03 (durable chat owns the conversation lifecycle); Agent-local conversational state is derived context and cache for the Agent's own coordination, not a second canonical history.

### Agent tools use the existing Wrangnarok capability boundary

Agents do not receive unrestricted secrets or raw vendor credentials.

ADR 022's capability and Code Mode boundary remains authoritative for broad provider API access. Curated Integration Actions, Sagas, MCP capabilities, and approved OpenAPI-backed operations may be exposed to Agents according to Organization, role, Connection, egress, and approval policy.

Representative execution path:

```text
Agent
  |
  +--> curated Wrangnarok tool
  |
  +--> OpenAPI Code Mode adapter
  |       |
  |       v
  |   Connection resolver + policy
  |       |
  |       v
  |   vendor API
  |
  +--> execute Saga
          |
          v
      Workflow
```

The Agent runtime itself must not become a generic credential store or unrestricted network proxy.

### Agent identity is durable and explicitly scoped

Each platform Agent has a stable Wrangnarok identity that maps deterministically to its Cloudflare Agent / Durable Object identity.

The stable identity must be scoped to the owning Wrangnarok instance and Organization boundary. If future deployment modes introduce multiple mutually untrusted tenants inside one Wrangnarok deployment, the identity and authorization model must be revisited before sharing an Agent namespace across those tenants.

Agent definitions should remain Git-owned/code-first where practical, consistent with ADR 021's user-code ownership model. Runtime state remains platform-managed.

### Conversations are not the Agent entity

AI-03 owns durable chat, attachment-aware conversations, safe routing, and conversation lifecycle.

A conversation may route to an Agent, but a conversation is not itself the canonical Agent identity. One Agent may participate in multiple conversations over time, and non-chat triggers may invoke the same Agent.

This distinction allows future triggers such as:

- schedules;
- events/webhooks;
- explicit API calls;
- operator chat;
- another Agent or Saga.

### Human approval remains a policy concern, not a model suggestion

Agents may propose or request operations, but approval-sensitive actions must be enforced by Wrangnarok policy at execution time.

The Agent's generated text or internal reasoning must never be treated as evidence that a privileged action was approved.

The existing authorization, Connection scoping, operation classification, and approval boundaries remain authoritative.

## Initial platform-agent contract

The first AI-02 implementation should prove a deliberately small Agent contract rather than exposing every Agents SDK feature directly.

A representative user-authored definition may eventually resemble:

```ts
export default defineAgent({
  id: "service-desk-investigator",
  modelProfile: "reasoning-default",
  tools: ["halo", "graph", "run-saga"],
  async instructions(ctx) {
    return "Investigate service desk incidents and prefer existing Sagas for deterministic remediation.";
  },
});
```

This is illustrative only. The SDK surface is owned by AI-02 and may differ.

The important boundary is that user code expresses Wrangnarok semantics while the platform maps them to Cloudflare Agents SDK primitives.

## AI-02 acceptance case

The first implementation should demonstrate all of the following against real local/workerd-compatible infrastructure and a safe model/provider configuration:

1. define and register a stable Agent identity;
2. resolve that identity to a persistent Cloudflare Agent / Durable Object instance;
3. persist agent-local state across separate requests/invocations;
4. use a model selected through AI-01 rather than hard-coding Workers AI;
5. invoke at least one curated Wrangnarok tool under normal authorization;
6. invoke at least one ADR 022 OpenAPI/Code Mode-backed provider operation without exposing the provider credential to model-visible state;
7. invoke an existing Saga and observe its durable result rather than reimplementing the Saga as agent reasoning;
8. deny a tool/operation the caller or Agent is not authorized to use;
9. retain auditable provenance for Agent identity, caller/trigger, selected model profile, tool/Saga invocations, and sanitized outcomes;
10. restart/redeploy the stateless Worker surface and prove the Agent's intended durable state survives through its Durable Object identity;
11. demonstrate that shared D1 truth is referenced rather than duplicated into agent-local storage for convenience.

AI-03 may extend this proof with durable multi-turn chat, attachments, and routing, but those are not required to establish the core Agent runtime.

## Invariants

1. A Wrangnarok Agent is not a Saga, and a Saga is not an Agent.
2. Cloudflare Agents SDK is the preferred runtime substrate; Wrangnarok's Agent programming contract remains platform-owned.
3. The Agent runtime does not force a particular LLM provider.
4. Raw Connection credentials are never exposed to model-visible state merely because a tool is available to an Agent.
5. Agent-local Durable Object storage is not the canonical store for shared workspace/business truth.
6. Authorization and approval are checked at tool/action execution time.
7. Agents should delegate deterministic repeatable processes to Sagas where an appropriate Saga exists.
8. Agent identity is stable and scoped to the owning Organization/instance.
9. Tool, Saga, and provider/model provenance is retained for auditable executions.
10. New Cloudflare agent features are adopted only when they preserve these boundaries rather than leaking Cloudflare-specific concepts into the stable Wrangnarok contract.

## Consequences

### Positive

- Avoids rebuilding persistent-agent identity, state, scheduling, and coordination from first principles.
- Aligns with Wrangnarok's broader Cloudflare-native architecture while keeping the user-facing abstraction platform-owned.
- Keeps model/provider choice independent from runtime choice.
- Gives agents a natural private state boundary without overloading D1.
- Composes directly with ADR 022's Code Mode/MCP capability design and existing Saga/Workflow execution.
- Creates a clean distinction between deterministic automation and reasoning-driven automation.

### Costs and risks

- The Agents SDK and Durable Object lifecycle become important runtime dependencies for AI-02/AI-03.
- Cloudflare-specific runtime semantics may leak into the SDK unless deliberately hidden behind Wrangnarok abstractions.
- Agent-local state can become an attractive dumping ground; schema/review guidance is needed to keep shared truth in D1/Vectorize/R2.
- Tool-call loops and scheduled activity can create uncontrolled model/token cost without explicit budgets and observability.
- Agent versioning/migrations will require care because runtime identity and persisted local state outlive individual deployments.
- Testing must distinguish deterministic platform behavior from stochastic model behavior.

## Alternatives rejected

### Build a custom agent loop on plain Workers + D1

Rejected as the default. Wrangnarok would need to recreate durable agent identity, state coordination, scheduling, resumability, and lifecycle semantics that Cloudflare already provides. D1 is also the wrong abstraction for serializing every agent-local coordination concern.

### Treat Workflows as the platform-agent runtime

Rejected. Workflows are a strong fit for deterministic durable Sagas but not the natural owner of long-lived agent identity, conversational state, iterative reasoning, or agent-local scheduling.

### Workers AI as the Agent abstraction

Rejected. Workers AI is an inference/model service, not the lifecycle/runtime definition of a persistent Wrangnarok Agent. Coupling the two would unnecessarily constrain provider choice.

### Store all Agent state in D1

Rejected. Shared platform truth belongs in D1, but persistent per-agent coordination/state has a clearer owner in the Agent's Durable Object. Centralizing all state in D1 would recreate coordination problems the Agents SDK/DO model already solves.

### Delay runtime selection until AI-02 implementation

Rejected. The runtime choice materially affects Agent identity, state ownership, scheduling, SDK boundaries, testing, and the division of responsibility with AI-03. Those constraints should be settled before implementation grows around an accidental substrate.

## Follow-up work

- AI-01: finalize provider Connections/model profiles and runtime model-selection interface.
- AI-02: define the Wrangnarok Agent SDK/domain model and implement the acceptance slice above.
- AI-03: define conversation/routing/attachment behavior on top of the stable Agent identity.
- AI-04: add deterministic evaluation harnesses, model/tool mocks, replay controls, and no-side-effect review paths.
- AI-05/AI-06: define shared knowledge/memory architecture using D1/Vectorize without conflating it with Agent-local state.
- Add explicit model/token/tool-call budgets and observability before enabling autonomous scheduled Agents in production.
