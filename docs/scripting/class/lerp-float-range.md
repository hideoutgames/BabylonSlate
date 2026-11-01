---
node: range.lerpFloat
---

# Lerp Float Range

Returns the value at **Alpha** between the range's **Min** and **Max**.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Range | Float Range |  |
| Alpha | Float | 0 returns **Min** and 1 returns **Max**. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Value | Float |  |

## Notes

- **Alpha** is not clamped: values below 0 or above 1 continue past the ends.
- See [Curves and ranges](../curves-and-ranges.md).
