---
node: curve.evaluateFloat
---

# Evaluate Float Curve

Returns the Float Curve's value at **Time**.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Curve | Float Curve |  |
| Time | Float |  |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Value | Float |  |

## Notes

- Each segment follows the interpolation of the key it starts at.
- Before the first key and after the last, the curve's **Before** and **After** settings decide the value.
- A curve without keys returns zero; a curve with one key returns that key's value.
- See [Curves and ranges](../curves-and-ranges.md).
