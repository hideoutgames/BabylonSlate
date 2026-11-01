---
node: curve.floatValueRange
---

# Get Float Curve Value Range

Returns the lowest and highest key values of a Float Curve.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Curve | Float Curve |  |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Value Range | Float Range |  |

## Notes

- Only key values count: a curve that overshoots between keys can go past this range.
- A curve without keys returns a range from 0 to 0.
- See [Curves and ranges](../curves-and-ranges.md).
