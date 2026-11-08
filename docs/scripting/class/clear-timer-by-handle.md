---
node: timers.clearTimer
---

# Clear Timer By Handle

Stops the timer; it will not run its event again.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Handle | Timer Handle |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- **Handle** comes from [Set Timer By Event](set-timer-by-event.md); keep it in a Timer Handle variable to reach the timer later.
- Clearing a timer that already ended does nothing.
