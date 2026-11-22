---
node: input.uv
---

# UV

Returns the texture coordinates of the surface, particle quad, text glyph or 2D element being drawn.

## Outputs

| Pin | Type |
| --- | --- |
| UV | Vector2 |

## Settings

| Setting | Description |
| --- | --- |
| UV Channel | **UV 0** reads the mesh's first set of texture coordinates. **UV 1** reads its second set, as a model's light map or detail texture often uses. |

## Notes

- Available in Surface, Landscape, Particle, Text, Decal and User Interface materials. Use [**Screen UV**](screen-uv.md) in Post Process materials.
- In Decal materials, it is the decal's projected coordinates: 0 to 1 across its box's local X and Z, on both channels.
- In Text materials, the component's **Material UV** setting chooses whole-text or per-glyph coordinates.
- In User Interface materials it is the Element UV of [**User Interface Input**](user-interface-input.md): 0 to 1 across the element, from its bottom left.
- UV Channel applies to Surface materials. Particles and text glyphs have one set of coordinates, which both channels read. A mesh without a second set reads (0, 0) on UV 1.
