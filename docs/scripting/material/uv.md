---
node: input.uv
---

# UV

Returns the texture coordinates of the surface, particle quad or text glyph being drawn.

## Outputs

| Pin | Type |
| --- | --- |
| UV | Vector 2 |

## Settings

| Setting | Description |
| --- | --- |
| UV Channel | **UV 0** reads the mesh's first set of texture coordinates. **UV 1** reads its second set, as a model's light map or detail texture often uses. |

## Notes

- Available in Surface, Landscape, Particle and Text materials. Use [**Screen UV**](screen-uv.md) in Post Process materials.
- In Text materials, the component's **Material UV** setting chooses whole-text or per-glyph coordinates.
- UV Channel applies to Surface materials. Particles and text glyphs have one set of coordinates, which both channels read. A mesh without a second set reads (0, 0) on UV 1.
