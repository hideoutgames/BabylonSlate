---
node: physics.addTorque
---

# Add Torque

Twists an actor's Rigid Body for one frame.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Actor Reference | Left unconnected the pin shows **Self** and uses the actor running the graph. |
| Torque | Vector3 | The world axis to turn about. Its length is the strength. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- The twist is **Torque** multiplied by the frame's delta seconds and acts about the body's centre of mass, so it spins the body without moving it.
- The body's shape and **Mass** decide how fast it starts spinning.
- In a 2D project only the Z value turns the body.
- Nothing happens unless the actor has a Rigid Body whose motion type is Dynamic.
