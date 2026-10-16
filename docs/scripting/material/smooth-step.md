---
node: math.smoothstep
---

# Smooth Step

Returns 0 below the first edge, 1 above the second, and a smooth curve in between.

## Inputs

| Pin | Type | Default |
| --- | --- | --- |
| Edge A | Any | 0 |
| Edge B | Any | 1 |
| Value | Any | 0 |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Any |

## Notes

- Accepts a Float, Vector 2 or Vector 3, but not a Color.
- Use it to ease a value in or out instead of changing it in a straight line.
