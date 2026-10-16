---
node: tween.componentTransform
---

# Tween Component Transform

Moves, rotates and scales a component from Transform A to Transform B together.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Target | ActorComponent Reference | Component to move. It must have a transform; 2D Anchor and Movement components are not supported. If it is empty or destroyed, the tween is cancelled. |
| A | Transform |  |
| B | Transform |  |
| Duration | Float | Seconds the tween takes, in game time. Defaults to 2; 0 or less writes B immediately. |
| Curve | EasingCurve | Easing shape, Linear by default. Back and Elastic curves can overshoot A and B. |
| Space | TweenSpace | Local (default) is relative to the parent; World uses world coordinates and follows a moving parent. |

## Outputs

| Pin | Type |
| --- | --- |
| Completed | Exec |

## Notes

- Writes A when it starts, interpolates to B, and runs **Completed** once B is written.
- It claims position, rotation and scale together, so it also cancels separate tweens on any of them.
- A new tween on the same property cancels the running one, which then never runs **Completed**.
- Latent: the node finishes later without pausing the rest of the game.
