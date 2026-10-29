---
node: input.waterDepthFade
---

# Water Depth Fade

Returns how deep the water is below this point, a fade that rises from 0 at the waterline to 1 in deep water, how much of what lies below shows through, and how the water fades out at its edges.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Distance | Float |  | Metres of water over which Fade rises toward 1. The asset's **Depth Color Distance** when unconnected. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Depth | Float | Metres of water straight down from the surface. |
| Fade | Float | 1 − e^(−Depth / Distance): 0 at the waterline, near 1 at three times Distance. |
| Transmittance | Vector 3 | How much of what lies below reaches the camera, per colour channel: near 1 in the shallows, falling with Depth and with a flatter view. The colours Shallow Color lacks fade first. Built-in water uses the same amount. |
| Edge Fade | Float | 0 to 1: how much water there is at this point near the body's edges. It falls to 0 at a shore over the last few centimetres of depth where the shore is steep, and up to 40 cm where it is gentle. At an edge that meets no land, such as an Ocean's outer edge, it fades over several metres. 1 everywhere else. Built-in water fades the same way. |

## Notes

- With the scene behind the water available (see [**Water Scene Color**](water-scene-color.md)), Depth measures whatever lies under the water, such as rocks. Otherwise it uses the terrain under the water, or the body's banks and **Depth**.
- Use Fade as the blend between Shallow and Deep Color, or as Opacity for soft shorelines.
- Multiply Opacity by Edge Fade so the water's edges fade out as built-in water's do. The Material has to be Translucent.
- To look like built-in water, [**Mix**](mix.md) from the deep water's colour to [**Water Scene Color**](water-scene-color.md) with Transmittance as the blend.
- On meshes that are not water, Transmittance is 0.
- On meshes that are not water, Depth, Fade and Edge Fade are 1.
- Only in Surface and Landscape materials.
