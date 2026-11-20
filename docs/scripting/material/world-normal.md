---
node: input.worldNormal
---

# World Normal

Returns the surface normal in world space, scaled to a length of 1.

## Outputs

| Pin | Type |
| --- | --- |
| Normal | Vector3 |

## Notes

- The length is 1 whatever the mesh's scale.
- Only in Surface, Landscape and Decal materials. In a Decal material, it is the normal of the surface under the decal.
