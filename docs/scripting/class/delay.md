---
node: timers.delay
---

# Delay

Waits for a number of seconds, then continues.

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

- Duration counts game time, so pausing the game or slowing time stretches the wait.
- If the owner is destroyed during the wait, the nodes after it do not run.
- Each call waits on its own. If Delay runs again while it waits, the nodes after it run once for every call, each Duration after its own call. To start the wait over on each call instead, use [Retriggerable Delay](retriggerable-delay.md).
- A Duration of 0 or less continues once every actor has ticked: called from [Event Tick](event-tick.md), later in the same tick. To continue in the next tick, use [Delay One Tick](delay-one-tick.md).
- Latent: the node finishes later without pausing the rest of the game.
