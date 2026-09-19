# Migration pilot (issue #119, MIG-02)

Proof that a `bifrost-workspace` workflow can become a Wrangnarok Saga.
Pilot: `workflows/sample/hello_world.py` → `hello` (`hello-v1`).

Upstream baseline: `gobifrost/bifrost@3543c7e` (`api/bifrost/decorators.py`,
`api/bifrost/cli.py`).

## Registered-ID mapping

The `@workflow` decorator carries identity-only metadata and no stable id;
stable identity exists only after registration. The pilot records the mapping
explicitly (never derived):

- workspace source `workflows/sample/hello_world.py` (decorator metadata only,
  no stable UUID) → registered Saga UUID
  `395e15f0-3627-41f6-8922-008ce37e3b35` (`hello`, `hello-v1`).
- The UUID lives in `src/domain.ts` (`helloSaga`), the Saga definition in
  `src/sagas/hello.ts` (`helloSagaDef`), the catalog entry via
  `src/sagas/index.ts` (`SAGA_DEFINITIONS`), and the churn snapshot in
  `sagas.manifest.json`. `test/saga-contract.test.ts` fails closed on any
  drift between the four.

## Construct mapping

| Workspace (`hello_world.py`) | Wrangnarok (`src/sagas/hello.ts`) |
| --- | --- |
| `@workflow(id="24f8f523-…")` | Stable Saga UUID `395e15f0-…` in `src/domain.ts` + `sagas.manifest.json` (ADR 002; UUIDs are not shared across systems, the mapping is recorded here, not derived) |
| `category="Examples"` | Catalog `tags: ["examples", "pilot"]` (discovery metadata only) |
| Typed signature `(name: str)` | `HelloInput` + `parseHelloInput` (400 `INVALID_INPUT` on violation) + JSON `inputSchema` |
| `return {"greeting": …, "name": …}` | `HelloResult` + `outputSchema`; terminal `result_json` |
| Bifrost durable execution | Cloudflare Workflow (`HelloWorkflow`, `HELLO_WORKFLOW` binding) + D1 `executions`/`operations` rows |
| Logging | `prepare-input-v1` / `greet-v1` Operation history (no log scraping) |

## Deliberate divergences

- No emoji in the greeting: boring outputs over workspace flavor.
- Input bound (1–1024 UTF-8 bytes) mirrors the echo message bound; a dedicated name bound waits for a real author-facing need.
- No usage block: only `system.smoke` emits Free-tier telemetry today.

## Acceptance proof (local API + history)

- `test/hello.test.ts` runs the pilot end to end on the real local runtime:
  `GET /api/sagas` lists `hello`; `POST /api/executions` accepts
  `{ sagaId: 395e15f0-…, input: { name: "Ada" } }` with 202 plus a
  `Location` receipt; the `HelloWorkflow` instance completes;
  `GET /api/executions/<id>` reports `Succeeded` with
  `{ greeting: "Hello, Ada!", name: "Ada" }` and Operations
  `prepare-input-v1` + `greet-v1` both `Succeeded`, with zero outbound fetch.
- Invalid names (`""`, non-string, wrong key) answer 400 `INVALID_INPUT`.
- History visibility: the Execution persists `saga_id`/`saga_name`/
  `saga_revision` plus input/result/Operations rows, so
  `GET /api/executions?sagaId=395e15f0-…` surfaces the pilot run through the
  standard history query path (`test/history.test.ts` proves the filters).

## Gaps this pilot does not close

- Tables (M2, #117) and Forms binding (M3, #118): the pilot takes raw JSON input.
- Manifest bridge (M1, #116): the pilot is hand-pinned, not converted.
- Second pilot with a real Integration call (read-only NinjaOne workflow) once M1 lands.

## Second pilot: NinjaOne organization lookup (issue #115)

Re-authors the vendor-read half of workspace
`features/ninjaone/workflows/sync_organizations.py` (private
bifrost-workspace; unreachable from this lane, so the mapping is
operator-declared, never derived) as `ninjaone-org-lookup`
(`ninjaone-org-lookup-v1`).

### Registered-ID mapping

- Workspace source `features/ninjaone/workflows/sync_organizations.py`
  (decorator metadata only, no stable UUID) → registered Saga UUID
  `aeab823e-c162-437d-835f-b19a05f078b6` (`ninjaone-org-lookup`,
  `ninjaone-org-lookup-v1`).
- The UUID lives in `src/domain.ts` (`ninjaLookupSaga`), the Saga definition
  in `src/sagas/ninja-lookup.ts` (`ninjaLookupSagaDef`), the catalog entry
  via `src/sagas/definitions.ts` (`SAGA_DEFINITIONS`), and the churn
  snapshot in `sagas.manifest.json`. `test/saga-contract.test.ts` fails
  closed on any drift between the four.

### Construct mapping

| Workspace (`sync_organizations.py`, read half) | Wrangnarok (`src/sagas/ninja-lookup.ts`) |
| --- | --- |
| Typed signature (name filter) | `NinjaLookupInput` (`query`, 1–128 chars) + `parseNinjaLookupInput` (400 `INVALID_INPUT` on violation) + JSON `inputSchema`; submittable through a Form declaration via `bindFormInput` (field names bind to Saga inputs) |
| Single vendor read (list organizations) | One `listOrganizations` call through `integrationOperation` (declared `requiredIntegrations: [NINJA_INTEGRATION_ID]`, 424 on missing Connection), existing Connection resolution untouched |
| Local match over the census | Pure `matchNinjaOrgs` (`src/domain.ts`): case-insensitive substring, `matchCount` total, `matches` bounded to `NINJA_ORGS_MAX` for persistence |
| Bifrost durable execution | Cloudflare Workflow (`NinjaLookupWorkflow`, `NINJA_LOOKUP_WORKFLOW` binding) + D1 `executions`/`operations` rows |
| Logging | `prepare-input-v1` / `ninja-list-orgs-v1` / `ninja-match-orgs-v1` Operation history (no log scraping) |

### Deliberate divergences

- Mapping writes are not ported: the workspace sync writes organization
  mappings downstream; this Saga is read-only by construction (one vendor
  GET plus a pure local match). The write half stays an explicit follow-up.
- Match is a substring filter, not an exact-key lookup: the census carries
  no stable external key in v0, so the Saga returns every case-insensitive
  substring match instead of guessing identity.

### Acceptance proof (local API + history)

- `test/ninja-lookup.test.ts` runs the pilot end to end on the real local
  runtime: `bindFormInput` binds `{ query: "acme" }` (and 422s on `{}`);
  `POST /api/executions` accepts the bound input with 202 plus a `Location`
  receipt; the `NinjaLookupWorkflow` instance completes with exactly two
  vendor calls (token plus the single list read); `GET
  /api/executions/<id>` reports `Succeeded` with `{ query: "acme",
  organizationCount: 3, matchCount: 2, matches: [...] }` and Operations
  `prepare-input-v1` + `ninja-list-orgs-v1` + `ninja-match-orgs-v1` all
  `Succeeded`.
- Empty matches succeed (`matchCount: 0`); missing/empty/oversize queries
  answer 400 `INVALID_INPUT`; no secret material persists (sentinel audit
  over executions/operations/connections/usage rows).


## Second migration: Cloudflare Zone Inventory (issues #116, #119)

First migration beyond hello-world: the `cloudflare-zone-inventory` 0.1.0
bundle (two read-only workflows, bearer Integration, six replay scenarios).

### Registered-ID mapping

Bifrost workflow UUIDs are source identity only (never derived): the
operator sagaMap records the mapping explicitly.

- `2fcb2d31-091a-583f-a980-38c4de3da9ab` (`verify_cloudflare_connection`)
  → registered Saga UUID `9d2f4a6c-3b1e-4f5a-9c2d-6e8f0a1b2c3d`
  (`cloudflare-verify-connection`, `cloudflare-verify-connection-v1`).
- `a5160896-d1de-55cc-b1af-71e57b670f44` (`inventory_cloudflare_zones`)
  → registered Saga UUID `7c1e3b5a-2d4f-4e6b-8a1c-5d7f9e0a1b2c`
  (`cloudflare-inventory-zones`, `cloudflare-inventory-zones-v1`).
- Integration `Cloudflare` → `6b0d2a48-1c3e-4d5a-7b9a-4c6e8d0f2a1b`
  (`cloudflare`), bearer `apiToken` secret.

The UUIDs live in `src/domain.ts`, the definitions in
`src/sagas/cloudflare.ts`, catalog entries via `src/sagas/index.ts`, the
installer pins in `src/solutions.ts` CODE_SAGAS, the source-catalog pins in
`src/solution-export.ts` CODE_SAGAS, and the churn snapshot in
`sagas.manifest.json`. `test/saga-contract.test.ts` fails closed on drift.

### Construct mapping

| Bundle (`functions/cloudflare_inventory.py`) | Wrangnarok |
| --- | --- |
| `@workflow(name=..., category="Cloudflare", tags=[...])` | Stable Saga UUID + revision in `src/domain.ts`; tags verbatim on the definition |
| `integrations.get("Cloudflare")` + `config["api_token"]` | `resolveConnection` (declared required, 424 on miss) + `apiToken` secret handle; presence enforced inside the Action, never branched on in Saga steps |
| `entity_id`/`entity_name` account mapping | Optional `account` envelope in the parsed Saga input (validated shape, carried through submit); strict 32-hex ID check at the Integration boundary |
| `httpx.AsyncClient(base_url, Bearer)` | `fetch` with `Authorization: Bearer <token>`, `redirect: "manual"`, 20s `AbortSignal.timeout` deadline |
| `_get_json` success/error shaping | `getJson`: bounded body, `success !== true` or non-2xx → `CLOUDFLARE_REQUEST_FAILED` with the first vendor message, secrets scrubbed |
| Pagination loop (`page`, `per_page=50`, `total_pages`) | Same loop, `max_zones` 1..250 validated (400 `INVALID_INPUT`); stops on empty batch or `page >= total_pages` |
| `_zone_summary` shaping | `zoneSummary`: same fields, camelCase contract (`accountId`, `nameServers` sorted, `developmentModeActive`) |
| `Counter` summaries | `statusCounts`/`typeCounts` (sorted keys), `paused`, `developmentModeActive` counts |
| `enforced_bounds` (1 or 5 external calls) | Reads execute under Connection authority; no mutation surface exists |
| `compatibility/wrangnarok/scenarios/*.json` | `test/fixtures/zone-inventory/*.json` (provenance in `PROVENANCE.md`); all 6 replay as regression tests in `test/cloudflare-inventory.test.ts` with ordered request matching and exact terminal comparisons |

### Deliberate divergences

- Result key `token` → `credential`: the platform secret-word tripwire
  (`test/echo-secretfields.test.ts`) bans the substring `token` on API
  surfaces; the bundle's `token: {status, ...}` becomes
  `credential: {status, expiresOn, notBefore}`. Recorded here, not silent.
- Termination follows advertised `total_pages`, not the Python's
  `len(batch) < PAGE_SIZE` shortcut: a non-final page may carry fewer rows
  than the page size, and stopping early drops trailing pages (the
  inventory-two-pages scenario pins 2-of-50 rows on page 1 of 2 and
  requires fetching page 2 — the Python shortcut yields 1 call where the
  contract requires 2).
- Base-path joining: `new URL("/path", "https://host/client/v4")` discards
  `/client/v4`; the Integration joins against the base directory so the
  version prefix survives.
- Parsers accept both `max_zones` (submission) and `maxZones` (persisted):
  submit persists parsed input and prepareExecution re-parses it, so the
  parser must be idempotent over its own output (like every other Saga).
- Descriptions avoid the substrings `secret`/`token` (same tripwire);
  "credential" reads fine and changes no behavior.
- No migration for the account mapping: Connection rows persist endpoint
  only, so `accountId` resolves test-locally per Execution input; a general
  per-tenant mapping store is a follow-up, not this lane.

### Acceptance proof

- `test/cloudflare-inventory.test.ts` replays all 6 vendored scenarios on
  the real local runtime (workerd + D1 + Workflows); only outbound vendor
  HTTP is mocked at the Integration boundary. Ordered exchange matching,
  exact terminal results/errors, invariant enforcement, secret-sentinel
  audits on responses and persisted rows.
- `test/migration-bridge.test.ts` converts the real bundle descriptor
  through `convertWorkspaceToBundle` (sagaMap + Cloudflare integrationMap)
  and proves the output parses as an installable manifest with zero gaps.
