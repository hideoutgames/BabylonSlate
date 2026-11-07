---
node: timers.retriggerableDelay
---

# Retriggerable Delay

Waits for a number of seconds after its latest call, then continues once.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Duration | Float |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Each call starts the wait over from 0 with its own Duration. The nodes after it run once, Duration after the latest call; the calls before it end there.
- Each object has its own wait, so a call on one object does not restart another's.
- Duration counts game time, so pausing the game or slowing time stretches the wait.
- If the owner is destroyed during the wait, the nodes after it do not run.
- To run the nodes after it once for every call, use [Delay](delay.md).
- Latent: the node finishes later without pausing the rest of the game.
