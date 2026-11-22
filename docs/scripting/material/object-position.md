---
node: input.objectPosition
---

# Object Position

Returns the position of the mesh's origin in world space, in metres.

## Outputs

| Pin | Type |
| --- | --- |
| Position | Vector3 |

## Notes

- The same for every pixel of one mesh, and separate for each instance.
- Subtract it from [**World Position**](world-position.md) for a position that moves with the mesh.
- Only in Surface, Landscape and Decal materials. In a Decal material, it is the decal's own centre.
