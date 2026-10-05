# ADR 033: Saga authoring ergonomics — less ceremony over the canonical contract

- **Status:** Accepted (issue #416; steward-reserved number 033 — no
  collision: 033 was free and the ADR-033 milestone already named it; the
  wider renumber in issue #225 stays open and untouched by this lane)
- **Date:** 2026-09-16 (RFC revised per steward feedback on PR #404 and #408;
  accepted 2026-09-17)
- **Extends:** ADR 002 (stable Saga identity), ADR 010 (source boundary), ADR 018 RUN-01 (runtime policy), ADR 039 RUN-02 (child invocation, renumbered from 018 by issue #225), `docs/upstream-spec.md` findings 1, 3, 15, 18
- **Implements:** ADR-033 Saga authoring ergonomics (issues #412–#416).
  #412 landed interior helpers, #413 scanner/manifest gates, #414 terminal
  outcome helpers, #415 Action vocabulary (six Integration legs onto
  `integrationOperation` — legs, not Saga rewrites); #416 records this
  acceptance plus the entrypoint/synthesis proofs, with the six in-scope
  Saga migrations following one-per-PR after acceptance (no Saga rewrites
  ride the acceptance PR itself).
- **Renamed:** `TBD-saga-authoring-ergonomics.md` → `033-saga-authoring-ergonomics.md`
  on acceptance; no content change rides the rename beyond the acceptance
  record in this section and the proof outcomes below.

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
an ordinary async function. Wrangnarok does not need a second Saga programming
model; it needs less duplicated platform ceremony around the existing
`defineSaga` contract. The verbosity gap is therefore not a missing language
feature — it is repeated run-body ceremony that the platform could own.

### Verbosity audit (measured 2026-09-16)

| Saga file | Lines | Integration steps | Repeated ceremony |
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
5. **Integration-step interior** (~25 lines per Integration Action call):
   `beginOperation`, policy-snapshot deadline lookup, `withOperation` +
   `resolveConnection`, declared/optional branch, secret-handle pass-through
   comment, try/catch around the Integration Action, `Fault`-vs-generic
   mapping, `finishOperation`, `{ok, result|error}` shaping. Echo, ninjaorgs,
   and both digest legs repeat this with only names, IDs, and the Action call
   differing.
6. **Outcome handling** (~15 lines per Integration call): `expectedFailure`
   capture, timeout-code check, `timeout-mark-v1`, `NonRetryableError` throw.
7. **persist-success / persist-failure + scrub** (~15 lines/file): identical
   SQL and scrub calls modulo the output value.

A single-Integration Saga is ~140 lines of which roughly **15 carry
Saga-specific behavior** (the Action call and the output shape). Everything
else is platform ceremony the author re-types per file.

## Decisions (accepted on issue #416)

Principles 1–6 plus 2b–2c below are the recorded decisions. They collapse
the RFC's former open questions into constraints and are stated as
decisions, not options:

1. **`defineSaga` remains the one canonical authoring contract.** Thin
   helpers desugar into the existing contract; they never create a peer
   contract. No `@saga`/`@operation` spelling ships in v1.
2. **Helpers may hide invariant machinery, but not durable topology, in v1.**
   `step.do(...)` / `step.sleep(...)` stay visible in Saga source, so the
   author can read the file and see `prepare -> integration/action -> wait ->
   persist` at a glance. Helpers may own the repetitive *interior* of an
   Operation — including terminal/error interiors (principle 2b) — but never
   the durable boundary itself. Concretely: helpers never receive `step`.
   The Saga owns every `step.do` / `step.sleep` call; a helper is always
   invoked *inside* a visible step callback (or in a pure, non-durable
   section). This gives agents one obvious shape to generate and the
   determinism scanner one invariant to check. The `sagaRun(...)` lifecycle
   wrapper is deferred: it would hide the durable Operation boundaries and
   force the scanner to learn a second blessed syntax.

2b. **Terminal and error interiors are helper-owned, not author-owned.**
    Timeout classification, scrub discipline, and terminal persistence are
    exactly the correctness machinery agents are most likely to get subtly
    wrong, so they belong inside helpers even though the persist *steps*
    stay visible. The Saga visibly calls
    `step.do("persist-success-v1", () => completeExecution(...))` /
    `step.do("persist-failure-v1", () => failSagaExecution(...))`, where
    those helpers own scrub plus terminal-state rules plus timeout
    classification. Author-owned `expectedFailure` / `timedOut` plumbing,
    per-Saga timeout-code checks, and hand-chosen success/failure/timed-out
    persistence paths disappear from generated code.
2c. **Timeout classification subsumes `timeout-mark-v1` (decision, not
    detail).** `timeout-mark-v1` does not survive as a distinct durable
    step. `failSagaExecution` classifies Failed vs TimedOut internally and
    is the one canonical terminal writer:

    ```text
    Integration Action fails
            ↓
    persist-failure-v1
            ↓
    failSagaExecution(...)
            ↓
    classifies Failed vs TimedOut
            ↓
    one canonical terminal writer
    ```

    Rationale, verified against the current implementation: `failExecution`
    already takes the terminal status as a parameter (`"Failed" |
    "TimedOut"`, `src/executions.ts`), and its conditional writes
    (`Pending`/`Running`-gated executions, `Running`-gated operations)
    already fence the cancel/timeout races — so no independent timeout
    checkpoint is needed for replay or recovery semantics. No code reads a
    `timeout-mark-v1` Operation row; it is a second terminal-writing shape,
    not an independent recovery checkpoint. The visible durable graph gets
    simpler for agents (one failure step, not two mutually exclusive
    terminal writers), and the `stepRetryLimit` table entry for
    `timeout-mark-v1` retires with it. ADR 018's "sole writer of TimedOut"
    invariant is preserved by mechanism — `failSagaExecution` becomes that
    sole writer — and the accepted ADR records the retirement explicitly
    rather than leaving two terminal shapes in the codebase.

    Retirement record (issue #414, landed pre-acceptance): `completeExecution`
    / `failSagaExecution` live in `src/executions.ts` beside `failExecution`,
    taking `(db, id, ...)` like their sibling terminal writers (the sketch's
    `ctx`-first call was illustrative; the lane chose the sibling shape).
    `failSagaExecution` classifies `*_VENDOR_TIMEOUT` codes as `TimedOut` and
    everything else as `Failed`, then writes through the one shared fenced
    mechanism. The `timeout-mark-v1` entry is retired from the retry table,
    code comments, and docs; the six legacy Saga `timeout-mark-v1` steps stay
    byte-identical until #416 migrates them, resolving 0 retries (fail-closed,
    pinned by `test/domain.test.ts` and `test/terminal-outcomes.test.ts`).
    The single-attempt checkpoint is the same conditional `UPDATE`, so the
    legacy paths still land `TimedOut` — proven by the existing timeout
    suites staying green, not by a second writer.
3. **Saga helpers accept no runtime-policy knobs.** Effective deadlines and
   retry ceilings derive internally from the Integration default plus the
   Execution policy snapshot plus the platform ceiling. Saga authors never
   pass a timeout-looking number, so there is nothing to confuse with a
   provider default. (The RFC's first draft passed `timeoutMs` /
   `VENDOR_TIMEOUT_MS` into the helper sketch; that argument is removed.)
4. **Integration Action, not vendor HTTP, is the author-facing abstraction.**
   Helpers are named around Integration Actions
   (`integrationOperation(...)` / `op.integration(...)`), never around
   vendors (`doVendor` / `op.vendor`). An Action may later be HTTP, a
   service binding, MCP/OpenAPI Code Mode, or another transport; the
   authoring surface must not freeze HTTP-vendor assumptions into helper
   names or signatures.
5. **Ergonomics by invariant ownership.** Helper value is measured as
   correctness, not line-count reduction. The best helper is one that makes
   it impossible to forget a platform invariant: begin/finish Operation,
   org-scoped Connection resolution, applied-policy deadline resolution,
   Fault mapping, timeout classification, scrub registration, terminal
   persistence. Terseness follows; it never leads.
6. **Agent-oriented authoring.** The primary author of Sagas is increasingly
   a coding agent, so the surface optimizes for agents first, humans second:
   minimum ambiguity plus maximum mechanical feedback. Terseness is
   secondary to deterministic synthesis, obvious durable topology, and
   compiler/contract/runtime feedback. Concretely: a small, strongly typed,
   low-overload helper surface that narrows the space of valid generated
   code; explicit `step.do()` boundaries (a feature for agents, giving the
   durable graph in source and the scanner a simple invariant); no
   magic/overloaded helper APIs with many optional shapes; error messages
   from `validateSagaDefinition`, determinism checks, and helper guards
   actionable enough that an agent can self-repair without guessing.

The intended end state is not "the shortest Saga possible". It is: **a Saga
where almost every remaining line expresses identity, durable sequencing, or
business behavior, while platform correctness machinery is centralized and
hard to omit.** If a 50–60 line Saga is dramatically easier for an agent to
generate correctly because identity, capabilities, and durable Operations
remain explicit, that is the better API than a 40-line one that hides
topology. The north-star question: can a coding agent take a concise
automation specification and reliably produce a valid, secure, test-passing
Saga on the first or second attempt without repository-specific folklore?

## Non-negotiables (this RFC must not weaken these)

1. **Stable identity** (ADR 002): explicit UUID id, manifest churn gate,
   duplicate-ID/name fatal boot errors. Helpers still produce one
   `defineSaga` call with an explicit UUID — never a name/path/code hash.
2. **No policy in source** (finding 3, ADR 018): timeouts, retries, schedules,
   endpoints, access rules stay persisted policy. Helper signatures accept no
   knob parameters (principle 3 above).
3. **Determinism contract** (`assertDeterministicRun` + `test/saga-contract.test.ts`):
   all I/O inside `step.do()`, `ctx.*` handles never touched outside it. The
   scanner works by blanking literal `step.do(...)` bodies and requires a
   literal `step.do(` in `run` source — and v1 keeps it that way, because no
   v1 helper hides `step.do` structure. No scanner change ships in v1.
4. **Scrub discipline** (ADR 005/SEC-01): write-time scrubbing on every egress
   path, by mechanism not author discipline.
5. **Cloudflare nouns stay native** (lexicon): Worker, Workflow, step, D1 keep
   their names; no portability abstraction.
6. **Free-tier flat**: authoring ergonomics must add zero runtime D1/Workflow
   cost and negligible Worker bundle weight (helpers are pure source
   factoring; the Worker bundle budget gate in `scripts/check-bundle-budget.mjs`
   stays green with headroom to spare for a few small functions).

## Proposal: thin helpers over the existing contract

No new contract, no decorator syntax, no codegen. Add a small set of boring
typed functions in `src/saga.ts` (or a new `src/saga-helpers.ts`) that own
the repeated interiors while `run` keeps calling `step.do` visibly:

- `schemaOf(properties, required)` — one-line frozen `IoSchema` builder
  replacing ~15 lines of nested `Object.freeze` literals. This is
  declaration sugar only: it compresses syntax without solving
  schema/parser drift, and must never be framed as more. A schema-first
  parser is revisited only if drift becomes a demonstrated problem.
- `makeSagaWorkflow(def)` — factory returning the `WorkflowEntrypoint`
  subclass, replacing the per-file adapter class body with a one-line named
  subclass (`export class EchoWorkflow extends
  makeSagaWorkflow(echoSagaDef) {}`). The named export per Saga file stays:
  `wrangler.jsonc` `class_name` entries and the `src/index.ts` re-export
  require statically exported classes, so an anonymous factory product alone
  cannot serve as the binding target. Typing verified 2026-09-16 with a
  throwaway probe (removed after): the factory's return type must preserve
  the native `(ctx: ExecutionContext, env: Bindings)` construct signature —
  a `new () => ...` return type fails with TS2322 because the native
  constructor takes 2 arguments. `src/bindings.ts` and `wrangler.jsonc`
  entries remain explicit (native binding names are Cloudflare's, not ours
  to abstract). Acceptance requires a workerd/Wrangler proof that the
  generated subclass remains a valid native Workflow entrypoint.
- `prepareInput(ctx, saga, parse)` — the `prepare-input-v1` interior,
  always invoked as `step.do("prepare-input-v1", () =>
  prepareInput(ctx, echoSaga, parseInput))`. Note the signature takes no
  `step`: per principle 2 the Saga owns the durable boundary.
- `integrationOperation(ctx, def, prepared, { op, integrationId, call })`
  — owns the ~25-line Integration-step interior (begin, applied-policy
  deadline derived internally, org-scoped resolution, Fault mapping, finish,
  `{ok,...}` shaping) while the author's `call` callback holds only the
  Integration Action invocation. Called **inside** a visible `step.do` so
  the scanner keeps working unchanged, and takes no `step` argument (the
  Saga owns the boundary). It takes no timeout/retry/deadline argument:
  the effective deadline resolves inside the helper from the Integration
  default + Execution policy snapshot + platform ceiling. It takes no
  `required` list either: required-vs-optional semantics derive from the
  Saga definition (`def.requiredIntegrations`, already authoritative via
  ADR 002) plus the integration ID, so generated call sites cannot drift
  out of sync with the declared requirements.

Sketch (echo, illustrative — exact names/shapes are shaping details.
Topology stays explicit; the sketch shows visible `step.do` boundaries and
no policy arguments):

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
  run: async (ctx, step): Promise<EchoInput> => {
    const id = ctx.executionId;
    if (typeof id !== "string" || !EXECUTION_ID.test(id)) {
      throw new NonRetryableError("Invalid local Execution invocation.");
    }
    const prepared = await step.do("prepare-input-v1", () =>
      prepareInput(ctx, echoSaga, parseInput),
    );
    const outcome = await step.do("echo-http-v1", () =>
      integrationOperation(ctx, echoSagaDef, prepared, {
        op: "echo-http-v1",
        integrationId: ECHO_INTEGRATION_ID,
        call: (connection, secrets, deadline, operationId) =>
          ctx.integrations.echo.echo(connection, prepared.input, operationId, deadline),
      }),
    );
    // Terminal interiors are helper-owned (principles 2b-2c): the persist
    // steps stay visible, but scrub, terminal-state rules, and timeout
    // classification live inside completeExecution / failSagaExecution —
    // timeout-mark-v1 is subsumed, not a separate step. No
    // expectedFailure/timedOut plumbing in generated code.
    if (!outcome.ok) {
      await step.do("persist-failure-v1", () =>
        failSagaExecution(ctx, id, outcome.error),
      );
      throw new NonRetryableError(outcome.error.code);
    }
    const output = outcome.result;
    await step.sleep("settle-wait-v1", "1 second");
    await step.do("persist-success-v1", () =>
      completeExecution(ctx, id, output),
    );
    return output;
  },
});

export class EchoWorkflow extends makeSagaWorkflow(echoSagaDef) {}
// Named subclass (not `export const X = makeSagaWorkflow(def)`): the
// wrangler.jsonc class_name target and src/index.ts re-export need a
// statically exported class.
```

The sketch is deliberately not maximally short: every durable boundary
(`prepare-input-v1`, `echo-http-v1`, `settle-wait-v1`, `persist-success-v1` /
`persist-failure-v1`) remains legible in source, for humans and for agents —
while the terminal and error *interiors* (scrub, terminal-state rules,
timeout classification) live inside `completeExecution` /
`failSagaExecution` rather than in author-owned plumbing. `defineSaga`, the
manifest gate, the policy rejection list, and the determinism scanner all
survive unchanged — no scanner update ships in v1 because nothing takes
`step` and nothing hides `step.do` structure anymore.

### Explicitly deferred (not v1; re-deferred on issue #416)

- The `sagaRun(...)` lifecycle wrapper: it would own the ID guard,
  try/catch, timeout-code routing, persist-success/failure, and scrub
  mapping — but it hides the durable Operation boundaries and forces the
  scanner to learn a second blessed syntax. Re-deferred on issue #416 with
  a demonstrated reason: #413 pins a step-hiding wrapper failing the
  scanner with no allowlist (`test/saga-contract.test.ts`, "fails a
  wrapper that hides step.do from run source"), and #415 migrated all six
  Integration legs onto `integrationOperation` with zero scanner change —
  so the interior-helper shape is proven and `sagaRun` has no demonstrated
  need beyond what interior helpers cover. It ships only after it earns
  its scanner diff against this evidence, not before.
- Class-decorator sugar (`@saga`): rejected as the contract surface (it
  trades a greppable, diffable, validatable object literal for class
  machinery with worse type inference and a second authoring path through
  the steward's one-diagram test). If the spelling is ever wanted, a single
  `@saga(meta)` class decorator desugaring to `defineSaga` could be added
  later on top of these helpers — never as the contract itself.
- Codegen / schema inference (zod/valibot/build-time extractor): every
  codegen dependency adds Worker bundle weight for metadata alone (ADR 002
  already made this call), and inferred schemas drift silently from the
  persisted catalog. Revisit only when schema drift actually bites.

## Scanner impact: none in v1

`assertDeterministicRun` blanks literal `.do(` call bodies and requires at
least one `step.do(` in `run` source (`src/saga.ts:586`, blanking at `:548`).
Verified 2026-09-16 with a throwaway vitest probe against the real scanner
(both assertions passed, probe removed after): interior helpers called
inside visible `step.do` callbacks pass unchanged, while a wrapper hiding
`step.do` fails the gate. Because v1 ships interior helpers only, **no
scanner change is required**. The contract test must additionally pin that
helpers never touch `fetch`/`ctx.*`/I/O at their own top level (they
receive already-resolved values) — a helper is itself reviewable code, and
its body is covered by the same lint and test gates as any Saga.

## What this RFC does NOT do

- No change to `SagaDefinition`, `buildCatalog`, the manifest gate, policy
  tables, Execution/Operation semantics, tenancy, or secrets handling.
- No new Cloudflare primitive, no binding abstraction, no DSL.
- No inference, codegen, or dependency additions.
- No peer authoring contract: `defineSaga` stays canonical.
- No rewrite of existing Sagas until the ADR is accepted; when accepted,
  migrate one Saga per PR with contract-test green each time.

## Consequences (if accepted as ADR)

- Authors write identity + schemas (one line each) + visible durable
  sequencing + the Action calls; the platform owns prepare/checkpoint
  interiors, timeout classification text, persist/scrub mechanics.
- The steward's one-diagram test is unaffected: one execution path, one
  persistence path, one secrets path — helpers are inlining, not branching.
- Free-tier cost unchanged: helpers are pure source factoring, zero extra
  D1 reads/writes/steps. Bundle delta is a few small functions.
- Agent synthesis gets a narrower, more predictable generation target with
  fast mechanical feedback (typecheck, contract test, local runtime proof).
- Guardrail: `validateSagaDefinition`'s policy-key rejection gains a
  helper-signature review rule — any future helper parameter that smells
  like runtime policy (timeout, retry, schedule, concurrency, backoff)
  fails review even before it reaches code.

## Acceptance record (issue #416)

1. Accepted as ADR 033 with principles 1–6 + 2b–2c as decisions (this
   section). No Saga rewrites rode the acceptance PR.
2. Helpers + extended contract tests landed with **zero** existing-Saga
   rewrites (#412–#415, all merged before acceptance).
3. Sagas migrate one per PR in order smoke → hello → echo → ninjaorgs →
   digest → hello-parent; each PR shows before/after line counts and a
   green FULL gate (`npm run test:coverage`, typecheck, lint, format,
   bundle, scope). The Cloudflare verify/inventory Sagas are out of scope
   and keep their legacy terminals.
4. Native-entrypoint proof for `makeSagaWorkflow`:
   `test/entrypoint-proof/` boots a test-only workerd worker whose
   `PROOF_WORKFLOW` binding targets `ProofWorkflow extends
   makeSagaWorkflow(proofSagaDef)` and dispatches it to terminal success
   against local D1 — binding + `class_name` + dispatch, not just
   typecheck.
5. **Agent synthesis proof:** `test/agent-synthesis-proof.test.ts`
   generates a Saga from a short natural-language spec (recorded in
   `docs/saga-authoring-for-agents.md`) using the helpers, with typecheck
   + scanner gate + local D1 runtime proof and no manual repair; the
   attempt count is recorded honestly in the test header. The tiny
   canonical "Saga authoring for agents" guide ships with golden examples
   so there is one obvious generation path.
6. Steward checklist: the platform diagram still shows one path per
   concern after the migration lands (recorded on issue #416).
