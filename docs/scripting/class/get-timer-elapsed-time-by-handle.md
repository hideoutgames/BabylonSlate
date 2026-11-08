---
node: timers.timerElapsed
---

# Get Timer Elapsed Time By Handle

Seconds since the timer last ran or started, or -1 when there is no timer.

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
