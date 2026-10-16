---
node: tween.actorRotation
---

# Tween Actor Rotation

Rotates an actor from rotation A to rotation B over Duration seconds.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Target | Actor Reference | Actor to move. If it is empty or destroyed, the tween is cancelled. |
| A | Rotator |  |
| B | Rotator |  |
| Duration | Float | Seconds the tween takes, in game time. Defaults to 2; 0 or less writes B immediately. |
| Curve | EasingCurve | Easing shape, Linear by default. Back and Elastic curves can overshoot A and B. |
| Space | TweenSpace | Local (default) is relative to the parent; World uses world coordinates and follows a moving parent. |

## Outputs

| Pin | Type |
| --- | --- |
| Completed | Exec |

## Notes

- Writes A when it starts, interpolates to B, and runs **Completed** once B is written.
- Angles blend as typed, in degrees, so a yaw from 0 to 360 spins one full turn.
- A new tween on the same property cancels the running one, which then never runs **Completed**.
- Latent: the node finishes later without pausing the rest of the game.
