---
node: curveObject.valueAtTimeVector
---

# Get Value At Time (Vector Curve)

Returns the Vector Curve's value at **Time**.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Target | Vector Curve Object |  |
| Time | Float |  |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Value | Vector 3 |  |

## Notes

- Uses each key's interpolation and the curve's **Before** and **After** settings, as [Evaluate Vector Curve](evaluate-vector-curve.md) does.
- An empty **Target** returns zero.
- See [Curve](../../assets/curve.md).
