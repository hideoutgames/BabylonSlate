# Maximum

Returns the larger of two values, component by component.

## Inputs

| Pin | Type | Default |
| --- | --- | --- |
| A | Any | 0 |
| B | Any | 0 |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Any |

## Notes

- Accepts a Float, Vector 2 or Vector 3, but not a Color. A Float is applied to every component of the other input.
- Two different vector types cannot be mixed; use [**Split**](split.md) and [**Combine**](combine.md) to convert.
