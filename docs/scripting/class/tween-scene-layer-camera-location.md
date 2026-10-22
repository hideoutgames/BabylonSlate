---
node: tween.sceneLayerCameraLocation
---

# Tween Scene Layer Camera Location

Pans a Scene Layer's camera from location A to location B over Duration seconds.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Target | SceneLayer Reference | The Scene Layer whose camera moves. |
| A | Vector 2 |  |
| B | Vector 2 |  |
| Duration | Float | Seconds the tween takes, in game time. Defaults to 2; 0 or less writes B immediately. |
| Curve | EasingCurve | Easing shape, Linear by default. Back and Elastic curves can overshoot A and B. |

## Outputs

| Pin | Type |
| --- | --- |
| Completed | Exec |

## Notes

- Writes A when it starts, interpolates to B, and runs **Completed** once B is written. To start from where the camera is, connect [**Get Scene Layer Camera Location**](get-scene-layer-camera-location.md) to A.
- Locations are in layer units, as for [**Set Scene Layer Camera Location**](set-scene-layer-camera-location.md).
- A new tween on the same property cancels the running one, which then never runs **Completed**. Removing the layer cancels it too.
- Latent: the node finishes later without pausing the rest of the game.
