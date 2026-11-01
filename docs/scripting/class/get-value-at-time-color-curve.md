---
node: curveObject.valueAtTimeColor
---

# Get Value At Time (Color Curve)

Returns the Color Curve's value at **Time**.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Target | Color Curve Object |  |
| Time | Float |  |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Value | Color |  |

## Notes

- Uses each key's interpolation and the curve's **Before** and **After** settings, as [Evaluate Color Curve](evaluate-color-curve.md) does.
- An empty **Target** returns zero.
- See [Curve](../../assets/curve.md).
