# Tween Scroll Offset

Scrolls a 2D Scroll Box from offset A to offset B over Duration seconds.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Target | 2D Scroll Box Component Reference | A 2D Scroll Box component. |
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
- Offsets are in scene layer units and are clamped to the measured content bounds.
- A new tween on the same property cancels the running one, which then never runs **Completed**.
- Latent: the node finishes later without pausing the rest of the game.
