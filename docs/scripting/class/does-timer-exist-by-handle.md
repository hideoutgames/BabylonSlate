---
node: timers.timerExists
---

# Does Timer Exist By Handle

True until the timer is cleared, its owner is destroyed or, when not looping, it has run.

## Inputs

| Pin | Type |
| --- | --- |
| Handle | Timer Handle |

## Outputs

| Pin | Type |
| --- | --- |
| Exists | Boolean |

## Notes

- **Handle** comes from [Set Timer By Event](set-timer-by-event.md); keep it in a Timer Handle variable to reach the timer later.
