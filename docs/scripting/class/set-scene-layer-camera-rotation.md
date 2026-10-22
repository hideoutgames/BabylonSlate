---
node: scene-layer.setCameraRotation
---

# Set Scene Layer Camera Rotation

Turns a Scene Layer's camera around the centre of its view.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Layer | SceneLayer Reference |  |
| Rotation | Float | The camera's angle in degrees. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- A positive angle turns the camera counter-clockwise, the same way a positive rotation turns a 2D actor, so the layer's content appears to turn clockwise.
- Taps, drags and 2D form controls follow the turned view.
- While the camera is turned, a [2D Scroll Box](../../components/2d-scroll-box.md) or [2D Mask](../../components/2d-mask.md) clips to the smallest upright rectangle on screen that contains it, so content near its corners can show outside it.
