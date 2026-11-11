---
node: time.setTimeDilation
---

# Set Time Dilation

Sets how fast game time runs, for slow motion or a freeze.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Time Dilation | Float | 1 is normal speed, 0.5 half speed and 0 frozen. Kept between 0 and 8. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Takes effect from the next simulation step, for everything that moves with game time: physics, animation, tweens, [**Delay**](delay.md) and the **Delta Seconds** of [**Event Tick**](event-tick.md) and [**Get Delta Seconds**](get-delta-seconds.md).
- Events keep running at the same rate. At 0, **Event Tick** still runs, but its **Delta Seconds** is 0, so anything scaled by it stands still.
- For something that should keep normal speed, such as a pause menu, use [**Get Real Time In Seconds**](get-real-time-in-seconds.md).
- The same as the `slomo` console command.
