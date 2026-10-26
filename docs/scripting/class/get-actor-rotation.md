---
node: transform.getRotation
---

# Get Actor Rotation

Returns an actor's rotation as a rotator in degrees.

## Inputs

| Pin | Type |
| --- | --- |
| Target | Actor Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Rotator |

## Notes

- Leave **Target** unconnected to use the actor running the graph; the pin shows **Self**.
- For an attached actor, the rotation is relative to its parent.
