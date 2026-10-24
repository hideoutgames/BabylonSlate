---
node: input.waterColors
---

# Water Colors

Returns the Water asset's colours and opacity, so a Custom Material follows the asset's **Inspector**, and how strongly the scene lights them.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Shallow Color | Vector 3 | The asset's **Shallow Color**, in linear colour. |
| Deep Color | Vector 3 | The asset's **Deep Color**, in linear colour. |
| Foam Color | Vector 3 | The asset's **Foam Color**, in linear colour. |
| Opacity | Float | The asset's **Opacity**. |
| Scene Light | Float | How strongly the scene lights the water's own colour, from 0.05 in the dark to 1.6 in bright daylight. Built-in water multiplies Deep Color by it, so a dim scene keeps a dim sea. |

## Notes

- Where the water blends with a body that uses a different Water asset (see [Water Blend Distance](../../graphics/water.md#water-blend-distance)), the colours and Opacity fade toward that body's, as built-in water does.
- On meshes that are not water, such as the material preview, the outputs are the default water's.
- Only in Surface and Landscape materials.
