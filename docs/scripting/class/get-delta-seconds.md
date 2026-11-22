---
node: time.getDeltaSeconds
---

# Get Delta Seconds

Returns the length of the current simulation step in seconds, scaled by time dilation.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Delta Seconds | Float | Seconds the current step covers, the same value [**Event Tick**](event-tick.md) gives. |

## Notes

- Works in any event or function, so you can scale movement by the step without wiring the value from **Event Tick**.
- Time dilation applies: at a dilation of 0.5 it returns half the fixed step.
- Inside **Event Tick** of an actor with a [**Tick Interval**](event-tick.md#tick-interval), it returns that tick's **Delta Seconds**: the time since the actor's previous tick.
- Returns 0 in Editor Utility Objects, which do not run a simulation.
