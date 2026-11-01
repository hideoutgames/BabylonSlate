---
node: curveObject.valueRangeFloat
---

# Get Value Range (Float Curve)

Returns the lowest and highest key values of the Float Curve.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Target | Float Curve Object |  |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Value Range | Float Range |  |

## Notes

- Only key values count: a curve that overshoots between keys can go past this range.
- See [Curve](../../assets/curve.md).
