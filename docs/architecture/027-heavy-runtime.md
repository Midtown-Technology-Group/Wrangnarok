# ADR 027: Cloudflare Containers as an earned runtime escape hatch

- **Status:** Proposed
- **Date:** 2026-09-12
- **Extends:** ADR 001, ADR 003, ADR 013

## Context

Wrangnarok is Worker-native by default: TypeScript Workers, Workflows, bindings, and selectively WebAssembly. Most automation is I/O-heavy and fits that model well.

Some workloads need a conventional Linux process/filesystem environment or existing OCI software. Cloudflare Containers provides that runtime alongside Workers and can reach Worker bindings through Worker-side outbound handlers.

## Decision

Use the following runtime preference:

1. ordinary Worker/TypeScript;
2. focused Wasm module when that solves the portability/compute need;
3. Cloudflare Container only when Linux/process/filesystem/native dependency semantics are materially required.

Containers are an exception path, not a second default platform.

### Keep the Wrangnarok capability boundary

Containerized behavior stays behind an Integration or platform capability:

```text
Saga / Agent
  -> Integration capability
       -> Worker adapter
            -> Container workload
```

Saga authors should not need to know whether a capability is implemented in TypeScript, Wasm, or a container.

### Access platform bindings through the Worker boundary

Where a container needs D1, R2, KV, or another Worker binding, prefer Cloudflare's outbound-handler pattern: the container calls an internal/virtual HTTP endpoint and Worker code performs the bound operation.

Avoid making Cloudflare REST credentials the normal integration mechanism for first-party platform resources.

### Durable state stays external

Container-local state is implementation state unless a later ADR explicitly chooses a persistent container feature. Authoritative Wrangnarok state remains in D1, R2, Workflows, or another chosen primitive.

### Required workload declaration

Every container-backed capability documents:

- why Worker/Wasm is insufficient;
- image/source ownership and update policy;
- resource and runtime limits;
- external destinations it needs;
- bounded inputs/outputs;
- timeout/cancellation behavior;
- retry/idempotency expectations.

ADR 005 and ADR 013 continue to govern credentials and egress behavior.

### Do not recreate a container platform

Wrangnarok does not use Containers as a reason to build its own scheduler, service mesh, or always-on microservice fleet. If a workload really wants a conventional container platform, operate it as such outside Wrangnarok and integrate through a capability.

## Good candidates

- vendor CLI that cannot reasonably run in Workers/Wasm;
- document/media conversion with native binaries;
- small existing OCI utilities;
- compute/memory work beyond sensible isolate limits;
- software requiring a conventional temporary filesystem/process tree.

## Poor candidates

- normal REST integrations;
- Saga orchestration;
- platform databases/caches that already have native primitives;
- replacing Workflows with daemon-style execution.

## Consequences

- Wrangnarok gains a controlled compatibility path for Linux-native workloads.
- Normal automation remains lightweight and Worker-native.
- Container images introduce additional patching and supply-chain ownership.
- Contributors need an explicit reason before adding a container dependency.

## Invariants

1. Workers are the default runtime.
2. Container implementation details stay behind a Wrangnarok capability.
3. Durable product state does not depend on container-local state.
4. Worker bindings remain the preferred way to expose Cloudflare resources to container-backed code.
5. Wrangnarok does not become a general-purpose container orchestrator.

## References

- Cloudflare Containers documentation.
- Cloudflare Containers Workers connections/outbound-handler documentation.
