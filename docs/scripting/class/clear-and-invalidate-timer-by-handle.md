---
node: timers.clearAndInvalidateTimer
---

# Clear And Invalidate Timer By Handle

Stops the timer and empties the Handle variable connected to it, so the handle names no timer.

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

- **Handle** is a [reference pin](../pin-types.md#reference-pins): connect the Timer Handle variable itself.
- **Handle** comes from [Set Timer By Event](set-timer-by-event.md); keep it in a Timer Handle variable to reach the timer later.
