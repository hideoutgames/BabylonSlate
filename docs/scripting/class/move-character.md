---
node: physics.moveCharacter
---

# Move Character

Moves an actor by a distance, sliding along solid colliders instead of passing through them.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Actor Reference |  |
| Translation | Vector 3 |  |
| Offset | Float | Gap kept from surfaces, in world units. Uses 0.01 unless above 0, and is read only the first time the actor moves. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- **Translation** is the distance to move in this call, in world units. It is not a speed, so multiply a velocity by the frame's delta time first.
- The actor needs a collider; without one it does not move.
