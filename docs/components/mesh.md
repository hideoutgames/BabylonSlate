# Mesh

Draws a built-in shape or a Model, with a Material, shadows and optional collision.

## Add it

Select an actor, then choose **Add Component > Rendering > Mesh**. You can also place a ready-made actor from **Place Actors > Shapes** (Box, Sphere, Cylinder, Plane or Ground), or place a Model from **Place Actors > Models**.

## Settings

| Setting | Description |
| --- | --- |
| Mesh Kind | Box, Sphere, Cylinder, Plane or Ground. Shown only while no Asset is set. Default Box. |
| Asset | A [Model](../assets/model.md). It replaces the built-in shape. |
| Material | A Material or Material Instance. With a Model, the default is the Model's own materials. |
| Collision | **Use Simple Collision**, **Use Complex Collision** or **No Collision**. Default No Collision. 3D physics only. |
| Layer | The collision layer this mesh is on. Shown when Collision is on. |
| Collides With | The layers this mesh collides with. Shown when Collision is on. |
| Cast Shadows | Casts shadows. Default on. |
| Receive Shadows | Receives shadows. Default on. |

## Notes

- Works in world scenes and in Scene Layers.
- Simple collision uses the Model's simple colliders, or the built-in shape for a primitive. Complex collision uses the visible triangles and does not follow skeletal animation.
- A Mesh with collision on is solid without a Rigid Body. Add a [Rigid Body](rigid-body.md) to make it move.
- Name collision layers in **Project Settings > Physics > Collision Layers**.
- Add a [Deformer](deformer.md) or [Outline](outline.md) to the same actor to bend or outline the mesh.

## Related

- [Models](../graphics/models.md)
- [Materials](../graphics/materials.md)
- [Collision](../physics/collision.md)
