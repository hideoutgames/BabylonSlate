---
node: input.waterColors
---

# Water Colors

Returns the Water asset's colours and opacity, so a Custom Material follows the asset's **Inspector**.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Shallow Color | Vector 3 | The asset's **Shallow Color**, in linear colour. |
| Deep Color | Vector 3 | The asset's **Deep Color**, in linear colour. |
| Foam Color | Vector 3 | The asset's **Foam Color**, in linear colour. |
| Opacity | Float | The asset's **Opacity**. |

## Notes

- On meshes that are not water, such as the material preview, the outputs are the Realistic defaults.
- Only in Surface and Landscape materials.
