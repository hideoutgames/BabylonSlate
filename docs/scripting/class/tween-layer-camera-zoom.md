---
node: tween.layerCameraZoom
---

# Tween Layer Camera Zoom

Zooms a Layer Camera from A to B over Duration seconds.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Target | LayerCamera Reference | The Layer Camera that zooms: a Scene's or a Scene Layer's. |
| A | Float | Defaults to 1, the normal size. |
| B | Float | Defaults to 1, the normal size. |
| Duration | Float | Seconds the tween takes, in game time. Defaults to 2; 0 or less writes B immediately. |
| Curve | EasingCurve | Easing shape, Linear by default. Back and Elastic curves can overshoot A and B. |

## Outputs

| Pin | Type |
| --- | --- |
| Completed | Exec |

## Notes

- Writes A when it starts, interpolates to B, and runs **Completed** once B is written.
- A zoom of 2 shows half the view at twice the size. Values below 0.01, including an overshoot, are raised to 0.01. See [Layer Camera](../../graphics/cameras.md#layer-camera).
- A new tween on the same property cancels the running one, which then never runs **Completed**. Removing the camera's Scene or Scene Layer cancels it too.
- Latent: the node finishes later without pausing the rest of the game.
