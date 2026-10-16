---
node: texture.transformUv
---

# Transform UV

Scales and offsets UV coordinates, for tiling and scrolling textures.

## Inputs

| Pin | Type | Default |
| --- | --- | --- |
| UV | Vector 2 |  |
| Tiling | Vector 2 | (1, 1) |
| Offset | Vector 2 | (0, 0) |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Vector 2 |

## Notes

- Multiplies UV by Tiling, then adds Offset.
- Animate Offset with [**Time**](time.md) to scroll a texture.
