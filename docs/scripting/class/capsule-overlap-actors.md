---
node: physics.capsuleOverlap
---

# Capsule Overlap Actors

Returns the actors whose colliders overlap a capsule at a given point.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Center | Vector 3 |  |
| Radius | Float | Defaults to 0.5. |
| Half Height | Float | Half the length of the capsule's straight part, along its up axis. Defaults to 0.5. |
| Orientation | Rotator | Turns the shape. Defaults to no turn. |
| Channel | CollisionChannel | Limits which colliders count, as on [**Line Trace**](line-trace.md). Defaults to All. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |
| Actors | Array of Actor Reference |
| Count | Integer |

## Notes

- **Radius** must be greater than 0, in world units.
- Each overlapping actor is listed once in **Actors**, nearest first, and **Count** is the number of actors returned.
