# Operations — bands-probe relay

## Packet identity

- Relay: `bands-probe` (experiment: cold-start continuation via packet only).
- Profile: ad-hoc pi runner. No `relay-runner` worktree mechanics; in-place mode.
- Location: `.pi-web/relays/bands-probe/` on branch `experiment/bands-relay-probe`.

## Operating mode

- Leg 1 (done): author packet, commit, push branch. Drafting checkout: `~/src/MTG-Thomas/Wrangnarok`.
- Leg 2 (complete): the cold runner used a SEPARATE checkout of the same branch, read charter → status → log, ran `npm run typecheck`, appended evidence and a verdict to `log.md`, and updated `status.md`.
- No active leg remains. The command and steps below are archival, not instructions to rerun the completed relay.

## Canonical pointers (read only what the leg needs)

- `AGENTS.md` — only if the leg required source changes (it does not).
- Relay method: packet = agreement (charter) + baton (status) + history (log).

## Verification / delivery mechanics

- Leg 2 command: `npm run typecheck` from repo root. Read-only toward source.
- Evidence: paste the tail (≤20 lines) of the command output into `log.md`.
- Baton update: set `status.md` to `Complete` with the pass/fail line.

## Packet isolation

- Runner-local state (node_modules, editor files) stays out of the packet.
- Historical log entries remain immutable. The original `log.md` is now held byte-for-byte in `log.original.txt`, linked by the current `log.md` evidence index. Never rewrite Leg 1 or Leg 2 entries in the original artifact.
- The original agreement is held byte-for-byte in `charter.original.txt`. `charter.md` is its entrypoint with a supported-Node clarification only. Never redefine done or change the historical agreement's acceptance criteria.
- The custody transfer is post-completion stewardship, not another relay leg. Native formatter and CI rules remain unchanged.
