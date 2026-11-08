---
node: time.getTimeDilation
---

# Get Time Dilation

Returns how fast game time runs.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Time Dilation | Float | 1 is normal speed, 0.5 half speed, 2 double speed and 0 frozen. |

## Notes

- Change it with [**Set Time Dilation**](set-time-dilation.md) or the `slomo` console command.
- Returns 1 in Editor Utility Objects, which do not run a simulation.
