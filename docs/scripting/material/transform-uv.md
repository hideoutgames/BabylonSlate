---
node: texture.transformUv
---

# Transform UV

Scales, rotates and offsets UV coordinates, for tiling, turning and scrolling textures.

## Inputs

| Pin | Type | Default |
| --- | --- | --- |
| UV | Vector 2 |  |
| Tiling | Vector 2 | (1, 1) |
| Rotation | Float | 0 |
| Offset | Vector 2 | (0, 0) |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Vector 2 |

## Notes

- Multiplies UV by Tiling, rotates the result by Rotation around UV (0, 0), then adds Offset.
- Rotation is in radians and turns UV counter-clockwise, which turns the texture clockwise. Use [**Radians**](radians.md) to enter degrees.
- Animate Offset with [**Time**](time.md) to scroll a texture.
