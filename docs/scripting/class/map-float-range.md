---
node: range.mapFloat
---

# Map Float Range

Maps **Value** from the **From** range to the **To** range.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Value | Float |  |
| From | Float Range | The range **Value** is measured in. |
| To | Float Range | The range to map into. |
| Clamp | Boolean | When on, the result stays inside **To**. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Result | Float |  |

## Notes

- A value at **From** Min returns **To** Min, and a value at **From** Max returns **To** Max.
- If **From** has no width, the result is **To** Min.
- See [Curves and ranges](../curves-and-ranges.md).
