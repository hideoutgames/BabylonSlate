# Project Cursor To Scene

Casts a ray from the active camera through the cursor and returns what it hits.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Channel | CollisionChannel | Limits the trace to this collision channel. |
| Draw Debug | Boolean | Draws the ray and the hit point. |
| Duration | Float | How long the debug drawing stays visible, in seconds. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Hit Result | HitResult | The hit as a single structure. Use the separate pins when you need only some of its values. |
| Hit | Boolean |  |
| Location | Vector 3 |  |
| Normal | Vector 3 |  |
| Distance | Float | Distance from the start of the ray to the hit. |
| Actor | Actor Reference | The actor that was hit. Empty on a miss. |
| World Origin | Vector 3 | Where the ray starts, at the camera. |
| World Direction | Vector 3 | The direction the ray points. |

## Notes

- Uses the possessed camera, otherwise the main camera set in the Scene; with no camera, the result is a miss.
- On a miss, **Hit** is false and **Location** and **Normal** are zero.
- Called from a Scene Layer, it uses that layer's own view and finds objects only when the layer has physics enabled.
