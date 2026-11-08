---
node: time.getGameTimeSeconds
---

# Get Game Time In Seconds

Returns the game time since Play started, scaled by time dilation.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Seconds | Float | Seconds of game time, including the current step. 0 before the first step. |

## Notes

- Adds up [**Get Delta Seconds**](get-delta-seconds.md) of every step, so it slows with [**Set Time Dilation**](set-time-dilation.md) and stops while the game is paused, by [**Set Game Paused**](set-game-paused.md) or the editor's **Pause** button.
- Keeps counting across scene changes.
- Use it for gameplay timers that should follow slow motion, such as a cooldown. For time that ignores time dilation, use [**Get Real Time Seconds**](get-real-time-seconds.md).
- Returns 0 in Editor Utility Objects, which do not run a simulation.
