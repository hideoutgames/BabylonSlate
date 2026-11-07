---
node: tween.layerCameraLocation
---

# Tween Layer Camera Location

Pans a Layer Camera from location A to location B over Duration seconds.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Target | LayerCamera Reference | The Layer Camera that moves: a Scene's or a Scene Layer's. |
| A | Vector 2 |  |
| B | Vector 2 |  |
| Duration | Float | Seconds the tween takes, in game time. Defaults to 2; 0 or less writes B immediately. |
| Curve | EasingCurve | Easing shape, Linear by default. Back and Elastic curves can overshoot A and B. |

## Outputs

| Pin | Type |
| --- | --- |
| Completed | Exec |

## Notes

- Writes A when it starts, interpolates to B, and runs **Completed** once B is written. To start from where the camera is, connect the camera's **Get Camera Location** to A.
- Locations are the point at the centre of the view: world units for a Scene's Layer Camera, layer units for a Scene Layer's. See [Layer Camera](../../graphics/cameras.md#layer-camera).
- A new tween of the same camera's location cancels the running one, which then never runs **Completed**, including a [**Tween Vector2**](tween-vector2.md) on its **Get Camera Location**. Removing the camera's Scene or Scene Layer cancels it too.
- Latent: the node finishes later without pausing the rest of the game.
