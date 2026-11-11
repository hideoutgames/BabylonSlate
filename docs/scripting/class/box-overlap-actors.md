---
node: physics.boxOverlap
---

# Box Overlap Actors

Returns the actors whose colliders overlap a box at a given point.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Center | Vector3 |  |
| Half Size | Vector3 | Half the box's size along each axis, in world units. Defaults to 0.5. |
| Orientation | Rotator | Turns the shape. Defaults to no turn. |
| Channel | CollisionChannel | Limits which colliders count, as on [**Line Trace**](line-trace.md). Defaults to All. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |
| Actors | Array of Actor Reference |
| Count | Integer |

## Notes

- Each overlapping actor is listed once in **Actors**, nearest first, and **Count** is the number of actors returned.
