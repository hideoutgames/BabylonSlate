---
node: physics.setMotionType
---

# Set Motion Type

Changes how an actor's Rigid Body moves, such as turning physics simulation on or off.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Actor Reference | Left unconnected the pin shows **Self** and uses the actor running the graph. |
| Motion Type | MotionType | Dynamic by default. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- **Dynamic** simulates the body: gravity, forces and collisions move it.
- **Kinematic** stops simulating: the body follows the actor's transform and still pushes Dynamic bodies.
- **Static** never moves and is answered by the Static channel of traces and overlaps.
- The node sets the **Motion Type** of the actor's first Rigid Body component and does nothing without one.
