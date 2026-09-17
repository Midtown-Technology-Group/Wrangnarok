# ADR TBD: Capability-based Connection resolution for heterogeneous customer environments

- **Status:** Proposed (design only — no implementation rides this ADR)
- **Date:** 2026-09-17
- **Issue:** #262 (`Define capability-based Connection resolution for heterogeneous customer environments`)
- **Extends:** ADR 003 (Integrations and Connections), ADR 005 (secret storage, v0 + fired envelope + OAuth slice 1), `docs/upstream-spec.md` findings 6, 11, 15, 19
- **Numbering note:** this document carries no ADR number until the steward
  reserves one. Issue #225 (ADR number governance) is open with collisions
  still present at 015/016/018/019/023 on `main`; per the reopened #225
  convention, unreserved decisions stay at non-numeric filenames. This file
  follows the `TBD-saga-authoring-ergonomics.md` precedent deliberately.
- **Phase gate:** the implementation/proving scenario is Phase 4+ (author-facing
  Saga + adapters) and must NOT open until this ADR is accepted.

## Context

CON-01/CON-02 shipped exact-Organization Connection mappings: a Saga asks for
an Integration in the current Execution's Organization context and
`resolveConnection` (`src/executions.ts`) returns exactly that Organization's
row or fails closed (`424 INTEGRATION_REQUIREMENT_UNSATISFIED` when declared).
Nothing answers which Connection satisfies a *semantic role* —
`identity.primary`, `mail.primary`, `endpoint.management`,
`ticketing.primary` — across heterogeneous customer environments. Issue #262
asks for that model, grounded in real patterns from the private
`MTG-Thomas/bifrost-workspace` repository rather than greenfield speculation,
and proved by one Employee Onboarding Saga that runs unmodified across a
Microsoft cloud-native org, an on-prem Active Directory org reached via
NinjaOne, and a Google Workspace org.

### Behavioral evidence (verified 2026-09-17 via API)

All five paths named in #262 were read or probed. SHAs pin what was seen;
future readers need workspace access to re-verify.

| #262 claim | Finding |
| --- | --- |
| `shared/bifrost/customer_identity.py` — normalized identity + backbone before secondary matching | **Confirmed** (1,384 bytes, sha `2789f6d`). `normalize_customer_name` lowercases and strips non-alphanumerics; `build_customer_match_index` refuses secondary matching when the Autotask backbone is empty (`require_autotask_backbone`, fail-closed `RuntimeError`) and only indexes unambiguous names (`len(matches) == 1`). |
| `features/utilities/workflows/check_integration_readiness.py` — org-scoped lookup, mapping checks, secret-safe reporting | **Confirmed** (5,043 bytes, sha `6dbd6bc`). Uses `integrations.get(name, scope=organization_id)` plus `integrations.get_mapping(name, scope=scope)`; returns presence booleans and `blockers` with explicit guarantees (`read_only`, `credential_values_returned: False`, `raw_scope_identifier_returned: False`). Scope modes are `organization` vs `current_or_global` — the cascade ADR 003 deliberately does not copy. |
| `features/*/workflows/sync_organizations.py` — IntegrationMappings associate vendor entities to orgs | **Confirmed with nuance.** Verified present under `features/ninjaone` (6,818 bytes) and `features/huntress` (3,819 bytes); **absent (HTTP 404)** under `autotask`, `halopsa`, `cove`, `datto`, `googleworkspace`, and `customer_onboarding`. The `*` in #262 is therefore "sampled vendors", not "every feature". NinjaOne's copy evidences one-to-many entities (`supplemental_entities` / `additional_entities` / `platform_sites` config keys indexed beside the primary `entity_id`), guarded upserts (`guarded_upsert_mapping` inside a mapping-mutation session with an `apply` dry-run flag), and reuse of the shared customer-identity backbone. |
| `features/googleworkspacereseller/workflows/customer_inventory.py` — provider module + org/mapping join + thin wrapper | **Confirmed** (4,662 bytes, sha `73f79f1`). `_load_customer_inventory` fetches via `googleworkspace.get_reseller_client(scope="global")`, joins `integrations.list_mappings(...)` to `organizations.list()` in pure `build_customer_inventory`, and the `@workflow` body is a thin wrapper. Warning vocabulary (`unmapped_customer`, `mapped_organization_missing`, `no_visible_subscriptions`) is worth reusing. |
| `modules/googleworkspace.py` — auth, retry, pagination outside the workflow | **Mostly confirmed** (30,290 bytes, sha `ce11ee4`; head read, see gaps). Service-account JWT Bearer [REDACTED] (`_parse_service_account_json`, raw-or-base64 JSON), least-privilege scope tuples (`DIRECTORY_*`, `RESELLER_READONLY`, `DRIVE_READONLY`), `RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504}`, 30 s default timeout. Auth and retry mechanics live in the module, not the workflow. |

Supporting local evidence: `features/customer_onboarding/workflows/` exists
(`intake.py`, `control_plane.py`, `microsoft_365_discovery.py`,
`reconcile_managed_entitlements.py`, …), confirming onboarding-shaped
orchestration is a real workspace concern, though no file there implements a
capability abstraction.

### Evidence gaps (recorded, not filled by invention)

1. **No capability abstraction exists in the sampled workspace.** The
   Connection/mapping/provider-module separations are real, but no file binds
   a semantic role to a Connection. The CapabilityAssignment layer below is new
   design; only the seams it rests on are evidenced.
2. **Mapping edge cases are partially evidenced.** One-to-many vendor entities
   are confirmed (NinjaOne supplemental entities). Aliases, stale mappings,
   customer consolidation, and mapping reconciliation beyond guarded
   upsert + dry-run are **not** directly evidenced in the sampled files and
   are marked accordingly below instead of specified.
3. **`modules/googleworkspace.py` was head-read only** (imports, scopes,
   auth parsing, retry set, timeout). Pagination helpers claimed by #262 were
   not line-verified; the retry/auth-outside-workflow claims were.
4. **Autotask backbone is vendor-specific.** The fail-closed backbone pattern
   is confirmed, but no generic (non-Autotask) backbone abstraction was found;
   the ADR adopts the fail-closed posture, not an Autotask dependency.
5. **Upstream Bifrost core** (`gobifrost/bifrost`) corroborates the portable
   vs per-org split and the declared-required/optional-missing distinction
   (upstream-spec §15), but contributes no capability-resolution contract
   beyond that; nothing here claims otherwise.

## Definitions (new terms, defined once)

- **Capability:** a semantic role a Saga requests, named by an opaque dotted
  string (`identity.primary`, `mail.primary`, `endpoint.management`,
  `ticketing.primary`). The name is the whole contract in v1; see below.
- **CapabilityAssignment:** Organization-scoped environment state binding one
  Capability name to one Connection for one Organization.
- **Adapter:** a typed TypeScript module implementing the shared operation
  contract for one Capability on top of one Integration's Actions
  (e.g. `identity` adapter for Graph, for Google Directory, for AD-over-Ninja).
- **Transport:** the mechanism by which an Adapter's operations reach the
  target environment (direct vendor HTTPS API; NinjaOne agent-mediated
  execution; later Datto, a dedicated runner, or another mechanism).
- **ExternalEntityMapping:** Organization-scoped environment state recording
  what an Organization/customer/resource is called inside a vendor
  (`entity_id`, display name), separate from Connection and CapabilityAssignment.

Existing terms (Saga, Execution, Operation, Integration, Connection,
Organization, ExecutionHistory) keep their `docs/lexicon.md` meanings.
Note: AI-01's "capability assignments" (model-profile vocabulary, ADR 032)
are a separate concept; this ADR's Capability is always Connection-bound and
the two must not be conflated in later work.

## Decision

### 1. Capability model

**Minimum useful abstraction: opaque string names bound per Organization.**
Capabilities start as opaque dotted-string identifiers (`identity.primary`),
not typed contracts with discoverable operations. Rationale: the workspace
evidence shows the *binding seams* (scoped lookup, mapping join, provider
module) but no shared operation contract to copy; inventing a typed
operation lattice now would be speculation. The string is stable Saga-facing
vocabulary; what varies per provider lives in Adapters (see §3). A later ADR
may promote names to typed contracts once two Adapters prove the shared shape.

**Multiple Connections per Integration per Organization: yes, required.**
The current `(org_id, integration_id)` unique row (migration 0001, ADR 003)
cannot express "Graph Connection A serves `identity.primary` while Graph
Connection B serves `mail.primary`", nor the three-org proving scenario
where identity and mail split across providers. CapabilityAssignment is the
table that breaks the 1:1 assumption: many Connections per (Organization,
Integration) distinguished by role, each bound to zero or more capabilities.
The existing unique constraint stays for the Connection identity row; role
disambiguation lives in CapabilityAssignment, not in a second Connection id
scheme.

**One Connection satisfying multiple capabilities: yes.** A Graph Connection
may satisfy both `identity.primary` and `mail.primary` for a
Microsoft-native org (proving scenario, Organization A). No exclusivity
constraint is imposed; exclusivity would force meaningless Connection
duplication and contradicts the evidence that one scoped Integration
resolution already serves many workflows.

**Optional vs required capabilities: mirror ADR 003's declared split.**
A Saga declares `requiredCapabilities` (loud failure when unbound:
`INTEGRATION_REQUIREMENT_UNSATISFIED`, 424 semantics in ExecutionHistory,
matching the existing declared-Integration contract) versus undeclared
capability lookup resolving to `None` without throwing. This reuses the
upstream-corrected declared/optional distinction (upstream-spec §15) instead
of inventing a second missing-requirement vocabulary. `requiredIntegrations`
stays as-is for provider-direct Sagas; a Saga may declare either or both,
and the 424 surfaces in the same two places (ExecutionHistory step error;
management probe where applicable).

**Provider-specific escape hatches: direct Integration Actions stay
first-class.** A Saga that intentionally depends on Microsoft/Google/Ninja
functionality calls that Integration's Actions directly
(`ctx.integrations.graph.*`) with `requiredIntegrations` declared. Adapters
are additive, never a lowest-common-denominator gate: no Adapter may remove
or wrap-mandatorily any Integration Action, and capability-routed calls must
be visibly distinct at the call site from provider-direct calls so reviewers
can see which portability promise each line carries. `modules/googleworkspace.py`
is the precedent: provider-native mechanics stay intact inside the provider
module whether or not an Adapter later covers the common subset.

### 2. Resolution

**Resolution point: lazily on first use per Capability, per Operation.**
Capability → Connection binding resolves when an Operation first requests
that Capability, not at Execution creation and not re-resolved per step
after first use. Rationale:

- Execution-creation resolution would force every declared capability to
  bind even on paths that never use it, and would pin disabled/rotated
  handling to "restart the Execution" for long-running onboardings.
- Per-Operation re-resolution would make mid-run Connection edits
  non-deterministic (step 3 uses Connection v1, step 9 silently uses v2).
- Lazy-on-first-use binds exactly the capabilities the run exercises, then
  freezes each binding for the rest of the run (see metadata below). This
  matches the workspace posture where `integrations.get(name, scope=...)`
  resolves at workflow use time (`check_integration_readiness.py`), while
  Wrangnarök's freeze adds the determinism a durable Execution needs.

**Immutable resolution metadata on the Execution: capability → Connection →
Integration revision, frozen at first use.** Each first-use resolution
appends an immutable record to ExecutionHistory (never updated in place):

- Capability name requested;
- resolved Connection id and its config generation/revision;
- Integration id (stable UUID per ADR 003) and Integration source revision;
- Adapter id and revision (when routed through an Adapter) or an explicit
  `direct` marker for provider-direct calls;
- Transport id where the Adapter delegates execution (e.g. `ninjaone`
  for AD-via-Ninja);
- ExternalEntityMapping id/version consumed, when the Operation used one;
- timestamp and the Operation that triggered the binding.

This answers #262's audit question — "what actually touched a customer
environment" — by replaying the frozen records, not by re-resolving current
state. Secret values are never part of the record (ADR 005 discipline).

**Disabled/rotated/replaced Connections mid-run: the running Execution is
unaffected; new resolutions fail closed or follow the new generation.**

- *Disabled:* a Connection disabled after an Execution froze its binding
  does not disturb that Execution; already-frozen Operations continue
  against the recorded binding. Any *new* first-use resolution (a capability
  the run has not bound yet) treats a disabled Connection as missing:
  declared → 424, undeclared → `None`. This extends ADR 003's
  "disabled mapping fails loud" rule from Integration resolution to
  capability resolution.
- *Rotated (secret/token rotation, same Connection identity):* rotation
  never moves Connection identity (ADR 003 OAuth section; ADR 005
  generation-fenced writes). Frozen bindings keep working because they
  reference identity, while secret/token material resolves transiently at
  the Action boundary under the current generation. No Execution metadata
  changes on rotation; the OAuth health lifecycle (`healthy`/`failed`/
  `revoked`) is observed, not snapshotted.
- *Replaced (new Connection row supersedes the old):* the frozen record
  keeps pointing at the old Connection id. New first-use resolutions see
  only the current CapabilityAssignment. There is no migration of running
  Executions to the replacement; operators who need the new binding cancel
  and re-run. Deleting a Connection deletes its CapabilityAssignments and
  ExternalEntityMappings with it (same cascade posture as ADR 005's
  secret/token rows), and any subsequent first-use resolution fails as
  missing.

**Cross-Organization prevention: resolution is Organization-bound and
centrally authorized, with no cross-org reference path.** The resolver takes
the Execution's Organization context only — never a caller-supplied org id —
and every CapabilityAssignment, Connection, and ExternalEntityMapping lookup
is predicated on that org. There is no API shape expressing "capability X
in Organization B" from an Execution running in Organization A; cross-org
administration, if ever needed, is an explicit administrative capability
outside Saga reach (ADR 003's existing rule, unchanged). Associated-data
binding (`org_id` + Connection id, ADR 005) makes row-copy exfiltration
decrypt-fail closed as defense in depth. Tests must pin allowed and denied
callers per the tenant-scope invariant (upstream-spec §5).

### 3. Integration vs Adapter vs Transport

- **Integration (kept):** portable provider code — typed Actions, config
  schema, secret declarations, vendor normalization, retry/pagination
  mechanics. `modules/googleworkspace.py` (auth + retry + scopes outside the
  workflow) and `ninjaone`'s client module are the shape to preserve. Every
  provider reachable through a Capability must first exist as an ordinary
  Integration with direct-callable Actions.
- **Adapter (new, thin):** a typed module per (Capability, Integration) pair
  implementing the shared operation subset for that Capability by calling the
  underlying Integration's Actions. Adapters own no credentials, no Connection
  rows, and no transport; they are pure call-shaping over an already-resolved
  Connection. Portability is earned per operation: an Adapter covers only the
  operations two or more providers genuinely share, and everything else stays
  provider-direct (§1 escape hatches).
- **Transport (new, explicit):** the delivery mechanism an Adapter executes
  through. Direct vendor HTTPS is the default transport (Graph, Google
  Directory). NinjaOne is a Transport for AD operations — the directory is
  Active Directory, reached through NinjaOne agent-mediated execution — not
  itself the directory. The Adapter/Transport seam is what lets AD later move
  to Datto, a dedicated runner, or another mechanism without rewriting
  portable Sagas: the Capability name and Adapter operation contract stay
  fixed while the Transport binding changes per Organization.

Proving-scenario bindings:

| Org | Capability | Adapter | Integration | Transport |
| --- | --- | --- | --- | --- |
| A (Microsoft) | `identity.primary`, `mail.primary` | Graph identity / Graph mail | `graph` Connections | direct HTTPS |
| B (on-prem AD) | `identity.primary` | AD identity | `ad` Connection (directory config) | `ninjaone` agent-mediated |
| C (Google) | `identity.primary` (+ `mail.primary` / `groups.primary` if the interface warrants) | Google identity | `googleworkspace` Connection | direct HTTPS |

The Onboarding Saga requests `identity.primary` in all three orgs with no
provider branch; Organization B's CapabilityAssignment points at the AD
Connection whose Adapter executes via the NinjaOne Transport.

### 4. External entity mappings

ExternalEntityMapping stays a **separate concern** from Connection and
CapabilityAssignment: the Connection says *how to authenticate*, the mapping
says *which vendor-side entity this org is*, and the assignment says *which
role this Connection fills*. Evidence for the split:
`check_integration_readiness.py` checks mapping presence independently of
credential readiness, and `customer_inventory.py` joins mappings to orgs as
its own step with its own warning vocabulary.

Edge-case posture, honestly scoped to the evidence:

- **One-to-many vendor entities: supported.** NinjaOne's supplemental-entity
  index (`supplemental_entities` et al.) proves one mapping row may need to
  cover a primary plus additional vendor entities. The model allows many
  ExternalEntityMappings per (Organization, Connection) with one marked
  primary.
- **Aliases, stale mappings, customer consolidation, reconciliation:**
  **deferred with rationale.** The sampled files show guarded upsert plus
  dry-run (`apply` flag) and unambiguous-match-only indexing, but no alias
  table, staleness lifecycle, consolidation workflow, or reconciliation
  protocol. Specifying those now would be invention. The deferred contract is
  narrow: mappings carry `created/updated` timestamps and a source marker
  (manual vs sync workflow) so a later reconciliation lane has provenance to
  work from, and sync workflows keep the evidenced dry-run-before-apply shape.
- **Backbone posture adopted, Autotask dependency not.** Secondary mapping
  syncs must fail closed without their declared identity backbone
  (`customer_identity.py` precedent), but the backbone is per-deployment
  configuration, not an Autotask import.

### 5. Security and audit

- Secret values never reach Saga code. Capability resolution hands the
  Adapter a callable bound to an already-resolved Connection; secret/token
  material resolves transiently at the Integration Action boundary under
  ADR 005 (deployment secrets + envelope + execution-scoped registry +
  substring scrubbing). The readiness-report precedent
  (`credential_values_returned: False`) applies to every capability
  introspection surface.
- Resolution is centrally authorized on the Execution's Organization
  context (§2); Adapters and Sagas cannot name another Organization.
- Executions record the frozen capability → Connection → Integration
  revision chain (§2) sufficient to answer post-hoc what touched a customer
  environment. Records are append-only in ExecutionHistory.

### 6. Suggested shape evaluation

#262's hypothesis — Organization → Connection → Integration revision, with
ExternalEntityMappings under the Connection, CapabilityAssignment →
Connection, and Execution → Saga revision requesting capabilities — is
**adopted with two corrections**:

1. ExternalEntityMappings hang under (Organization, Connection), not under
   the Connection alone: the same Connection pattern reused across orgs must
   never share vendor-entity identity, and org-predicated lookup (§2) needs
   the org on the row.
2. CapabilityAssignment needs its own enabled flag and audit timestamps
   independent of the Connection's: disabling a *role binding* (stop using
   Graph for mail) must not disable the *Connection* (Graph for identity
   keeps working), and vice versa.

No schema is created by this ADR; the shape above constrains the
implementation lane's migration design.

### 7. Proving-scenario contract (falsifiable, for a later lane)

The Employee Onboarding Saga takes `(organization, new_hire)` and performs
at minimum: create identity, assign to groups, provision a mailbox. Pass
criteria:

1. One Saga source file contains zero provider-selection branches
   (`if org uses AD/Entra/GWS`, provider switch statements, or per-provider
   modules chosen by org) for operations covered by the shared identity
   contract. A grep for provider names in the Saga body outside Adapter
   imports and escape-hatch blocks fails the proof.
2. The same Saga source executes green in three seeded Organizations with
   the §3 bindings (mocked vendor HTTP only, local workerd + D1): Entra,
   AD-via-Ninja, Google Workspace.
3. Each Execution's history carries the §2 frozen records, and an auditor
   can state per run which Connection, Integration revision, Adapter, and
   Transport touched the customer environment.
4. Provider-specific operations (e.g. an Entra-only licensing call) remain
   callable in the same Saga through direct Integration Actions without
   altering the shared path.

Named non-adoptions for the proving lane: no typed capability-operation
lattice (strings + Adapters only); no alias/staleness/consolidation
machinery (timestamps + source markers only); no scheduled refresh or health
aggregate beyond what OAUTH-01 already owns; no second Saga for the proof
(one Saga or the proof fails).

### 8. What remains provider-specific

Provider auth mechanics, retry/pagination/rate-limit behavior, response
normalization, vendor entity identifiers, Transport execution details
(NinjaOne agent mediation), and any operation without a demonstrated second
provider stay in the Integration or the single-provider Adapter. The shared
identity contract grows only by evidenced overlap, never by anticipatory
generalization. GAM7-style alternate backends (noted as possible-future in
`modules/googleworkspace.py`) stay out until a Transport lane proposes one.

### 9. Migration and compatibility notes

- Current `(org_id, integration_id)` Connection rows become the identity
  layer; CapabilityAssignment is additive. Existing Sagas using
  `ctx.integrations.<name>.<action>()` with `requiredIntegrations` keep
  working unchanged — capability routing is a new resolution path alongside
  direct resolution, not a replacement.
- `resolveConnection`'s exact-org, no-global-fallback, disabled-fails-loud
  rules (ADR 003) extend verbatim to capability resolution; the workspace's
  `current_or_global` cascade is explicitly not adopted (upstream-spec §11).
- No migration, binding, or primitive ships with this ADR. The implementation
  lane will need steward-owned migration numbering and a Free-tier accounting
  (D1 rows per assignment/mapping; no new primitive anticipated).
- Saga identity (ADR 002) is unaffected: adding capability declarations to a
  Saga is an ordinary source edit, not a re-registration.

## Implementation-lane breakdown (NOT executed)

This ADR authorizes no code. When accepted, the steward may open these
slices in order; each is a separate lane with its own tests:

1. **CapabilityAssignment + ExternalEntityMapping persistence.** Migration(s)
   for the two tables (org-predicated, enabled flags, timestamps, source
   markers); CRUD confined to an admin/operator boundary; no resolver yet.
2. **Central resolver + frozen Execution metadata.** Lazy-on-first-use
   resolution, §2 record shape in ExecutionHistory, disabled/missing
   semantics (declared 424 / undeclared `None`), cross-org negative tests.
3. **Adapter seam + one proving Adapter.** Adapter authoring contract plus
   the Graph identity Adapter (direct transport), exercised against mocked
   vendor HTTP.
4. **Second Adapter + first Transport split.** Google identity Adapter, then
   the AD Adapter with NinjaOne as Transport; Transport interface proven by
   exactly these two cases, no further generalization.
5. **Onboarding proving Saga.** The §7 Saga with the three-org falsifiable
   contract; closes the proof, not the feature.
6. **Operator surfaces.** Capability/mapping administration routes and
   readiness reporting in the `check_integration_readiness.py` shape
   (presence booleans, blockers, no secret values); Integration-list health
   stays with OAUTH-01.

Deferred past the proof (not in these lanes): typed capability contracts,
alias/staleness/consolidation machinery, scheduled refresh, any new
Cloudflare primitive.

## Consequences

- Sagas gain portable vocabulary for heterogeneous environments without
  inheriting Bifrost's global-cascade fallback or its process architecture.
- Connection assignment, external entity mapping, and capability assignment
  become independently testable seams with distinct failure modes.
- The one-diagram steward test is unaffected: no auth, execution,
  persistence, secrets, deployment, or recovery path changes — this ADR adds
  a design, not a path.
- Risk accepted: opaque strings may prove too weak once three Adapters
  exist; the ADR names the typed-contract promotion as the explicit
  follow-up rather than guessing the lattice now.

## References

- Issue #262 (design questions, proving scenario, suggested shape).
- `MTG-Thomas/bifrost-workspace` (private; verified 2026-09-17):
  `shared/bifrost/customer_identity.py`, `features/utilities/workflows/
  check_integration_readiness.py`, `features/ninjaone/workflows/
  sync_organizations.py`, `features/huntress/workflows/sync_organizations.py`,
  `features/googleworkspacereseller/workflows/customer_inventory.py`,
  `modules/googleworkspace.py`.
- ADR 003 (Integration/Connection contract, resolution rules).
- ADR 005 (secret storage v0, fired envelope, OAuth slice 1).
- `docs/upstream-spec.md` §6 (definition/mapping split), §11 (bounded
  fallback), §15 (declared/optional, single refresh primitive),
  candidate invariants 3–6.
- Issue #225 (number governance — why this ADR is TBD, not numbered).
- Capability Fabric issues (#277–#284, incl. #283 north-star demo): context
  only; this ADR does not implement or schedule them.
