# Dynamic Runtime Mesh

A mesh whose triangles a script creates and changes while the game runs.

## Add it

Select an actor, then choose **Add Component > Rendering > Dynamic Runtime Mesh**. It starts empty and has no asset.

## Settings

| Setting | Description |
| --- | --- |
| Material | A Material or Material Instance for the generated surface. |
| Enable Collision | Uses the current triangles as collision. Default off. 3D physics only. |
| Layer | The collision layer the mesh is on. |
| Collides With | The layers the mesh collides with. |
| Cast Shadows | Casts shadows. Default on. |
| Receive Shadows | Receives shadows. Default on. |

## From scripts

Drag the component into a graph to find its functions:

| Function | Description |
| --- | --- |
| Set Geometry | Replaces the mesh from lists of positions and triangle indices. Normals and UVs are optional. |
| Update Vertices | Changes a run of vertices starting at an index, keeping the triangles. |
| Clear Geometry | Removes all geometry. |
| Recalculate Normals | Rebuilds normals after you deform the mesh. |
| Recalculate Bounds | Tightens the bounds after the mesh shrinks. |

## Notes

- World scenes only.
- Positions are in the component's local space. Each list is flat numbers: x, y, z for each position, and three indices for each triangle.
- A mesh holds up to 1,000,000 vertices and 6,000,000 indices. A call with invalid data returns false and changes nothing.
- With Enable Collision on, an actor without a Rigid Body gets a static body. Edits to positions or triangles rebuild the collision on the next physics step, so leave it off for meshes that change every frame.
- Generated geometry is not saved. It is discarded on Stop.

## Related

- [Geometry](../graphics/geometry.md)
- [Materials](../graphics/materials.md)
