---
node: input.vertexNormalWS
---

# VertexNormalWS

Returns the vertex normal in world space, scaled to a length of 1.

## Outputs

| Pin | Type |
| --- | --- |
| Normal | Vector 3 |

## Notes

- It follows the mesh's transform, skinning and morph targets, so it suits vertex displacement through **World Position Offset**.
- Only in Surface and Landscape materials.
