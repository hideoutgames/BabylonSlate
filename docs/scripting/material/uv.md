---
node: input.uv
---

# UV

Returns the texture coordinates of the surface, particle quad or text glyph being drawn.

## Outputs

| Pin | Type |
| --- | --- |
| UV | Vector 2 |

## Notes

- Available in Surface, Landscape, Particle and Text materials. Use [**Screen UV**](screen-uv.md) in Post Process materials.
- In Text materials, the component's **Material UV** setting chooses whole-text or per-glyph coordinates.
