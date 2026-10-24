---
node: input.waterDepthFade
---

# Water Depth Fade

Returns how deep the water is below this point, a fade that rises from 0 at the waterline to 1 in deep water, and how much of what lies below shows through.

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

## Notes

- With the scene behind the water available (see [**Water Scene Color**](water-scene-color.md)), Depth measures whatever lies under the water, such as rocks. Otherwise it uses the terrain under the water, or the body's banks and **Depth**.
- Use Fade as the blend between Shallow and Deep Color, or as Opacity for soft shorelines.
- To look like built-in water, [**Mix**](mix.md) from the deep water's colour to [**Water Scene Color**](water-scene-color.md) with Transmittance as the blend.
- On meshes that are not water, Transmittance is 0.
- On meshes that are not water, Depth and Fade are 1.
- Only in Surface and Landscape materials.
