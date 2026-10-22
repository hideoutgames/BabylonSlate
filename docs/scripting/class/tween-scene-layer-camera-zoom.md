---
node: tween.sceneLayerCameraZoom
---

# Tween Scene Layer Camera Zoom

Zooms a Scene Layer's camera from A to B over Duration seconds.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Target | SceneLayer Reference | The Scene Layer whose camera zooms. |
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
- Zoom works as for [**Set Scene Layer Camera Zoom**](set-scene-layer-camera-zoom.md); values below 0.01, including an overshoot, are raised to 0.01.
- A new tween on the same property cancels the running one, which then never runs **Completed**. Removing the layer cancels it too.
- Latent: the node finishes later without pausing the rest of the game.
