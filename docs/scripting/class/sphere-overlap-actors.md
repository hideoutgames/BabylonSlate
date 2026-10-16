# Sphere Overlap Actors

Returns the actors whose colliders overlap a sphere at a given point.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Center | Vector 3 |  |
| Radius | Float |  |
| Channel | CollisionChannel | Limits which colliders count, as on [**Line Trace**](line-trace.md). Defaults to All. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |
| Actors | Array of Actor Reference |
| Count | Integer |

## Notes

- **Radius** must be greater than 0, in world units.
- Each overlapping actor is listed once in **Actors**, and **Count** is the number of actors returned.
