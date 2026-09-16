# ADR 033 (RFC): Saga authoring ergonomics — decorator-equivalent terseness without new contracts

- **Status:** Proposed (RFC, not yet accepted — shape into ADR before any Saga rewrite)
- **Date:** 2026-09-16
- **Extends:** ADR 002 (stable Saga identity), ADR 010 (source boundary), ADR 018 RUN-01/RUN-02 (runtime policy, child invocation), `docs/upstream-spec.md` findings 1, 3, 15, 18
- **Implements:** nothing yet — no issue number assigned; no code changes ride this RFC

## Context

### TypeScript decorators are real, but they are not Python decorators

TypeScript 5 implements the standardized TC39 decorators proposal: decorators
apply to **classes and class members** (methods, fields, accessors) — not to
bare functions. Verified 2026-09-16: a `@saga(meta)` class decorator
typechecks clean on the repo's TypeScript 5.9.3 with default config (no
`experimentalDecorators` flag present anywhere in the repo). There is no
`@workflow`-on-a-function equivalent. Upstream
Bifrost's authoring surface (`api/bifrost/decorators.py`, swept in
upstream-spec §15) is `@workflow`/`@tool` on ordinary async Python functions,
with identity/discovery-only decorator parameters and runtime policy living in
the database (finding 3).

Our `defineSaga({...})` call **already is** the TypeScript equivalent of
`@workflow`: a higher-order wrapper carrying identity/discovery metadata around
an ordinary async function. Any `@saga` spelling would be sugar over the same
call (a class decorator returning the same `SagaDefinition`), never a new
mechanism. The verbosity gap is therefore not a missing language feature — it
is repeated run-body ceremony that the platform could own.

### Verbosity audit (measured 2026-09-16)

| Saga file | Lines | Vendor steps | Repeated ceremony |
| --- | --- | --- | --- |
| `hello.ts` | 106 | 0 | prepare, greet checkpoint, persist-success/failure, scrub, adapter class |
| `echo.ts` | 144 | 1 | + deadline lookup, connection resolution, Fault mapping, timeout-mark, sleep |
| `ninjaorgs.ts` | 143 | 1 | same as echo |
| `digest.ts` | 209 | 2 | echo pattern twice plus pure-transform shaping |
| `smoke.ts` | 162 | 0 | D1 probe/verify checkpoints, usage block |
| `hello-parent.ts` | 114 | 0 (+2 child steps) | child dispatch/await checkpoints, Fault mapping |

Per-Saga boilerplate taxonomy (all counted inside `run` plus file scaffolding):

1. **Imports + Workflow adapter class** (~12 lines/file): 6+ imports and an
   `XxxWorkflow extends WorkflowEntrypoint` class that only forwards to
   `executeSaga`. Pure scaffolding, zero Saga behavior.
2. **Hand-frozen IO schemas** (~10–20 lines/file): nested `Object.freeze`
   literals re-stating what `parseXInput` and the TypeScript types already know.
3. **Execution-ID guard + expectedFailure/timedOut plumbing** (~10 lines/file):
   identical in every Saga.
4. **prepare-input-v1** (~3 lines, identical): `step.do("prepare-input-v1",
   () => prepareExecution(...))`.
5. **Vendor-step interior** (~25 lines per vendor call): `beginOperation`,
   policy-snapshot deadline lookup, `withOperation` + `resolveConnection`,
   declared/optional branch, secret-handle pass-through comment, try/catch
   around the Integration Action, `Fault`-vs-generic mapping, `finishOperation`,
   `{ok, result|error}` shaping. Echo, ninjaorgs, and both digest legs repeat
   this with only names, IDs, and the Action call differing.
6. **Outcome handling** (~15 lines per vendor call): `expectedFailure`
   capture, timeout-code check, `timeout-mark-v1`, `NonRetryableError` throw.
7. **persist-success / persist-failure + scrub** (~15 lines/file): identical
   SQL and scrub calls modulo the output value.

A single-vendor Saga is ~140 lines of which roughly **15 carry Saga-specific
behavior** (the Action call and the output shape). Everything else is platform
ceremony the author re-types per file.

## Non-negotiables (this RFC must not weaken these)

1. **Stable identity** (ADR 002): explicit UUID id, manifest churn gate,
   duplicate-ID/name fatal boot errors. Any sugar must still produce one
   `defineSaga` call with an explicit UUID — never a name/path/code hash.
2. **No policy in source** (finding 3, ADR 018): timeouts, retries, schedules,
   endpoints, access rules stay persisted policy. Helpers must not accept knob
   parameters that smell like policy.
3. **Determinism contract** (`assertDeterministicRun` + `test/saga-contract.test.ts`):
   all I/O inside `step.do()`, `ctx.*` handles never touched outside it. The
   scanner works by blanking literal `step.do(...)` bodies — anything that
   hides `step.do` inside a helper **must update the scanner in the same PR**,
   or keep `step.do` literally visible in `run`.
4. **Scrub discipline** (ADR 005/SEC-01): write-time scrubbing on every egress
   path, by mechanism not author discipline.
5. **Cloudflare nouns stay native** (lexicon): Worker, Workflow, step, D1 keep
   their names; no portability abstraction.
6. **Free-tier flat**: authoring ergonomics must add zero runtime D1/Workflow
   cost and negligible Worker bundle weight.

## Options considered

### A. Thin helpers over the existing contract (recommended)

No new contract, no decorator syntax, no codegen. Add a small set of boring
typed functions in `src/saga.ts` (or a new `src/saga-helpers.ts`) that own the
repeated interiors while `run` keeps calling `step.do` visibly:

- `schemaOf(properties, required)` — one-line frozen `IoSchema` builder
  replacing ~15 lines of nested `Object.freeze` literals.
- `makeSagaWorkflow(def)` — factory returning the `WorkflowEntrypoint`
  subclass, replacing the per-file adapter class (~5 lines) with one line.
  `src/bindings.ts` and `wrangler.jsonc` entries remain explicit (native
  binding names are Cloudflare's, not ours to abstract).
- `prepareInput(ctx, step, saga, parse)` — one-line `prepare-input-v1`.
- `doVendor(ctx, step, prepared, { op, integrationId, required, timeoutMs, call })`
  — owns the ~25-line vendor-step interior (begin, deadline, resolution,
  Fault mapping, finish, `{ok,...}` shaping) while the author's `call`
  callback holds only the Integration Action invocation. Called **inside** a
  visible `step.do` so the scanner keeps working unchanged.
- `sagaRun(...)` lifecycle wrapper — owns the ID guard, try/catch,
  timeout-code routing to `timeout-mark-v1`, persist-success/failure, and
  scrub mapping, with the author supplying only the steps body. This is the
  one helper that hides `step.do` structure, so it needs the scanner update
  (below) — or it stays out of v1 and only the interior helpers land first.

Sketch (echo, illustrative — exact names/shapes are shaping questions):

```ts
export const echoSagaDef = defineSaga<EchoInput>({
  id: echoSaga.id,
  name: echoSaga.name,
  revision: echoSaga.revision,
  description: echoSaga.description,
  tags: ["utility", "fixture"],
  requiredIntegrations: [ECHO_INTEGRATION_ID],
  inputSchema: schemaOf({ message: "string" }, ["message"]),
  outputSchema: schemaOf({ message: "string" }, ["message"]),
  parse: parseInput,
  run: (ctx, step) =>
    sagaRun(ctx, step, { saga: echoSaga, parse: parseInput, timeoutCodes: ["ECHO_VENDOR_TIMEOUT"] }, async (input, op) => {
      const out = await op.vendor("echo-http-v1", ECHO_INTEGRATION_ID, VENDOR_TIMEOUT_MS, (conn, secrets, deadline) =>
        ctx.integrations.echo.echo(conn, input, op.key("echo-http-v1"), deadline),
      );
      await op.wait("settle-wait-v1", "1 second");
      return out;
    }),
});

export class EchoWorkflow extends makeSagaWorkflow(echoSagaDef) {}
```

Estimated effect: single-vendor Saga drops from ~140 lines to ~40, of which
nearly all is identity, schemas (one line each), and the Action call.
`defineSaga`, the manifest gate, the policy rejection list, and the
determinism scanner's `step.do` visibility rule all survive (the scanner
gains one allowlisted wrapper boundary — see below).

### B. Class-based `@saga` / `@operation` decorators (not recommended)

```ts
@saga({ id: "...", name: "echo", ... })
class EchoSaga {
  @operation("echo-http-v1") async echoHttp(...) {...}
}
```

This is the closest visual match to Jack's `@workflow`, and TC39 decorators
support it today. Rejected as the primary surface because: it trades the
current explicit object literal (greppable, diffable, trivially validatable by
`validateSagaDefinition`) for class machinery with zero additional power; the
determinism scanner would need to analyze method bodies instead of one `run`
function; `requiredIntegrations`/schemas/parse become decorator arguments
with worse type inference than the current generic `defineSaga<TOutput>`; and
two authoring surfaces (object + class) means two paths through the steward's
one-diagram test. If authors want the spelling, a single `@saga(meta)` class
decorator desugaring to `defineSaga` could be added later **on top of A** —
never as the contract itself.

### C. Codegen / schema inference / macro layer (rejected for now)

Inferring `IoSchema` from TypeScript types or `parse` functions (via zod,
valibot, or a build-time extractor) would delete category 2 entirely. Rejected
because: every codegen dependency adds Worker bundle weight for metadata
alone (ADR 002 already made this call); inferred schemas drift silently from
the persisted catalog; and hand-derived schemas are currently 6 Sagas small.
Revisit when schema drift actually bites, per ADR 002's own note.

## Scanner impact (must-ship-with, not follow-up)

`assertDeterministicRun` blanks literal `.do(` call bodies and requires at
least one `step.do(` in `run` source (`src/saga.ts:586`, blanking at `:548`).
Verified 2026-09-16 with a throwaway vitest probe against the real scanner
(both assertions passed, probe removed after):

- Interior helpers (`doVendor`, `prepareInput`, `schemaOf`) are called
  **inside** visible `step.do` callbacks or outside durable sections without
  touching `ctx.*`/I/O — the scanner needs no change for them, but the
  contract test must pin that they never touch `fetch`/`ctx.*` at their own
  top level (they receive already-resolved values).
- The `sagaRun` lifecycle wrapper (if it owns `step.do` calls) breaks the
  "run body never calls step.do" gate. Two sub-options: (a) extend the
  scanner to treat `sagaRun(...)` bodies like `step.do(...)` bodies
  (allowlist one wrapper, blank its body argument too); (b) defer `sagaRun`
  and ship only interior helpers first, keeping every `step.do` literal.
  Recommendation: (b) first, (a) only when the wrapper earns it — smaller
  scanner diff, smaller review surface.

## What this RFC does NOT do

- No change to `SagaDefinition`, `buildCatalog`, the manifest gate, policy
  tables, Execution/Operation semantics, tenancy, or secrets handling.
- No new Cloudflare primitive, no binding abstraction, no DSL.
- No inference, codegen, or dependency additions.
- No rewrite of existing Sagas until the ADR is accepted; when accepted,
  migrate one Saga per PR with contract-test green each time.

## Consequences (if accepted as ADR)

- Authors write identity + schemas (one line each) + the Action calls; the
  platform owns prepare/checkpoints/timeout-marking/persist/scrub text.
- The steward's one-diagram test is unaffected: one execution path, one
  persistence path, one secrets path — helpers are inlining, not branching.
- Free-tier cost unchanged: helpers are pure source factoring, zero extra
  D1 reads/writes/steps. Bundle delta is a few small functions.
- Risk: helpers become the place where policy knobs sneak back into source
  (a `timeoutMs` parameter per call is already borderline — today it resolves
  through the snapshot default). The ADR must draw the helper/policy line
  explicitly, and `validateSagaDefinition`'s policy-key rejection should gain
  a helper-signature review rule.

## Open questions (for shaping into ADR)

1. Where is the helper/policy line? `doVendor` needs *some* timeout input
   (today: `VENDOR_TIMEOUT_MS` constant + snapshot override). Is passing the
   Integration default constant into the helper source-policy by another
   name, or is it fine because the snapshot always wins?
2. `sagaRun` wrapper now or interior-helpers-only first? (Recommendation
   above: helpers first.)
3. Should `op.vendor` return the `{ok, result|error}` union (author branches)
   or throw the structured error (wrapper catches)? Throwing deletes category
   6 but hides the timeout-code routing authors currently see.
4. Does `schemaOf` stay a hand-written frozen-literal builder, or do we
   accept that schemas remain verbose until real drift justifies codegen?
5. Class-decorator sugar (`@saga`) ever, or is `defineSaga` the permanent
   spelling? If ever, it desugars to `defineSaga` — agreed?
6. Who owns the Workflow adapter factory: `src/saga.ts` next to
   `bindSagaStep`, or per-Saga files keep explicit classes for greppability?
7. Migration order when accepted: smoke (no vendor) → hello → echo →
   ninjaorgs → digest → hello-parent, one PR each?

## Migration / acceptance sketch

1. Accept this as ADR 033 with the open questions resolved.
2. Land helpers + extended contract tests (scanner allowlist if `sagaRun`
   ships) with **zero** existing-Saga rewrites in the same PR.
3. Migrate Sagas one per PR; each PR shows before/after line counts and a
   green FULL gate (`npm run test:coverage`, typecheck, lint, format,
   bundle, scope).
4. Steward checklist: confirm the platform diagram still shows one path per
   concern after the migration lands.
