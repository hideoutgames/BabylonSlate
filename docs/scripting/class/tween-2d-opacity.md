---
node: tween.opacity
---

# Tween 2D Opacity

Fades the opacity of a 2D component from A to B over Duration seconds.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Target | ActorComponent Reference | 2D component with opacity, such as 2D Texture, 2D Panel, 2D Text or a 2D control. |
| A | Float |  |
| B | Float |  |
| Duration | Float | Seconds the tween takes, in game time. Defaults to 2; 0 or less writes B immediately. |
| Curve | EasingCurve | Easing shape, Linear by default. Back and Elastic curves can overshoot A and B. |

## Outputs

| Pin | Type |
| --- | --- |
| Completed | Exec |

## Notes

- Writes A when it starts, interpolates to B, and runs **Completed** once B is written.
- Opacity runs from 0 (invisible) to 1 (opaque); values outside that range are clamped.
- A new tween on the same property cancels the running one, which then never runs **Completed**.
- Latent: the node finishes later without pausing the rest of the game.
