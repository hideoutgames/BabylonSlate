# Line Trace

Casts a ray from a start point to an end point and reports the first thing it hits.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Start | Vector 3 |  |
| End | Vector 3 |  |
| Channel | CollisionChannel | Limits what the trace can hit: All, Static, Dynamic, Character, Solid (ignores triggers) or Triggers (only triggers). Defaults to All. |
| Draw Debug | Boolean | On by default. Draws the trace for one frame, red for a miss and green for a hit. |
| Actors To Ignore | Array of Actor Reference | Actors whose colliders are skipped, so they cannot block the trace. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Hit Result | HitResult | All results in one structure. Use **Break Hit Result** to read its fields. |
| Hit | Boolean |  |
| Location | Vector 3 |  |
| Normal | Vector 3 |  |
| Distance | Float | Distance along the trace from **Start** to the hit point, in world units. |
| Actor | Actor Reference | The actor that was hit, or an empty reference on a miss. |

## Notes

- A miss reports Hit as false, zero for Location, Normal and Distance, and an empty Actor.
- Debug lines are not drawn in release exports.
