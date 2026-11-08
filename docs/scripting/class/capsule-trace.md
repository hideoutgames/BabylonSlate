---
node: physics.capsuleTrace
---

# Capsule Trace

Sweeps a capsule from a start point to an end point and reports the first hit.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Start | Vector 3 |  |
| End | Vector 3 |  |
| Radius | Float | Defaults to 0.5. |
| Half Height | Float | Half the length of the capsule's straight part, along its up axis. Defaults to 0.5. |
| Orientation | Rotator | Turns the shape. Defaults to no turn. |
| Channel | CollisionChannel | Limits which colliders count, as on [**Line Trace**](line-trace.md). Defaults to All. |
| Actors To Ignore | Array of Actor Reference | Actors the query passes through. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Hit Result | HitResult | All results in one structure. Use **Break Hit Result** to read its fields. |
| Hit | Boolean |  |
| Location | Vector 3 | The point on the surface that was hit. |
| Normal | Vector 3 |  |
| Distance | Float | How far the shape's centre travelled before the hit, in world units. |
| Actor | Actor Reference | The actor that was hit, or an empty reference on a miss. |

## Notes

- **Radius** must be greater than 0, in world units.
- The capsule stands upright unless **Orientation** turns it, and keeps that turn for the whole sweep.
- A capsule that already overlaps something at **Start** hits with a Distance of 0.
