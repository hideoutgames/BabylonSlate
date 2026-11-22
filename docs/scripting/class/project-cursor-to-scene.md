---
node: input.projectCursorToScene
---

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
| Location | Vector3 |  |
| Normal | Vector3 |  |
| Distance | Float | Distance from the start of the ray to the hit. |
| Actor | Actor Reference | The actor that was hit. Empty on a miss. |
| World Origin | Vector3 | Where the ray starts: on the camera's near clip plane, under the cursor. |
| World Direction | Vector3 | The direction the ray points. |

## Notes

- Uses the possessed camera, otherwise the main camera set in the Scene; with no camera, the result is a miss.
- The ray goes through the cursor's point on the view exactly as the last frame showed it, so it lands on what is drawn under the cursor. For a possessed camera that is the view of its first Camera component, wherever that sits: at the end of a Spring Arm (with its lag and Camera Probe), on a bone, under a Camera Shake, or part way through a Possess Camera With Blend.
- The cursor position is read in the same pixels as [Get Cursor Position](get-cursor-position.md), so the game view's position on the page, the screen's pixel density and the render resolution do not change where the ray goes.
- On a miss, **Hit** is false and **Location** and **Normal** are zero.
- Called from a Scene Layer, it uses that layer's own view, including its camera's location, rotation and zoom, and finds objects only when the layer has physics enabled.
