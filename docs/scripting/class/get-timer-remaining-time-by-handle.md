---
node: timers.timerRemaining
---

# Get Timer Remaining Time By Handle

Seconds until the timer runs its event, or -1 when there is no timer.

## Inputs

| Pin | Type |
| --- | --- |
| Handle | Timer Handle |

## Outputs

| Pin | Type |
| --- | --- |
| Seconds | Float |

## Notes

- **Handle** comes from [Set Timer By Event](set-timer-by-event.md); keep it in a Timer Handle variable to reach the timer later.
- A paused timer reports the time it had left.
