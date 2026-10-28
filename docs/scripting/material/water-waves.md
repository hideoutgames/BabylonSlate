---
node: input.waterWaves
---

# Water Waves

Returns the water asset's simulated ocean at this point: the wave offset, height, normal, breaking-crest foam and the sunlight glowing through the crests.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Offset | Vector 3 | Displacement in world units to add to the vertex position. |
| Wave Height | Float | Vertical wave displacement in metres. |
| Normal | Vector 3 | World-space normal of the displaced surface. |
| Crest Foam | Float | Foam on breaking crests, 0 to 1. It lingers and fades behind the crests. |
| Subsurface | Float | Sunlight scattered through the wave crests toward the camera, times the asset's **Subsurface**. Strongest looking toward the sun across tall crests; 0 looking down. Built-in water adds Shallow Color times it to Deep Color. |
| Simulation Time | Float | Time in seconds that drives the waves. |

## Notes

- Connect Offset to **World Position Offset** and Normal to **Normal** on [**Material Output**](material-output.md) to displace and shade the water.
- Wave Height, Normal, Crest Foam and Subsurface are sampled per pixel, so short waves stay sharp between mesh vertices.
- Only affects water bodies that use this material as their Custom Material. Other meshes get no offset and keep their own normal.
- Only in Surface and Landscape materials.
