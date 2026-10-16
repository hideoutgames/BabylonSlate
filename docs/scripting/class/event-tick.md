# Event Tick

Runs on every simulation step, giving the time since the previous one.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Delta Seconds | Float | Simulation time since the previous tick, in seconds, scaled by time dilation. |

## Notes

- Set **Event Tick** to Disabled in **Actor Defaults** to stop it for an actor; components keep ticking.
- If the graph waits on a latent node such as [**Delay**](delay.md), further ticks are skipped until that run finishes.
- Also available in Game Instance and subsystem classes.
