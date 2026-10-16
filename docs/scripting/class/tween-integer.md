---
node: tween.integer
---

# Tween Integer

Animates an Integer variable from A to B in whole-number steps.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Target | Integer | Connect a [**Get Variable**](get-variable.md) node for a writable variable. Constants, computed values and read-only variables cannot be tweened. |
| A | Integer |  |
| B | Integer |  |
| Duration | Float | Seconds the tween takes, in game time. Defaults to 2; 0 or less writes B immediately. |
| Curve | EasingCurve | Easing shape, Linear by default. Back and Elastic curves can overshoot A and B. |

## Outputs

| Pin | Type |
| --- | --- |
| Completed | Exec |

## Notes

- Writes A when it starts, interpolates to B, and runs **Completed** once B is written.
- A, B and every intermediate value are rounded to whole numbers.
- A new tween on the same property cancels the running one, which then never runs **Completed**.
- Latent: the node finishes later without pausing the rest of the game.
