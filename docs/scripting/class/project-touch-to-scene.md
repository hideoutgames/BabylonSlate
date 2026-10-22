---
node: input.projectTouchToScene
---

# Project Touch To Scene

Casts a ray from the active camera through a touch and returns what it hits.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Finger | Integer | The finger number of the touch to cast through. |
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

- Works like [Project Cursor To Scene](project-cursor-to-scene.md), at the touch's position instead of the cursor's.
- A finger with no touch this tick is a miss, and no ray is drawn. A touch that ended this tick can still be cast through.
- Called from a Scene Layer, it uses that layer's own view and finds objects only when the layer has physics enabled.
