---
node: input.waterDepthFade
---

# Water Depth Fade

Returns how deep the water is below this point, and a fade that rises from 0 at the waterline to 1 in deep water.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Distance | Float |  | Metres of water over which Fade rises toward 1. The asset's **Depth Color Distance** when unconnected. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Depth | Float | Metres of water straight down from the surface. |
| Fade | Float | 1 − e^(−Depth / Distance): 0 at the waterline, near 1 at three times Distance. |

## Notes

- With the scene behind the water available (see [**Water Scene Color**](water-scene-color.md)), Depth measures whatever lies under the water, such as rocks. Otherwise it uses the terrain under the water, or the body's banks and **Depth**.
- Use Fade as the blend between Shallow and Deep Color, or as Opacity for soft shorelines.
- On meshes that are not water, Depth and Fade are 1.
- Only in Surface and Landscape materials.
