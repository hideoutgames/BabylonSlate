---
node: rotator.nearlyEqual
---

# Rotator Nearly Equal

Returns true when two rotators are equal within a small tolerance.

## Inputs

| Pin | Type |
| --- | --- |
| A | Rotator |
| B | Rotator |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Boolean |

## Notes

- Pitch, yaw and roll may each differ by less than 0.001 degrees.
- Angles wrap, so 0 and 360 degrees count as equal.
