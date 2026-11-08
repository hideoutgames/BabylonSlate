---
node: flow.event.tick
---

# Event Tick

Runs on every simulation step, giving the time since the previous one.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Delta Seconds | Float | Simulation time since the previous tick, in seconds, scaled by time dilation. |

## Notes

- Set **Event Tick** to Disabled in **Actor Defaults** to stop it for an actor; components keep ticking.
- While the game is paused by [**Set Game Paused**](set-game-paused.md), it runs only for actors and Game Instances with **Tick On Pause**, and for actors in a Scene Layer with **Tick On Pause**.
- Every tick runs the graph, even while an earlier tick's run still waits on a latent node such as [**Delay**](delay.md). Each run waits on its own, so a Delay here continues once for every tick that reached it.
- Also available in Game Instance and subsystem classes, and in Object classes that implement the **Tickable Object** interface; see [Objects and lifetime](../object-lifetime.md#tick).
