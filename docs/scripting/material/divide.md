---
node: math.divide
---

# Divide

Divides one value by another, component by component.

## Inputs

| Pin | Type | Default |
| --- | --- | --- |
| A | Any | 0 |
| B | Any | 1 |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Any |

## Notes

- Accepts a Float, Vector 2 or Vector 3, but not a Color. A Float is applied to every component of the other input.
- Dividing by 0 gives an invalid result.
