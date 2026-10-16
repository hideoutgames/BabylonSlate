---
node: transform.setRotation
---

# Set Actor Rotation

Sets an actor's rotation from pitch, yaw and roll angles in degrees.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Actor Reference |  |
| Rotation | Rotator | Pitch, yaw and roll in degrees. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Replaces the whole rotation. For an attached actor, it is relative to the parent.
- A value that is not a finite number changes nothing.
