# ADR 030: Vectorize as the semantic index for Wrangnarok knowledge

- **Status:** Accepted (2026-09-18; owner decision recorded on issue #168)
- **Date:** 2026-09-12
- **Implements:** AI-05 / AI-06 knowledge-memory direction
- **Related:** ADR 001 (Execution model), ADR 003 (Integrations/Connections), ADR 022 (OpenAPI Code Mode), ADR 041/AI-02 agent-runtime direction when merged (renumbered from 023 by issue #225)

## Context

Upstream BiFrost can keep semantic embeddings close to ordinary application data by using PostgreSQL vector capabilities. Wrangnarok is intentionally decomposing the PostgreSQL role across Cloudflare primitives instead of making D1 impersonate every database feature.

Wrangnarok therefore needs an explicit answer for semantic retrieval over platform knowledge such as:

- synchronized vendor objects (for example Halo contracts, tickets, assets, documentation metadata);
- authored workspace knowledge and documentation;
- prior Execution summaries or operator-approved memories;
- agent retrieval context;
- semantically discoverable Integration/provider material.

D1 is the canonical relational/domain store but is not the target vector-search engine. Cloudflare Vectorize is the preferred semantic-nearest-neighbor index.

## Decision

### D1 remains canonical; Vectorize is a derived index

Wrangnarok stores canonical domain records and retrieval metadata in D1 (or R2 for blob bodies) and stores only the vector-search representation in Vectorize.

Representative shape:

```text
D1 / R2 canonical object
        |
        | normalized retrieval text
        v
embedding provider
        |
        v
Vectorize
  vector id = canonical object id/version
        |
        | semantic query
        v
matching ids + scores
        |
        v
D1 / R2 rehydrate authoritative objects
```

Vectorize metadata MUST NOT become the sole source of truth for business state. If an object cannot be reconstructed or authorized from the canonical store, the vector hit is unusable.

### Embedding generation is provider-abstract

Vectorize stores and searches numeric embeddings; it does not define the embedding model.

Embedding generation may use Workers AI, OpenAI, another approved provider, or a compatible external/local service. The Wrangnarok knowledge contract therefore records the embedding model identity/version separately from the Vectorize index itself.

Workers AI is a convenient Cloudflare-native default, not a permanent API contract.

### Stable identity and model/version provenance are mandatory

Every indexed item must retain enough provenance to answer:

- which canonical object produced this vector;
- which source revision/hash was embedded;
- which embedding provider/model/version produced it;
- when it was embedded;
- which logical index/schema version it belongs to.

Recommended canonical metadata includes:

```text
object_id
object_type
source_revision or source_hash
embedding_provider
embedding_model
embedding_version/index_generation
embedded_at
```

Changing embedding dimensions, distance metric, or materially changing the embedding model is treated as an index migration, not an in-place invisible change.

### Vector identifiers join back to canonical objects

Vector IDs should be deterministic or otherwise durably mapped to canonical object identity. The retrieval path returns IDs/scores, then loads the current authorized objects from D1/R2.

Do not copy full canonical records into Vectorize metadata merely to avoid the rehydrate step.

### Metadata and namespaces are for search narrowing, not database modeling

Use Vectorize namespaces/metadata only for fields that materially narrow semantic search before nearest-neighbor selection, for example:

- Organization/workspace/customer scope;
- object type;
- source/provider;
- active/deleted visibility state;
- coarse knowledge category.

Avoid mirroring arbitrary D1 columns into Vectorize metadata. Rich relational predicates remain D1's job.

Organization/authorization scope must be applied before semantic results become visible to a caller. A cross-Organization vector hit must never be returned merely because it is semantically similar.

### Deletion and staleness are explicit

Vectorize is a derived index, so canonical changes may temporarily lead it.

Wrangnarok must support:

- upsert after relevant canonical changes;
- delete/tombstone propagation;
- periodic reconciliation for missing/orphaned vectors;
- source-hash comparison to avoid needless re-embedding;
- bounded retry for failed indexing operations.

Search results must be revalidated against canonical visibility/state on read, so a stale vector cannot resurrect a deleted or unauthorized object.

### Re-embedding is asynchronous work

Embedding and bulk re-indexing do not belong in interactive request latency when avoidable.

Use Queue/Workflow-backed jobs for:

- initial indexing;
- model migrations;
- large source refreshes;
- reconciliation/backfill;
- retry after embedding-provider or Vectorize errors.

The platform should remain usable if semantic indexing is delayed or temporarily unavailable; search quality may degrade, but canonical D1/R2 correctness must not.

### Retrieval is a capability, not raw Vectorize access

Saga and agent authors should consume a Wrangnarok retrieval/knowledge API such as a typed `ctx.knowledge.search(...)` capability rather than receive unrestricted Vectorize bindings by default.

That capability owns:

- Organization scoping;
- allowed object types/sources;
- embedding the query with the index-compatible model;
- namespace/metadata filters;
- result-count and score bounds;
- canonical D1/R2 rehydration;
- authorization checks;
- provenance and observability.

This keeps Vectorize as an implementation detail and permits future index migrations without rewriting authored automation.

### Agent-local memory and shared semantic knowledge are distinct

Agent runtime-local scratch/conversation state should remain in the agent runtime's own durable state where appropriate.

Vectorize is for shared/searchable semantic knowledge. Persisting every transient agent thought or chain-of-thought-like scratch item into the shared semantic index is explicitly out of scope.

## Cost and performance rules

- Embed only fields that are useful for retrieval; do not blindly embed complete vendor payloads.
- Chunk long documents deterministically with parent-object linkage and bounded chunk size/overlap.
- Re-embed only when the normalized retrieval text or embedding generation changes.
- Bound `topK` and metadata returned to callers.
- Prefer namespace/metadata filtering before broad global searches.
- Track embedding calls and vector query/storage usage through operational telemetry without logging raw sensitive content.

## Security and privacy

Embedding generation may send source text to an external model provider. Provider policy therefore matters independently of Vectorize storage.

Knowledge indexing must classify source material before embedding and respect Organization/provider policy for data allowed to leave the deployment or enter a third-party model endpoint.

Raw secrets, bearer tokens, credentials, and secret-bearing configuration are never embedding inputs.

## Acceptance slice

AI-05/AI-06 implementation should demonstrate at least:

1. index an Organization-scoped canonical D1 object through a configured embedding provider;
2. store vector identity/provenance with source hash/model generation;
3. query semantically within the Organization and rehydrate the canonical D1 object;
4. prove a different Organization cannot retrieve that object;
5. update the source, re-index it, and avoid re-embedding when source hash is unchanged;
6. delete/tombstone the canonical object and prove a stale vector cannot expose it;
7. demonstrate model/index generation migration without silently mixing incompatible vectors;
8. surface embedding/Vectorize failure as degraded semantic search rather than canonical-data failure;
9. record bounded operational telemetry for embedding and vector-query cost/latency without raw source content.

## Consequences

### Positive

- Preserves the semantic-retrieval capability BiFrost received from PostgreSQL vector support.
- Uses the Cloudflare primitive designed for vector search instead of forcing D1 into the role.
- Keeps canonical truth, authorization, and relational querying in D1/R2.
- Allows embedding providers to evolve independently of storage.
- Gives agent and Saga code a stable Wrangnarok knowledge capability rather than a Cloudflare-specific API.

### Costs and risks

- Retrieval becomes a distributed two-stage operation: vector search then canonical rehydration.
- Index reconciliation and model-version migrations become explicit platform responsibilities.
- External embedding providers introduce privacy, latency, availability, and cost concerns.
- Stale derived indexes require careful read-time authorization/canonical-state validation.

## Alternatives rejected

### Store embeddings in D1 and implement similarity search ourselves

Rejected. D1 remains the relational store; custom vector similarity over SQLite rows would recreate a specialized search engine poorly and complicate cost/performance characteristics.

### Treat Vectorize as the canonical knowledge database

Rejected. Vector metadata/search semantics are intentionally narrower than the relational and authorization requirements of platform state.

### Hard-code Workers AI embeddings

Rejected. Workers AI is a strong default, but the embedding-provider contract should remain configurable just as model-provider choice is separated from the platform-agent runtime.

### Keep semantic retrieval out of Wrangnarok

Rejected. BiFrost already uses vector capabilities, and semantic retrieval is directly useful for agents, knowledge, incident history, and natural-language navigation across synchronized workspace data.
