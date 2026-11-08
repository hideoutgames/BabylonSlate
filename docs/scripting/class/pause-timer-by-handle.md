---
node: timers.pauseTimer
---

# Pause Timer By Handle

Holds the timer where it is until Unpause Timer By Handle.

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
- A paused timer keeps its remaining time.
