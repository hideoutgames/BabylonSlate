---
node: timers.isTimerActive
---

# Is Timer Active By Handle

True while the timer exists and is not paused.

## Inputs

| Pin | Type |
| --- | --- |
| Handle | Timer Handle |

## Outputs

| Pin | Type |
| --- | --- |
| Active | Boolean |

## Notes

- **Handle** comes from [Set Timer By Event](set-timer-by-event.md); keep it in a Timer Handle variable to reach the timer later.
