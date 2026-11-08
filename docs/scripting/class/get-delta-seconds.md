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
- Returns 0 in Editor Utility Objects, which do not run a simulation.
