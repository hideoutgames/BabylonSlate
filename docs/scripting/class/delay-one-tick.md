---
node: timers.delayOneTick
---

# Delay One Tick

Waits until the next tick, then continues.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Called from [Event Tick](event-tick.md), the nodes after it run in the next tick. A [Delay](delay.md) with a Duration of 0 continues later in the same tick instead.
- Each call waits on its own, like [Delay](delay.md): if it runs again while it waits, the nodes after it run once for every call.
- The tick counts only while the owner can run, so a paused owner waits until it runs again.
- If the owner is destroyed during the wait, the nodes after it do not run.
- Latent: the node finishes later without pausing the rest of the game.
