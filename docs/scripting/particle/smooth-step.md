# Smooth Step

Returns 0 below the first edge, 1 above the second, and a smooth curve in between.

## Inputs

| Pin | Type | Default |
| --- | --- | --- |
| Value | Any | 0 |
| Edge A | Float | 0 |
| Edge B | Float | 1 |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Any |

## Notes

- Accepts a Float, Vector 2 or Vector 3, but not a Color.
- Use it to ease a value in or out instead of changing it in a straight line.
