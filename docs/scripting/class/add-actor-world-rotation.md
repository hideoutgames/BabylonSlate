---
node: transform.addWorldRotation
---

# Add Actor World Rotation

Turns the actor about the world's axes.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Target | Actor Reference |
| Delta Rotation | Rotator |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Leave **Target** unconnected to use the actor running the graph; the pin shows **Self**.
- Rotations are in degrees. The turn is about the world's axes, also for an attached actor.
- A value that is not a finite number changes nothing.
- If **Target** is empty when the node runs, nothing happens and an error is logged.
