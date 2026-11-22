---
node: physics.addForce
---

# Add Force

Pushes an actor's Rigid Body for one frame.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Actor Reference | Left unconnected the pin shows **Self** and uses the actor running the graph. |
| Force | Vector3 | The push in world directions. Its length is the strength. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- The push is **Force** multiplied by the frame's delta seconds, so calling the node every frame accelerates the body steadily whatever the frame rate. For one instant push, use [**Add Impulse**](add-impulse.md).
- From the **Event Tick** of an actor with a [**Tick Interval**](event-tick.md#tick-interval), the delta seconds cover the whole interval, so the push for the interval lands on one step.
- A heavier body (a larger **Mass**) speeds up less from the same force.
- Nothing happens unless the actor has a Rigid Body whose motion type is Dynamic.
