---
node: scene-layer.addCameraOffset
---

# Add Scene Layer Camera Offset

Moves a Scene Layer's camera by an amount from where it is now.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Layer | SceneLayer Reference |  |
| Delta | Vector 2 | How far to move the camera, in layer units. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- The offset is in layer units, along the layer's own axes, whatever the camera's rotation and zoom.
- To pan smoothly every frame, multiply a speed by the **Delta Seconds** of **Event Tick**.
