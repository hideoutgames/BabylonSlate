---
node: math.ease
---

# Ease

Blends between two numbers along an easing curve.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| A | Float |  |
| B | Float | Defaults to 1. |
| Alpha | Float |  |
| Curve | EasingCurve | Defaults to Linear. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Float |

## Notes

- **Alpha** 0 returns **A** and 1 returns **B**; it is clamped to 0 to 1.
- Back and Elastic curves can overshoot **A** and **B**.
