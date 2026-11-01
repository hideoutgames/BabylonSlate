---
node: curveObject.valueAtTimeFloat
---

# Get Value At Time (Float Curve)

Returns the Float Curve's value at **Time**.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Target | Float Curve Object |  |
| Time | Float |  |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Value | Float |  |

## Notes

- Uses each key's interpolation and the curve's **Before** and **After** settings, as [Evaluate Float Curve](evaluate-float-curve.md) does.
- An empty **Target** returns zero.
- See [Curve](../../assets/curve.md).
