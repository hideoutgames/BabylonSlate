---
node: physics.multiLineTrace
---

# Multi Line Trace

Casts a ray from a start point to an end point and reports every actor it passes through.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Start | Vector 3 |  |
| End | Vector 3 |  |
| Channel | CollisionChannel | Limits which colliders count, as on [**Line Trace**](line-trace.md). Defaults to All. |
| Actors To Ignore | Array of Actor Reference | Actors the query passes through. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Hits | Array of HitResult | One Hit Result per actor, nearest first. |
| Hit | Boolean | True when **Hits** is not empty. |

## Notes

- Each actor appears once, at the first point the ray reaches it.
- The ray carries on through every actor; at most 64 actors are reported.
