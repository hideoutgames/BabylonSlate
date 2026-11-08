---
node: timers.unpauseTimer
---

# Unpause Timer By Handle

Lets a paused timer count on from where it stopped.

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
