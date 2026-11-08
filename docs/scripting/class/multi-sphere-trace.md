---
node: physics.multiSphereTrace
---

# Multi Sphere Trace

Sweeps a sphere from a start point to an end point and reports every actor it touches.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Start | Vector 3 |  |
| End | Vector 3 |  |
| Radius | Float | Defaults to 0.5. |
| Channel | CollisionChannel | Limits which colliders count, as on [**Line Trace**](line-trace.md). Defaults to All. |
| Actors To Ignore | Array of Actor Reference | Actors the query passes through. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Hits | Array of HitResult | One Hit Result per actor, nearest first. |
| Hit | Boolean | True when **Hits** is not empty. |

## Notes

- **Radius** must be greater than 0, in world units.
- Each actor appears once, at the first point the sphere touches it; at most 64 actors are reported.
