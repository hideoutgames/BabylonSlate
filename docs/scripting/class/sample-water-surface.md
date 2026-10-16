# Sample Water Surface

Samples the rendered water surface at a world position, including wave motion.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| World Position | Vector 3 |  |
| Water Actor | Actor Reference | Limits the sample to one water actor. Leave empty to use any water at the position. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Then | Exec |  |
| Found | Boolean |  |
| Surface Height | Float | Height of the water surface in world space. |
| Immersion Depth | Float | How far the position is below the surface. Negative when it is above the surface. |
| Surface Normal | Vector 3 | The direction the surface faces at the sample point. |
| Water Velocity | Vector 3 | The current plus wave motion. X and Z rock back and forth with the waves and average to zero at a fixed point. Y is how fast the surface height changes at this X/Z. |
| Bank Distance | Float | How far the position is from the water's edge, in metres. |
| Water Actor | Actor Reference |  |

## Notes

- **Found** is false when no water covers the position. The other outputs then read as empty, with a straight-up normal.
- Water Quality settings do not change the result.
