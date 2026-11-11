---
node: physics.boxTrace
---

# Box Trace

Sweeps a box from a start point to an end point and reports the first hit.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Start | Vector3 |  |
| End | Vector3 |  |
| Half Size | Vector3 | Half the box's size along each axis, in world units. Defaults to 0.5. |
| Orientation | Rotator | Turns the shape. Defaults to no turn. |
| Channel | CollisionChannel | Limits which colliders count, as on [**Line Trace**](line-trace.md). Defaults to All. |
| Actors To Ignore | Array of Actor Reference | Actors the query passes through. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Hit Result | HitResult | All results in one structure. Use **Break Hit Result** to read its fields. |
| Hit | Boolean |  |
| Location | Vector3 | The point on the surface that was hit. |
| Normal | Vector3 |  |
| Distance | Float | How far the shape's centre travelled before the hit, in world units. |
| Actor | Actor Reference | The actor that was hit, or an empty reference on a miss. |

## Notes

- The box keeps **Orientation** for the whole sweep.
- A box that already overlaps something at **Start** hits with a Distance of 0.
- A miss reports the same empty values as [**Line Trace**](line-trace.md).
