---
node: curve.evaluateColor
---

# Evaluate Color Curve

Returns the Color Curve's value at **Time**.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Curve | Color Curve |  |
| Time | Float |  |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Value | Color |  |

## Notes

- Each segment follows the interpolation of the key it starts at.
- Before the first key and after the last, the curve's **Before** and **After** settings decide the value.
- A curve without keys returns zero; a curve with one key returns that key's value.
- See [Curves and ranges](../curves-and-ranges.md).
