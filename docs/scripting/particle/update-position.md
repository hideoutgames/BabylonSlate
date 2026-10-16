---
node: update.position
---

# Update Position

Sets the position of every particle each frame.

## Inputs

| Pin | Type |
| --- | --- |
| Particle | Particle |
| Position | Vector 3 |

## Outputs

| Pin | Type |
| --- | --- |
| Particle | Particle |

## Notes

- The position is in world space.
- Use it instead of [**Apply Velocity**](apply-velocity.md) when you want to control the motion yourself.
