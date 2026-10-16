---
node: noise.perlin
---

# Perlin Noise

Returns smooth 3D noise for a position, with values from about -1 to 1.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Coordinates | Vector 3 | (0, 0, 0) | Position to sample. Multiply it to change the scale of the noise. |

## Outputs

| Pin | Type |
| --- | --- |
| Value | Float |

## Notes

- Multiply by 0.5 and add 0.5 for a 0 to 1 range.
- A constant position gives a constant value. Connect [**World Position**](world-position.md) or [**UV**](uv.md) for a pattern that varies across a surface.
