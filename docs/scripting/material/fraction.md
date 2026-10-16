---
node: math.fract
---

# Fraction

Returns the part of the input after the decimal point.

## Inputs

| Pin | Type | Default |
| --- | --- | --- |
| Value | Any | 0 |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Any |

## Notes

- Accepts a Float, Vector 2, Vector 3 or Color, and works on each component.
- Negative values keep their sign, so -1.25 becomes -0.25.
