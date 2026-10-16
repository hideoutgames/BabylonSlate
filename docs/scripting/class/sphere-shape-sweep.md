---
node: physics.shapeSweep
---

# Sphere Shape Sweep

Sweeps a sphere from a start point to an end point and reports the first hit.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Start | Vector 3 |  |
| End | Vector 3 |  |
| Radius | Float |  |
| Channel | CollisionChannel | Limits which colliders the sphere can hit, as on [**Line Trace**](line-trace.md). Defaults to All. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Hit Result | HitResult | All results in one structure. Use **Break Hit Result** to read its fields. |
| Hit | Boolean |  |
| Location | Vector 3 | The point on the surface that was hit. |
| Normal | Vector 3 |  |
| Distance | Float | How far the centre of the sphere travelled before the hit, in world units. |
| Actor | Actor Reference | The actor that was hit, or an empty reference on a miss. |

## Notes

- **Radius** must be greater than 0, in world units.
- A sphere that already overlaps something at **Start** hits with a Distance of 0.
- A miss reports the same empty values as [**Line Trace**](line-trace.md).
