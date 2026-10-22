---
node: scene-layer.setCameraZoom
---

# Set Scene Layer Camera Zoom

Zooms a Scene Layer's camera in or out around the centre of its view.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Layer | SceneLayer Reference |  |
| Zoom | Float | 1 shows the layer at its normal size. Defaults to 1. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- A zoom of 2 shows the layer twice as large, so half as much of it fits on screen; 0.5 shows it at half size.
- Values below 0.01 are raised to 0.01.
- Everything on the layer scales with the zoom. 2D Anchor and 2D Safe Area positions do not change.
