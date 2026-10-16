# Tween Layout Size

Resizes a 2D layout component from size A to size B over Duration seconds.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Target | ActorComponent Reference | 2D layout component such as a box or scroll box. 2D Padding is not supported. |
| A | Vector 2 |  |
| B | Vector 2 |  |
| Duration | Float | Seconds the tween takes, in game time. Defaults to 2; 0 or less writes B immediately. |
| Curve | EasingCurve | Easing shape, Linear by default. Back and Elastic curves can overshoot A and B. |

## Outputs

| Pin | Type |
| --- | --- |
| Completed | Exec |

## Notes

- Writes A when it starts, interpolates to B, and runs **Completed** once B is written.
- Only dimensions set to Fixed change, in scene layer units. If neither width nor height is Fixed, the tween is cancelled.
- A new tween on the same property cancels the running one, which then never runs **Completed**.
- Latent: the node finishes later without pausing the rest of the game.
