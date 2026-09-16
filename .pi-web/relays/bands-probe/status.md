# Status — bands-probe relay

## State
**Leg 1 complete. Leg 2 dispatched (cold runner, separate checkout).**

## Leg 1 (done)
Authored packet, committed on `experiment/bands-relay-probe`, pushed to origin.

## Current / next leg
- Leg 2: cold runner reads charter → status → log, runs `npm run typecheck`
  in its own checkout, appends evidence + verdict to `log.md`, marks Complete.
- Bounded leg: observe + report only. No fixes. No source modifications.

## Blockers
None.
