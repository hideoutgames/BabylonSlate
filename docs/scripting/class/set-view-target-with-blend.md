---
node: camera.setViewTargetWithBlend
---

# Set View Target With Blend

Makes the camera on an actor the view the player sees, moving the view there smoothly.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| New View Target | Actor Reference | Left unconnected the pin shows **Self** and uses the actor running the graph. |
| Blend Time | Float | Seconds the move takes. Defaults to 1. |
| Blend Function | EasingCurve | How the move speeds up and slows down. Defaults to Linear. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- The view moves and turns from where it was when the node ran to the new camera, following that camera if it moves, and its field of view changes along the way. Then the view looks through the new camera itself.
- **Blend Time** 0 or below switches at once, like [**Possess Camera**](possess-camera.md).
- The view blends only between cameras with the same **Projection Mode**. Switching between perspective and orthographic, including to or from the Scene's orthographic [Layer Camera](../../graphics/cameras.md#layer-camera) and a perspective camera, switches at once.
- Connect a None reference to return the view to the Layer Camera. Scripts reading the camera in view, such as **Get Scene Camera Manager**, see the new camera from the start of the blend.
- Blends count real time.
