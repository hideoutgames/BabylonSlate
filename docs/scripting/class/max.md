---
node: math.max
---

# Max

Returns the larger of two numbers.

## Inputs

| Pin | Type |
| --- | --- |
| A | Float |
| B | Float |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Float |

## Notes

- Accepts a Float, Vector2 or Vector3, but not a Color. A Float is applied to every component of the other input.
- Two different vector types cannot be mixed; use [**Split**](split.md) and **Combine** to convert.
