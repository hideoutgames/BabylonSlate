---
node: timers.isTimerPaused
---

# Is Timer Paused By Handle

True while the timer exists and is paused.

## Inputs

| Pin | Type |
| --- | --- |
| Handle | Timer Handle |

## Outputs

| Pin | Type |
| --- | --- |
| Paused | Boolean |

## Notes

- **Handle** comes from [Set Timer By Event](set-timer-by-event.md); keep it in a Timer Handle variable to reach the timer later.
