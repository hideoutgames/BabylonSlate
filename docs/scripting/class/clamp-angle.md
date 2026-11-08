---
node: math.clampAngle
---

# Clamp Angle

Limits an angle in degrees to an arc.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Angle | Float |  |
| Min Angle Degrees | Float | Defaults to -90. |
| Max Angle Degrees | Float | Defaults to 90. |

## Outputs

| Pin | Type |
| --- | --- |
| Return Value | Float |

## Notes

- The arc runs from **Min Angle Degrees** round to **Max Angle Degrees** in the positive direction, so 90 to -90 is the half circle through 180.
- An angle outside the arc moves to the nearer end. The result is between -180 and 180.
