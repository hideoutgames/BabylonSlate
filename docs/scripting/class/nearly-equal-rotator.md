---
node: rotator.nearlyEqual
---

# Nearly Equal Rotator

Returns true when two rotators are equal within a small tolerance.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| A | Rotator |  |
| B | Rotator |  |
| Tolerance | Float | In degrees. Defaults to 0.0001. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Boolean |

## Notes

- Pitch, yaw and roll must each differ by no more than **Tolerance** degrees.
- Angles wrap, so 0 and 360 degrees count as equal.
