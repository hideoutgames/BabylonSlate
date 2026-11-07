---
node: tween.layerCameraRotation
---

# Tween Layer Camera Rotation

Turns a Layer Camera from angle A to angle B over Duration seconds.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Target | LayerCamera Reference | The Layer Camera that turns: a Scene's or a Scene Layer's. |
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
- Positive angles turn the camera counter-clockwise, so the view's content turns clockwise on screen. See [Layer Camera](../../graphics/cameras.md#layer-camera).
- A new tween on the same property cancels the running one, which then never runs **Completed**. Removing the camera's Scene or Scene Layer cancels it too.
- Latent: the node finishes later without pausing the rest of the game.
