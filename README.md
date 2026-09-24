> **Project status (2026-09-24):** Development of Wrangnarök is paused. We may return to the project in the future; until then, this repository is maintained as-is.

# Wrangnarök

[![codecov](https://codecov.io/gh/MTG-Thomas/Wrangnarok/branch/main/graph/badge.svg)](https://codecov.io/gh/MTG-Thomas/Wrangnarok)

> An experimental, Cloudflare-native reimagining of [Bifrost](https://github.com/gobifrost/bifrost).

Wrangnarök asks a deliberately constrained question:

**How much of Bifrost's code-first integration-orchestration model can be reproduced using only Cloudflare-native primitives, while remaining useful on Cloudflare's free tier?**

Wrangnarök is a full-stack app: one Cloudflare Worker serves both the browser UI (Workers Static Assets) and the JSON API, backed by Workflows + D1. See ADR 008.

This is a greenfield experiment, not a line-by-line port. Upstream Bifrost is treated primarily as a behavioral and product specification. Wrangnarök should preserve useful ideas while allowing Cloudflare's execution model to reshape the implementation.

## Project constraints

1. **Cloudflare-native first.** Prefer Workers, Workflows, D1, R2, Queues, Durable Objects, KV, and other Cloudflare primitives over external infrastructure.
2. **Free-tier viability is a design constraint.** The first useful MVP should operate within Cloudflare Free allowances. If a requirement breaks that constraint, document exactly why before adopting paid-only infrastructure.
3. **Code-first automation.** Sagas are TypeScript. Do not invent a workflow DSL until there is a demonstrated reason to have one.
4. **No infrastructure cosplay.** Do not recreate PostgreSQL, Redis, RabbitMQ, or conventional persistent workers merely because upstream uses them. Map capabilities to Cloudflare primitives instead.
5. **Cloudflare keeps its nouns.** Worker, Workflow, step, Queue, Durable Object, D1, R2, KV, and binding retain their Cloudflare meanings. Wrangnarök domain vocabulary must not obscure the underlying platform.
6. **Behavior over implementation compatibility.** Compatibility with Bifrost concepts matters more than compatibility with Bifrost internals.
7. **Add primitives when requirements demand them.** Start small and earn architectural complexity.

## Working vocabulary

The canonical domain vocabulary is defined in `docs/lexicon.md`; the table below is a non-normative summary. In case of conflict, `docs/lexicon.md` prevails.

| Wrangnarök | Meaning | Likely Cloudflare implementation |
| --- | --- | --- |
| **Saga** | Code-first automation definition | Cloudflare Workflow |
| **Execution** | One execution of a Saga | Workflow instance |
| **Operation** | A durable unit of Saga execution | Workflow step |
| **Integration** | Provider such as NinjaOne or Microsoft Graph | TypeScript module |
| **Connection** | Configured/authenticated instance of an Integration | D1 metadata + secrets |
| **Organization** | Organization/tenant boundary | D1-backed domain model |
| **Trigger** | Something that starts a Saga | HTTP, Cron, event, etc. |
| **ExecutionHistory** | Execution/audit history | D1 initially |
| **Catalog** | The catalog/graph tying Sagas, Integrations, Triggers, and Organizations together | Application/domain layer |

This vocabulary is intentionally conservative. Forms remain forms. Tables remain tables. Secrets remain secrets. Cloudflare Queues remain Queues. Mythology should clarify the domain, not turn the codebase into a crossword puzzle.

## MVP: First slice

The first milestone is intentionally tiny:

- TypeScript Worker deployable with Wrangler
- D1-backed minimal application state
- one code-first Saga
- one Execution launched through the API
- multiple durable Operations backed by Cloudflare Workflow steps
- persisted Execution/Operation status and results
- one simple HTTP-based Integration
- basic execution-history API
- demonstrated operation within Cloudflare Free limits

The slice is the milestone, not (yet) a domain abstraction.

## Upstream relationship

Bifrost currently provides the reference product model: multi-tenancy, reusable integrations, connection/OAuth management, secrets, code-first workflows, dynamic forms, tables/storage, triggers, monitoring, and Git/AI-assisted development.

Wrangnarök will maintain a capability map describing whether each upstream concept is:

- **Adopted** — behavior belongs in Wrangnarök
- **Adapted** — behavior belongs, but Cloudflare changes the model
- **Deferred** — useful but unnecessary for the current milestone
- **Rejected** — implementation or behavior does not fit the experiment
- **Unknown** — needs investigation

See `docs/upstream-spec.md` as that inventory develops.

## Initial architecture

```text
Browser UI (Static Assets) / API caller
        |
        v
 Cloudflare Worker (UI + /api/*, single deployment)
        |
        +---- D1 ----------------> Organizations / Connections / ExecutionHistory
        |
        +---- Workflow ----------> Saga Execution
                                  |
                                  +-- Operation
                                  +-- Operation
                                  +-- Operation
                                        |
                                        v
                                      Integration
                                        |
                                        v
                                   External API
```

Additional Cloudflare primitives are deliberately absent until a concrete requirement calls for them.

## Status

**Pre-alpha / architecture spike.** Expect names, APIs, and assumptions to change quickly.

## Attribution and licensing

Wrangnarök is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**, matching upstream [Bifrost Integrations](https://github.com/gobifrost/bifrost). Bifrost is the reference product and a potential source of compatible implementation ideas; preserve upstream copyright and attribution where upstream code is actually adapted or copied.
