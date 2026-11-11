---
node: physics.getMotionType
---

# Get Motion Type

Returns how an actor's Rigid Body moves: Dynamic, Kinematic or Static.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Target | Actor Reference | Left unconnected the pin shows **Self** and uses the actor running the graph. |

## Outputs

| Pin | Type |
| --- | --- |
| Motion Type | MotionType |

## Notes

- Static when the actor has no Rigid Body.
