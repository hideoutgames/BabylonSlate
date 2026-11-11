---
node: input.worldNormal
---

# World Normal

Returns the surface normal in world space.

## Outputs

| Pin | Type |
| --- | --- |
| Normal | Vector3 |

## Notes

- The direction is not scaled to a length of 1: its length follows the mesh's scale. Use [**Vertex Normal (World)**](vertex-normal-world.md) for a unit-length normal.
- Only in Surface and Landscape materials.
