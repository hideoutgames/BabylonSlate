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
- Every tick runs the graph, even while an earlier tick's run still waits on a latent node such as [**Delay**](delay.md). Each run waits on its own, so a Delay here continues once for every tick that reached it.
- Also available in Game Instance and subsystem classes, and in Object classes that implement the **Tickable Object** interface; see [Objects and lifetime](../object-lifetime.md#tick).
