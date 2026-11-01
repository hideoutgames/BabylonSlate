---
node: curveObject.keyCountVector
---

# Get Key Count (Vector Curve)

Returns how many keys the Vector Curve has.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Target | Vector Curve Object |  |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Count | Integer |  |

## Notes

- An empty **Target** returns 0.
- A key that sets only some axes counts as one key. See [Curves and ranges](../curves-and-ranges.md#curves).
- See [Curve](../../assets/curve.md).
