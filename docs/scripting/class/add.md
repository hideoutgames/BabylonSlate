# Add

Returns the sum of two values, component by component.

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

- Accepts a Float, Vector 2, Vector 3 or Color. A Float is applied to every component of the other input.
- Two different vector types cannot be mixed; use [**Split**](split.md) and **Combine** to convert.
