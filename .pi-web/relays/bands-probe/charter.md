# Charter — bands-probe relay

## Goal
Prove that this packet alone lets a fresh agent context (no transcript, no prior conversation)
continue bounded verification work in the Wrangnarok checkout and report back.

## Observable finish line
`log.md` contains a Leg 2 entry, written by a runner that started cold, recording:
the exact command run, pass/fail, and (if failing) the first error — plus a one-line verdict
on whether this packet sufficed without transcript replay.

## Minimum outcome acceptance
- Leg 2 runner touches only: the typecheck command, `status.md`, `log.md`.
- No source files modified. No fixes attempted, even if the typecheck fails.
- Verdict line present: "packet sufficed" or "packet insufficient because …".

## In-scope edges
- Checkout: any clean clone of `Midtown-Technology-Group/Wrangnarok` at branch
  `experiment/bands-relay-probe` (packet travels with the branch).
- Command: `npm run typecheck` from the repo root (Node 22+, dependencies installed).

## Explicit non-goals
- Fixing type errors. Improving the packet format. Touching CI, deployments, or D1.
- Replaying or reconstructing Leg 1's conversation. The packet is the whole context.

## Material assumptions / human decisions
- Operator approved this experiment end to end (dispatch authorized, 2026-09-16).
- `npm install` state is the runner's responsibility; network access assumed.
- AGENTS.md constraints apply to any source change — but this relay makes none.
