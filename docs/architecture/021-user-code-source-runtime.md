# ADR 021: Git-Authored User Code and Immutable Runtime Artifacts

- **Status:** Proposed
- **Date:** 2026-09-11
- **Extends:** ADR 002 (Saga identity), ADR 003 (Integrations and Connections), ADR 005 (secret storage), ADR 016 (dev/preview sync), ADR 019 (artifacts), ADR 020 (scoped configuration)
- **Implements:** issue #264
- **Related:** issues #262 and #263

## Context

Wrangnarok needs a clear answer to two different questions that are easy to conflate:

1. Where do operators, developers, and coding agents author userland code?
2. What exact code does a durable Execution run and later resume?

Upstream Bifrost and `MTG-Thomas/bifrost-workspace` demonstrate that a normal Git workspace is productive for userland automation. Provider mechanics live in reusable modules, workflows are ordinary source files, tests and shared helpers live beside them, and changes are reviewed with normal Git tooling.

Wrangnarok should preserve that ergonomics. However, a mutable Git ref is a poor runtime identity for durable execution. A branch may move or be deleted, GitHub may be unavailable while a Workflow wakes, and an Execution must remain auditable after source has changed.

The architecture therefore distinguishes **authoring truth** from **execution truth**.

## Decision

### Git is authoring/source-control truth

Wrangnarok will begin with one trusted private GitHub monorepo, analogous to the current Bifrost workspace, for user-authored code such as:

- Sagas;
- Integrations/provider clients;
- capability adapters;
- forms and triggers;
- shared helper libraries;
- tests and artifact manifests.

Git supplies developer and agent ergonomics: commits, branches, pull requests, review, history, local tooling, and CI.

The initial implementation does not require repository-per-customer or repository-per-integration isolation. Additional registered code sources may be supported later without changing runtime identity semantics.

### Git is not the execution substrate

A branch name, tag, Git commit checkout, or GitHub file URL is not sufficient runtime identity.

Code must pass an ingestion/build/promotion path before it becomes executable. The resulting runtime artifact is immutable and content-addressed. A candidate flow is:

```text
private GitHub workspace
      |
      v
PR / merge / explicit sync
      |
      v
ingest + validate + build
      |
      v
immutable artifact
      |
      +--> R2: source/build bundle, manifest, source map, SBOM as applicable
      |
      +--> D1: CodeRevision metadata and provenance
      |
      v
explicit promotion / activation
      |
      v
Execution pins exact revision(s)
```

The detailed artifact schema and runtime mechanism remain owned by issue #263. This ADR fixes the architectural boundary, not the final implementation of Dynamic Workers or dynamic Workflows.

### Runtime artifacts are immutable

Every executable revision has a stable digest or equivalent immutable identifier.

An Execution that starts against revision `R` remains bound to `R` for its lifetime. Editing `main`, merging another PR, deleting the source branch, or changing the default active revision must not alter the code resumed by an in-flight durable Execution.

Old revisions must remain available while referenced by:

- active or sleeping Executions;
- retry/replay semantics that require the original code;
- audit/retention policy.

Garbage collection therefore follows references and retention policy, not "latest version wins."

### D1 stores metadata; R2 stores artifact payloads

D1 should contain small structured metadata such as:

- logical artifact identity;
- artifact kind (`saga`, `integration`, `adapter`, etc.);
- content digest;
- source repository and commit provenance;
- build/runtime compatibility metadata;
- artifact object location;
- validation/build/promotion status;
- creator and timestamps.

R2 is the preferred home for larger immutable payloads such as source bundles, production bundles, manifests, source maps, and dependency metadata.

Large mutable source blobs should not become ordinary D1 rows unless later evidence justifies that tradeoff.

### Configuration and secrets are environment state, not source

Userland source may declare required configuration, capabilities, Integration requirements, or secret field names. It must not contain customer credential values or mutable Organization configuration.

Actual Connection/configuration values remain Organization-scoped runtime state under ADR 003, ADR 005, and ADR 020.

This distinction is intentional:

```text
Git / artifact
  "this Integration requires tenantId and clientSecret"

Wrangnarok environment state
  "Organization A uses tenant X and secret reference Y"
```

A source artifact must remain portable between environments without carrying customer secrets with it.

### Promotion is explicit

Successfully ingesting or building a revision does not automatically make it the active production revision.

The lifecycle should distinguish at least conceptually between:

- discovered/ingested;
- validated;
- promoted/active;
- deprecated/retired.

The exact state machine is deferred to #263, but production activation must be explicit so CI, security scans, human review, or future policy gates can participate without changing the source model.

### Execution provenance is first-class

Wrangnarok must be able to answer, after the fact, what exact code touched a customer environment.

An Execution should retain enough immutable provenance to reconstruct at least:

- Saga revision/digest;
- Integration and capability-adapter revisions invoked where dynamically versioned;
- source repository/commit provenance;
- runtime/build compatibility version;
- resolved Connection/config revisions where the relevant ADRs require pinning.

The detailed resolution contract is coordinated with issue #262.

### Runtime mechanism may evolve without changing source semantics

Early trusted code may remain bundled into the main Worker release. Later user-authored code may execute through Dynamic Workers, dynamic Workflows, or another Cloudflare-native runtime.

Those mechanisms should share the same logical revision/provenance vocabulary where practical.

The architecture must therefore avoid equating "artifact revision" with one specific Cloudflare deployment primitive.

## Initial workspace recommendation

Start with one private monorepo for userland code.

A representative layout may look like:

```text
wrangnarok-workspace/
  integrations/
    microsoft/
    google-workspace/
    ninjaone/
  adapters/
    identity/
  sagas/
    employee-onboarding/
  forms/
  triggers/
  shared/
```

This is organizational guidance rather than a mandated package format. Issue #263 owns the eventual manifest/build contract.

## Invariants

1. Mutable Git refs are never sufficient identity for an in-flight Execution.
2. GitHub availability is not required for an already-started durable Execution to resume.
3. Source revisions become executable only after validation/build and explicit promotion.
4. Runtime artifacts are immutable and content-addressed or equivalently pinned.
5. Customer credentials and mutable Organization config are never embedded in runtime source artifacts.
6. Executions preserve exact code provenance for auditability.
7. Artifact retention protects revisions referenced by active/sleeping Executions.
8. Trusted bundled code and future dynamic code should converge on one revision/provenance model rather than forming separate product concepts.

## Consequences

### Positive

- Retains the productive Bifrost-style Git development workflow.
- Makes durable execution deterministic across source changes.
- Decouples execution availability from GitHub availability.
- Provides a natural security/promotion boundary for user-generated code.
- Makes rollback and forensic reconstruction substantially clearer.
- Allows Dynamic Workers/dynamic Workflows to be adopted later without redefining the authoring model.

### Costs

- Wrangnarok must eventually implement artifact ingestion, retention, provenance, and promotion machinery.
- Old revisions consume some R2/D1 storage until no longer referenced.
- A change being merged to Git is no longer identical to "the runtime is now using it," so tooling must make promotion status visible.
- Local/preview workflows must clearly distinguish source checkout identity from promoted runtime revision identity.

## Alternatives rejected

### Execute directly from GitHub / mutable Git refs

Rejected because it couples durable execution to an external mutable source system and weakens reproducibility, auditability, and availability.

### Store all user source directly in D1

Rejected as the default because D1 is better suited to structured metadata and environment state than large/versioned source payloads. It also gives up the Git-native developer workflow that is already effective in Bifrost.

### Put customer configuration/secrets in the workspace repo

Rejected. Source declares requirements; environment state supplies Organization-specific values. This is necessary for portability and is consistent with ADR 003/005/020.

### Require one repository per Organization

Rejected for the initial model. Code reuse across customers is fundamental to MSP automation, while Connections/capability assignments provide the customer-specific boundary. Additional repositories remain a future CodeSource capability rather than a tenant-isolation requirement.

## Deferred decisions

Issue #263 owns the deeper design for:

- CodeRevision schema;
- artifact manifest/package format;
- GitHub App/webhook versus CI push/pull ingestion;
- exact R2 object layout;
- signing/verification;
- security gates;
- Dynamic Worker and dynamic Workflow mechanics;
- artifact garbage collection;
- promotion UX/API;
- whether non-Git authoring is eventually supported.

Issue #262 owns capability-to-Connection resolution and the provenance that must be pinned when heterogeneous provider adapters are selected.
