---
node: texture.transformUv
---

# Transform UV

Scales, rotates and offsets UV coordinates, for tiling, turning and scrolling textures.

## Inputs

| Pin | Type | Default |
| --- | --- | --- |
| UV | Vector2 |  |
| Tiling | Vector2 | (1, 1) |
| Rotation (Radians) | Float | 0 |
| Offset | Vector2 | (0, 0) |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Vector2 |

## Notes

- Multiplies UV by Tiling, rotates the result by Rotation around UV (0, 0), then adds Offset.
- Rotation is in radians and turns UV counter-clockwise, which turns the texture clockwise. Use [**Degrees To Radians**](degrees-to-radians.md) to enter degrees.
- Animate Offset with [**Time**](time.md) to scroll a texture, or use [**Panner**](panner.md). [**Rotator**](rotator.md) turns UV around a centre point.
