# Water Waves

Calculates animated wave displacement on the GPU, returning offset, height, normal and time for a water surface.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Offset | Vector 3 | Displacement in world units to add to the vertex position. |
| Wave Height | Float | Vertical wave displacement in metres. |
| Normal | Vector 3 | World-space normal of the displaced surface. |
| Simulation Time | Float | Time in seconds that drives the waves. |

## Notes

- Connect Offset to **World Position Offset** and Normal to **Normal** on [**Material Output**](material-output.md) to displace and shade the water.
- Only affects water bodies that use this material as their Custom Material. Other meshes get no offset and keep their own normal.
- Only in Surface and Landscape materials.
