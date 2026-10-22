---
node: scene-layer.setCameraLocation
---

# Set Scene Layer Camera Location

Moves a Scene Layer's camera so the view is centred on a point of the layer.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Layer | SceneLayer Reference |  |
| Location | Vector 2 | The point at the centre of the view, in layer units. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Every Scene Layer starts with its camera at 0, 0, the centre of its design canvas. Moving the camera to the right makes the layer's content move to the left on screen.
- Only this layer moves. The world camera and other layers stay where they are.
- There are no limits: the camera can move past the edges of the design canvas.
- See [Move the layer camera](../../scenes/scene-layers.md#move-the-layer-camera).
