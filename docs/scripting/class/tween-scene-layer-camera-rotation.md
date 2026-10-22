---
node: tween.sceneLayerCameraRotation
---

# Tween Scene Layer Camera Rotation

Turns a Scene Layer's camera from angle A to angle B over Duration seconds.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Target | SceneLayer Reference | The Scene Layer whose camera turns. |
| A | Float | Degrees. |
| B | Float | Degrees. |
| Duration | Float | Seconds the tween takes, in game time. Defaults to 2; 0 or less writes B immediately. |
| Curve | EasingCurve | Easing shape, Linear by default. Back and Elastic curves can overshoot A and B. |

## Outputs

| Pin | Type |
| --- | --- |
| Completed | Exec |

## Notes

- Writes A when it starts, interpolates to B, and runs **Completed** once B is written. The angle is not wrapped: tweening from 0 to 720 turns the camera twice.
- Angles work as for [**Set Scene Layer Camera Rotation**](set-scene-layer-camera-rotation.md).
- A new tween on the same property cancels the running one, which then never runs **Completed**. Removing the layer cancels it too.
- Latent: the node finishes later without pausing the rest of the game.
