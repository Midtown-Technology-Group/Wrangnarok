# Saga authoring for agents (ADR 033, issue #416)

One obvious generation path. `defineSaga` (`src/saga.ts`) is the only
contract; the helpers below desugar into it. Full rules live in
`docs/sdk-agents.md` and `docs/architecture/033-saga-authoring-ergonomics.md`;
this file is the short version with copyable shapes.

## The generation checklist

1. Identity: explicit stable UUID `id`, slug `name`, non-empty `revision`,
   1–280 char `description`, explicit `requiredIntegrations` (even empty).
2. Schemas: `schemaOf({ field: "string" }, ["field"])` from `src/saga.ts`.
3. `run` owns every durable boundary: each effect inside a visible
   `step.do("name-v1", () => ...)` / `step.sleep(...)`. Helpers never take
   `step` — always call them *inside* a step callback.
4. Prepare: `step.do("prepare-input-v1", () => prepareInput(ctx, saga, parse))`.
5. Integration legs: `step.do("<op>-v1", () => integrationOperation(ctx, def,
   prepared, { op, position, integrationId, vendorDefaultMs, failureCode,
   failureMessage, call }))`. `call` takes
   `(connection, secrets, deadline, operationId)` and holds ONLY the Action
   invocation. No timeout/retry/required arguments — ever.
6. Failure branch: `await step.do("persist-failure-v1", () =>
   failSagaExecution(ctx.db, id, outcome.error)); throw new
   NonRetryableError(outcome.error.code);` No `expectedFailure`/`timedOut`
   variables, no per-Saga timeout-code checks, no `timeout-mark-v1`.
7. Success: `await step.do("persist-success-v1", () =>
   completeExecution(ctx.db, id, output)); return output;`
8. Unexpected errors: the `catch` persists the generic marker (or a
   `Fault`-mapped code) via `failSagaExecution` and throws its code. If the
   failure branch already persisted, rethrow untouched — step names are
   unique per Execution, so exactly one `persist-failure-v1` runs.
9. Adapter: `export class XxxWorkflow extends makeSagaWorkflow(xxxSagaDef)
   {}` (`src/sagas/shared.ts`). Never hand-write the adapter body.
10. Never in source: timeouts, retries, schedules, endpoints, credentials,
    `fetch`/`Date.now`/`Math.random` outside `step.do`, `ctx.*` handles
    outside `step.do` (except `ctx.executionId` for the ID guard).

## Golden example 1: pure transform (no Integration)

```ts
import { NonRetryableError } from "cloudflare:workflows";
import { defineSaga, schemaOf } from "../src/saga";
import { Fault } from "../src/domain";
import type { SafeError } from "../src/domain";
import { assertRunExecutionId, completeExecution, failSagaExecution } from "../src/executions";
import { prepareInput } from "../src/saga-helpers";

const SHOUT_ID = "aaaaaaaa-1111-4111-8111-111111111111";

interface ShoutInput { phrase: string }
interface ShoutOutput { shouted: string }

function parseShoutInput(value: unknown): ShoutInput {
  if (typeof value !== "object" || value === null || typeof (value as { phrase?: unknown }).phrase !== "string") {
    throw new Fault(400, "INVALID_INPUT", "Expected { phrase: string }.");
  }
  return { phrase: (value as { phrase: string }).phrase };
}

export const shoutSagaDef = defineSaga<ShoutOutput>({
  id: SHOUT_ID,
  name: "shout",
  revision: "shout-v1",
  description: "Uppercase a phrase with no Integration calls.",
  tags: ["utility", "example"],
  requiredIntegrations: [],
  inputSchema: schemaOf({ phrase: "string" }, ["phrase"]),
  outputSchema: schemaOf({ shouted: "string" }, ["shouted"]),
  parse: parseShoutInput,
  run: async (ctx, step): Promise<ShoutOutput> => {
    // Pure transform, no expected-failure branch: the catch below is the
    // only persist-failure-v1 writer. Sagas with a pre-persisting failure
    // branch add the terminalWritten guard from golden example 2.
    const id = assertRunExecutionId(ctx.executionId);
    try {
      const prepared = await step.do("prepare-input-v1", () =>
        prepareInput(ctx, shoutSagaDef, parseShoutInput),
      );
      const output: ShoutOutput = { shouted: prepared.input.phrase.toUpperCase() };
      await step.do("persist-success-v1", () => completeExecution(ctx.db, id, output));
      return output;
    } catch {
      const failure: SafeError = {
        code: "EXECUTION_FAILED",
        message: "The Execution could not complete. Inspect local runtime diagnostics.",
      };
      await step.do("persist-failure-v1", () => failSagaExecution(ctx.db, id, failure));
      throw new NonRetryableError(failure.code);
    }
  },
});
```

## Golden example 2: one Integration leg (echo-shaped)

Same skeleton, plus one leg between prepare and persist. The `call`
callback holds only the Action invocation; required-vs-optional derives
from `def.requiredIntegrations` inside the helper:

```ts
const outcome = await step.do("echo-http-v1", () =>
  integrationOperation(ctx, echoSagaDef, prepared, {
    op: "echo-http-v1",
    position: 1,
    integrationId: ECHO_INTEGRATION_ID,
    vendorDefaultMs: VENDOR_TIMEOUT_MS,
    failureCode: "ECHO_INTEGRATION_FAILED",
    failureMessage: "The echo Integration could not complete.",
    call: (connection, _secrets, deadline, operationId) =>
      ctx.integrations.echo.echo(connection, prepared.input, operationId, deadline),
  }),
);
if (!outcome.ok) {
  await step.do("persist-failure-v1", () =>
    failSagaExecution(ctx.db, id, outcome.error),
  );
  terminalWritten = true;
  throw new NonRetryableError(outcome.error.code);
}
```

## Validate (mechanical feedback — use it before asking)

- `npx tsc --noEmit -p test/tsconfig.json` — the helpers are strongly
  typed; a wrong `call` shape or helper argument fails here first.
- `npm run check:sagas` — the determinism scanner: a hidden `step.do`
  or top-level `ctx.*`/`fetch`/clock use fails here, never in review.
- Run the Saga against local D1 (see `test/agent-synthesis-proof.test.ts`
  for the minimal harness): insert an Execution row, drive `def.run`
  with an inline step runner, assert the terminal row.

If the scanner or typecheck fails, the error names the exact invariant —
self-repair from that message; do not reshape the helpers or add a new
authoring path. A second blessed syntax (today: any `sagaRun`-style
wrapper hiding `step.do`) fails the gate by design (ADR 033).
