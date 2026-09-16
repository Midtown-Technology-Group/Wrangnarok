# Log — bands-probe relay (append-only)

## Leg 1 — packet authored + pushed (2026-09-16, drafting checkout Wrangnarok)
- Authored charter/operations/status/log per relay method (agreement / baton / history split).
- Task selected: read-only `npm run typecheck` + report. Deliberately trivial work so the
  experiment measures *packet sufficiency*, not task difficulty.
- Committed on `experiment/bands-relay-probe`, pushed to origin for git-mailbox delivery.
- Handoff: Leg 2 runner starts cold in a separate checkout of this branch.
