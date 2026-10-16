---
node: input.worldNormal
---

# World Normal

Returns the surface normal in world space.

## Outputs

| Pin | Type |
| --- | --- |
| Normal | Vector 3 |

## Notes

- The direction is not scaled to a length of 1. Use [**VertexNormalWS**](vertexnormalws.md) for a unit-length normal.
- Only in Surface and Landscape materials.
