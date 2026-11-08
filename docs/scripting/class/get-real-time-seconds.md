---
node: time.getRealTimeSeconds
---

# Get Real Time Seconds

Returns the time since Play started, ignoring time dilation.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Seconds | Float | Seconds since Play started, including the current step. 0 before the first step. |

## Notes

- Advances by the full simulation step whatever the time dilation, so it keeps normal speed during slow motion or a freeze. Use it for menus, UI animation and real-time cooldowns.
- Stops while the game is paused, and keeps counting across scene changes.
- For time that follows slow motion, use [**Get Game Time In Seconds**](get-game-time-in-seconds.md). For the clock time, use [**Get Time MS**](get-time-ms.md).
- Returns 0 in Editor Utility Objects, which do not run a simulation.
