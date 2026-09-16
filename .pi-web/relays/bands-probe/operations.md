# Operations — bands-probe relay

## Packet identity
- Relay: `bands-probe` (experiment: cold-start continuation via packet only).
- Profile: ad-hoc pi runner. No `relay-runner` worktree mechanics; in-place mode.
- Location: `.pi-web/relays/bands-probe/` on branch `experiment/bands-relay-probe`.

## Operating mode
- Leg 1 (done): author packet, commit, push branch. Drafting checkout:
  `~/src/MTG-Thomas/Wrangnarok`.
- Leg 2 (pending): cold runner in a SEPARATE checkout of the same branch
  (e.g. `~/src/MTG-Thomas/Wrangnarok-up`). Read charter → status → log, in that
  order. Do work. Append to log. Update status. Stop.

## Canonical pointers (read only what the leg needs)
- `AGENTS.md` — only if the leg required source changes (it does not).
- Relay method: packet = agreement (charter) + baton (status) + history (log).

## Verification / delivery mechanics
- Leg 2 command: `npm run typecheck` from repo root. Read-only toward source.
- Evidence: paste the tail (≤20 lines) of the command output into `log.md`.
- Baton update: set `status.md` to `Complete` with the pass/fail line.

## Packet isolation
- Runner-local state (node_modules, editor files) stays out of the packet.
- `log.md` is append-only. Never rewrite Leg 1 entries. Never edit `charter.md`
  to redefine done — that is an agreement change and stops the relay instead.
